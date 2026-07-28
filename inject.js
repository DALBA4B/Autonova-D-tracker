// Runs in the PAGE context (not isolated). Patches window.fetch and XMLHttpRequest
// to capture responses from cp.autonovad.ua/* (orders, basket, profile) and main-site
// /api/ + /ajax/ endpoints. Posts findings back to the content script via postMessage.
(function () {
  if (window.__ANO_INJECTED__) return;
  window.__ANO_INJECTED__ = true;

  // Read shared constants passed via data-* attributes on the <script> tag
  // by content.js (config.js is not available in the page world).
  var _script = document.currentScript || {};
  var NS = _script.dataset && _script.dataset.ns || 'ANO_EXT';
  var ORDER_RE = new RegExp((_script.dataset && _script.dataset.orderRe) || 'ЗК-\\d+');
  const ORDER_URL_FRAG = 'cp.autonovad.ua/api/v1/orders';
  const PROFILE_URL_FRAG = 'cp.autonovad.ua/api/profile';
  const BASKET_URL_FRAG = 'cp.autonovad.ua/pub/v1/basket';
  // Anything matching one of these substrings is captured into the debug log.
  // Covers: API hosts (cp.*), and any endpoints on the main site under /api/ or /ajax/
  // (used by some legacy pages — e.g. ЗК detail views).
  const DEBUG_URL_FRAGS = ['cp.autonovad.ua', 'autonovad.ua/api/', 'autonovad.ua/ajax/'];
  function urlMatchesDebug(url) {
    for (let i = 0; i < DEBUG_URL_FRAGS.length; i++) {
      if (url.indexOf(DEBUG_URL_FRAGS[i]) >= 0) return true;
    }
    return false;
  }

  // Endpoints whose response bodies we actually need for attribution debugging
  // (order creation, basket totals/items, profile client-code). For every other
  // matched URL we log only url/method/status metadata — the full bodies of
  // catalogue/search/delivery calls are noise and used to bloat the log to ~10MB,
  // hitting chrome.storage.local's quota.
  function isKeyEndpoint(url) {
    return url.indexOf(ORDER_URL_FRAG) >= 0 ||
           url.indexOf(PROFILE_URL_FRAG) >= 0 ||
           url.indexOf(BASKET_URL_FRAG) >= 0;
  }

  // Cache of basket data by basketId so we have sum/items at the moment of POST /orders.
  const basketCache = {};
  // In-flight self-fetches of the basket, keyed by basketId (dedupe concurrent submits).
  const basketRefresh = {};
  // Hard cap on how long the ORDER branch waits for a self-fetch before giving up
  // and posting whatever's in basketCache — the page tears down right after checkout
  // (redirect to /checkout/success/), so blocking indefinitely would lose the message.
  const BASKET_WAIT_MS = 2500;

  function post(kind, payload) {
    try {
      window.postMessage({ ns: NS, kind: kind, payload: payload }, '*');
    } catch (e) { /* noop */ }
  }

  const trunc = (s) => (s && s.length > 4000) ? s.slice(0, 4000) + '...[TRUNCATED]' : s;

  // Recursively find first string value matching the order-number pattern.
  function findOrderNumber(obj, depth) {
    if (depth > 6 || obj == null) return null;
    if (typeof obj === 'string') {
      const m = obj.match(ORDER_RE);
      return m ? m[0] : null;
    }
    if (typeof obj !== 'object') return null;
    if (Array.isArray(obj)) {
      for (const v of obj) {
        const r = findOrderNumber(v, depth + 1);
        if (r) return r;
      }
      return null;
    }
    for (const v of Object.values(obj)) {
      const r = findOrderNumber(v, depth + 1);
      if (r) return r;
    }
    return null;
  }

  // Try to find a client code (4-6 digit) in a profile JSON. We look at common keys first.
  function findClientCode(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const preferredKeys = ['clientCode', 'client_code', 'code', 'customerCode', 'customer_code', 'login', 'id'];
    for (const k of preferredKeys) {
      if (obj[k] != null) {
        const s = String(obj[k]);
        if (/^\d{4,6}$/.test(s)) return s;
      }
    }
    // Fallback: any string field that looks like a 4-6 digit code
    function walk(o, depth) {
      if (depth > 4 || o == null) return null;
      if (typeof o === 'string') {
        if (/^\d{4,6}$/.test(o)) return o;
        return null;
      }
      if (typeof o === 'number') {
        const s = String(o);
        return /^\d{4,6}$/.test(s) ? s : null;
      }
      if (typeof o !== 'object') return null;
      for (const v of (Array.isArray(o) ? o : Object.values(o))) {
        const r = walk(v, depth + 1);
        if (r) return r;
      }
      return null;
    }
    return walk(obj, 0);
  }

  function tryParseJson(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // Writes a basket GET response into basketCache, keyed by the basket's own id
  // (not necessarily the id that was requested — the server can hand back a
  // different, freshly-rotated basket once an order has consumed the old one).
  // Anti-clobber: a self-fetch that lands late (after the order already rotated
  // the basket server-side) must not overwrite a good cached entry with an empty
  // one. `source` is 'observed' (site's own traffic) or 'self' (our own fetch) —
  // purely for diagnostics, and as a manual test hook (see README/plan notes).
  function cacheBasketFromJson(data, source) {
    if (!data || !data.id) return false;
    const prev = basketCache[data.id];
    const newTotalSum = (data.price && typeof data.price.current === 'number') ? data.price.current : null;
    if (prev && typeof prev.totalSum === 'number' && (typeof newTotalSum !== 'number' || data.quantity === 0)) {
      return false;
    }
    basketCache[data.id] = {
      ts: Date.now(),
      source: source,
      totalSum: newTotalSum,
      currency: (data.price && data.price.currency) || null,
      itemsCount: (typeof data.quantity === 'number') ? data.quantity : null,
      items: Array.isArray(data.items) ? data.items.map(function (it) {
        const offer = it.offer || {};
        return {
          productId: it.productId || it.id || null,
          code: offer.code || it.sku || it.code || null,
          brand: (offer.brand && (offer.brand.shortName || offer.brand.name)) || null,
          name: offer.name || it.name || null,
          quantity: it.quantity || null,
          price: (it.price && it.price.current) || it.priceCurrent || null
        };
      }) : []
    };
    return true;
  }

  // Pulls { basketId, deliveryName } out of a POST /orders request body string.
  function parseOrderReq(reqBody) {
    try {
      const reqJson = reqBody ? JSON.parse(reqBody) : null;
      if (reqJson) {
        return {
          basketId: (reqJson.basket && reqJson.basket.basketId) || reqJson.basketId || null,
          deliveryName: (reqJson.address && reqJson.address.deliveryServiceName) || null
        };
      }
    } catch (e) { /* noop */ }
    return { basketId: null, deliveryName: null };
  }

  // Proactively fetches the basket ourselves instead of passively waiting for the
  // site to GET it on the checkout page — it doesn't always do so, which is exactly
  // what left some orders without a sum/items and therefore unattributable later.
  // Uses origFetch (the pre-patch reference) so this never recurses into our own
  // wrapper and is always visible as a single, clearly-tagged DEBUG_CAPTURE entry.
  // Never rejects — callers just want "settled", not "succeeded".
  function ensureBasketFresh(orderUrl, basketId) {
    if (!basketId) return null;
    if (basketRefresh[basketId]) return basketRefresh[basketId];

    let u;
    try {
      u = new URL(orderUrl, location.href);
      u.pathname = u.pathname.replace(/\/api\/v1\/orders.*$/, '/pub/v1/basket');
      u.search = '?basketId=' + encodeURIComponent(basketId);
    } catch (e) {
      return null;
    }
    // Only ever fetch our own known site — never follow an unexpected origin.
    if (!/(^|\.)autonovad\.ua$/i.test(u.hostname) || u.protocol !== 'https:') return null;
    const urlStr = u.toString();

    async function attempt(init) {
      const resp = await origFetch.call(window, urlStr, init);
      const t = await resp.text();
      return { resp: resp, text: t };
    }

    const p = (async function () {
      let resp = null, text = '', errMsg = null;
      try {
        const r = await attempt({ method: 'GET', cache: 'no-store' });
        resp = r.resp; text = r.text;
        if (resp.status === 401 || resp.status === 403) {
          const r2 = await attempt({ method: 'GET', cache: 'no-store', credentials: 'include' });
          resp = r2.resp; text = r2.text;
        }
      } catch (e) {
        errMsg = String(e && e.message || e);
      }

      if (resp) {
        const data = tryParseJson(text);
        if (data && data.id === basketId) cacheBasketFromJson(data, 'self');
      }

      try {
        post('DEBUG_CAPTURE', {
          ts: Date.now(),
          url: urlStr,
          method: 'GET',
          status: resp ? resp.status : 0,
          pageUrl: location.href,
          reqBody: null,
          respBody: trunc(text || null),
          respHeaders: null,
          selfFetch: true,
          error: errMsg
        });
      } catch (e) { /* noop */ }
    })();

    p.catch(function () {}).finally(function () { delete basketRefresh[basketId]; });
    basketRefresh[basketId] = p;
    return p;
  }

  function buildOrderCreatedPayload(url, text, reqBody) {
    const data = tryParseJson(text);
    let orderNumber = data ? findOrderNumber(data, 0) : null;
    if (!orderNumber) {
      const m = text.match(ORDER_RE);
      if (m) orderNumber = m[0];
    }
    const orderUuid = (data && (data.orderUuid || data.uuid || data.id)) || null;
    const { basketId, deliveryName } = parseOrderReq(reqBody);

    const basket = basketId ? basketCache[basketId] : null;
    // Flat array of part-codes (jsonb-friendly) for matching against history-row codes.
    const itemCodes = (basket && Array.isArray(basket.items))
      ? basket.items.map(function (it) { return it && it.code ? String(it.code).trim() : null; })
                    .filter(function (c) { return !!c; })
      : null;

    post('ORDER_CREATED', {
      orderNumber: orderNumber || null,
      orderUuid: orderUuid,
      basketId: basketId,
      deliveryName: deliveryName,
      totalSum: basket ? basket.totalSum : null,
      itemsCount: basket ? basket.itemsCount : null,
      items: basket ? basket.items : null,
      itemCodes: (itemCodes && itemCodes.length) ? itemCodes : null,
      currency: basket ? basket.currency : null,
      url: url,
      ts: Date.now()
    });
  }

  function handleResponseText(url, method, text, reqBody, status, respHeaders) {
    // Emit a debug capture for matching domains. Full bodies only for the key
    // endpoints; everything else keeps just metadata (bodyOmitted flag makes the
    // trimming explicit, so an omitted body isn't confused with an empty response).
    if (urlMatchesDebug(url)) {
      const capture = {
        ts: Date.now(),
        url: url,
        method: method,
        status: status,
        pageUrl: location.href
      };
      if (isKeyEndpoint(url)) {
        capture.reqBody = trunc(reqBody || null);
        capture.respBody = trunc(text || null);
        capture.respHeaders = respHeaders || null;
      } else {
        capture.bodyOmitted = true;
      }
      post('DEBUG_CAPTURE', capture);
    }
    if (!text) return;
    if (url.indexOf(BASKET_URL_FRAG) >= 0 && method === 'GET') {
      // Cache basket totals so we can attach them to the next POST /orders.
      cacheBasketFromJson(tryParseJson(text), 'observed');
    } else if (url.indexOf(ORDER_URL_FRAG) >= 0 && method === 'POST') {
      const { basketId } = parseOrderReq(reqBody);
      const pending = basketId ? basketRefresh[basketId] : null;
      if (pending) {
        // Wait for our own in-flight basket fetch (bounded), then build with
        // whatever ended up in basketCache — could be from the self-fetch, or
        // from the site's own traffic if that happened to win the race.
        const timeout = new Promise(function (resolve) { setTimeout(resolve, BASKET_WAIT_MS); });
        Promise.race([pending, timeout]).then(
          function () { buildOrderCreatedPayload(url, text, reqBody); },
          function () { buildOrderCreatedPayload(url, text, reqBody); }
        );
      } else {
        buildOrderCreatedPayload(url, text, reqBody);
      }
    } else if (url.indexOf(PROFILE_URL_FRAG) >= 0) {
      const data = tryParseJson(text);
      if (data) {
        const code = findClientCode(data);
        if (code) post('PROFILE_SEEN', { clientCode: code });
      }
    }
  }

  // ---- Patch fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      let reqBody = null;
      try {
        if (init && init.body != null) {
          reqBody = (typeof init.body === 'string') ? init.body : '[non-string body]';
        }
      } catch (e) { /* noop */ }
      if (String(method).toUpperCase() === 'POST' && url.indexOf(ORDER_URL_FRAG) >= 0) {
        try { ensureBasketFresh(url, parseOrderReq(reqBody).basketId); } catch (e) { /* noop */ }
      }
      const p = origFetch.apply(this, arguments);
      p.then(function (resp) {
        try {
          if (urlMatchesDebug(url)) {
            const headers = {};
            try { resp.headers.forEach(function (v, k) { headers[k] = v; }); } catch (e) { /* noop */ }
            resp.clone().text().then(function (t) {
              handleResponseText(url, String(method).toUpperCase(), t, reqBody, resp.status, headers);
            }).catch(function () { /* noop */ });
          }
        } catch (e) { /* noop */ }
      }).catch(function () { /* noop */ });
      return p;
    };
  }

  // ---- Patch XHR ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ano_method = method;
    this.__ano_url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const url = this.__ano_url || '';
      let reqBody = null;
      if (typeof body === 'string') reqBody = body;
      else if (body != null) reqBody = '[non-string body]';
      if (String(this.__ano_method || '').toUpperCase() === 'POST' && url.indexOf(ORDER_URL_FRAG) >= 0) {
        try { ensureBasketFresh(url, parseOrderReq(reqBody).basketId); } catch (e) { /* noop */ }
      }
      if (urlMatchesDebug(url)) {
        this.addEventListener('load', function () {
          try {
            const hdrRaw = this.getAllResponseHeaders ? this.getAllResponseHeaders() : '';
            const headers = {};
            if (hdrRaw) {
              hdrRaw.split(/\r?\n/).forEach(function (line) {
                const i = line.indexOf(':');
                if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
              });
            }
            handleResponseText(
              url,
              String(this.__ano_method || 'GET').toUpperCase(),
              this.responseText,
              reqBody,
              this.status,
              headers
            );
          } catch (e) { /* noop */ }
        });
      }
    } catch (e) { /* noop */ }
    return origSend.apply(this, arguments);
  };
})();
