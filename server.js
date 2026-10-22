/**
 * Movi Lover — Telegram Stream Proxy
 *  GET /stream?m=<messageId>[&f=<file_id>]   (ফ্রন্টএন্ড এটাই ডাকে)
 *  GET /stream/:file_id
 *  /download — ওয়েব/বট থেকে সম্পূর্ণ বন্ধ (403)। শুধু অফিশিয়াল অ্যাপ, যে X-App-Key হেডার পাঠাবে (APP_DOWNLOAD_KEY মিললে)
 *  GET /health
 *
 * দুই মোড:
 *  1) MTProto (API_ID+API_HASH+CHAT_ID সেট থাকলে) — যেকোনো সাইজ, চ্যানেল-মেসেজ থেকে সরাসরি
 *  2) Bot API getFile — ২০MB পর্যন্ত (Local Bot API সার্ভার দিলে যেকোনো সাইজ)
 * দুই মোডেই HTTP Range (206) সাপোর্ট করে — সিক/ফাস্ট-ফরোয়ার্ড কাজ করে।
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { Readable } = require('stream');

const TOKEN = (process.env.BOT_TOKEN || '').trim();
const API_BASE = (process.env.BOT_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const API_ID = parseInt(process.env.API_ID || '0', 10);
const API_HASH = process.env.API_HASH || '';
const CHAT_ID = (process.env.CHAT_ID || '').trim();
const PORT = process.env.PORT || 3000;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MT_ENABLED = !!(API_ID && API_HASH && (CHAT_ID || process.env.ALLOWED_CHATS));
const ALLOWED_CHATS = (process.env.ALLOWED_CHATS || '').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
const REQ = 512 * 1024; // MTProto chunk (4096 এর গুণিতক, ১MB এর কম)

if (!TOKEN) { console.error('BOT_TOKEN সেট করুন (.env)'); process.exit(1); }

const app = express();
app.disable('x-powered-by');

/* ---------- CORS ---------- */
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (!ORIGINS.length) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (o && ORIGINS.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Disposition');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, mtproto: MT_ENABLED }));

/* ---------- Range পার্সার ---------- */
function parseRange(h, size) {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h).trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let start, end;
  if (m[1] === '') { const n = parseInt(m[2], 10); start = Math.max(0, size - n); end = size - 1; }
  else { start = parseInt(m[1], 10); end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1); }
  if (isNaN(start) || start > end || start >= size) return 'bad';
  return { start, end };
}

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo' };
const mimeOf = (name, fallback) => MIME[path.extname(name || '').toLowerCase()] || fallback || 'video/mp4';
const safeName = n => String(n || 'video.mp4').replace(/[\r\n"\\/:*?<>|]+/g, '_').slice(0, 120) || 'video.mp4';

/* =====================================================================
   সোর্স ১: Bot API getFile  → { size, mime, name, read(start,end,signal) }
   ===================================================================== */
const fileCache = new Map(); // file_id -> { info, at }
async function botGetFile(fileId) {
  const c = fileCache.get(fileId);
  if (c && Date.now() - c.at < 45 * 60 * 1000) return c.info;
  const r = await fetch(`${API_BASE}/bot${TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const j = await r.json().catch(() => ({}));
  if (!j.ok || !j.result || !j.result.file_path) {
    const err = new Error(j.description || 'getFile failed');
    err.code = /too big/i.test(j.description || '') ? 'TOO_BIG' : 'NOT_FOUND';
    throw err;
  }
  const info = { file_path: j.result.file_path, file_size: j.result.file_size };
  fileCache.set(fileId, { info, at: Date.now() });
  return info;
}
async function botSource(fileId) {
  const { file_path, file_size } = await botGetFile(fileId);
  const name = path.basename(file_path);
  // Local Bot API: file_path হলো ডিস্কের পুরো পথ
  if (path.isAbsolute(file_path) && fs.existsSync(file_path)) {
    const size = fs.statSync(file_path).size;
    return { size, name, mime: mimeOf(name), read: (s, e) => fs.createReadStream(file_path, { start: s, end: e }) };
  }
  const url = path.isAbsolute(file_path) ? null : `${API_BASE}/file/bot${TOKEN}/${file_path}`;
  if (!url) { const e = new Error('local file missing'); e.code = 'NOT_FOUND'; throw e; }
  let size = file_size;
  if (!size) { // size জানা না থাকলে HEAD
    const h = await fetch(url, { method: 'HEAD' });
    size = parseInt(h.headers.get('content-length') || '0', 10);
  }
  if (!size) { const e = new Error('unknown size'); e.code = 'NOT_FOUND'; throw e; }
  return {
    size, name, mime: mimeOf(name),
    read: async (s, e, signal) => {
      const up = await fetch(url, { headers: { Range: `bytes=${s}-${e}` }, signal });
      if (!up.ok && up.status !== 206) throw new Error('upstream ' + up.status);
      let stream = Readable.fromWeb(up.body);
      if (up.status === 200 && s > 0) { // আপস্ট্রিম Range না মানলে নিজে কেটে নিই
        let skip = s; let left = e - s + 1;
        stream = stream.pipe(new (require('stream').Transform)({
          transform(chunk, _, cb) {
            if (skip >= chunk.length) { skip -= chunk.length; return cb(); }
            if (skip > 0) { chunk = chunk.subarray(skip); skip = 0; }
            if (left <= 0) return cb();
            if (chunk.length > left) chunk = chunk.subarray(0, left);
            left -= chunk.length; cb(null, chunk);
          }
        }));
      }
      return stream;
    }
  };
}

/* =====================================================================
   সোর্স ২: MTProto (GramJS) — চ্যানেল মেসেজ থেকে, যেকোনো সাইজ
   ===================================================================== */
let mtClientP = null;
function mtClient() {
  if (!mtClientP) {
    mtClientP = (async () => {
      const { TelegramClient } = require('telegram');
      const { StringSession } = require('telegram/sessions');
      const c = new TelegramClient(new StringSession(process.env.SESSION || ''), API_ID, API_HASH, { connectionRetries: 5 });
      await c.start({ botAuthToken: TOKEN });
      try { await c.getEntity(/^-?\d+$/.test(CHAT_ID) ? Number(CHAT_ID) : CHAT_ID); } catch (e) { console.warn('চ্যানেল এন্টিটি রিসলভ হয়নি:', e.message); }
      console.log('MTProto সংযুক্ত');
      return c;
    })().catch(e => { mtClientP = null; throw e; });
  }
  return mtClientP;
}
const msgCache = new Map(); // id -> { msg, at }
async function mtSource(msgId, chatParam) {
  const bigInt = require('big-integer');
  const client = await mtClient();
  const chatRaw = (chatParam || CHAT_ID || '').trim();
  if (!chatRaw) { const e = new Error('CHAT_ID দিন'); e.code = 'BAD'; throw e; }
  if (chatParam && chatParam.toLowerCase() !== CHAT_ID.toLowerCase() && ALLOWED_CHATS.length && !ALLOWED_CHATS.includes(chatParam.toLowerCase())) {
    const e = new Error('এই চ্যানেল অনুমোদিত নয়'); e.code = 'BAD'; throw e;
  }
  const cacheKey = chatRaw + ':' + msgId;
  let hit = msgCache.get(cacheKey);
  if (!hit || Date.now() - hit.at > 20 * 60 * 1000) {
    const chat = /^-?\d+$/.test(chatRaw) ? Number(chatRaw) : chatRaw;
    const list = await client.getMessages(chat, { ids: [Number(msgId)] });
    const msg = list && list[0];
    if (!msg || !msg.media || !msg.media.document) { const e = new Error('message/video not found'); e.code = 'NOT_FOUND'; throw e; }
    hit = { msg, at: Date.now() }; msgCache.set(cacheKey, hit);
  }
  const doc = hit.msg.media.document;
  const size = Number(doc.size);
  const nameAttr = (doc.attributes || []).find(a => a.fileName);
  const name = (nameAttr && nameAttr.fileName) || `video_${msgId}.mp4`;
  return {
    size, name, mime: doc.mimeType && doc.mimeType.startsWith('video/') ? doc.mimeType : mimeOf(name),
    read: async function* (s, e, signal) {
      const aligned = s - (s % REQ);
      let pos = aligned;
      for await (const chunk of client.iterDownload({ file: hit.msg.media, offset: bigInt(aligned), requestSize: REQ })) {
        if (signal && signal.aborted) return;
        let buf = Buffer.from(chunk);
        const cs = pos, ce = pos + buf.length - 1;
        pos += buf.length;
        if (ce < s) continue;
        const from = Math.max(0, s - cs), to = Math.min(buf.length, e - cs + 1);
        yield buf.subarray(from, to);
        if (ce >= e) return;
      }
    }
  };
}

/* ---------- রিকোয়েস্ট থেকে সোর্স বাছাই ---------- */
async function pickSource(req) {
  const fileId = req.params.file_id || req.query.f;
  const m = req.query.m;
  if (m && MT_ENABLED) return mtSource(String(m).replace(/\D/g, ''), req.query.c ? String(req.query.c) : '');
  if (fileId) return botSource(String(fileId));
  if (m && !MT_ENABLED) { const e = new Error('MTProto চালু নেই (API_ID/API_HASH/CHAT_ID দিন) অথবা &f=<file_id> দিন'); e.code = 'NO_MT'; throw e; }
  const e = new Error('file_id বা m দিন'); e.code = 'BAD'; throw e;
}

/* ---------- মূল হ্যান্ডলার (206 Partial Content) ---------- */
async function serve(req, res, download) {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  let src;
  try { src = await pickSource(req); }
  catch (e) {
    const code = e.code === 'TOO_BIG' ? 413 : e.code === 'NOT_FOUND' ? 404 : e.code === 'NO_MT' || e.code === 'BAD' ? 400 : 502;
    return res.status(code).json({ error: e.code === 'TOO_BIG' ? 'ফাইল ২০MB-এর বেশি — MTProto (API_ID/API_HASH/CHAT_ID) বা Local Bot API লাগবে' : e.message });
  }
  const { size } = src;
  const range = parseRange(req.headers.range, size);
  if (range === 'bad') { res.setHeader('Content-Range', `bytes */${size}`); return res.sendStatus(416); }

  const start = range ? range.start : 0, end = range ? range.end : size - 1;
  res.status(range ? 206 : 200);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', download ? 'application/octet-stream' : src.mime);
  res.setHeader('Content-Length', end - start + 1);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  if (download) {
    const fname = safeName(req.query.name || src.name);
    res.setHeader('Content-Disposition', `attachment; filename="${fname.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  }
  if (req.method === 'HEAD') return res.end();

  try {
    const stream = await src.read(start, end, ac.signal);
    for await (const chunk of stream) {
      if (ac.signal.aborted) break;
      if (!res.write(chunk)) await once(res, 'drain');
    }
    res.end();
  } catch (e) {
    if (!ac.signal.aborted) console.error('stream error:', e.message);
    res.destroy();
  }
}

app.get(['/stream', '/stream/:file_id'], (req, res) => serve(req, res, false));
app.head(['/stream', '/stream/:file_id'], (req, res) => serve(req, res, false));
/* ডাউনলোড: ডিফল্টে সম্পূর্ণ বন্ধ। শুধু .env-এ APP_DOWNLOAD_KEY দিলে এবং অফিশিয়াল অ্যান্ড্রয়েড অ্যাপ
   X-App-Key হেডারে সেই কী পাঠালে চালু হয়। ওয়েব পেজের JS-এ এই কী কখনো রাখবেন না। */
const APP_KEY = process.env.APP_DOWNLOAD_KEY || '';
app.all(['/download', '/download/:file_id'], (req, res) => {
  const k = String(req.headers['x-app-key'] || '');
  const ok = APP_KEY && k.length === APP_KEY.length && require('crypto').timingSafeEqual(Buffer.from(k), Buffer.from(APP_KEY));
  if (!ok) return res.status(403).json({ error: 'ডাউনলোড শুধু অফিশিয়াল অ্যাপে চালু আছে।' });
  return serve(req, res, true);
});

app.listen(PORT, () => console.log(`Stream proxy চলছে :${PORT} — MTProto: ${MT_ENABLED ? 'চালু' : 'বন্ধ (শুধু Bot API)'}`));
