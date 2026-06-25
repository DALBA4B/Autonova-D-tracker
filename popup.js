const $ = (id) => document.getElementById(id);

// ---------- Install ID + Supabase name-reservation ----------
// Each extension install gets a random UUID stored locally. The server
// uses it to bind a name reservation, so re-saving from the same install
// updates rather than conflicts. Two different installs can't hold the
// same name (case-insensitive, trimmed) while both are active (≤30d).
function getOrCreateInstallId() {
  return new Promise(function (res) {
    chrome.storage.local.get(['installId'], function (obj) {
      if (obj && obj.installId) { res(obj.installId); return; }
      var id;
      try { id = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : null; } catch (e) { id = null; }
      if (!id) {
        // RFC4122 v4 fallback
        id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = (Math.random() * 16) | 0;
          var v = c === 'x' ? r : ((r & 0x3) | 0x8);
          return v.toString(16);
        });
      }
      chrome.storage.local.set({ installId: id }, function () { res(id); });
    });
  });
}

function getClientCodeFromBackground() {
  return new Promise(function (res) {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, function (resp) {
      if (chrome.runtime.lastError || !resp || !resp.ok) { res(null); return; }
      res(resp.clientCode || null);
    });
  });
}

async function reserveName(name, color) {
  if (!self.ANO_CFG) throw new Error('config-missing');
  var installId = await getOrCreateInstallId();
  var clientCode = await getClientCodeFromBackground();
  var url = ANO_CFG.SUPABASE_URL + '/rest/v1/rpc/reserve_user_name';
  var resp = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': ANO_CFG.SUPABASE_KEY,
      'Authorization': 'Bearer ' + ANO_CFG.SUPABASE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      p_install_id: installId,
      p_user_name: name,
      p_user_color: color || null,
      p_client_code: clientCode
    })
  });
  if (!resp.ok) {
    var txt = await resp.text().catch(function () { return ''; });
    throw new Error('HTTP ' + resp.status + ' ' + txt.slice(0, 200));
  }
  var arr = await resp.json();
  var row = Array.isArray(arr) ? arr[0] : arr;
  return row || { out_ok: false, out_message: 'empty-response' };
}

const PALETTE = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4',
  '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#84cc16', '#64748b'
];
const DEFAULT_COLOR = '#64748b';

let selectedColor = DEFAULT_COLOR;

function showStatus(text, isError) {
  const el = $('status');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

function updatePreview() {
  const preview = $('badge-preview');
  preview.textContent = ($('name').value || '').trim() || 'Імʼя';
  preview.style.backgroundColor = selectedColor;
}

function setActiveSwatch(color) {
  selectedColor = color;
  document.querySelectorAll('.color-swatch').forEach(function (s) {
    s.classList.toggle('active', s.dataset.color === color);
  });
  updatePreview();
}

function buildColorGrid() {
  const grid = $('color-grid');
  grid.innerHTML = '';
  PALETTE.forEach(function (c) {
    const b = document.createElement('button');
    b.className = 'color-swatch';
    b.style.backgroundColor = c;
    b.dataset.color = c;
    b.title = c;
    b.addEventListener('click', function () { setActiveSwatch(c); });
    grid.appendChild(b);
  });
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      const target = t.dataset.tab;
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === target));
    });
  });
}

function refreshState() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, function (resp) {
    if (chrome.runtime.lastError || !resp || !resp.ok) return;
    $('name').value = resp.userName || '';
    setActiveSwatch(resp.userColor || DEFAULT_COLOR);
    $('client-code').textContent = resp.clientCode || '—';
    $('expected-code').textContent = resp.expectedClientCode || '—';
    $('pending-count').textContent = resp.pendingClaimsCount || 0;
    if (resp.currentVersion) $('version').textContent = 'v' + resp.currentVersion;
    if (resp.clientCode && resp.clientCode !== resp.expectedClientCode) {
      showStatus('Код клієнта (' + resp.clientCode + ') не співпадає з очікуваним (' + resp.expectedClientCode + ').', true);
    }
    // Best-effort: if a name is already stored locally but we have no
    // reservation yet (e.g. upgrade from older version), try to claim it
    // silently. If someone else got there first, show a banner.
    if (resp.userName) {
      reserveName(resp.userName, resp.userColor || DEFAULT_COLOR).then(function (r) {
        if (r && r.out_ok === false && r.out_message === 'name-taken') {
          showStatus('Увага: імʼя "' + resp.userName + '" зараз використовує інший співробітник. Будь ласка, виберіть інше імʼя.', true);
        }
      }).catch(function () { /* offline — try again on next save */ });
    }
  });
}

function getStoredProfile() {
  return new Promise(function (res) {
    chrome.storage.local.get(['userName', 'userColor'], function (obj) {
      res({ name: (obj && obj.userName) || '', color: (obj && obj.userColor) || '' });
    });
  });
}

$('save').addEventListener('click', async function () {
  const name = ($('name').value || '').trim();
  if (!name) {
    showStatus('Введіть імʼя', true);
    return;
  }
  $('save').disabled = true;
  showStatus('Перевірка...', false);
  try {
    // Fast-path: if the name didn't change, just persist the new color locally.
    // No need to round-trip reserve_user_name — same install already owns it.
    const prev = await getStoredProfile();
    if (prev.name && prev.name.trim().toLowerCase() === name.toLowerCase()) {
      chrome.storage.local.set({ userName: name, userColor: selectedColor }, function () {
        if (chrome.runtime.lastError) {
          showStatus('Помилка: ' + chrome.runtime.lastError.message, true);
        } else {
          showStatus('Збережено ✓', false);
        }
      });
      // Update color server-side too, but don't block UX on it.
      reserveName(name, selectedColor).catch(function () { /* noop */ });
      return;
    }
    const r = await reserveName(name, selectedColor);
    if (!r.out_ok) {
      if (r.out_message === 'name-taken') {
        showStatus('Імʼя "' + name + '" вже зайняте іншим співробітником. Виберіть інше.', true);
      } else {
        showStatus('Помилка: ' + (r.out_message || 'unknown'), true);
      }
      return;
    }
    chrome.storage.local.set({ userName: name, userColor: selectedColor }, function () {
      if (chrome.runtime.lastError) {
        showStatus('Помилка: ' + chrome.runtime.lastError.message, true);
        return;
      }
      showStatus('Збережено ✓', false);
    });
  } catch (e) {
    showStatus('Помилка мережі: ' + (e.message || e), true);
  } finally {
    $('save').disabled = false;
  }
});

$('name').addEventListener('input', updatePreview);

$('name').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') $('save').click();
});

function refreshLogCount() {
  chrome.runtime.sendMessage({ type: 'GET_DEBUG_LOG' }, function (resp) {
    if (chrome.runtime.lastError || !resp || !resp.ok) return;
    $('log-count').textContent = (resp.log || []).length;
  });
}

$('download-log').addEventListener('click', function () {
  chrome.runtime.sendMessage({ type: 'GET_DEBUG_LOG' }, function (resp) {
    if (!resp || !resp.ok) { showStatus('Не вдалося отримати лог', true); return; }
    const blob = new Blob([JSON.stringify(resp.log, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'autonova-debug-' + ts + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showStatus('Збережено ' + (resp.log || []).length + ' записів', false);
  });
});

$('clear-log').addEventListener('click', function () {
  chrome.runtime.sendMessage({ type: 'CLEAR_DEBUG_LOG' }, function () {
    showStatus('Лог очищено', false);
    refreshLogCount();
  });
});

$('clear-cache').addEventListener('click', function () {
  chrome.storage.local.remove(['orderNameCache'], function () {
    if (chrome.runtime.lastError) {
      showStatus('Помилка: ' + chrome.runtime.lastError.message, true);
      return;
    }
    showStatus('Кеш імен очищено ✓', false);
  });
});

// ---------- Manual push: "Надіслати логи розробнику" ----------
const PUSH_DEFAULT_LABEL = 'Надіслати логи розробнику';
const PUSH_MIN_LOADING_MS = 1800;   // keep the spinner visible at least this long for nicer UX
const PUSH_SUCCESS_HOLD_MS = 3800;
const PUSH_ERROR_HOLD_MS = 4500;
let _pushCooldownUntil = 0;
let _pushResetTimer = null;

function setPushState(state, label) {
  const btn = $('push-log');
  btn.classList.remove('is-loading', 'is-success', 'is-error');
  if (state) btn.classList.add('is-' + state);
  btn.textContent = label != null ? label : PUSH_DEFAULT_LABEL;
  btn.disabled = state === 'loading';
}

function resetPushButtonSoon(ms) {
  clearTimeout(_pushResetTimer);
  _pushResetTimer = setTimeout(function () { setPushState(null); }, ms);
}

$('push-log').addEventListener('click', function () {
  const now = Date.now();
  if (now < _pushCooldownUntil) {
    const left = Math.ceil((_pushCooldownUntil - now) / 1000);
    showStatus('Зачекайте ' + left + 'с перед повторною відправкою', true);
    return;
  }
  clearTimeout(_pushResetTimer);
  setPushState('loading', 'Надсилання...');
  const startedAt = Date.now();

  chrome.runtime.sendMessage({ type: 'MANUAL_PUSH_LOGS' }, function (resp) {
    // Keep the spinner visible for at least PUSH_MIN_LOADING_MS so the user
    // perceives the action as deliberate rather than instant. The actual
    // network round-trip is often <300ms which feels jarring without this.
    const elapsed = Date.now() - startedAt;
    const delay = Math.max(0, PUSH_MIN_LOADING_MS - elapsed);
    setTimeout(function () {
      if (chrome.runtime.lastError) {
        setPushState('error', 'Помилка');
        showStatus('Помилка: ' + chrome.runtime.lastError.message, true);
        resetPushButtonSoon(PUSH_ERROR_HOLD_MS);
        return;
      }
      if (!resp || !resp.ok) {
        setPushState('error', 'Не вдалося');
        showStatus('Не вдалося надіслати: ' + ((resp && resp.error) || 'unknown'), true);
        resetPushButtonSoon(PUSH_ERROR_HOLD_MS);
        return;
      }
      const namePart = resp.userName ? resp.userName + ' ' : '';
      const idPart = resp.id != null ? '#' + resp.id : '';
      const summary = (namePart + idPart).trim();
      setPushState('success', 'Надіслано ' + summary);
      showStatus('Логи відправлено розробнику ✓', false);
      _pushCooldownUntil = Date.now() + 30 * 1000; // 30s throttle
      resetPushButtonSoon(PUSH_SUCCESS_HOLD_MS);
    }, delay);
  });
});

// ---------- Admin tab ----------
// Activated by running in popup DevTools:
//   chrome.storage.local.set({ adminMode: true })
// Then reopen the popup. The "Адмін" tab appears.
function adminEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function adminFormatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}
function adminFormatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' +
         pad(d.getHours()) + ':' + pad(d.getMinutes());
}

async function adminLoadList() {
  if (!self.ANO_CFG) return;
  $('admin-count').textContent = 'Завантаження...';
  $('admin-list').innerHTML = '';
  try {
    const url = ANO_CFG.SUPABASE_URL +
      '/rest/v1/log_uploads?select=id,install_id,user_name,ext_version,uploaded_at,entries_count,size_bytes' +
      '&order=uploaded_at.desc&limit=50';
    const resp = await fetch(url, {
      headers: {
        'apikey': ANO_CFG.SUPABASE_KEY,
        'Authorization': 'Bearer ' + ANO_CFG.SUPABASE_KEY
      }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const rows = await resp.json();
    $('admin-count').textContent = 'Логів: ' + rows.length;
    if (rows.length === 0) {
      $('admin-list').innerHTML = '<div class="admin-empty">Поки що жодних логів</div>';
      return;
    }
    const html = rows.map(function (r) {
      const name = adminEscape(r.user_name || '—');
      const ver = adminEscape(r.ext_version || '?');
      const date = adminFormatDate(r.uploaded_at);
      const size = adminFormatBytes(r.size_bytes);
      const entries = r.entries_count != null ? r.entries_count : '?';
      return (
        '<div class="admin-item">' +
          '<div class="admin-item-row">' +
            '<span class="admin-item-name">' + name + '</span>' +
            '<span class="admin-item-id">#' + r.id + '</span>' +
          '</div>' +
          '<div class="admin-item-row">' +
            '<span class="admin-item-meta">v' + ver + ' · ' + date + '</span>' +
            '<span class="admin-item-meta">' + entries + ' · ' + size + '</span>' +
          '</div>' +
          '<button class="admin-download" data-id="' + r.id + '" data-name="' + name + '">Скачати JSON</button>' +
        '</div>'
      );
    }).join('');
    $('admin-list').innerHTML = html;
    document.querySelectorAll('.admin-download').forEach(function (btn) {
      btn.addEventListener('click', function () {
        adminDownload(btn.getAttribute('data-id'), btn.getAttribute('data-name'), btn);
      });
    });
  } catch (e) {
    $('admin-count').textContent = '—';
    $('admin-list').innerHTML = '<div class="admin-empty">Помилка: ' + adminEscape(e.message || e) + '</div>';
  }
}

async function adminDownload(id, name, btn) {
  if (!self.ANO_CFG) return;
  const origText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Завантаження...'; }
  try {
    const url = ANO_CFG.SUPABASE_URL +
      '/rest/v1/log_uploads?select=*&id=eq.' + encodeURIComponent(id);
    const resp = await fetch(url, {
      headers: {
        'apikey': ANO_CFG.SUPABASE_KEY,
        'Authorization': 'Bearer ' + ANO_CFG.SUPABASE_KEY
      }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const rows = await resp.json();
    const row = rows && rows[0];
    if (!row) throw new Error('Запис не знайдено');
    const blob = new Blob([JSON.stringify(row, null, 2)], { type: 'application/json' });
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    // Use the actual user name (Cyrillic/etc preserved). Only strip
    // filesystem-unsafe chars and collapse whitespace.
    const rawName = (row && row.user_name) || name || 'user';
    const safeName = String(rawName)
      .replace(/[\/\\:*?"<>|]+/g, '')
      .replace(/\s+/g, '_')
      .trim() || 'user';
    a.href = objUrl;
    a.download = 'autonova-log-' + safeName + '-' + id + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
  } catch (e) {
    showStatus('Помилка скачування: ' + (e.message || e), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText || 'Скачати JSON'; }
  }
}

function setupAdminMode() {
  chrome.storage.local.get(['adminMode'], function (obj) {
    const enabled = !!(obj && obj.adminMode);
    const tab = $('admin-tab');
    if (enabled) {
      tab.hidden = false;
      // Lazy-load list when the admin tab is first opened.
      tab.addEventListener('click', function once() {
        adminLoadList();
        tab.removeEventListener('click', once);
      });
      $('admin-refresh').addEventListener('click', adminLoadList);
    }
  });
}

// Hidden gesture: 5 quick clicks on the version label toggles a hint
// banner — useful only to remind the admin how to activate the mode
// (the actual activation is via DevTools, as documented in README).
let _versionClicks = 0;
let _versionClickTimer = null;
$('version').addEventListener('click', function () {
  _versionClicks++;
  clearTimeout(_versionClickTimer);
  _versionClickTimer = setTimeout(function () { _versionClicks = 0; }, 1500);
  if (_versionClicks >= 5) {
    _versionClicks = 0;
    showStatus('Admin-режим: відкрий DevTools цього попапу → ' +
               'chrome.storage.local.set({adminMode: true})', false);
  }
});

// ---------- Functions: auto-expand ----------
function refreshAutoExpand() {
  chrome.storage.local.get(['autoExpandOrders'], function (obj) {
    if ($('auto-expand')) $('auto-expand').checked = !!(obj && obj.autoExpandOrders);
  });
}

$('auto-expand').addEventListener('change', function () {
  chrome.storage.local.set({ autoExpandOrders: $('auto-expand').checked });
});

initTabs();
buildColorGrid();
setActiveSwatch(DEFAULT_COLOR);
refreshState();
refreshLogCount();
refreshAutoExpand();
setupAdminMode();
