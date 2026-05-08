const express = require('express');
const { WebSocketServer } = require('ws');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || '/downloads';
const CREDS_FILE = path.join(DATA_DIR, 'credentials.json');
const API_ID = parseInt(process.env.API_ID || '0');
const API_HASH = process.env.API_HASH || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── State ────────────────────────────────────────────────────────────────────
let tgClient = null;
let pendingPhoneCodeHash = null;
let pendingPhone = null;
const downloads = {};  // id -> { id, channelTitle, files, done, total, failed, status, log[] }

// ── Helpers ──────────────────────────────────────────────────────────────────
function loadSession() {
  if (fs.existsSync(CREDS_FILE)) {
    try { return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')).session || ''; } catch { return ''; }
  }
  return '';
}

function saveSession(session) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CREDS_FILE, JSON.stringify({ session }, null, 2));
}

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
  }
  return {};
}

function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function getMediaInfo(msg) {
  const m = msg.media;
  if (!m) return null;

  if (m.className === 'MessageMediaPhoto') {
    return { mediaType: 'photo', filename: String(msg.id).padStart(5, '0') + '.jpg' };
  }

  if (m.className === 'MessageMediaDocument') {
    const attrs = m.document.attributes || [];
    const fnAttr    = attrs.find(a => a.className === 'DocumentAttributeFilename');
    const vidAttr   = attrs.find(a => a.className === 'DocumentAttributeVideo');
    const audAttr   = attrs.find(a => a.className === 'DocumentAttributeAudio');
    const animAttr  = attrs.find(a => a.className === 'DocumentAttributeAnimated');
    const stickAttr = attrs.find(a => a.className === 'DocumentAttributeSticker');

    if (stickAttr) return null;

    if (fnAttr) {
      const ext = path.extname(fnAttr.fileName).toLowerCase();
      const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ts'];
      const audioExts = ['.mp3', '.flac', '.aac', '.ogg', '.wav', '.m4a', '.opus'];
      const mediaType = videoExts.includes(ext) ? 'video' : audioExts.includes(ext) ? 'audio' : 'document';
      return { mediaType, filename: fnAttr.fileName };
    }
    if (animAttr)          return { mediaType: 'gif',      filename: String(msg.id).padStart(5, '0') + '.mp4' };
    if (vidAttr)           return { mediaType: 'video',    filename: String(msg.id).padStart(5, '0') + '.mp4' };
    if (audAttr?.voice)    return { mediaType: 'voice',    filename: String(msg.id).padStart(5, '0') + '.ogg' };
    if (audAttr)           return { mediaType: 'audio',    filename: String(msg.id).padStart(5, '0') + '.mp3' };
    return                        { mediaType: 'document', filename: String(msg.id).padStart(5, '0') + '.bin' };
  }

  return null;
}

async function getClient() {
  if (tgClient && !tgClient.disconnected) return tgClient;
  const session = loadSession();
  tgClient = new TelegramClient(new StringSession(session), API_ID, API_HASH, { connectionRetries: 5 });
  await tgClient.connect();
  return tgClient;
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

// ── Auth ─────────────────────────────────────────────────────────────────────
app.get('/api/auth/status', async (req, res) => {
  try {
    const client = await getClient();
    const authorized = await client.isUserAuthorized();
    res.json({ authorized });
  } catch {
    res.json({ authorized: false });
  }
});

app.post('/api/auth/phone', async (req, res) => {
  const { phone } = req.body;
  try {
    const client = await getClient();
    const result = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
    pendingPhoneCodeHash = result.phoneCodeHash;
    pendingPhone = phone;
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/code', async (req, res) => {
  const { code } = req.body;
  try {
    const client = await getClient();
    await client.invoke(new Api.auth.SignIn({
      phoneNumber: pendingPhone,
      phoneCodeHash: pendingPhoneCodeHash,
      phoneCode: code,
    }));
    saveSession(await client.session.save());
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    if (tgClient) { await tgClient.destroy(); tgClient = null; }
    if (fs.existsSync(CREDS_FILE)) fs.unlinkSync(CREDS_FILE);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Config ────────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => res.json(loadConfig()));
app.post('/api/config', (req, res) => {
  const cfg = loadConfig();
  Object.assign(cfg, req.body);
  saveConfig(cfg);
  res.json({ ok: true });
});

// ── Channels ─────────────────────────────────────────────────────────────────
app.get('/api/channels', async (req, res) => {
  try {
    const client = await getClient();
    const dialogs = await client.getDialogs({ limit: 200 });
    const channels = dialogs
      .filter(d => d.entity && (d.entity.className === 'Channel' || d.entity.className === 'Chat'))
      .map(d => ({
        id: d.entity.id.toString(),
        title: d.title || d.name || '',
        username: d.entity.username || null,
        participantsCount: d.entity.participantsCount || null,
      }));
    res.json(channels);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Media ────────────────────────────────────────────────────────────────────
app.get('/api/channels/:id/media', async (req, res) => {
  try {
    const client = await getClient();
    const bigInt = require('big-integer');
    const channelId = bigInt(req.params.id);
    const dialogs = await client.getDialogs({ limit: 200 });
    const dialog = dialogs.find(d => d.entity && d.entity.id && d.entity.id.equals(channelId));
    if (!dialog) return res.status(404).json({ error: 'Canal no encontrado' });

    const entity = dialog.entity;
    const media = [];
    let offsetId = 0;

    while (true) {
      const messages = await client.getMessages(entity, { limit: 100, offsetId });
      if (!messages || messages.length === 0) break;
      for (const msg of messages) {
        const info = getMediaInfo(msg);
        if (!info) continue;
        media.push({
          id: msg.id,
          caption: (msg.message || '').trim(),
          date: msg.date,
          mediaType: info.mediaType,
          filename: info.filename,
        });
      }
      offsetId = messages[messages.length - 1].id;
    }

    res.json({ channelId: req.params.id, title: entity.title, media });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Downloads ─────────────────────────────────────────────────────────────────
app.post('/api/download', async (req, res) => {
  const { channelId, channelTitle, messageIds, outputFolder } = req.body;
  if (!channelId || !messageIds || !messageIds.length) {
    return res.status(400).json({ error: 'channelId y messageIds requeridos' });
  }

  const id = uuidv4();
  const { downloadsRoot } = loadConfig();
  const outDir = downloadsRoot
    ? path.join(DOWNLOADS_DIR, downloadsRoot, outputFolder || channelTitle || channelId)
    : path.join(DOWNLOADS_DIR, outputFolder || channelTitle || channelId);

  downloads[id] = {
    id, channelId, channelTitle,
    total: messageIds.length,
    done: 0, failed: 0,
    status: 'queued',
    outDir,
    log: [],
  };

  res.json({ downloadId: id });
  runDownload(id, channelId, messageIds, outDir);
});

async function runDownload(id, channelId, messageIds, outDir) {
  const dl = downloads[id];
  dl.status = 'running';
  broadcast({ type: 'download_update', download: sanitizeDl(dl) });

  try {
    const client = await getClient();
    const bigInt = require('big-integer');
    const cid = bigInt(channelId);
    const dialogs = await client.getDialogs({ limit: 200 });
    const dialog = dialogs.find(d => d.entity && d.entity.id && d.entity.id.equals(cid));
    if (!dialog) throw new Error('Canal no encontrado');
    const entity = dialog.entity;

    fs.mkdirSync(outDir, { recursive: true });

    for (const msgId of messageIds) {
      let skipped = false;
      let success = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const msgs = await client.getMessages(entity, { ids: [msgId] });
          if (!msgs || !msgs[0]) throw new Error('Mensaje no encontrado');
          const info = getMediaInfo(msgs[0]);
          if (!info) { skipped = true; break; }

          const filename = path.join(outDir, info.filename);

          if (attempt === 1 && fs.existsSync(filename)) {
            dl.done++;
            dl.log.push(`[SKIP] ${info.filename}`);
            broadcast({ type: 'download_update', download: sanitizeDl(dl) });
            skipped = true;
            break;
          }

          dl.log.push(`[DL] ${info.filename}${attempt > 1 ? ` (intento ${attempt})` : ''}`);
          broadcast({ type: 'download_update', download: sanitizeDl(dl) });
          await client.downloadMedia(msgs[0], { outputFile: filename });
          dl.done++;
          dl.log.push(`[OK] ${info.filename}`);
          broadcast({ type: 'download_update', download: sanitizeDl(dl) });
          success = true;
          break;
        } catch (e) {
          if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
        }
      }

      if (!skipped && !success) {
        dl.failed++;
        dl.log.push(`[FAIL] msg ${msgId}`);
        broadcast({ type: 'download_update', download: sanitizeDl(dl) });
      }
    }

    dl.status = 'completed';
  } catch (e) {
    dl.status = 'error';
    dl.log.push(`[ERROR] ${e.message}`);
  }

  broadcast({ type: 'download_update', download: sanitizeDl(dl) });
}

app.get('/api/downloads', (req, res) => {
  res.json(Object.values(downloads).map(sanitizeDl));
});

app.delete('/api/downloads/:id', (req, res) => {
  delete downloads[req.params.id];
  res.json({ ok: true });
});

function sanitizeDl(dl) {
  return {
    id: dl.id, channelId: dl.channelId, channelTitle: dl.channelTitle,
    total: dl.total, done: dl.done, failed: dl.failed,
    status: dl.status, outDir: dl.outDir,
    log: dl.log.slice(-50),
    percent: dl.total > 0 ? Math.round((dl.done / dl.total) * 100) : 0,
  };
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'init', downloads: Object.values(downloads).map(sanitizeDl) }));
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`Telegram Downloader UI running on port ${PORT}`));
