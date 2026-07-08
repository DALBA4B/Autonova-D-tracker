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
  // A price/amount token: digits (optionally with thousands spaces) ending in a
  // decimal separator + 1-2 fraction digits. E.g. "13650.48", "4 793,64", "1267.5".
  const PRICE_LIKE_RE = /^\d[\d\s]*[.,]\d{1,2}$/;
  function looksLikePartCode(s) {
    if (!s) return false;
    s = s.trim();
    if (s.length < 3 || s.length > 32) return false;
    if (!PART_CODE_RE.test(s)) return false;
    if (!/\d/.test(s)) return false;          // must have a digit
    if (/^[\d\s.,-]+$/.test(s)) return false; // pure number/price → not a code
    return true;
  }

  // Relaxed check for a code taken from the product-link <a> in the code column.
  // That cell is structurally the artikul, so pure-numeric codes are valid here
  // (many real codes are all digits: 890173, 707919350, 77555610). We still reject
  // price-like tokens as a safety net, though prices never live inside this <a>.
  function looksLikePartCodeFromLink(s) {
    if (!s) return false;
    s = s.trim();
    if (s.length < 3 || s.length > 32) return false;
    if (!PART_CODE_RE.test(s)) return false;
    if (!/\d/.test(s)) return false;          // must have a digit
    if (PRICE_LIKE_RE.test(s)) return false;  // guard against a stray price
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
      if (looksLikePartCodeFromLink(t)) return t;
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

  // True only if EVERY item in this order has a status from `statusList`.
  // Returns false when there are no item rows, the list is empty, or any row's
  // status isn't in the list — safer to keep the order visible than to hide one
  // the user still needs.
  function isOrderFullyInStatuses(headerTr, statusList) {
    if (!statusList || statusList.length === 0) return false;
    const rows = getItemRows(headerTr);
    if (!rows || rows.length === 0) return false;
    for (let i = 0; i < rows.length; i++) {
      if (statusList.indexOf(getItemStatus(rows[i])) < 0) return false;
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
    chrome.storage.local.get(['hidePickedOrders', 'hideStatuses', 'filterByName', 'filterNameTarget'], function (obj) {
      var hidePicked = !!(obj && obj.hidePickedOrders);
      // Which item statuses count as "picked". Defaults to ['ЗС'] for installs
      // upgraded from before the setting existed.
      var hideStatuses = (obj && Array.isArray(obj.hideStatuses)) ? obj.hideStatuses : ['ЗС'];
      var filterName = !!(obj && obj.filterByName);
      var nameTarget = (obj && obj.filterNameTarget) || '';
      var rows = collectOrderRows();
      var hiddenByPicked = 0;
      var hiddenByName = 0;
      rows.forEach(function (row) {
        if (!row.tr) return;
        // Picked filter: hide if ALL items are in one of the selected statuses.
        if (hidePicked && isOrderFullyInStatuses(row.tr, hideStatuses)) {
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
        hidePicked: hidePicked, hideStatuses: hideStatuses, filterName: filterName, nameTarget: nameTarget,
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

  // ---------- Floating control panel (history page) ----------
  // A fixed panel pinned to the right edge with the same filters as the popup's
  // "Функції" tab: hide-picked (+ status chips) and name filter. It reads/writes
  // the SAME chrome.storage keys as the popup, so the two stay in sync live via
  // the storage.onChanged listener below — no extra messaging needed.
  const PANEL_ID = 'ano-control-panel';
  const PANEL_STATUS_VALUES = ['ЗС', 'ЗО', 'ЗОП'];

  function injectPanelStyles() {
    if (document.getElementById('ano-panel-style')) return;
    const style = document.createElement('style');
    style.id = 'ano-panel-style';
    style.textContent = `
      #${PANEL_ID} {
        position: fixed; top: 90px;
        z-index: 2147483000; box-sizing: border-box;
        background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
        box-shadow: 0 4px 18px rgba(0,0,0,.14);
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        font-size: 12px; color: #1e293b;
        user-select: none; -webkit-user-select: none;
      }
      #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID} .ano-p-head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 6px; padding: 6px 8px;
      }
      #${PANEL_ID} .ano-p-title {
        font-weight: 700; font-size: 10px; letter-spacing: .04em;
        text-transform: uppercase; color: #64748b; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis;
      }
      #${PANEL_ID} .ano-p-toggle {
        flex: none; border: none; background: #f1f5f9; border-radius: 6px;
        width: 20px; height: 20px; line-height: 18px; text-align: center;
        cursor: pointer; color: #475569; font-size: 14px; padding: 0;
      }
      #${PANEL_ID} .ano-p-toggle:hover { background: #e2e8f0; }
      #${PANEL_ID} .ano-p-body { padding: 0 8px 8px; }
      #${PANEL_ID} .ano-p-section { margin-bottom: 9px; }
      #${PANEL_ID} .ano-p-section:last-child { margin-bottom: 0; }
      #${PANEL_ID} .ano-p-row {
        display: flex; align-items: center; gap: 7px; font-weight: 600; cursor: pointer;
        line-height: 1.25;
      }
      #${PANEL_ID} .ano-p-row input { cursor: pointer; margin: 0; flex: none; }
      #${PANEL_ID} .ano-p-chips {
        display: flex; gap: 5px; flex-wrap: wrap; margin: 6px 0 0 22px;
      }
      #${PANEL_ID} .ano-p-chips.disabled { opacity: .4; pointer-events: none; }
      #${PANEL_ID} .ano-p-chip {
        display: inline-flex; align-items: center; gap: 3px;
        background: #f1f5f9; border-radius: 7px; padding: 2px 6px;
        font-size: 11px; font-weight: 600; cursor: pointer;
      }
      #${PANEL_ID} .ano-p-chip input { margin: 0; cursor: pointer; }
      #${PANEL_ID} select {
        width: 100%; margin-top: 6px; padding: 4px 5px;
        border: 1px solid #cbd5e1; border-radius: 7px;
        font-size: 12px; background: #fff; color: #1e293b;
      }
      #${PANEL_ID} select:disabled { opacity: .5; }
      /* Collapsed: hide title + body, leaving only the toggle as a small tab. */
      #${PANEL_ID}.ano-collapsed { width: auto !important; }
      #${PANEL_ID}.ano-collapsed .ano-p-title,
      #${PANEL_ID}.ano-collapsed .ano-p-body { display: none; }
      #${PANEL_ID}.ano-collapsed .ano-p-head { padding: 5px; }
    `;
    document.head.appendChild(style);
  }

  // Read the checked status chips inside the panel.
  function readPanelStatuses(panel) {
    const out = [];
    panel.querySelectorAll('.ano-p-status').forEach(function (cb) {
      if (cb.checked) out.push(cb.value);
    });
    return out;
  }

  // Reflect current storage state into the panel UI (used on build and whenever
  // the popup changes a key). Setting .checked programmatically does NOT fire
  // 'change', so this never loops back into a storage write.
  function syncPanelFromStorage() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    chrome.storage.local.get(['hidePickedOrders', 'hideStatuses', 'filterByName', 'filterNameTarget'], function (obj) {
      const picked = !!(obj && obj.hidePickedOrders);
      const statuses = (obj && Array.isArray(obj.hideStatuses)) ? obj.hideStatuses : ['ЗС'];
      const filterName = !!(obj && obj.filterByName);
      const target = (obj && obj.filterNameTarget) || '';

      panel.querySelector('#ano-p-picked').checked = picked;
      panel.querySelector('#ano-p-chips').classList.toggle('disabled', !picked);
      panel.querySelectorAll('.ano-p-status').forEach(function (cb) {
        cb.checked = statuses.indexOf(cb.value) >= 0;
      });

      const nameSel = panel.querySelector('#ano-p-name-select');
      panel.querySelector('#ano-p-namefilter').checked = filterName;
      nameSel.disabled = !filterName;
      nameSel.value = target;
    });
  }

  // Fill the name dropdown from the local name cache (same source the popup uses),
  // preserving the currently-selected target.
  function populatePanelNames() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const nameSel = panel.querySelector('#ano-p-name-select');
    chrome.storage.local.get([CACHE_KEY, 'filterNameTarget'], function (obj) {
      const cache = (obj && obj[CACHE_KEY]) || {};
      const names = [];
      const seen = Object.create(null);
      for (const key in cache) {
        const e = cache[key];
        if (e && e.name && !seen[e.name]) { seen[e.name] = 1; names.push({ name: e.name, color: e.color || null }); }
      }
      names.sort(function (a, b) { return a.name.localeCompare(b.name); });

      const target = (obj && obj.filterNameTarget) || '';
      nameSel.innerHTML = '<option value="">— оберіть —</option>';
      names.forEach(function (n) {
        const opt = document.createElement('option');
        opt.value = n.name;
        opt.textContent = n.name;
        if (n.color) opt.style.color = n.color;
        nameSel.appendChild(opt);
      });
      nameSel.value = target;
    });
  }

  // Adaptive placement: find the empty gutter beside the orders table and park
  // the panel there so it never overlaps content. Picks the wider gutter (ties
  // go left), fits the panel width to it, and pins to the viewport edge if the
  // gutter is too narrow. Recomputed on load, resize and collapse/expand.
  const PANEL_MIN_W = 150;   // below this the panel would be unusable → pin to edge
  const PANEL_MAX_W = 230;   // never grow wider than this even in a huge gutter
  const PANEL_GAP = 10;      // breathing room from the table / viewport edge

  function findOrdersTableRect() {
    // `tr.table-item` matches BOTH top-level order rows AND item rows inside the
    // detail popups (table.items-list tr.table-item). The popup tables are narrow
    // and centered, so anchoring on the first match can place the panel in the
    // middle. Instead scan all tables holding such rows and pick the WIDEST one —
    // that's the full-width orders table.
    const rows = document.querySelectorAll('tr.table-item');
    let best = null;
    const seen = new Set();
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i].closest('table');
      if (!t || seen.has(t)) continue;
      seen.add(t);
      const r = t.getBoundingClientRect();
      // Skip hidden tables (closed detail popups report 0 size). Among the visible
      // ones the widest is the full-width orders table — narrow/centered popups
      // never win, so we don't need fragile id/class exclusions.
      if (!r.width || !r.height) continue;
      if (!best || r.width > best.width) best = r;
    }
    return best;
  }

  function positionPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const vw = document.documentElement.clientWidth;
    const rect = findOrdersTableRect();

    // Collapsed panel is tiny — just pin it to the right edge, no measuring.
    if (panel.classList.contains('ano-collapsed')) {
      panel.style.width = 'auto';
      panel.style.right = PANEL_GAP + 'px';
      panel.style.left = 'auto';
      return;
    }

    // Always dock to the RIGHT edge (top-right). Width fits the free space beside
    // the table: capped at PANEL_MAX_W, and never wider than the gutter minus the
    // gap — so the panel can NEVER overlap the "Сума" column. On a genuinely tiny
    // gutter it just gets narrow (floored at PANEL_MIN_W for readability).
    panel.style.left = 'auto';
    panel.style.right = PANEL_GAP + 'px';
    const rightGutter = rect ? (vw - rect.right) : vw;
    let width = Math.min(PANEL_MAX_W, rightGutter - PANEL_GAP * 2);
    if (width < PANEL_MIN_W) width = PANEL_MIN_W;
    panel.style.width = width + 'px';
  }

  // Reposition on viewport changes (debounced via rAF to avoid thrashing).
  var _posRaf = 0;
  function schedulePosition() {
    if (_posRaf) return;
    _posRaf = requestAnimationFrame(function () { _posRaf = 0; positionPanel(); });
  }

  // Build the panel once and wire its controls to storage.
  function buildControlPanel() {
    if (document.getElementById(PANEL_ID)) return;
    if (!document.body) return;
    injectPanelStyles();

    const chipsHtml = PANEL_STATUS_VALUES.map(function (s) {
      return '<label class="ano-p-chip"><input type="checkbox" class="ano-p-status" value="' + s + '">' + s + '</label>';
    }).join('');

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML =
      '<div class="ano-p-head">' +
        '<span class="ano-p-title">Autonova · фільтри</span>' +
        '<button class="ano-p-toggle" id="ano-p-toggle" title="Згорнути/розгорнути">–</button>' +
      '</div>' +
      '<div class="ano-p-body">' +
        '<div class="ano-p-section">' +
          '<label class="ano-p-row"><input type="checkbox" id="ano-p-picked">Сховати замовлення</label>' +
          '<div class="ano-p-chips" id="ano-p-chips">' + chipsHtml + '</div>' +
        '</div>' +
        '<div class="ano-p-section">' +
          '<label class="ano-p-row"><input type="checkbox" id="ano-p-namefilter">Фільтр по замовнику</label>' +
          '<select id="ano-p-name-select" disabled><option value="">— оберіть —</option></select>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);

    const pickedCb = panel.querySelector('#ano-p-picked');
    const nameCb = panel.querySelector('#ano-p-namefilter');
    const nameSel = panel.querySelector('#ano-p-name-select');
    const toggleBtn = panel.querySelector('#ano-p-toggle');

    // Collapse / expand, persisted so it stays the user's choice across reloads.
    // Reposition on the NEXT frame (via schedulePosition), not synchronously —
    // right after toggling the class the browser hasn't reflowed the panel yet,
    // so an immediate measure reads stale geometry and mis-places the panel.
    function applyCollapsed(collapsed) {
      panel.classList.toggle('ano-collapsed', collapsed);
      toggleBtn.textContent = collapsed ? '☰' : '–';
      schedulePosition();
    }
    toggleBtn.addEventListener('click', function () {
      const nowCollapsed = !panel.classList.contains('ano-collapsed');
      chrome.storage.local.set({ panelCollapsed: nowCollapsed });
      applyCollapsed(nowCollapsed);
    });
    chrome.storage.local.get(['panelCollapsed'], function (obj) {
      applyCollapsed(!!(obj && obj.panelCollapsed));
    });

    pickedCb.addEventListener('change', function () {
      const enabled = pickedCb.checked;
      // Enabling with nothing checked would hide nothing — seed with ЗС.
      if (enabled && readPanelStatuses(panel).length === 0) {
        panel.querySelectorAll('.ano-p-status').forEach(function (cb) {
          if (cb.value === 'ЗС') cb.checked = true;
        });
      }
      chrome.storage.local.set({ hidePickedOrders: enabled, hideStatuses: readPanelStatuses(panel) });
    });

    panel.querySelectorAll('.ano-p-status').forEach(function (cb) {
      cb.addEventListener('change', function () {
        chrome.storage.local.set({ hideStatuses: readPanelStatuses(panel) });
      });
    });

    nameCb.addEventListener('change', function () {
      const enabled = nameCb.checked;
      chrome.storage.local.set({
        filterByName: enabled,
        filterNameTarget: enabled ? nameSel.value : ''
      });
    });

    nameSel.addEventListener('change', function () {
      chrome.storage.local.set({ filterNameTarget: nameSel.value });
    });

    syncPanelFromStorage();
    populatePanelNames();

    // Initial placement + keep it correct as the window resizes. positionPanel is
    // also called by applyCollapsed (fired right after this by the collapse-state
    // loader above).
    positionPanel();
    // Recompute ONLY on genuine viewport changes and once the page has settled —
    // NOT on content reflow. Tying placement to reflow (e.g. a ResizeObserver) made
    // the panel resize every time filters hid/showed orders (scrollbar appears →
    // clientWidth changes), so its shape jittered on each toggle. The site lays out
    // the history table slightly after our first measure, so we re-place on `load`
    // and via two short timeouts to catch that initial settle, then stay static.
    window.addEventListener('resize', schedulePosition);
    window.addEventListener('load', schedulePosition);
    setTimeout(schedulePosition, 400);
    setTimeout(schedulePosition, 1200);
  }

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
    buildControlPanel();
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
      populatePanelNames();

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
          populatePanelNames();
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
  var FILTER_KEYS = ['hidePickedOrders', 'hideStatuses', 'filterByName', 'filterNameTarget'];

  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local') return;
    if (!isHistoryPage()) return;
    var relevant = false;
    for (var i = 0; i < FILTER_KEYS.length; i++) {
      if (changes[FILTER_KEYS[i]]) { relevant = true; break; }
    }
    if (relevant) {
      applyAllFilters();
      // Keep the on-page panel in step with changes made from the popup.
      syncPanelFromStorage();
    }
    // Refresh the panel's name dropdown when the name cache grows.
    if (changes[CACHE_KEY]) populatePanelNames();
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
