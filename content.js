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

  // ---------- 1. Inject page-world script ----------
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject.js');
    s.async = false;
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

      out.push({ number, date, sum, itemsCount, itemCodes, targetSpan });
    });
    return out;
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

    // Step A: render from local cache instantly (no network).
    chrome.storage.local.get([CACHE_KEY], function (obj) {
      const cache = (obj && obj[CACHE_KEY]) || {};
      const now = Date.now();
      let renderedFromCache = 0;
      rows.forEach(function (row) {
        const e = cache[row.number];
        if (e && e.name && e.ts && (now - e.ts) < CACHE_TTL_MS) {
          renderBadge(row.targetSpan, e.name, e.color || null);
          renderedFromCache++;
        }
      });
      if (renderedFromCache > 0) console.log('[ANO] rendered', renderedFromCache, 'badges from cache');

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
          // Saves a follow-up LOOKUP_ORDERS round-trip.
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
            }
          });
          chrome.storage.local.set({ [CACHE_KEY]: updated });
          if (added > 0) console.log('[ANO] rendered', added, 'new badges from Supabase');
        }
      );
    });
  }

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
