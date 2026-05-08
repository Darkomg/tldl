// ── State ────────────────────────────────────────────────────────────────────
let currentChannelId = null;
let currentChannelTitle = null;
let currentMediaList = [];
let currentMediaFilter = 'all';
let ws = null;
let downloads = {};
let appConfig = {};

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initWebSocket();
  const { authorized } = await api('/api/auth/status');
  if (authorized) showApp();
  else showLogin();
  bindEvents();
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
function initWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'init') {
      msg.downloads.forEach(dl => { downloads[dl.id] = dl; });
      renderDownloads();
    } else if (msg.type === 'download_update') {
      downloads[msg.download.id] = msg.download;
      renderDownloads();
      updateDownloadsBadge();
    }
  };
  ws.onclose = () => setTimeout(initWebSocket, 3000);
}

// ── API helper ────────────────────────────────────────────────────────────────
async function api(url, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

// ── Login ─────────────────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('screen-login').classList.add('active');
  document.getElementById('screen-app').classList.remove('active');
}

function showApp() {
  document.getElementById('screen-login').classList.remove('active');
  document.getElementById('screen-app').classList.add('active');
  loadAppConfig();
  loadChannels();
}

function bindEvents() {
  // Login
  document.getElementById('btn-send-code').onclick = sendPhone;
  document.getElementById('btn-verify-code').onclick = verifyCode;
  document.getElementById('btn-verify-password').onclick = verifyPassword;
  document.getElementById('btn-back-phone').onclick = () => {
    document.getElementById('login-code-step').classList.add('hidden');
    document.getElementById('login-password-step').classList.add('hidden');
    document.getElementById('login-phone-step').classList.remove('hidden');
  };
  document.getElementById('input-phone').addEventListener('keydown', e => { if (e.key === 'Enter') sendPhone(); });
  document.getElementById('input-code').addEventListener('keydown', e => { if (e.key === 'Enter') verifyCode(); });
  document.getElementById('input-password').addEventListener('keydown', e => { if (e.key === 'Enter') verifyPassword(); });

  // Logout
  document.getElementById('btn-logout').onclick = async () => {
    await api('/api/auth/logout', 'POST');
    showLogin();
  };

  // Nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      showView(btn.dataset.view);
    };
  });

  // Channels
  document.getElementById('btn-refresh-channels').onclick = loadChannels;
  document.getElementById('input-search-channels').oninput = filterChannels;
  document.getElementById('btn-back-channels').onclick = () => showView('channels');

  // Videos
  document.getElementById('chk-select-all').onchange = toggleSelectAll;
  document.getElementById('input-subfolder').addEventListener('input', updatePathPreview);
  document.getElementById('input-downloads-root').addEventListener('input', () => {
    const v = document.getElementById('input-downloads-root').value.trim();
    document.getElementById('settings-path-preview').textContent = v ? `📁 /downloads/${v}/…` : '📁 /downloads/…';
  });
  document.getElementById('btn-save-settings').onclick = saveSettings;
  document.getElementById('btn-start-download').onclick = startDownload;

  // Downloads
  document.getElementById('btn-clear-completed').onclick = clearCompleted;
}

async function sendPhone() {
  const phone = document.getElementById('input-phone').value.trim();
  if (!phone) return;
  setLoginError('');
  document.getElementById('btn-send-code').disabled = true;
  document.getElementById('btn-send-code').textContent = 'Enviando...';
  const res = await api('/api/auth/phone', 'POST', { phone });
  document.getElementById('btn-send-code').disabled = false;
  document.getElementById('btn-send-code').textContent = 'Enviar código';
  if (res.ok) {
    document.getElementById('login-phone-step').classList.add('hidden');
    document.getElementById('login-code-step').classList.remove('hidden');
    document.getElementById('input-code').focus();
  } else {
    setLoginError(res.error || 'Error al enviar código');
  }
}

async function verifyCode() {
  const code = document.getElementById('input-code').value.trim();
  if (!code) return;
  setLoginError('');
  document.getElementById('btn-verify-code').disabled = true;
  document.getElementById('btn-verify-code').textContent = 'Verificando...';
  const res = await api('/api/auth/code', 'POST', { code });
  document.getElementById('btn-verify-code').disabled = false;
  document.getElementById('btn-verify-code').textContent = 'Verificar';
  if (res.ok) {
    showApp();
  } else if (res.needsPassword) {
    document.getElementById('login-code-step').classList.add('hidden');
    document.getElementById('login-password-step').classList.remove('hidden');
    document.getElementById('input-password').focus();
  } else {
    setLoginError(res.error || 'Código incorrecto');
  }
}

async function verifyPassword() {
  const password = document.getElementById('input-password').value.trim();
  if (!password) return;
  setLoginError('');
  document.getElementById('btn-verify-password').disabled = true;
  document.getElementById('btn-verify-password').textContent = 'Verificando...';
  const res = await api('/api/auth/password', 'POST', { password });
  document.getElementById('btn-verify-password').disabled = false;
  document.getElementById('btn-verify-password').textContent = 'Continuar';
  if (res.ok) showApp();
  else setLoginError(res.error || 'Contraseña incorrecta');
}

function setLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

// ── Views ─────────────────────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById(`view-${name === 'channel-detail' ? 'channel-detail' : name}`);
  if (el) el.classList.add('active');
}

// ── Channels ─────────────────────────────────────────────────────────────────
let allChannels = [];

async function loadChannels() {
  const list = document.getElementById('channels-list');
  list.innerHTML = '<div class="loading">Cargando canales...</div>';
  const channels = await api('/api/channels');
  if (channels.error) { list.innerHTML = `<div class="empty-state">${channels.error}</div>`; return; }
  allChannels = channels;
  renderChannels(channels);
}

function filterChannels() {
  const q = document.getElementById('input-search-channels').value.toLowerCase();
  renderChannels(allChannels.filter(c => c.title.toLowerCase().includes(q)));
}

function renderChannels(channels) {
  const list = document.getElementById('channels-list');
  if (!channels.length) { list.innerHTML = '<div class="empty-state">No se encontraron canales.</div>'; return; }
  list.innerHTML = channels.map(c => `
    <div class="channel-card" data-id="${c.id}" data-title="${escHtml(c.title)}">
      <div class="channel-avatar">${c.title.charAt(0).toUpperCase()}</div>
      <div class="channel-info">
        <div class="channel-title">${escHtml(c.title)}</div>
        <div class="channel-meta">${c.username ? '@' + c.username : 'Canal privado'}${c.participantsCount ? ' · ' + c.participantsCount.toLocaleString() + ' miembros' : ''}</div>
      </div>
      <span class="channel-arrow">›</span>
    </div>
  `).join('');
  list.querySelectorAll('.channel-card').forEach(card => {
    card.onclick = () => openChannel(card.dataset.id, card.dataset.title);
  });
}

// ── Channel Detail ────────────────────────────────────────────────────────────
async function openChannel(id, title) {
  currentChannelId = id;
  currentChannelTitle = title;
  document.getElementById('channel-detail-title').textContent = title;
  document.getElementById('input-subfolder').value = sanitizeFolderName(title);
  updatePathPreview();
  document.getElementById('btn-start-download').disabled = true;
  document.getElementById('chk-select-all').checked = false;
  showView('channel-detail');

  const list = document.getElementById('videos-list');
  list.innerHTML = '<div class="loading">Cargando videos...</div>';

  const res = await api(`/api/channels/${id}/media`);
  if (res.error) { list.innerHTML = `<div class="empty-state">${res.error}</div>`; return; }

  currentMediaList = res.media.sort((a, b) => a.id - b.id);
  currentMediaFilter = 'all';
  renderFilterButtons();
  renderMediaList('all');
}

function renderFilterButtons() {
  const bar = document.getElementById('media-filter-bar');
  if (!currentMediaList.length) { bar.innerHTML = ''; return; }

  const counts = {};
  currentMediaList.forEach(v => { counts[v.mediaType] = (counts[v.mediaType] || 0) + 1; });
  const types = Object.keys(counts);

  bar.innerHTML = `<button class="media-filter-btn active" data-filter="all">Todos (${currentMediaList.length})</button>` +
    types.map(t => `<button class="media-filter-btn" data-filter="${t}">${t} (${counts[t]})</button>`).join('');

  bar.querySelectorAll('.media-filter-btn').forEach(btn => {
    btn.onclick = () => renderMediaList(btn.dataset.filter);
  });
}

function renderMediaList(filter) {
  currentMediaFilter = filter;
  document.querySelectorAll('.media-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));

  const items = filter === 'all' ? currentMediaList : currentMediaList.filter(v => v.mediaType === filter);
  const list = document.getElementById('videos-list');

  if (!items.length) {
    list.innerHTML = '<div class="empty-state">No hay archivos de este tipo.</div>';
    document.getElementById('chk-select-all').checked = false;
    updateDownloadBtn();
    return;
  }

  list.innerHTML = items.map((v, i) => {
    const label = v.caption ? escHtml(v.caption) : (v.filename ? escHtml(v.filename) : '<span class="no-caption">Sin título</span>');
    const badge = `<span class="media-badge media-badge-${v.mediaType || 'document'}">${v.mediaType || 'doc'}</span>`;
    return `
    <div class="video-row">
      <input type="checkbox" class="video-chk" data-id="${v.id}">
      <span class="video-num">#${String(i + 1).padStart(3, '0')}</span>
      ${badge}
      <span class="video-caption">${label}</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.video-chk').forEach(chk => { chk.onchange = updateDownloadBtn; });
  document.getElementById('chk-select-all').checked = false;
  updateDownloadBtn();
}

function toggleSelectAll() {
  const checked = document.getElementById('chk-select-all').checked;
  document.querySelectorAll('.video-chk').forEach(c => c.checked = checked);
  updateDownloadBtn();
}

function updateDownloadBtn() {
  const count = document.querySelectorAll('.video-chk:checked').length;
  const btn = document.getElementById('btn-start-download');
  btn.disabled = count === 0;
  btn.textContent = count > 0 ? `⬇️ Descargar (${count} archivos)` : '⬇️ Descargar seleccionados';
}

async function startDownload() {
  const messageIds = [...document.querySelectorAll('.video-chk:checked')].map(c => parseInt(c.dataset.id));
  const outputFolder = document.getElementById('input-subfolder').value.trim() || currentChannelTitle;
  if (!messageIds.length) return;

  const res = await api('/api/download', 'POST', {
    channelId: currentChannelId,
    channelTitle: currentChannelTitle,
    messageIds,
    outputFolder,
  });

  if (res.downloadId) {
    toast(`Descarga iniciada (${messageIds.length} videos)`);
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-view="downloads"]').classList.add('active');
    showView('downloads');
  } else {
    toast('Error al iniciar descarga: ' + (res.error || 'desconocido'));
  }
}

// ── Downloads ─────────────────────────────────────────────────────────────────
function renderDownloads() {
  const list = document.getElementById('downloads-list');
  const all = Object.values(downloads);
  if (!all.length) { list.innerHTML = '<div class="empty-state">No hay descargas activas.</div>'; return; }

  const sorted = all.sort((a, b) => {
    const order = { running: 0, queued: 1, error: 2, completed: 3 };
    return (order[a.status] ?? 4) - (order[b.status] ?? 4);
  });

  list.innerHTML = sorted.map(dl => {
    const pct = dl.percent;
    const fillClass = dl.status === 'completed' ? 'completed' : dl.status === 'error' ? 'error' : '';
    const statusLabel = { running: 'Descargando', queued: 'En cola', completed: 'Completado', error: 'Error', paused: 'Pausado', cancelled: 'Cancelado' }[dl.status] || dl.status;
    const logHtml = dl.log.map(line => {
      if (line.startsWith('[OK]')) return `<div class="log-ok">${escHtml(line)}</div>`;
      if (line.startsWith('[SKIP]')) return `<div class="log-skip">${escHtml(line)}</div>`;
      if (line.startsWith('[FAIL]') || line.startsWith('[ERROR]')) return `<div class="log-fail">${escHtml(line)}</div>`;
      return `<div class="log-dl">${escHtml(line)}</div>`;
    }).join('');

    return `
      <div class="download-card" data-id="${dl.id}">
        <div class="download-card-header">
          <div class="download-title">${escHtml(dl.channelTitle || dl.channelId)}</div>
          <span class="download-status status-${dl.status}">${statusLabel}</span>
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill ${fillClass}" style="width:${pct}%"></div>
        </div>
        <div class="download-stats">
          <span><b>${dl.done}</b> / ${dl.total} videos</span>
          <span><b>${pct}%</b></span>
          ${dl.failed ? `<span style="color:var(--red)"><b>${dl.failed}</b> fallidos</span>` : ''}
          <span style="color:var(--muted)">${escHtml(dl.outDir)}</span>
        </div>
        <div class="download-log">${logHtml || '<span style="color:var(--muted)">Iniciando...</span>'}</div>
        <div class="download-card-footer">
          ${dl.canPause  ? `<button class="btn-ghost btn-pause-dl"  data-id="${dl.id}">Pausar</button>` : ''}
          ${dl.canResume ? `<button class="btn-ghost btn-resume-dl" data-id="${dl.id}">Reanudar</button>` : ''}
          ${dl.canCancel ? `<button class="btn-ghost btn-cancel-dl" data-id="${dl.id}" style="color:var(--red)">Cancelar</button>` : ''}
          ${dl.status === 'completed' || dl.status === 'error' || dl.status === 'cancelled' ? `<button class="btn-ghost btn-remove-dl" data-id="${dl.id}">Eliminar</button>` : ''}
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.btn-pause-dl').forEach(btn => {
    btn.onclick = () => api(`/api/downloads/${btn.dataset.id}/pause`, 'POST');
  });
  list.querySelectorAll('.btn-resume-dl').forEach(btn => {
    btn.onclick = () => api(`/api/downloads/${btn.dataset.id}/resume`, 'POST');
  });
  list.querySelectorAll('.btn-cancel-dl').forEach(btn => {
    btn.onclick = () => api(`/api/downloads/${btn.dataset.id}/cancel`, 'POST');
  });
  list.querySelectorAll('.btn-remove-dl').forEach(btn => {
    btn.onclick = async () => {
      await api(`/api/downloads/${btn.dataset.id}`, 'DELETE');
      delete downloads[btn.dataset.id];
      renderDownloads();
      updateDownloadsBadge();
    };
  });

  // Auto-scroll logs
  list.querySelectorAll('.download-log').forEach(log => { log.scrollTop = log.scrollHeight; });
}

async function clearCompleted() {
  const completed = Object.values(downloads).filter(d => d.status === 'completed' || d.status === 'error');
  for (const dl of completed) {
    await api(`/api/downloads/${dl.id}`, 'DELETE');
    delete downloads[dl.id];
  }
  renderDownloads();
  updateDownloadsBadge();
}

function updateDownloadsBadge() {
  const active = Object.values(downloads).filter(d => d.status === 'running' || d.status === 'queued').length;
  const btn = document.querySelector('[data-view="downloads"]');
  const existing = btn.querySelector('.badge');
  if (existing) existing.remove();
  if (active > 0) btn.insertAdjacentHTML('beforeend', `<span class="badge">${active}</span>`);
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sanitizeFolderName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '').trim();
}

function updatePathPreview() {
  const root = appConfig.downloadsRoot || '';
  const sub = document.getElementById('input-subfolder').value.trim();
  const parts = ['/downloads', root, sub || '…'].filter(Boolean);
  document.getElementById('dest-preview').textContent = '📁 ' + parts.join('/');
}

async function loadAppConfig() {
  const cfg = await api('/api/config');
  if (!cfg.error) {
    appConfig = cfg;
    const rootInput = document.getElementById('input-downloads-root');
    if (rootInput) rootInput.value = cfg.downloadsRoot || '';
    const preview = document.getElementById('settings-path-preview');
    if (preview) {
      const v = cfg.downloadsRoot || '';
      preview.textContent = v ? `📁 /downloads/${v}/…` : '📁 /downloads/…';
    }
  }
}

async function saveSettings() {
  const root = document.getElementById('input-downloads-root').value.trim();
  const res = await api('/api/config', 'POST', { downloadsRoot: root });
  if (res.ok) {
    appConfig.downloadsRoot = root;
    toast('Configuración guardada');
  }
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}
