/**
 * migration.js — পুরোনো (ব্যান হওয়া) বট থেকে নতুন বটে ইউজার আনার ইঞ্জিন
 *
 * গুরুত্বপূর্ণ সত্য: Telegram ইউজার ID সব বটের কাছে একই। তাই নতুন বটে Start চাপলে ctx.from.id = আগের ID।
 * "নতুন ID দিয়ে ডক বদলানো" লাগে না — শুধু ডকটা খুঁজে "নতুন বটের সাথে যুক্ত" চিহ্ন বসাই; ব্যালেন্স/হিস্ট্রি যেখানে ছিল সেখানেই থাকে।
 *
 * নিরাপত্তা: লিংকের `sync_<ID>_<সাইন>` অংশ থেকে কখনো পরিচয় নিই না (কেউ অন্যের ID বসিয়ে লিংক বানাতে পারে)।
 * পরিচয় = Telegram-এর দেওয়া from.id। লিংকের সাইন (HMAC) শুধু প্রমাণ করে লিংকটা আমাদের বটই পাঠিয়েছে।
 *
 * সীমা: নতুন বট এমন কাউকে মেসেজ পাঠাতে পারে না যে একবারও এই বটে Start দেয়নি (Telegram 403/400)। তাদের "পৌঁছানো যায়নি" গোনা হয়।
 */
'use strict';
const crypto = require('crypto');

const TG_FIELDS = (process.env.TG_ID_FIELDS || 'tgUserId,telegram_id,chat_id').split(',').map(s => s.trim()).filter(Boolean);
const ID_RE = /^\d{3,15}$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- সাইন করা sync লিংক ---------- */
function makeSigner(secret) {
  const sign = id => crypto.createHmac('sha256', String(secret)).update(String(id)).digest('base64url').slice(0, 10);
  return {
    sign,
    build: id => `sync_${id}_${sign(id)}`,
    /** -> null (sync নয়) | { oldId, valid } */
    parse(payload) {
      const m = /^sync_(\d{3,15})_([A-Za-z0-9_-]{10})$/.exec(String(payload || ''));
      if (!m) return null;
      const valid = crypto.timingSafeEqual(Buffer.from(sign(m[1])), Buffer.from(m[2]));
      return { oldId: m[1], valid };
    }
  };
}

/** ইউজার ডক থেকে Telegram ID বের করি (tgUserId / telegram_id / chat_id — যেটা আছে) */
function tgIdOf(data) {
  for (const f of TG_FIELDS) {
    const v = data && data[f];
    if (v != null && ID_RE.test(String(v).trim())) return String(v).trim();
  }
  return '';
}

/**
 * ইউজারের পুরোনো অ্যাকাউন্ট (users কালেকশন) খুঁজে "নতুন বটের সাথে যুক্ত" চিহ্ন বসায়।
 * ID-র টাইপ (সংখ্যা/স্ট্রিং) দুটোই খোঁজে; টাইপ বদলায় না। -> যুক্ত হওয়া ডকের সংখ্যা
 */
async function linkExistingAccount(db, from) {
  const id = String(from.id), num = Number(id);
  const found = new Map();
  for (const f of TG_FIELDS) {
    for (const v of [id, num]) {
      const snap = await db.collection('users').where(f, '==', v).get();
      snap.forEach(d => found.set(d.id, d));
    }
  }
  const now = Date.now();
  for (const d of found.values()) {
    await d.ref.set({ botSyncedAt: now, botChatId: id }, { merge: true });
  }
  return found.size;
}

/* ---------- মাইগ্রেশন ব্রডকাস্ট ---------- */
function createMigration({ db, telegram, botUsername, signer, delayMs = 45, concurrency = 4, log = console }) {
  // গ্লোবাল রেট-লিমিটার: প্রতি delayMs-এ সর্বোচ্চ একটা মেসেজ শুরু (৪৫ms ≈ ২২/সেকেন্ড, Telegram-এর ~৩০/সেকেন্ডের নিচে)
  let nextAt = 0, pauseUntil = 0;
  async function acquire() {
    const now = Date.now();
    const t = Math.max(now, nextAt, pauseUntil);
    nextAt = t + delayMs;
    if (t > now) await sleep(t - now);
    while (Date.now() < pauseUntil) await sleep(Math.min(250, pauseUntil - Date.now()));
  }

  /** কাকে পাঠাব: সাইটের সব টেলিগ্রাম ইউজার − যারা আগেই নতুন বটে আছে (bot_users-এ সক্রিয়) − (onlyUnsent হলে) আগে চেষ্টা হয়ে যাওয়া */
  async function collectAudience({ onlyUnsent }) {
    const [users, bots] = await Promise.all([db.collection('users').get(), db.collection('bot_users').get()]);
    const onNewBot = new Set(), done = new Set();
    bots.forEach(d => {
      const x = d.data();
      if (x.startedAt && x.active !== false) onNewBot.add(d.id);
      if (x.migrationStatus) done.add(d.id);
    });
    const map = new Map();
    users.forEach(d => {
      const x = d.data(), id = tgIdOf(x);
      if (!id || map.has(id)) return;
      map.set(id, { id, name: x.tgFirstName || x.firstName || x.first_name || '' });
    });
    const out = [];
    let alreadyOnBot = 0, skippedDone = 0;
    for (const u of map.values()) {
      if (onNewBot.has(u.id)) { alreadyOnBot++; continue; }
      if (onlyUnsent && done.has(u.id)) { skippedDone++; continue; }
      out.push(u);
    }
    return { list: out, totalKnown: map.size, alreadyOnBot, skippedDone };
  }

  function classify(e) {
    const code = e && e.response && e.response.error_code;
    const desc = String((e && e.response && e.response.description) || (e && e.message) || '');
    if (code === 429) return { kind: 'rate', wait: ((e.response.parameters && e.response.parameters.retry_after) || 3) + 1 };
    if (code === 403 || (code === 400 && /chat not found|user is deactivated/i.test(desc))) return { kind: 'unreachable', desc };
    if (code === 400 && /wrong file|HTTP URL|web page content|IMAGE_PROCESS|failed to get/i.test(desc)) return { kind: 'badphoto', desc };
    if (code >= 500 || !code) return { kind: 'retry', desc };
    return { kind: 'failed', desc };
  }

  async function sendTo(u, job) {
    const url = `https://t.me/${botUsername}?start=${signer.build(u.id)}`;
    const name = esc(u.name || 'বন্ধু');
    const text = esc(job.text || '').split('{name}').join(name);
    const kb = { inline_keyboard: [[{ text: job.buttonText || '🚀 নতুন বটে Start দিন', url }]] };
    let photo = job.imageUrl && text.length <= 1000 ? job.imageUrl : '';
    for (let attempt = 0; attempt < 4; attempt++) {
      await acquire();
      try {
        if (photo) await telegram.sendPhoto(u.id, photo, { caption: text, parse_mode: 'HTML', reply_markup: kb });
        else await telegram.sendMessage(u.id, text || ' ', { parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });
        return { status: 'sent' };
      } catch (e) {
        const c = classify(e);
        if (c.kind === 'rate') { pauseUntil = Math.max(pauseUntil, Date.now() + c.wait * 1000); continue; }
        if (c.kind === 'badphoto' && photo) { photo = ''; continue; }
        if (c.kind === 'retry') { await sleep(500 * (attempt + 1)); continue; }
        if (c.kind === 'unreachable') return { status: 'unreachable' };
        return { status: 'failed', error: c.desc || String(e && e.message) };
      }
    }
    return { status: 'failed', error: 'বারবার চেষ্টাতেও ব্যর্থ' };
  }

  /** মূল কাজ। job = { text, buttonText, imageUrl, onlyUnsent } ; onProgress({total,done,sent,unreachable,failed}) */
  async function run(job, onProgress) {
    const { list, totalKnown, alreadyOnBot, skippedDone } = await collectAudience({ onlyUnsent: job.onlyUnsent !== false });
    const total = list.length;
    const res = { total, sent: 0, unreachable: 0, failed: 0, done: 0, totalKnown, alreadyOnBot, skippedDone };
    const errors = {};
    let buf = [];
    const flush = async () => {
      const chunk = buf; buf = [];
      for (let i = 0; i < chunk.length; i += 400) {
        const b = db.batch();
        chunk.slice(i, i + 400).forEach(({ id, patch }) => b.set(db.doc('bot_users/' + id), patch, { merge: true }));
        await b.commit().catch(e => log.error('migration flush', e.message));
      }
    };
    if (onProgress) await onProgress(res);
    let idx = 0;
    const worker = async () => {
      while (idx < list.length) {
        const u = list[idx++];
        const r = await sendTo(u, job);
        res.done++;
        const now = Date.now();
        if (r.status === 'sent') { res.sent++; buf.push({ id: u.id, patch: { tgUserId: u.id, migrationStatus: 'sent', migrationSentAt: now } }); }
        else if (r.status === 'unreachable') {
          res.unreachable++;
          // active:false => সাধারণ ব্রডকাস্টেও বাদ পড়ে; পরে ইউজার Start দিলে নিজে active হয়ে যায়
          buf.push({ id: u.id, patch: { tgUserId: u.id, migrationStatus: 'unreachable', migrationSentAt: now, active: false, blockedAt: now } });
        } else {
          res.failed++; errors[r.error] = (errors[r.error] || 0) + 1;
          buf.push({ id: u.id, patch: { tgUserId: u.id, migrationStatus: 'failed', migrationError: String(r.error || '').slice(0, 120), migrationSentAt: now } });
        }
        if (res.done % 50 === 0 || res.done === total) {
          await flush();
          if (onProgress) await onProgress(res);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, worker));
    await flush();
    if (onProgress) await onProgress(res);
    res.errors = errors;
    return res;
  }

  return { run, collectAudience, classify, _internals: { acquire } };
}

module.exports = { makeSigner, tgIdOf, linkExistingAccount, createMigration, TG_FIELDS };
