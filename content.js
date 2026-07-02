// Runs in the ISOLATED world on every autonovad.ua page at document_start.
// Responsibilities:
//   1. Inject inject.js into the PAGE world so it can patch fetch/XHR before the SPA loads.
//   2. Listen for window.postMessage from inject.js and forward to background.
//   3. Detect client code (48320) from .user-name in old-site header.
//   4. On orders-history page (id=27), find ЗК-... numbers, request names from Supabase, render badges.

(function () {
  const CFG = (self.ANO_CFG || window.ANO_CFG);
  if (!CFG) { console.warn('[ANO] config missing'); return; }
  const NS = CFG.MSG_NS;

  // In-memory name map populated during processHistoryPage (cache + Supabase).
  // Used by the name filter to decide visibility without re-reading storage.
  var _nameMap = null;

  // ---------- 1. Inject page-world script ----------
  // Pass shared constants via data-* attributes: config.js is unavailable in
  // the page world, so inject.js reads them from its own <script> tag.
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject.js');
    s.async = false;
    s.dataset.ns = NS;
    s.dataset.orderRe = CFG.ORDER_NUMBER_REGEX.source;
    (document.head || document.documentElement).appendChild(s);
    s.onload = function () { s.remove(); };
  } catch (e) {
    console.warn('[ANO] inject failed', e);
  }

  // ---------- 2. Bridge window.postMessage -> chrome.runtime ----------
  window.addEventListener('message', function (ev) {
    if (!ev.data || ev.data.ns !== NS) return;
    const kind = ev.data.kind;
    const payload = ev.data.payload || {};
    if (kind === 'ORDER_CREATED') {
      chrome.runtime.sendMessage({ type: 'ORDER_CREATED', payload: payload });
    } else if (kind === 'PROFILE_SEEN') {
      chrome.runtime.sendMessage({ type: 'PROFILE_SEEN', payload: payload });
    } else if (kind === 'DEBUG_CAPTURE') {
      chrome.runtime.sendMessage({ type: 'DEBUG_CAPTURE', payload: payload });
    }
  }, false);

  // ---------- 3. Detect client code from DOM (old site header) ----------
  function detectClientCodeFromDom() {
    const el = document.querySelector('.user-name');
    if (!el) return null;
    const m = (el.textContent || '').match(/\((\d{4,6})\)/);
    return m ? m[1] : null;
  }

  function reportDomClientCode() {
    const code = detectClientCodeFromDom();
    if (code) {
      chrome.runtime.sendMessage({ type: 'PROFILE_SEEN', payload: { clientCode: code, source: 'dom' } });
    }
  }

  // ---------- 4. History-page badges ----------
  function isHistoryPage() {
    return location.href.indexOf(CFG.HISTORY_URL_FRAGMENT) >= 0;
  }

  // Find a span inside `cell` whose text matches `re` and return the matched string.
  function findInCell(cell, re) {
    if (!cell) return null;
    const spans = cell.querySelectorAll('span');
    for (const sp of spans) {
      const txt = (sp.textContent || '').trim();
      const m = txt.match(re);
      if (m) return m[0];
    }
    // Fallback: cell textContent
    const m2 = (cell.textContent || '').trim().match(re);
    return m2 ? m2[0] : null;
  }

  // Items for an order live in a hidden popup <div id="d_N">, opened by a button
  // <a id="but_d_N" href="#d_N"> inside the order row. The popup contains
  // <table class="items-list"> with one <tr class="table-item"> per ordered item.
  function findItemsPopupForOrder(headerTr) {
    const trigger = headerTr.querySelector('a[id^="but_d_"][href^="#"]');
    if (!trigger) return null;
    const id = (trigger.getAttribute('href') || '').slice(1);
    return id ? document.getElementById(id) : null;
  }

  function getItemRows(headerTr) {
    const popup = findItemsPopupForOrder(headerTr);
    if (!popup) return null;
    const rows = popup.querySelectorAll('table.items-list tr.table-item');
    return rows.length ? rows : null;
  }

  // Number of ordered items in this order. Null if popup/table missing.
  function countItemsForOrder(headerTr) {
    const rows = getItemRows(headerTr);
    return rows ? rows.length : null;
  }

  // Loose part-code matcher: 3+ chars, alphanumeric (digits, letters, dot, dash, slash),
  // contains at least one digit, no whitespace, max 32 chars. Excludes obvious price/qty
  // tokens (no decimal commas/dots-only). Examples: 3315001, GV0310, 076510005, N91153201.
  const PART_CODE_RE = /^[A-Z0-9][A-Z0-9./-]{2,31}$/i;
  function looksLikePartCode(s) {
    if (!s) return false;
    s = s.trim();
    if (s.length < 3 || s.length > 32) return false;
    if (!PART_CODE_RE.test(s)) return false;
    if (!/\d/.test(s)) return false;          // must have a digit
    if (/^[\d\s.,-]+$/.test(s)) return false; // pure number/price → not a code
    return true;
  }

  // Extract the part code from a single item-row inside the popup's items-list.
  // The first <td> holds the code, usually wrapped in <a>. Fallback: first non-empty
  // token in the cell, skipping the mobile-only heading span.
  function extractCodeFromItemRow(itemTr) {
    const firstTd = itemTr.querySelector(':scope > td');
    if (!firstTd) return null;
    const a = firstTd.querySelector('a');
    if (a) {
      const t = (a.textContent || '').trim();
      if (looksLikePartCode(t)) return t;
    }
    const spans = firstTd.querySelectorAll(':scope > span');
    for (const sp of spans) {
      if (sp.classList && sp.classList.contains('catalogue-list-mob-heading')) continue;
      const tok = ((sp.textContent || '').trim().split(/\s+/)[0]) || '';
      if (looksLikePartCode(tok)) return tok;
    }
    return null;
  }

  // Deduped array of part codes for this order, or null if the popup is missing.
  function collectItemCodesForOrder(headerTr) {
    const rows = getItemRows(headerTr);
    if (!rows) return null;
    const codes = [];
    const seen = Object.create(null);
    rows.forEach(function (itr) {
      const code = extractCodeFromItemRow(itr);
      if (code && !seen[code]) { seen[code] = 1; codes.push(code); }
    });
    return codes.length ? codes : null;
  }

  function collectOrderRows() {
    const rows = document.querySelectorAll('tr.table-item');
    const out = [];
    rows.forEach(function (tr) {
      const tds = tr.querySelectorAll(':scope > td');
      if (tds.length === 0) return;

      // td[0] — order number
      let number = null;
      let targetSpan = null;
      const spans = tds[0].querySelectorAll('span');
      for (let i = spans.length - 1; i >= 0; i--) {
        const m = (spans[i].textContent || '').trim().match(CFG.ORDER_NUMBER_REGEX);
        if (m) { number = m[0]; targetSpan = spans[i]; break; }
      }
      if (!number) return;

      // td[1] — date dd/mm/yyyy
      const date = findInCell(tds[1], /\d{1,2}[./]\d{1,2}[./]\d{4}/);

      // td with class text-right — sum (decimal number)
      let sumCell = tr.querySelector(':scope > td.text-right');
      let sumStr = sumCell ? findInCell(sumCell, /-?\d+[.,]?\d*/) : null;
      let sum = null;
      if (sumStr) {
        const cleaned = sumStr.replace(/\s/g, '').replace(',', '.');
        const v = parseFloat(cleaned);
        if (!isNaN(v)) sum = v;
      }

      // Number of items in this order — used as tiebreaker in tolerance match.
      const itemsCount = countItemsForOrder(tr);
      // Catalogue codes of items — used as primary disambiguator when sums collide.
      const itemCodes = collectItemCodesForOrder(tr);

      out.push({ number, date, sum, itemsCount, itemCodes, targetSpan, tr: tr });
    });
    return out;
  }

  // Status text of one item-row inside a detail popup. The last <td> holds the
  // status, wrapped as <span><div title="...">ЗС</div></span>. We read the <div>
  // text rather than the cell's textContent to skip the mobile-only "Статус"
  // heading span. Returns null if the status cell can't be found.
  function getItemStatus(itemTr) {
    const tds = itemTr.querySelectorAll(':scope > td');
    if (tds.length === 0) return null;
    const statusTd = tds[tds.length - 1];
    const div = statusTd.querySelector('div');
    if (div) return (div.textContent || '').trim();
    return (statusTd.textContent || '').trim() || null;
  }

  // True only if EVERY item in this order has status "ЗС". Returns false when
  // there are no item rows or any row's status isn't ЗС — safer to keep the
  // order visible than to hide one the user still needs.
  function isOrderFullyPicked(headerTr) {
    const rows = getItemRows(headerTr);
    if (!rows || rows.length === 0) return false;
    for (let i = 0; i < rows.length; i++) {
      if (getItemStatus(rows[i]) !== 'ЗС') return false;
    }
    return true;
  }

  // ---------- Filter: hide fully-picked orders ----------
  // An order is hidden only when all of its items are "ЗС". Toggling the setting
  // off restores visibility, so it's safe to flip on the fly.
  // Shared helper: hide / show all DOM elements that belong to one order row
  // (the <tr> itself, <div id="head_N">, <div id="d_N">).
  function setOrderVisible(tr, visible) {
    if (!tr) return;
    tr.style.display = visible ? '' : 'none';
    var trigger = tr.querySelector('a[id^="but_d_"][href^="#"]');
    var popupId = trigger ? (trigger.getAttribute('href') || '').slice(1) : null;
    if (!popupId) return;
    var headId = popupId.replace(/^d_(\d+)$/, 'head_$1');
    var headEl = document.getElementById(headId);
    var popupEl = document.getElementById(popupId);
    if (headEl) headEl.style.display = visible ? '' : 'none';
    if (popupEl) popupEl.style.display = visible ? '' : 'none';
  }

  // Read the cached name for a given order number. Returns null if unknown.
  function getCachedName(orderNumber) {
    // Synchronous lookup from the in-memory snapshot populated by processHistoryPage.
    // If the badge hasn't been rendered yet the cache entry may not exist — that's OK,
    // we treat it as "name unknown → don't hide".
    var badge = null;
    if (orderNumber && _nameMap) badge = _nameMap[orderNumber];
    return badge ? (badge.name || null) : null;
  }

  // ---------- Combined visibility filter ----------
  // Both conditions (picked + name) are checked in a single pass so they
  // don't overwrite each other. An order is visible only if it passes ALL
  // active filters.
  function applyAllFilters() {
    chrome.storage.local.get(['hidePickedOrders', 'filterByName', 'filterNameTarget'], function (obj) {
      var hidePicked = !!(obj && obj.hidePickedOrders);
      var filterName = !!(obj && obj.filterByName);
      var nameTarget = (obj && obj.filterNameTarget) || '';
      var rows = collectOrderRows();
      var hiddenByPicked = 0;
      var hiddenByName = 0;
      rows.forEach(function (row) {
        if (!row.tr) return;
        // Picked filter: hide if ALL items are ЗС
        if (hidePicked && isOrderFullyPicked(row.tr)) {
          setOrderVisible(row.tr, false);
          hiddenByPicked++;
          return;
        }
        // Name filter: hide if name doesn't match
        if (filterName && nameTarget) {
          var name = getCachedName(row.number);
          if (name !== nameTarget) {
            setOrderVisible(row.tr, false);
            hiddenByName++;
            return;
          }
        }
        // Passed all filters — show
        setOrderVisible(row.tr, true);
      });
      clog('filters-applied', {
        hidePicked: hidePicked, filterName: filterName, nameTarget: nameTarget,
        total: rows.length, hiddenByPicked: hiddenByPicked, hiddenByName: hiddenByName
      });
    });
  }

  // Deterministic fallback color from a name (when DB has no color set).
  function nameToColor(name) {
    const palette = ['#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#06b6d4','#3b82f6','#6366f1','#a855f7','#ec4899','#64748b','#84cc16'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  function renderBadge(span, name, color) {
    if (!span) return;
    const tr = span.closest('tr');
    if (!tr || tr.querySelector('.' + CFG.BADGE_CLASS)) return;
    const cs = getComputedStyle(span);
    if (cs.position === 'static') span.style.position = 'relative';
    const badge = document.createElement('span');
    badge.className = CFG.BADGE_CLASS;
    badge.textContent = name;
    badge.title = 'Замовив: ' + name;
    const bg = color || nameToColor(name);
    badge.style.backgroundColor = bg;
    badge.style.color = '#fff';
    span.appendChild(badge);
  }

  function injectBadgeStyles() {
    if (document.getElementById('ano-badge-style')) return;
    const style = document.createElement('style');
    style.id = 'ano-badge-style';
    style.textContent = `
      .${CFG.BADGE_CLASS} {
        position: absolute;
        right: calc(100% + 80px);
        top: 50%;
        transform: translateY(-50%);
        font-size: 13px;
        font-weight: 600;
        color: #fff;
        background: #64748b;
        padding: 2px 10px;
        border-radius: 10px;
        white-space: nowrap;
        pointer-events: none;
        box-shadow: 0 1px 2px rgba(0,0,0,.12);
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
      }
      .${CFG.BADGE_CLASS}::selection { background: transparent; color: #fff; }
      .${CFG.BADGE_CLASS}::-moz-selection { background: transparent; color: #fff; }
    `;
    document.head.appendChild(style);
  }

  // Diagnostic logger — sends to background, which writes to debugLog.
  function clog(event, data) {
    try {
      chrome.runtime.sendMessage({ type: 'CONTENT_LOG', payload: { event: event, data: data || null, url: location.href } });
    } catch (e) { /* noop */ }
  }

  // Local cache key in chrome.storage.local — flat map { "ЗК-12345": "Андрей" }.
  const CACHE_KEY = 'orderNameCache';
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  // Stamp: { number: { name, ts } } stored under CACHE_KEY.

  function processHistoryPage() {
    const onHistory = isHistoryPage();
    clog('process-history-entry', { onHistory: onHistory, href: location.href, fragment: CFG.HISTORY_URL_FRAGMENT });
    if (!onHistory) return;
    const code = detectClientCodeFromDom();
    if (code && code !== CFG.EXPECTED_CLIENT_CODE) {
      clog('process-history-skip-mismatch', { code: code, expected: CFG.EXPECTED_CLIENT_CODE });
      return;
    }

    const rows = collectOrderRows();
    clog('process-history-rows-parsed', { rowCount: rows.length, sample: rows[0] ? { number: rows[0].number, date: rows[0].date, sum: rows[0].sum } : null });
    if (rows.length === 0) return;
    console.log('[ANO] history rows parsed:', rows.length);

    injectBadgeStyles();
    autoExpandIfEnabled();
    // Picked filter doesn't depend on _nameMap, so run it now.
    // Name filter will be re-run after _nameMap is populated (Step A + Step B).
    applyAllFilters();

    // In-memory name map for the name filter: { "ЗК-12345": { name, color } }.
    // Populated first from cache (Step A), then updated from Supabase (Step B).
    _nameMap = Object.create(null);

    // Step A: render from local cache instantly (no network).
    chrome.storage.local.get([CACHE_KEY], function (obj) {
      const cache = (obj && obj[CACHE_KEY]) || {};
      const now = Date.now();
      let renderedFromCache = 0;
      rows.forEach(function (row) {
        const e = cache[row.number];
        if (e && e.name && e.ts && (now - e.ts) < CACHE_TTL_MS) {
          renderBadge(row.targetSpan, e.name, e.color || null);
          _nameMap[row.number] = { name: e.name, color: e.color || null };
          renderedFromCache++;
        }
      });
      if (renderedFromCache > 0) console.log('[ANO] rendered', renderedFromCache, 'badges from cache');

      // Name filter depends on _nameMap — run all filters again now that cache is loaded.
      applyAllFilters();

      // Step B: ask background to claim unattributed + refresh known names.
      const rowsPayload = rows.map(function (r) {
        return { number: r.number, date: r.date, sum: r.sum, itemsCount: r.itemsCount, itemCodes: r.itemCodes };
      });

      chrome.runtime.sendMessage(
        { type: 'CLAIM_HISTORY', payload: { rows: rowsPayload } },
        function (resp) {
          if (chrome.runtime.lastError) {
            console.warn('[ANO] CLAIM_HISTORY error', chrome.runtime.lastError.message);
            return;
          }
          // CLAIM_HISTORY returns a unified nameMap = existing-in-orders + newly-claimed.
          if (!resp || !resp.ok || !resp.nameMap) return;

          const updated = Object.assign({}, cache);
          let added = 0;
          rows.forEach(function (row) {
            const entry = resp.nameMap[row.number];
            if (entry && entry.name) {
              const tr = row.targetSpan.closest('tr');
              if (!tr || !tr.querySelector('.' + CFG.BADGE_CLASS)) {
                renderBadge(row.targetSpan, entry.name, entry.color || null);
                added++;
              }
              updated[row.number] = { name: entry.name, color: entry.color || null, ts: Date.now() };
              _nameMap[row.number] = { name: entry.name, color: entry.color || null };
            }
          });
          chrome.storage.local.set({ [CACHE_KEY]: updated });
          if (added > 0) console.log('[ANO] rendered', added, 'new badges from Supabase');

          // Re-run all filters now that _nameMap is fully populated.
          applyAllFilters();
        }
      );
    });
  }

  // ---------- Auto-expand orders on history page ----------
  // The site's #showAll button simply removes the `mfp-hide` class from every
  // detail popup (div[id*='d_']). We use that as the success signal: after
  // clicking we count `div[id^='d_']:not(.mfp-hide)`; if it's still 0 the
  // handler wasn't ready yet, so we retry with backoff.
  function countExpandedPopups() {
    return document.querySelectorAll("div[id^='d_']:not(.mfp-hide)").length;
  }

  function clickShowAllWithRetry() {
    // Already expanded (user did it manually, or a prior run) — nothing to do.
    if (countExpandedPopups() > 0) {
      clog('auto-expand-already-expanded', { count: countExpandedPopups() });
      return;
    }

    const MAX_ATTEMPTS = 10;
    let attempt = 0;

    function run(delay) {
      attempt++;
      const btn = document.querySelector('input#showAll');
      if (!btn) {
        // Button not in the DOM yet — keep waiting until the last attempt.
        if (attempt < MAX_ATTEMPTS) {
          setTimeout(function () { run(delay * 1.6); }, delay);
        } else {
          clog('auto-expand-giveup', { reason: 'no-btn', attempts: attempt });
          console.log('[ANO] auto-expand: #showAll not found after', attempt, 'attempts');
        }
        return;
      }

      btn.click();
      // The site's jQuery handler removes `mfp-hide` synchronously on click,
      // but yield a paint cycle before checking so any deferred work settles.
      requestAnimationFrame(function () {
        const n = countExpandedPopups();
        if (n > 0) {
          clog('auto-expand-success', { count: n, attempts: attempt });
          console.log('[ANO] auto-expand: ok on attempt', attempt, '(' + n + ' popups)');
        } else if (attempt < MAX_ATTEMPTS) {
          setTimeout(function () { run(delay * 1.6); }, delay); // backoff ~50→80→128→204…
        } else {
          clog('auto-expand-giveup', { reason: 'no-effect', attempts: attempt });
          console.log('[ANO] auto-expand: gave up after', attempt, 'attempts');
        }
      });
    }

    run(50);
  }

  function autoExpandIfEnabled() {
    chrome.storage.local.get(['autoExpand', 'autoExpandMode'], function (obj) {
      let enabled = !!(obj && obj.autoExpand);
      // Migrate the legacy three-way setting once: click/dom → on, none → off.
      if (obj && obj.autoExpandMode !== undefined && obj.autoExpand === undefined) {
        enabled = (obj.autoExpandMode === 'click' || obj.autoExpandMode === 'dom');
      }
      chrome.storage.local.set({ autoExpand: enabled });
      chrome.storage.local.remove('autoExpandMode');

      if (enabled) clickShowAllWithRetry();
    });
  }

  // ---------- Live filter updates ----------
  // React instantly when the user toggles a filter in the popup — no page reload.
  // Intentionally does NOT react to autoExpand changes (that requires a reload).
  var FILTER_KEYS = ['hidePickedOrders', 'filterByName', 'filterNameTarget'];

  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local') return;
    var relevant = false;
    for (var i = 0; i < FILTER_KEYS.length; i++) {
      if (changes[FILTER_KEYS[i]]) { relevant = true; break; }
    }
    if (!relevant) return;
    if (!isHistoryPage()) return;
    applyAllFilters();
  });

  // ---------- Boot ----------
  function boot() {
    clog('content-boot', { href: location.href, readyState: document.readyState });
    reportDomClientCode();
    processHistoryPage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
