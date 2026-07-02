// Service worker (MV3). Handles communication with Supabase REST API and message routing.
// Loads shared config via importScripts.
try { importScripts('config.js'); } catch (e) { console.warn('[ANO bg] config load failed', e); }

const CFG = self.ANO_CFG;

// In-memory cache (reset on SW restart, that's fine — DOM/profile will re-emit)
let lastClientCode = null;

// ---------- bg-side logger ----------
// Writes are serialized through a single promise chain to avoid the read-modify-write
// race when many RPCs log concurrently (storage.local is async; without serialization,
// concurrent writers overwrite each other and we lose ~half the entries).
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LOG_HARD_CAP = 10000;                        // safety ceiling per write
let _logChain = Promise.resolve();
function pruneLog(log) {
  const cutoff = Date.now() - LOG_RETENTION_MS;
  const fresh = log.filter(e => e && typeof e.ts === 'number' && e.ts >= cutoff);
  return fresh.length > LOG_HARD_CAP ? fresh.slice(-LOG_HARD_CAP) : fresh;
}
function bgLog(event, data) {
  const entry = { ts: Date.now(), source: 'bg', event: event, data: data || null };
  _logChain = _logChain.then(async () => {
    try {
      const obj = await chrome.storage.local.get(['debugLog']);
      const log = Array.isArray(obj.debugLog) ? obj.debugLog : [];
      log.push(entry);
      await chrome.storage.local.set({ debugLog: pruneLog(log) });
    } catch (e) { /* noop */ }
  }).catch(() => {});
  return _logChain;
}

const CLAIM_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // claims valid for 30 days

// ---------- Storage helpers ----------
async function getUserName() {
  const obj = await chrome.storage.local.get(['userName']);
  return (obj && obj.userName) ? String(obj.userName).trim() : '';
}

async function getUserColor() {
  const obj = await chrome.storage.local.get(['userColor']);
  return (obj && obj.userColor) ? String(obj.userColor).trim() : '';
}

async function setClientCodeFlag(code) {
  await chrome.storage.local.set({ lastClientCode: code, lastClientCodeAt: Date.now() });
}

async function loadClientCodeFlag() {
  const obj = await chrome.storage.local.get(['lastClientCode']);
  return obj && obj.lastClientCode ? String(obj.lastClientCode) : null;
}

// ---------- Supabase REST ----------
function sbHeaders(extra) {
  const h = {
    'apikey': CFG.SUPABASE_KEY,
    'Authorization': 'Bearer ' + CFG.SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
  if (extra) Object.assign(h, extra);
  return h;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sbInsertClaimOnce(claim) {
  const url = CFG.SUPABASE_URL + '/rest/v1/pending_claims';
  const resp = await fetch(url, {
    method: 'POST',
    headers: sbHeaders({ 'Prefer': 'return=representation' }),
    body: JSON.stringify([claim])
  });
  const respText = await resp.text().catch(() => '');
  if (!resp.ok) {
    bgLog('sb-insert-claim-fail', { status: resp.status, body: respText, claim: claim });
    throw new Error('Supabase claim insert failed: ' + resp.status + ' ' + respText);
  }
  let arr = [];
  try { arr = JSON.parse(respText); } catch (e) { /* noop */ }
  bgLog('sb-insert-claim-ok', { claim: claim, returned: arr[0] || null });
  return arr[0] || null;
}

// In-memory retry wrapper. Survives transient network glitches (DNS, brief offline,
// SW just woke up). Three attempts: 0s → 2s → 5s. If all fail — caller (queueClaim
// or flushOfflineClaims) keeps the claim in chrome.storage for a later flush attempt.
const INSERT_RETRY_DELAYS_MS = [0, 2000, 5000];
async function sbInsertClaim(claim) {
  let lastErr = null;
  for (let i = 0; i < INSERT_RETRY_DELAYS_MS.length; i++) {
    if (INSERT_RETRY_DELAYS_MS[i] > 0) await _sleep(INSERT_RETRY_DELAYS_MS[i]);
    try {
      return await sbInsertClaimOnce(claim);
    } catch (e) {
      lastErr = e;
      bgLog('sb-insert-claim-retry', { attempt: i + 1, error: String(e && e.message || e) });
    }
  }
  throw lastErr || new Error('sbInsertClaim: all retries failed');
}

async function sbClaimOrder(orderNumber, clientCode, sum, dateStr, itemsCount, itemCodes) {
  const url = CFG.SUPABASE_URL + '/rest/v1/rpc/claim_order';
  const reqBody = {
    p_order_number: orderNumber,
    p_client_code: clientCode,
    p_sum: (typeof sum === 'number') ? sum : null,
    p_order_date: dateStr || null,
    p_items_count: (typeof itemsCount === 'number') ? itemsCount : null,
    p_item_codes: (Array.isArray(itemCodes) && itemCodes.length) ? itemCodes : null
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify(reqBody)
  });
  const respText = await resp.text().catch(() => '');
  if (!resp.ok) {
    bgLog('sb-rpc-claim-fail', { req: reqBody, status: resp.status, body: respText });
    throw new Error('Supabase claim_order RPC failed: ' + resp.status + ' ' + respText);
  }
  let arr = [];
  try { arr = JSON.parse(respText); } catch (e) { /* noop */ }
  const row = Array.isArray(arr) ? arr[0] : arr;
  const result = row ? {
    matched: !!row.out_matched,
    userName: row.out_user_name || null,
    userColor: row.out_user_color || null,
    method: row.out_method || null,
    claimId: row.out_claim_id || null
  } : { matched: false };
  bgLog('sb-rpc-claim-ok', { req: reqBody, result: result });
  return result;
}

// Push the current local debug log to Supabase log_uploads. Used by the
// "Надіслати логи" button in the popup; admin reads them in the "Адмін" tab.
// Returns { ok, id, userName } on success or { ok:false, error } on failure.
async function uploadLogs() {
  try {
    const obj = await chrome.storage.local.get([
      'debugLog', 'failedClaims', 'installId', 'userName',
      'pendingClaims', 'lastClientCode'
    ]);
    const log = Array.isArray(obj.debugLog) ? obj.debugLog : [];
    const failed = Array.isArray(obj.failedClaims) ? obj.failedClaims : [];
    const installId = obj.installId || null;
    if (!installId) {
      return { ok: false, error: 'no-install-id (відкрийте попап хоча б раз раніше)' };
    }
    const userName = obj.userName || null;
    const meta = {
      clientCode: obj.lastClientCode || lastClientCode || null,
      pendingCount: Array.isArray(obj.pendingClaims) ? obj.pendingClaims.length : 0,
      failedCount: failed.length,
      uploadedFrom: 'background'
    };
    const serialized = JSON.stringify(log);
    const row = {
      install_id: installId,
      user_name: userName,
      ext_version: chrome.runtime.getManifest().version,
      entries_count: log.length,
      size_bytes: serialized.length,
      log_entries: log,
      failed_claims: failed.length ? failed : null,
      meta: meta
    };
    const resp = await fetch(CFG.SUPABASE_URL + '/rest/v1/log_uploads', {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify([row])
    });
    const txt = await resp.text().catch(() => '');
    if (!resp.ok) {
      bgLog('upload-logs-fail', { status: resp.status, body: txt.slice(0, 300) });
      return { ok: false, error: 'HTTP ' + resp.status };
    }
    let id = null;
    try {
      const arr = JSON.parse(txt);
      if (Array.isArray(arr) && arr[0] && arr[0].id != null) id = arr[0].id;
    } catch (e) { /* noop */ }
    bgLog('upload-logs-ok', { id: id, entries: log.length, size: serialized.length });
    return { ok: true, id: id, userName: userName };
  } catch (e) {
    bgLog('upload-logs-exception', { error: String(e && e.message || e) });
    return { ok: false, error: String(e && e.message || e) };
  }
}

// Ping the user_registry so the current install's reservation stays "active".
// No-op if there's no installId yet (popup never opened) or no registration
// on the server side. Fire-and-forget; never throws.
async function pingUserRegistry() {
  try {
    const obj = await chrome.storage.local.get(['installId']);
    if (!obj || !obj.installId) return;
    await fetch(CFG.SUPABASE_URL + '/rest/v1/rpc/ping_user_registry', {
      method: 'POST',
      headers: sbHeaders(),
      body: JSON.stringify({ p_install_id: obj.installId })
    });
  } catch (e) { /* noop */ }
}

async function sbLookupOrders(numbers) {
  if (!numbers || numbers.length === 0) return {};
  // Chunk to avoid URI-too-long (Supabase/Cloudflare ~8KB limit).
  const CHUNK = 80;
  const map = {};
  for (let i = 0; i < numbers.length; i += CHUNK) {
    const slice = numbers.slice(i, i + CHUNK);
    const list = slice.map(n => '"' + String(n).replace(/"/g, '\\"') + '"').join(',');
    const url = CFG.SUPABASE_URL +
      '/rest/v1/orders?select=order_number,user_name,user_color&order_number=in.(' + encodeURIComponent(list) + ')';
    const resp = await fetch(url, { method: 'GET', headers: sbHeaders() });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      bgLog('sb-lookup-fail', { chunk: i, status: resp.status, body: t.slice(0, 500) });
      throw new Error('Supabase lookup failed: ' + resp.status + ' ' + t);
    }
    const arr = await resp.json();
    for (const row of arr) map[row.order_number] = { name: row.user_name, color: row.user_color || null };
  }
  bgLog('sb-lookup-ok', { askedCount: numbers.length, foundCount: Object.keys(map).length });
  return map;
}

// ---------- Pending claims (offline outbox; primary store is Supabase) ----------
// Local list is only used when Supabase insert fails (e.g. offline). On every order
// or extension boot we attempt to flush the outbox.
async function loadClaims() {
  const obj = await chrome.storage.local.get(['pendingClaims']);
  const list = Array.isArray(obj.pendingClaims) ? obj.pendingClaims : [];
  const now = Date.now();
  return list.filter(c => c && c.ts && (now - c.ts) < CLAIM_WINDOW_MS);
}

async function saveClaims(list) {
  await chrome.storage.local.set({ pendingClaims: list });
}

// Build the row to send to Supabase pending_claims from the in-extension claim object.
function claimToRow(c) {
  // Convert ts (ms) → order_date YYYY-MM-DD in local time (the day the order was placed)
  const d = new Date(c.ts || Date.now());
  const orderDate = d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
  return {
    user_name: c.userName,
    user_color: c.userColor || null,
    client_code: c.clientCode || null,
    order_uuid: c.orderUuid || null,
    basket_id: c.basketId || null,
    total_sum: (typeof c.totalSum === 'number') ? c.totalSum : null,
    order_date: orderDate,
    delivery_name: c.deliveryName || null,
    items_count: (typeof c.itemsCount === 'number') ? c.itemsCount : null,
    item_codes: (Array.isArray(c.itemCodes) && c.itemCodes.length) ? c.itemCodes : null,
    currency: c.currency || null
  };
}

// How long to keep trying a stuck claim before giving up and writing it to the failed log.
const FLUSH_GIVEUP_MS = 24 * 60 * 60 * 1000; // 24h
// Minimum gap between retries for the same claim. Avoids hammering Supabase if we're
// flushed frequently (every history-view triggers a flush attempt).
const FLUSH_MIN_GAP_MS = 60 * 1000; // 1 min

async function appendFailedClaim(claim, reason) {
  const obj = await chrome.storage.local.get(['failedClaims']);
  const list = Array.isArray(obj.failedClaims) ? obj.failedClaims : [];
  list.push({ claim: claim, reason: reason, failedAt: Date.now() });
  // Cap the failed log at 200 entries to avoid unbounded storage growth.
  while (list.length > 200) list.shift();
  await chrome.storage.local.set({ failedClaims: list });
  bgLog('claim-given-up', { claim: claim, reason: reason });
}

async function flushOfflineClaims() {
  const list = await loadClaims();
  if (list.length === 0) return;
  const now = Date.now();
  const remaining = [];
  for (const c of list) {
    // Give-up if older than 24h regardless of attempt count.
    if (c.ts && (now - c.ts) > FLUSH_GIVEUP_MS) {
      await appendFailedClaim(c, 'expired-24h');
      continue;
    }
    // Throttle: don't retry the same claim more often than FLUSH_MIN_GAP_MS.
    if (c.lastAttemptTs && (now - c.lastAttemptTs) < FLUSH_MIN_GAP_MS) {
      remaining.push(c);
      continue;
    }
    try {
      await sbInsertClaim(claimToRow(c));
      console.log('[ANO bg] flushed offline claim');
    } catch (e) {
      console.warn('[ANO bg] flush failed, keeping local', e.message);
      c.lastAttemptTs = now;
      c.attempts = (c.attempts || 0) + 1;
      remaining.push(c);
    }
  }
  await saveClaims(remaining);
}

// On every order POST: try to insert claim into Supabase right away.
// If it fails (offline/network) → save locally, will retry later via flushOfflineClaims().
async function queueClaim(order) {
  const userName = await getUserName();
  const userColor = await getUserColor();
  if (!userName) {
    console.warn('[ANO bg] no user name, skip claim');
    return { ok: false, reason: 'no_user_name' };
  }
  const clientCode = lastClientCode || await loadClientCodeFlag();
  if (clientCode && clientCode !== CFG.EXPECTED_CLIENT_CODE) {
    console.log('[ANO bg] client code mismatch, skip claim', clientCode);
    return { ok: false, reason: 'client_code_mismatch' };
  }
  if (!clientCode) {
    // Without client code we can't safely insert; queue locally and retry once profile arrives.
    console.warn('[ANO bg] no client code yet, saving claim locally for later');
  }

  const claim = {
    ts: order.ts || Date.now(),
    userName: userName,
    userColor: userColor || null,
    clientCode: clientCode || null,
    orderUuid: order.orderUuid || null,
    basketId: order.basketId || null,
    totalSum: typeof order.totalSum === 'number' ? order.totalSum : null,
    deliveryName: order.deliveryName || null,
    itemsCount: typeof order.itemsCount === 'number' ? order.itemsCount : null,
    itemCodes: (Array.isArray(order.itemCodes) && order.itemCodes.length) ? order.itemCodes : null,
    currency: order.currency || null
  };

  bgLog('queue-claim-start', { claim: claim, hasClientCode: !!clientCode });

  // Defence: don't create a claim without total_sum. A claim w/o sum can only match via
  // FIFO which is dangerous (would steal someone else's order). Better to skip entirely.
  if (typeof claim.totalSum !== 'number' || isNaN(claim.totalSum)) {
    bgLog('queue-claim-skip-no-sum', { claim: claim });
    console.warn('[ANO bg] claim has no totalSum, skipping (cannot safely attribute later)');
    return { ok: false, reason: 'no_total_sum' };
  }

  // Flush old offline first (best effort)
  try { await flushOfflineClaims(); } catch (e) { /* noop */ }

  if (clientCode) {
    try {
      await sbInsertClaim(claimToRow(claim));
      console.log('[ANO bg] claim inserted to Supabase. uuid=', claim.orderUuid, 'sum=', claim.totalSum);
      // Keep our reservation alive (cheap, fire-and-forget).
      pingUserRegistry();
      return { ok: true, mode: 'supabase' };
    } catch (e) {
      console.warn('[ANO bg] Supabase insert failed, falling back to local outbox:', e.message);
      bgLog('queue-claim-supabase-fail-fallback-local', { error: String(e) });
    }
  }

  // Fallback: keep locally
  const list = await loadClaims();
  list.push(claim);
  await saveClaims(list);
  bgLog('queue-claim-local-saved', { totalLocal: list.length });
  return { ok: true, mode: 'local', queued: list.length };
}

// Parse DD/MM/YYYY → YYYY-MM-DD. Returns null on failure.
function parseHistoryDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (!m) return null;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  return m[3] + '-' + mm + '-' + dd;
}

// In-memory cache of "tried and didn't match" ZK numbers so we don't hammer the RPC
// on every history-page visit. Re-checked after MATCH_RECHECK_MS (claim may appear later).
const MATCH_RECHECK_MS = 60 * 60 * 1000; // 1 hour
const HISTORY_PROCESS_LIMIT = 50;        // cap RPC calls per visit (newest rows first)
const RPC_CONCURRENCY = 10;              // parallel RPC requests
const rpcMissCache = new Map();          // orderNumber → ts of last "not matched"

async function pMapLimit(items, limit, worker) {
  const ret = new Array(items.length);
  let i = 0;
  async function next() {
    while (true) {
      const cur = i++;
      if (cur >= items.length) return;
      try { ret[cur] = await worker(items[cur], cur); }
      catch (e) { ret[cur] = { error: e }; }
    }
  }
  const runners = [];
  for (let k = 0; k < Math.min(limit, items.length); k++) runners.push(next());
  await Promise.all(runners);
  return ret;
}

// rows: [{ number, date: "DD/MM/YYYY", sum: number }] in DOM order (top = newest first)
async function claimOrdersFromHistory(rows) {
  try {
    return await _claimOrdersFromHistoryImpl(rows);
  } catch (e) {
    bgLog('claim-history-error', { error: String(e && e.message || e), stack: String(e && e.stack || '').slice(0, 800) });
    return { ok: false, error: String(e) };
  }
}

async function _claimOrdersFromHistoryImpl(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: true, claimed: [] };

  try { await flushOfflineClaims(); } catch (e) { bgLog('flush-offline-error', { error: String(e) }); }

  const clientCode = lastClientCode || await loadClientCodeFlag();
  if (!clientCode) {
    bgLog('claim-history-no-client-code', null);
    return { ok: false, reason: 'no_client_code' };
  }

  // Skip rows already in `orders` (single batched query, chunked internally)
  const numbers = rows.map(r => r.number).filter(Boolean);
  const existingMap = await sbLookupOrders(numbers);

  // Filter: not yet in orders AND not in recent miss-cache
  const now = Date.now();
  const todoAll = rows.filter(r => {
    if (!r.number) return false;
    if (existingMap[r.number]) return false;
    const last = rpcMissCache.get(r.number);
    if (last && (now - last) < MATCH_RECHECK_MS) return false;
    return true;
  });

  // Cap to top N (newest rows are first in DOM order)
  const todo = todoAll.slice(0, HISTORY_PROCESS_LIMIT);
  if (todoAll.length > HISTORY_PROCESS_LIMIT) {
    console.log('[ANO bg] history: capping', todoAll.length, '→', HISTORY_PROCESS_LIMIT, 'oldest deferred');
  }

  bgLog('claim-history-start', {
    rowsTotal: rows.length,
    alreadyInOrders: Object.keys(existingMap).length,
    todoAll: todoAll.length,
    todo: todo.length,
    capDeferred: Math.max(0, todoAll.length - todo.length),
    sampleRow: rows[0] || null
  });

  const claimed = [];
  await pMapLimit(todo, RPC_CONCURRENCY, async (row) => {
    const dateStr = parseHistoryDate(row.date);
    try {
      const r = await sbClaimOrder(row.number, clientCode, row.sum, dateStr, row.itemsCount, row.itemCodes);
      if (r.matched) {
        claimed.push({ number: row.number, userName: r.userName, userColor: r.userColor, method: r.method });
        console.log('[ANO bg] matched', row.number, '→', r.userName, '(' + r.method + ')');
      } else {
        rpcMissCache.set(row.number, Date.now());
      }
    } catch (e) {
      console.error('[ANO bg] claim_order failed for', row.number, e.message);
    }
  });

  // Build a single name map for the caller (existingMap + newly-claimed).
  const nameMap = Object.assign({}, existingMap);
  for (const c of claimed) {
    if (c.number && c.userName) nameMap[c.number] = { name: c.userName, color: c.userColor || null };
  }

  bgLog('claim-history-done', { claimed: claimed, processed: todo.length });
  return { ok: true, claimed, existingMap, nameMap, processed: todo.length, deferred: Math.max(0, todoAll.length - todo.length) };
}

// ---------- Message router ----------
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return false;

  if (msg.type === 'CONTENT_LOG') {
    const p = msg.payload || {};
    bgLog('content/' + (p.event || 'unknown'), { url: p.url || null, data: p.data || null });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'ORDER_CREATED') {
    bgLog('order-created-received', msg.payload || {});
    queueClaim(msg.payload || {}).then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  }

  if (msg.type === 'PROFILE_SEEN') {
    const code = msg.payload && msg.payload.clientCode;
    if (code) {
      const wasMissing = !lastClientCode;
      lastClientCode = String(code);
      setClientCodeFlag(lastClientCode).catch(() => {});
      if (wasMissing) {
        // Try to flush any locally-buffered claims now that we know the client code.
        flushOfflineClaims().catch(() => {});
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'CLAIM_HISTORY') {
    const p = msg.payload || {};
    let rows = Array.isArray(p.rows) ? p.rows : null;
    if (!rows && Array.isArray(p.numbers)) {
      rows = p.numbers.map(n => ({ number: n, date: null, sum: null }));
    }
    bgLog('claim-history-received', { rowCount: rows ? rows.length : 0, sample: rows && rows[0] ? rows[0] : null });
    claimOrdersFromHistory(rows || [])
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  }

  if (msg.type === 'DEBUG_CAPTURE') {
    // Use the same serialized chain as bgLog to avoid race condition.
    const entry = msg.payload || {};
    _logChain = _logChain.then(async () => {
      try {
        const obj = await chrome.storage.local.get(['debugLog']);
        const log = Array.isArray(obj.debugLog) ? obj.debugLog : [];
        log.push(entry);
        const trimmed = pruneLog(log);
        await chrome.storage.local.set({ debugLog: trimmed });
        sendResponse({ ok: true, count: trimmed.length });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    }).catch(() => {});
    return true;
  }

  if (msg.type === 'GET_DEBUG_LOG') {
    chrome.storage.local.get(['debugLog'], (obj) => {
      sendResponse({ ok: true, log: Array.isArray(obj.debugLog) ? obj.debugLog : [] });
    });
    return true;
  }

  if (msg.type === 'CLEAR_DEBUG_LOG') {
    chrome.storage.local.set({ debugLog: [] }, () => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'MANUAL_PUSH_LOGS') {
    uploadLogs().then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  }

  if (msg.type === 'GET_STATE') {
    (async () => {
      const userName = await getUserName();
      const userColor = await getUserColor();
      const storedCode = await loadClientCodeFlag();
      const claims = await loadClaims();
      sendResponse({
        ok: true,
        userName: userName,
        userColor: userColor,
        clientCode: lastClientCode || storedCode || null,
        expectedClientCode: CFG.EXPECTED_CLIENT_CODE,
        pendingClaimsCount: claims.length,
        currentVersion: chrome.runtime.getManifest().version
      });
    })();
    return true; // async
  }

  return false;
});

// ---------- Periodic alarms: log retention + offline-claim flush ----------
// Fires every 10 min so any pending_claims that failed during a network outage get
// retried automatically — the user never has to do anything.
chrome.alarms.create('ano-housekeeping', { periodInMinutes: 10, delayInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async function (alarm) {
  if (alarm.name !== 'ano-housekeeping') return;
  // 1) Drain offline claim queue (silent retry; gives up after 24h → failedClaims log)
  try { await flushOfflineClaims(); } catch (e) { bgLog('alarm-flush-error', { error: String(e) }); }
  // 2) Heartbeat the name reservation so it stays active.
  try { await pingUserRegistry(); } catch (e) { /* noop */ }
  // 3) Prune old log entries proactively (covers idle periods with no writes)
  try {
    const obj = await chrome.storage.local.get(['debugLog']);
    const log = Array.isArray(obj.debugLog) ? obj.debugLog : [];
    const before = log.length;
    const fresh = pruneLog(log);
    if (fresh.length !== before) {
      await chrome.storage.local.set({ debugLog: fresh });
      bgLog('log-pruned', { before: before, after: fresh.length });
    }
  } catch (e) { /* noop */ }
});

// On install, open the popup so user can set their name
chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get(['userName'], function (obj) {
    if (!obj || !obj.userName) {
      try { chrome.action.openPopup && chrome.action.openPopup(); } catch (e) { /* noop */ }
    }
  });
});

// Drain offline queue shortly after every service-worker wake (Chrome restart, idle resume).
setTimeout(function () { flushOfflineClaims().catch(() => {}); }, 5000);
