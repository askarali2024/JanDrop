'use strict';

/**
 * JanDrop — lightweight self-hosted LAN file sharing & clipboard hub.
 *
 *   browser SPA (public/)  <──SSE──>  /api/events  <──  Express routes
 *        │  uploads (busboy → streamed to disk)   │  downloads (stream + Range)
 *        ▼                                          ▼
 *   ./uploads/<id><ext>                    ./data/items.json (metadata store)
 *
 * A cleanup worker prunes expired items every 30s and broadcasts removals.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const Busboy = require('busboy');
const QRCode = require('qrcode');

/* ────────────────────────────── Configuration ───────────────────────────── */

const PORT = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'items.json');
const MAX_FILE_SIZE_MB = Number.parseFloat(process.env.MAX_FILE_SIZE_MB || '') || 0; // 0 = unlimited
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB > 0 ? Math.floor(MAX_FILE_SIZE_MB * 1024 * 1024) : 0;
const MAX_TEXT_CHARS = 1_000_000;
const CLEANUP_INTERVAL_MS = 30_000;
const EXPIRY_MODES = new Set(['never', '1h', '24h', 'burn']);

/* ────────────────────────────── Item store ─────────────────────────────── */

/** @type {Map<string, object>} id → item */
const items = new Map();
let saveTimer = null;

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function loadItems() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    for (const it of JSON.parse(raw)) items.set(it.id, it);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[jandrop] failed to read items.json:', err.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${DB_FILE}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify([...items.values()], null, 2));
      await fsp.rename(tmp, DB_FILE);
    } catch (err) {
      console.error('[jandrop] failed to persist items:', err.message);
    }
  }, 250);
}

function sanitizeFilename(name) {
  const base = path
    .basename(String(name || 'file'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\/]/g, '_')
    .trim();
  return base.length ? base.slice(0, 255) : 'file';
}

function makeItem(base, expiresMode) {
  const now = Date.now();
  const item = {
    id: base.id,
    type: base.type, // 'file' | 'text'
    filename: base.filename || null,
    text: base.text || null,
    size: base.size,
    mimeType: base.mimeType || null,
    createdAt: now,
    expiresAt: null,
    maxDownloads: null,
    downloadCount: 0,
    storedName: base.storedName || null,
  };
  if (expiresMode === '1h') item.expiresAt = now + 60 * 60 * 1000;
  else if (expiresMode === '24h') item.expiresAt = now + 24 * 60 * 60 * 1000;
  else if (expiresMode === 'burn') item.maxDownloads = 1;
  return item;
}

function itemFilePath(item) {
  // storedName is server-generated; basename() is a defensive guard
  return path.join(UPLOAD_DIR, path.basename(item.storedName));
}

function publicItem(item) {
  const { storedName, ...rest } = item;
  return rest;
}

function isExpired(item, now = Date.now()) {
  return typeof item.expiresAt === 'number' && item.expiresAt <= now;
}

async function deleteItem(id, reason = 'deleted') {
  const item = items.get(id);
  if (!item) return false;
  items.delete(id);
  scheduleSave();
  if (item.type === 'file' && item.storedName) {
    try {
      await fsp.rm(itemFilePath(item), { force: true });
    } catch {
      /* best effort */
    }
  }
  broadcastSse('item:deleted', { id, reason });
  return true;
}

/* ────────────────────────────── SSE hub ────────────────────────────────── */

/** @type {Set<import('express').Response>} */
const sseClients = new Set();

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastSse(event, data) {
  for (const res of sseClients) {
    try {
      sseSend(res, event, data);
    } catch {
      /* socket already gone; 'close' handler cleans up */
    }
  }
}

/* ────────────────────────────── App & routes ───────────────────────────── */

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

/* Live event stream ------------------------------------------------------ */

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  broadcastSse('clients', { count: sseClients.size });

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    if (sseClients.delete(res)) broadcastSse('clients', { count: sseClients.size });
  });
});

/* Item list -------------------------------------------------------------- */

app.get('/api/items', (req, res) => {
  const list = [...items.values()]
    .filter((it) => !isExpired(it))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicItem);
  res.json({ items: list });
});

/* Server info (LAN URL for QR) ------------------------------------------- */

function lanUrl() {
  return `http://${pickLanIp()}:${PORT}`;
}

/**
 * Pick the LAN IP other devices can actually reach.
 * os.networkInterfaces() order is arbitrary — on machines with VirtualBox,
 * VMware, or WSL adapters the first non-internal IP is often a virtual
 * network (e.g. VirtualBox's 192.168.56.1) that no phone can connect to.
 *
 * Strategy: ask the OS which local address outbound traffic would use, by
 * "connecting" a UDP socket to a public IP. UDP connect sends no packets —
 * it only makes the kernel pick a route — so this works offline too.
 */
function pickLanIp() {
  try {
    const dgram = require('dgram');
    const sock = dgram.createSocket('udp4');
    sock.connect(53, '8.8.8.8');
    const ip = sock.address().address;
    sock.close();
    if (ip && !ip.startsWith('127.')) return ip;
  } catch {
    /* no route at all (fully offline) — fall through */
  }
  // Fallback: first non-internal IPv4, skipping common virtual-adapter
  // subnets (VirtualBox host-only 192.168.56.x/192.168.85.x, WSL 172.x).
  const virtual = [/^192\.168\.(56|85)\./, /^172\.(1[6-9]|2\d|3[01])\./];
  const lists = Object.values(os.networkInterfaces());
  const candidates = [];
  for (const list of lists) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) candidates.push(addr.address);
    }
  }
  return (
    candidates.find((ip) => !virtual.some((re) => re.test(ip))) ||
    candidates[0] ||
    'localhost'
  );
}

app.get('/api/server-info', (req, res) => {
  res.json({ url: lanUrl(), version: require('./package.json').version });
});

app.get('/api/qr', async (req, res) => {
  const data = Array.isArray(req.query.data) ? String(req.query.data[0]) : String(req.query.data || '');
  if (!data || data.length > 512) return res.status(400).json({ error: 'Missing or oversized data param' });
  try {
    const svg = await QRCode.toString(data, {
      type: 'svg',
      margin: 1,
      width: 240,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f111a', light: '#ffffff' },
    });
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

/* File upload (busboy streams straight to disk) --------------------------- */

app.post('/api/upload', (req, res) => {
  let expiresMode = 'never';
  let requestTooLarge = false;
  let responded = false;
  const created = [];
  const pendingWrites = []; // one promise per file, resolves when its disk write settles
  const inFlight = new Set(); // paths currently being written (for abort sweep)

  const limits = { files: 50 };
  if (MAX_FILE_SIZE_BYTES) limits.fileSize = MAX_FILE_SIZE_BYTES;
  // busboy v1.x exports a factory function (not a constructor)
  const bb = Busboy({ headers: req.headers, limits });

  bb.on('field', (name, value) => {
    if (name === 'expires' && EXPIRY_MODES.has(value)) expiresMode = value;
  });

  bb.on('file', (_field, stream, info) => {
    const filename = sanitizeFilename(info.filename);
    const rawExt = path.extname(filename);
    const ext = /^[\w.\-]{0,20}$/.test(rawExt) ? rawExt : '';
    const id = uid();
    const storedName = id + ext;
    const filePath = path.join(UPLOAD_DIR, storedName);

    const out = fs.createWriteStream(filePath);
    let bytes = 0;
    let tooLarge = false;

    inFlight.add(filePath);
    stream.on('data', (chunk) => {
      bytes += chunk.length;
    });
    stream.on('limit', () => {
      // busboy enforced MAX_FILE_SIZE_BYTES and truncated the stream
      tooLarge = true;
      requestTooLarge = true;
    });

    pendingWrites.push(
      new Promise((resolve) => {
        const settle = () => {
          inFlight.delete(filePath);
          resolve();
        };
        out.on('error', () => {
          fsp.rm(filePath, { force: true }).catch(() => {});
          settle();
        });
        out.on('finish', () => {
          if (tooLarge) {
            fsp.rm(filePath, { force: true }).catch(() => {});
            return settle();
          }
          const item = makeItem(
            {
              id,
              type: 'file',
              filename,
              storedName,
              size: bytes,
              mimeType: info.mimeType || 'application/octet-stream',
            },
            expiresMode
          );
          items.set(id, item);
          scheduleSave();
          created.push(item);
          settle();
        });
      })
    );

    stream.pipe(out);
  });

  // If the client aborts mid-upload, sweep partial files that never completed.
  // NOTE: in Node >=16 'close' also fires when a fully-received request message
  // completes — before busboy finishes and 'finish' sets `responded`. Sweeping
  // then would delete just-uploaded files, so only sweep if the request body
  // was genuinely cut off (req.complete === false).
  req.on('close', () => {
    if (responded || res.writableEnded || req.complete) return;
    for (const p of inFlight) fsp.rm(p, { force: true }).catch(() => {});
  });

  bb.on('error', () => {
    if (responded) return;
    responded = true;
    for (const p of inFlight) fsp.rm(p, { force: true }).catch(() => {});
    res.status(400).json({ error: 'Malformed upload request' });
  });

  bb.on('finish', async () => {
    if (responded) return;
    responded = true;
    // busboy's 'finish' means the request was parsed — the piped disk writes
    // may still be flushing. Wait for them before responding.
    await Promise.all(pendingWrites);
    if (requestTooLarge) {
      return res.status(413).json({
        error: `File exceeds MAX_FILE_SIZE_MB (${MAX_FILE_SIZE_MB} MB)`,
      });
    }
    if (!created.length) return res.status(400).json({ error: 'No file received' });
    for (const item of created) broadcastSse('item:created', { item: publicItem(item) });
    res.status(201).json({ items: created.map(publicItem) });
  });

  req.pipe(bb);
});

/* Text snippet ----------------------------------------------------------- */

app.post('/api/text', express.json({ limit: '2mb' }), (req, res) => {
  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : '';
  const expiresMode = EXPIRY_MODES.has(body.expires) ? body.expires : 'never';

  if (!text.trim()) return res.status(400).json({ error: 'Text is empty' });
  if (text.length > MAX_TEXT_CHARS) {
    return res.status(413).json({ error: `Text exceeds ${MAX_TEXT_CHARS} characters` });
  }

  const item = makeItem(
    { id: uid(), type: 'text', text, size: Buffer.byteLength(text, 'utf8'), mimeType: 'text/plain' },
    expiresMode
  );
  items.set(item.id, item);
  scheduleSave();
  broadcastSse('item:created', { item: publicItem(item) });
  res.status(201).json({ item: publicItem(item) });
});

/* Text snippet copy (burn counting) -------------------------------------- */

app.post('/api/items/:id/copy', (req, res) => {
  const item = items.get(req.params.id);
  if (!item || item.type !== 'text') return res.status(404).json({ error: 'Item not found' });

  item.downloadCount += 1;
  scheduleSave();
  broadcastSse('item:updated', { id: item.id, downloadCount: item.downloadCount });

  // For burn items, a copy is the single use.
  if (item.maxDownloads != null && item.downloadCount >= item.maxDownloads) {
    deleteItem(item.id, 'burned'); // broadcasts item:deleted
    return res.json({ ok: true, burned: true });
  }
  res.json({ ok: true, burned: false });
});

/* Download (stream + HTTP Range support) --------------------------------- */

app.get('/api/items/:id/download', async (req, res) => {
  const item = items.get(req.params.id);
  if (!item || item.type !== 'file') return res.status(404).json({ error: 'Item not found' });

  const filePath = itemFilePath(item);
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return res.status(404).json({ error: 'File is missing on disk' });
  }

  const mime = item.mimeType || 'application/octet-stream';
  const asciiName = item.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  const inline = req.query.inline === '1';
  const disposition =
    `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(item.filename)}`;

  // A "full fetch" is a download without a Range header, or an open-ended
  // "bytes=0-" range (what browsers send for the initial media load).
  // Partial/seek ranges (e.g. "bytes=5000-") do not count, so scrubbing a
  // video preview does not consume burn-after-download items.
  // Preview requests (?inline=1 — <img>/<video>/<audio> cards) never count
  // either: otherwise simply rendering a burn photo in the feed would
  // consume it the moment its preview loads.
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range.trim() : '';
  const isFullFetch = !rangeHeader || /^bytes=0-$/i.test(rangeHeader);
  let burnAfterResponse = false;

  if (req.method === 'GET' && isFullFetch && !inline) {
    item.downloadCount += 1;
    scheduleSave();
    broadcastSse('item:updated', { id: item.id, downloadCount: item.downloadCount });
    if (item.maxDownloads != null && item.downloadCount >= item.maxDownloads) burnAfterResponse = true;
  }

  res.on('finish', () => {
    if (burnAfterResponse) deleteItem(item.id, 'burned');
  });

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', disposition);
  res.setHeader('Cache-Control', 'no-store');

  const match = rangeHeader ? /bytes=(\d*)-(\d*)/.exec(rangeHeader) : null;
  if (match) {
    let start = match[1] === '' ? null : Number.parseInt(match[1], 10);
    let end = match[2] === '' ? null : Number.parseInt(match[2], 10);
    if (start === null && end !== null) {
      // suffix range: "bytes=-N" = last N bytes
      start = Math.max(0, stat.size - end);
      end = stat.size - 1;
    } else {
      if (start === null) start = 0;
      if (end === null || end >= stat.size) end = stat.size - 1;
    }
    if (start <= end && start < stat.size) {
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
    }
    return;
  }

  res.writeHead(200, { 'Content-Length': stat.size });
  fs.createReadStream(filePath).pipe(res);
});

/* Delete / clear ---------------------------------------------------------- */

app.delete('/api/items/:id', async (req, res) => {
  const ok = await deleteItem(req.params.id, 'deleted');
  if (!ok) return res.status(404).json({ error: 'Item not found' });
  res.json({ ok: true });
});

app.post('/api/items/clear-expired', async (req, res) => {
  const now = Date.now();
  const ids = [...items.values()].filter((it) => isExpired(it, now)).map((it) => it.id);
  for (const id of ids) await deleteItem(id, 'expired');
  res.json({ removed: ids.length });
});

app.post('/api/items/clear-all', async (req, res) => {
  const ids = [...items.keys()];
  for (const id of ids) await deleteItem(id, 'cleared');
  res.json({ removed: ids.length });
});

/* Fallbacks & errors ------------------------------------------------------ */

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[jandrop] error:', err.message);
  res.status(err.status || 500).json({ error: err.status ? 'Invalid request' : 'Internal server error' });
});

/* ────────────────────────────── Cleanup worker ────────────────────────── */

async function cleanupPass() {
  const now = Date.now();
  for (const item of [...items.values()]) {
    if (isExpired(item, now)) await deleteItem(item.id, 'expired');
  }
}

/* ────────────────────────────── Boot ──────────────────────────────────── */

async function main() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  loadItems();

  // Drop file items whose backing file vanished while we were down.
  let pruned = 0;
  for (const item of [...items.values()]) {
    if (item.type !== 'file') continue;
    try {
      await fsp.access(itemFilePath(item));
    } catch {
      items.delete(item.id);
      pruned++;
    }
  }
  if (pruned) {
    console.log(`[jandrop] pruned ${pruned} item(s) with missing files`);
    scheduleSave();
  }

  await cleanupPass();

  app.listen(PORT, () => {
    const size = MAX_FILE_SIZE_MB > 0 ? `${MAX_FILE_SIZE_MB} MB` : 'unlimited';
    console.log('');
    console.log('  ✔ JanDrop is up');
    console.log(`    Local:    http://localhost:${PORT}`);
    console.log(`    LAN:      ${lanUrl()}`);
    console.log(`    Uploads:  ${UPLOAD_DIR}`);
    console.log(`    Data:     ${DB_FILE}`);
    console.log(`    Max size: ${size}`);
    console.log('');
  });

  setInterval(() => {
    cleanupPass().catch((err) => console.error('[jandrop] cleanup error:', err.message));
  }, CLEANUP_INTERVAL_MS);
}

main().catch((err) => {
  console.error('[jandrop] fatal:', err);
  process.exit(1);
});
