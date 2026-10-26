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
const ALLOWED_CHATS_RAW = (process.env.ALLOWED_CHATS || '').split(',').map(x=>x.trim()).filter(Boolean);
const ALLOWED_CHATS = ALLOWED_CHATS_RAW.map(x=>x.toLowerCase());
const REQ = 1024 * 1024; // MTProto chunk = ১MB (সর্বোচ্চ; কম রাউন্ড-ট্রিপ = বড় ভিডিও দ্রুত)

if (!TOKEN) { console.error('BOT_TOKEN সেট করুন (.env)'); process.exit(1); }

/* GramJS ব্যাকগ্রাউন্ডে মাঝে মাঝে TIMEOUT ইত্যাদি এরর ছোড়ে — এগুলো সার্ভার ক্র্যাশ করালে Railway-তে সব ভিডিও একসাথে 502 হয়ে যায় */
process.on('unhandledRejection', (e) => console.warn('unhandledRejection:', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.warn('uncaughtException:', e && e.message ? e.message : e));

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
/* অ্যাডমিনে লিংকের শেষে / থাকলে //stream হয়ে যায় — বাড়তি স্ল্যাশ সরিয়ে দিই */
app.use((req, res, next) => { req.url = req.url.replace(/^\/{2,}/, '/'); next(); });

/* ---------- CORS ---------- */
app.use((req, res, next) => {
  /* CORS শুধু ব্রাউজারের fetch() আটকায়, <video> ট্যাগ আটকায় না — তাই ALLOWED_ORIGINS দিয়ে ভিডিও সুরক্ষা হয় না।
     প্লেয়ার যেন সার্ভারের এরর-বার্তা পড়তে পারে, সেজন্য সবসময় অনুমতি দিই। */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Disposition');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
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
      console.log('MTProto সংযোগ হচ্ছে...' + (process.env.SESSION ? ' (সেভ করা SESSION ব্যবহার হচ্ছে)' : ''));
      try { c.setLogLevel('error'); } catch (e) {}
      await c.start({ botAuthToken: TOKEN });
      if (!process.env.SESSION) {
        try {
          const str = c.session.save();
          console.log('\n================ SESSION STRING ================\n' + str + '\n================================================\n' +
            'উপরের লম্বা লেখাটা কপি করে Railway → Variables-এ SESSION নামে বসান (লোড হলে আর লগইন লাগবে না)। এটা গোপন রাখুন।\n');
        } catch (e) { console.warn('SESSION ছাপা যায়নি:', e.message); }
      }
      try { await c.getEntity(/^-?\d+$/.test(CHAT_ID) ? Number(CHAT_ID) : CHAT_ID); } catch (e) { console.warn('চ্যানেল এন্টিটি রিসলভ হয়নি:', e.message); }
      console.log('MTProto সংযুক্ত');
      return c;
    })().catch(e => { mtClientP = null; throw e; });
  }
  return mtClientP;
}
const msgCache = new Map(); // id -> { msg, at }
/* MTProto থেকে [s..e] বাইট পড়া। iterDownload-কে সরাসরি InputDocumentFileLocation + dcId + fileSize দিই
   (খালি Document দিলে "Cannot cast Document to any kind of InputFileLocation" এরর হয়) */
async function* mtReadRange(client, doc, s, e, signal, onFail) {
  const { Api } = require('telegram');
  const bigInt = require('big-integer');
  const aligned = s - (s % REQ);
  let pos = aligned;
  const location = new Api.InputDocumentFileLocation({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: '' });
  try {
    for await (const chunk of client.iterDownload({ file: location, dcId: doc.dcId, fileSize: doc.size, offset: bigInt(aligned), requestSize: REQ })) {
      if (signal && signal.aborted) return;
      const buf = Buffer.from(chunk);
      const cs = pos, ce = pos + buf.length - 1;
      pos += buf.length;
      if (ce < s) continue;
      const from = Math.max(0, s - cs), to = Math.min(buf.length, e - cs + 1);
      yield buf.subarray(from, to);
      if (ce >= e) return;
    }
  } catch (err) { if (onFail) onFail(); throw err; }   // ব্যর্থ হলে ক্যাশ মুছি, পরের রিকোয়েস্টে মেসেজ নতুন করে আনা হবে
}

const peerCache = new Map();
async function resolvePeer(client, chatRaw) {
  if (peerCache.has(chatRaw)) return peerCache.get(chatRaw);
  const { Api } = require('telegram');
  const bigInt = require('big-integer');
  let peer;
  if (/^-?\d+$/.test(chatRaw)) {
    const n = Number(chatRaw);
    try { peer = await client.getInputEntity(n); }
    catch (e) {
      // প্রাইভেট চ্যানেল: -100xxxxxxxxxx থেকে channelId বের করে সরাসরি চেষ্টা
      const cid = String(chatRaw).replace(/^-100/, '').replace(/^-/, '');
      peer = new Api.InputPeerChannel({ channelId: bigInt(cid), accessHash: bigInt(0) });
    }
  } else {
    peer = await client.getInputEntity(chatRaw.replace(/^@/, ''));
  }
  peerCache.set(chatRaw, peer);
  return peer;
}
async function mtSource(msgId, chatParam) {
  const bigInt = require('big-integer');
  const client = await mtClient();
  const chatRaw = (chatParam || CHAT_ID || '').trim();
  if (!chatRaw) { const e = new Error('CHAT_ID দিন'); e.code = 'BAD'; throw e; }
  if (chatParam && chatParam.toLowerCase() !== CHAT_ID.toLowerCase() && ALLOWED_CHATS.length && !ALLOWED_CHATS.includes(chatParam.toLowerCase())) {
    const e = new Error('এই চ্যানেল (' + chatParam + ') অনুমোদিত নয় — Railway Variables-এর ALLOWED_CHATS-এ যোগ করুন'); e.code = 'BAD'; throw e;
  }
  const cacheKey = chatRaw + ':' + msgId;
  let hit = msgCache.get(cacheKey);
  if (!hit || Date.now() - hit.at > 20 * 60 * 1000) {
    const peer = await resolvePeer(client, chatRaw);
    const list = await client.getMessages(peer, { ids: [Number(msgId)] });
    const msg = list && list[0];
    if (!msg || !msg.media || !msg.media.document) { const e = new Error('message/video not found'); e.code = 'NOT_FOUND'; throw e; }
    hit = { msg, at: Date.now() }; msgCache.set(cacheKey, hit);
  }
  const doc = hit.msg.media.document;
  const size = Number(doc.size);
  const nameAttr = (doc.attributes || []).find(a => a.fileName);
  const name = (nameAttr && nameAttr.fileName) || `video_${msgId}.mp4`;
  return {
    size, name, docId: String(doc.id), mime: doc.mimeType && doc.mimeType.startsWith('video/') ? doc.mimeType : mimeOf(name),
    read: (s, e, signal) => mtReadRange(client, doc, s, e, signal, () => msgCache.delete(cacheKey))
  };
}

/* Bot API file_id থেকে ডকুমেন্ট আইডি বের করা — একাধিক চ্যানেলে একই মেসেজ নম্বর থাকলে সঠিক ভিডিও চিনতে */
function fileIdDocId(fid) {
  try {
    const raw = Buffer.from(String(fid).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === 0 && i + 1 < raw.length) { for (let k = 0; k < raw[i + 1]; k++) out.push(0); i++; } else out.push(raw[i]);
    }
    const d = Buffer.from(out);
    const type = d.readInt32LE(0);
    let pos = 8;
    if (type & (1 << 25)) {                       // file reference (TL bytes)
      let len = d[pos], head = 1;
      if (len === 254) { len = d[pos + 1] | (d[pos + 2] << 8) | (d[pos + 3] << 16); head = 4; }
      pos += head + len; while ((pos - 8) % 4 !== 0) pos++;
    }
    return d.readBigInt64LE(pos).toString();
  } catch (e) { return null; }
}
async function mtSourceMulti(msgId, chatParam, fileId) {
  const cands = chatParam ? [chatParam] : Array.from(new Set([CHAT_ID, ...ALLOWED_CHATS_RAW].filter(Boolean)));
  const want = fileId ? fileIdDocId(fileId) : null;
  let first = null, lastErr = null;
  for (const chat of cands) {
    try {
      const src = await mtSource(msgId, chat);
      if (!want || src.docId === want) return src;
      if (!first) first = src;
    } catch (e) { lastErr = e; }
  }
  if (first) { if (cands.length > 1) console.warn('file_id মেলেনি, প্রথম চ্যানেলের মেসেজ ব্যবহার হচ্ছে'); return first; }
  throw lastErr || new Error('মেসেজ কোনো চ্যানেলে পাওয়া যায়নি');
}

/* ---------- সাহায্যকারী ---------- */
let mtDownUntil = 0;
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timeout')), ms))]);

/* ---------- রিকোয়েস্ট থেকে সোর্স বাছাই ---------- */
async function pickSource(req) {
  const fileId = req.params.file_id || req.query.f;
  const m = req.query.m;
  if (m && MT_ENABLED && !(fileId && Date.now() < mtDownUntil)) {
    try { return await withTimeout(mtSourceMulti(String(m).replace(/\D/g, ''), req.query.c ? String(req.query.c) : '', fileId ? String(fileId) : ''), fileId ? 10000 : 25000, 'MTProto'); }
    catch (err) {
      console.warn('MTProto ব্যর্থ:', err.message);
      if (fileId) mtDownUntil = Date.now() + 60000;   // ১ মিনিট MTProto বাদ দিয়ে সরাসরি Bot API (ছোট ভিডিও দ্রুত চলবে)
      if (!fileId) { const e = new Error('MTProto ব্যর্থ: ' + err.message + ' — /diag?m=' + m + ' দিয়ে কারণ দেখুন'); e.code = 'MT_FAIL'; throw e; }
      // file_id থাকলে (ছোট ভিডিও) Bot API দিয়ে চালিয়ে দেওয়া
    }
  }
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
    console.warn('stream request ব্যর্থ:', e.code || '', e.message);
    return res.status(code).json({ error: e.code === 'TOO_BIG' ? 'ফাইল ২০MB-এর বেশি — MTProto (API_ID/API_HASH/CHAT_ID) বা Local Bot API লাগবে' : e.message });
  }
  const { size } = src;
  const range = parseRange(req.headers.range, size);
  if (range === 'bad') { res.setHeader('Content-Range', `bytes */${size}`); return res.sendStatus(416); }

  const start = range ? range.start : 0, end = range ? range.end : size - 1;
  const tag = (req.query.m ? 'm=' + req.query.m + (req.query.c ? ' c=' + req.query.c : '') : 'f=' + String(req.params.file_id || req.query.f || '').slice(0, 12)) + ' ' + start + '-' + end + '/' + size;
  const setHeaders = (source) => {
    res.status(range ? 206 : 200);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', download ? 'application/octet-stream' : source.mime);
    res.setHeader('Content-Length', end - start + 1);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    if (download) {
      const fname = safeName(req.query.name || source.name);
      res.setHeader('Content-Disposition', `attachment; filename="${fname.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    }
  };
  if (req.method === 'HEAD') { setHeaders(src); return res.end(); }

  console.log('stream অনুরোধ ' + tag);
  /* প্রথম চাঙ্ক আগে আনি, তারপর হেডার পাঠাই: ডাউনলোড ব্যর্থ হলে "সংযোগ কেটে যাচ্ছে" নয়, আসল কারণসহ JSON এরর যাবে */
  const open = async (source) => {
    const stream = await source.read(start, end, ac.signal);
    const it = stream[Symbol.asyncIterator]();
    const first = await withTimeout(it.next(), 60000, 'প্রথম ডেটা আসতে দেরি');
    return { it, first, source };
  };
  let opened;
  try { opened = await open(src); }
  catch (e1) {
    console.warn('প্রথম চেষ্টা ব্যর্থ: ' + tag + ' — ' + e1.message + ' (আবার চেষ্টা হচ্ছে)');
    try { opened = await open(await pickSource(req)); }
    catch (e2) {
      console.error('stream error: ' + tag + ' — ' + e2.message);
      if (ac.signal.aborted) return;
      return res.status(502).json({ error: 'ভিডিও ডাউনলোড ব্যর্থ: ' + e2.message });
    }
  }

  const t0 = Date.now(); let sent = 0;
  try {
    setHeaders(opened.source);
    let cur = opened.first;
    while (!cur.done) {
      if (ac.signal.aborted) break;
      sent += cur.value.length;
      if (!res.write(cur.value)) await once(res, 'drain');
      cur = await opened.it.next();
    }
    if (ac.signal.aborted && opened.it.return) { try { await opened.it.return(); } catch (e) {} }
    res.end();
    console.log('stream ' + (ac.signal.aborted ? 'বন্ধ(ক্লায়েন্ট)' : 'শেষ') + ' ' + tag + ' পাঠানো=' + Math.round(sent / 1024) + 'KB ' + (Date.now() - t0) + 'ms');
  } catch (e) {
    if (!ac.signal.aborted) console.error('stream error (মাঝপথে): ' + tag + ' — ' + e.message);
    res.destroy();
  }
}

/* /diag?m=<মেসেজ নম্বর>&c=<চ্যানেল>[&f=<file_id>] — ধাপে ধাপে দেখায় কোথায় আটকাচ্ছে */
app.get('/diag', async (req, res) => {
  if (process.env.DIAG_KEY && req.query.k !== process.env.DIAG_KEY) return res.status(403).json({ error: 'DIAG_KEY লাগবে (?k=...)' });
  const out = { mtprotoEnabled: MT_ENABLED, chatDefault: CHAT_ID || null, steps: [] };
  const step = (n, ok, info) => out.steps.push({ step: n, ok, info });
  try {
    const me = await (await fetch(`${API_BASE}/bot${TOKEN}/getMe`)).json();
    step('বট টোকেন (getMe)', !!me.ok, me.ok ? '@' + me.result.username : me.description);
  } catch (e) { step('বট টোকেন (getMe)', false, e.message); }
  if (MT_ENABLED && req.query.m) {
    try {
      const chat = (req.query.c ? String(req.query.c) : CHAT_ID);
      const client = await withTimeout(mtClient(), 20000, 'MTProto connect'); step('MTProto সংযোগ', true, 'ঠিক আছে');
      const peer = await withTimeout(resolvePeer(client, chat), 15000, 'peer'); step('চ্যানেল চেনা (' + chat + ')', true, peer.className);
      const list = await withTimeout(client.getMessages(peer, { ids: [Number(req.query.m)] }), 15000, 'getMessages');
      const msg = list && list[0];
      step('মেসেজ #' + req.query.m, !!msg, msg ? 'পাওয়া গেছে' : 'মেসেজ নেই — নম্বর/চ্যানেল মেলান');
      const doc = msg && msg.media && msg.media.document;
      step('ভিডিও ফাইল আছে?', !!doc, doc ? ('সাইজ ' + Math.round(Number(doc.size) / 1048576) + ' MB, ধরন ' + doc.mimeType) : 'মেসেজে ভিডিও/ডকুমেন্ট নেই');
      if (doc) {   // আসল ডাউনলোড পরীক্ষা: শুরুর ১২৮KB আর মাঝখান থেকে ১২৮KB টেনে দেখি
        try {
          const t0 = Date.now(); let n = 0;
          for await (const b of mtReadRange(client, doc, 0, 131071, null)) n += b.length;
          const mid = Math.max(0, Math.floor(Number(doc.size) / 2) - 65536); let n2 = 0;
          for await (const b of mtReadRange(client, doc, mid, mid + 131071, null)) n2 += b.length;
          step('ডাউনলোড টেস্ট (শুরু + মাঝখান)', n > 0 && n2 > 0, n + ' + ' + n2 + ' bytes, ' + (Date.now() - t0) + ' ms');
        } catch (e) { step('ডাউনলোড টেস্ট', false, e.message); }
      }
    } catch (e) { step('MTProto', false, e.message); }
  } else if (!MT_ENABLED) step('MTProto', false, 'বন্ধ — API_ID, API_HASH, CHAT_ID সেট করুন (২০MB-এর বেশি ভিডিওর জন্য আবশ্যক)');
  if (req.query.f) {
    try { const r = await botGetFile(String(req.query.f)); step('Bot API getFile', true, 'file_size ' + r.file_size); }
    catch (e) { step('Bot API getFile', false, e.code === 'TOO_BIG' ? 'ফাইল ২০MB-এর বেশি' : e.message); }
  }
  res.json(out);
});

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

if (require.main === module) app.listen(PORT, () => {
  console.log(`Stream proxy চলছে :${PORT} — MTProto: ${MT_ENABLED ? 'চালু' : 'বন্ধ (শুধু Bot API)'}`);
  if (!MT_ENABLED) {
    const miss = [!API_ID && 'API_ID', !API_HASH && 'API_HASH', !(CHAT_ID || process.env.ALLOWED_CHATS) && 'CHAT_ID'].filter(Boolean);
    console.log('MTProto বন্ধ কারণ এই ভেরিয়েবল নেই/খালি: ' + (miss.join(', ') || '—') + ' (Railway Variables দেখুন, নাম হুবহু বড় হাতের হতে হবে)');
    return;
  }
  // স্টার্টেই সংযোগ করি, যাতে SESSION লগে এখনই আসে (প্রথম ভিডিও চাপার অপেক্ষা না করে)
  mtClient().then(() => console.log('MTProto প্রস্তুত')).catch(e => console.error('MTProto সংযোগ ব্যর্থ:', e.message, '— API_ID/API_HASH ঠিক আছে কিনা দেখুন'));
});

module.exports = { mtReadRange, fileIdDocId, parseRange, app, __setClient: (c) => { mtClientP = Promise.resolve(c); } };
