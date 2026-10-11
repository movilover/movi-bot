/**
 * Movi Lover — Telegram bot (Telegraf + Firebase Admin)   v2
 *
 * নতুন বট বসানো: কোড বদলাতে হবে না।
 *   • টোকেন:  BOT_TOKEN env  অথবা  এডমিন প্যানেল → ভিডিও বট-এ বসানো টোকেন (Firestore settings/videobot)
 *   • লিংক:   এডমিন প্যানেল → ভিডিও বট → "মেইন বটের ইউজারনেম / মিনি অ্যাপ নাম" (settings/site) — বট নিজেই পড়ে নেয়
 *
 * বট যা করে
 *  1. /start <code>  -> ক্লিক + জয়েন রেকর্ড (ref_ID, r-ID, কাস্টম স্লাগ)। সাইটে আগেই গোনা থাকলে ডাবল গোনে না।
 *  2. প্রতিটি বট-ইউজার Firestore `bot_users`-এ সেভ (প্রোফাইল, রেফারার, সক্রিয়/ব্লক, আয়)
 *  3. ইউজার বট ব্লক করলে / চ্যানেল ছাড়লে রেফারেল "লিভ" হয়
 *  4. নতুন ভিডিও সেভ হলেই থাম্বনেইল + টাইটেল + "▶️ Watch Now" সব ইউজারের কাছে একসাথে চলে যায়
 *  5. এডমিনের "বট সার্ভারের মাধ্যমে পাঠান" (broadcast_jobs) = এক ক্লিকে সবাইকে মেসেজ, লাইভ প্রগ্রেস সহ
 *  সবাই = bot_users + সাইটে ঢোকা সব টেলিগ্রাম ইউজার (users.tgUserId)। যারা বটে Start দেয়নি বা অনুমতি দেয়নি,
 *  টেলিগ্রাম তাদের কাছে পাঠাতে দেয় না (403) — তারা স্বয়ংক্রিয়ভাবে "ব্লক" চিহ্নিত হয়, পরে Start দিলে আবার সক্রিয়।
 *
 * চালু করা:  npm i   ->   BOT_TOKEN=... GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json node bot.js
 * ঐচ্ছিক env: SITE_URL (https://আপনার-সাইট) — দিলে বটের মেনু বাটন ও /start-এ সরাসরি সাইট খোলার বাটন বসে
 *             CHANNEL_ID, WEBAPP_LINK (settings/site না থাকলে ফলব্যাক), DEFAULT_RATE (ডিফল্ট ৫)
 */
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');

const SITE_URL = (process.env.SITE_URL || '').trim();
const CHANNEL_ID = process.env.CHANNEL_ID || '';
const DEFAULT_RATE = parseFloat(process.env.DEFAULT_RATE || '5');

admin.initializeApp(); // GOOGLE_APPLICATION_CREDENTIALS
const db = admin.firestore();
let bot = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------------- সেটিংস (Firestore থেকে, ৩০ সেকেন্ড ক্যাশ) ---------------- */
let siteCache = { at: 0, base: '' };
async function webappBase() {
  if (Date.now() - siteCache.at < 30000 && siteCache.base) return siteCache.base;
  // ফলব্যাক আগে ঠিক করি: env লিংক, নইলে চলতি বটের নিজের ইউজারনেম (Firestore ব্যর্থ হলেও লিংক কখনো খালি হবে না)
  let base = (process.env.WEBAPP_LINK || '').replace(/\/$/, '');
  if (!base && bot && bot.botInfo && bot.botInfo.username) base = 'https://t.me/' + bot.botInfo.username;
  try {
    const d = await db.doc('settings/site').get();
    if (d.exists && d.data().botUsername) {
      const u = String(d.data().botUsername).replace(/^@/, '');
      const app = String(d.data().appShort || '').replace(/[^A-Za-z0-9_]/g, '');
      base = `https://t.me/${u}${app ? '/' + app : ''}`;
    }
  } catch (e) { noteError('settings/site পড়া', e); }
  siteCache = { at: Date.now(), base };
  return base;
}
async function startappLink(param) { return (await webappBase()) + '?startapp=' + param; }

async function getRate() {
  try {
    const d = await db.doc('settings/referralRate').get();
    const r = d.exists ? parseFloat(d.data().ratePerJoin) : NaN;
    return isNaN(r) ? DEFAULT_RATE : r;
  } catch (e) { return DEFAULT_RATE; }
}

/** "ref_123", "r-123", "123" বা কাস্টম স্লাগ -> আসল রেফারার আইডি */
async function resolveRef(raw) {
  let code = String(raw || '').trim().replace(/^ref_/i, '').replace(/^r-/i, '');
  if (!code) return '';
  try {
    const s = await db.doc('referral_slugs/' + code).get();
    if (s.exists && s.data().userId) return String(s.data().userId);
  } catch (e) {}
  return code;
}

async function recalcReferrer(refId) {
  try {
    const snap = await db.collection('referrals').where('ref', '==', refId).get();
    let total = 0, left = 0;
    snap.forEach(d => { total++; const x = d.data(); if (x.leftAt || x.status === 'left') left++; });
    const valid = total - left;
    const rate = await getRate();
    const sl = await db.collection('referral_slugs').where('userId', '==', refId).limit(1).get();
    const slug = sl.empty ? '' : sl.docs[0].id;
    await db.doc('bot_users/' + refId).set({
      referralLink: await startappLink('r-' + (slug || refId)),
      totalReferrals: total, leftReferrals: left, validReferrals: valid,
      totalEarnings: Math.round(valid * rate * 100) / 100
    }, { merge: true });
  } catch (e) { console.error('recalcReferrer', e.message); }
}

async function upsertBotUser(from) {
  const id = String(from.id);
  const ref = db.doc('bot_users/' + id);
  const snap = await ref.get();
  const base = {
    tgUserId: id, username: from.username || '', firstName: from.first_name || '',
    lastName: from.last_name || '', languageCode: from.language_code || '',
    isPremium: !!from.is_premium, lastSeenAt: Date.now(), active: true, blockedAt: null
  };
  if (!snap.exists) {
    base.startedAt = Date.now();
    base.referralLink = await startappLink('r-' + id);
    base.totalReferrals = 0; base.totalEarnings = 0;
  }
  await ref.set(base, { merge: true });
  return !snap.exists;
}

/** এই টেলিগ্রাম ইউজারের জয়েন সাইট (users/{uid}) থেকে আগেই গোনা হয়েছে কি? */
async function alreadyCountedOnSite(tgId) {
  for (const v of [String(tgId), Number(tgId)]) {
    if (v !== v) continue;
    const us = await db.collection('users').where('tgUserId', '==', v).get();
    for (const u of us.docs) { if ((await db.doc('referrals/' + u.id).get()).exists) return true; }
  }
  return false;
}

async function recordReferral(from, rawCode) {
  const refId = await resolveRef(rawCode);
  const me = String(from.id);
  if (!refId || refId === me) return null;
  try { await db.doc(`referral_clicks/tg${me}_${refId}`).create({ ref: refId, userId: 'tg' + me, source: 'bot', createdAt: Date.now() }); } catch (e) {}
  if (await alreadyCountedOnSite(me)) return null; // ডাবল আয় নয়
  try {
    await db.doc('referrals/tg' + me).create({ ref: refId, refTelegramId: refId, userId: 'tg' + me, source: 'bot', createdAt: Date.now() });
    await db.doc('bot_users/' + me).set({ referredBy: refId }, { merge: true });
    await recalcReferrer(refId);
    return refId;
  } catch (e) { return null; }
}

async function markLeft(tgId, left) {
  tgId = String(tgId);
  const patch = left ? { leftAt: Date.now(), status: 'left' } : { leftAt: null, status: 'active' };
  const refIds = new Set();
  const touch = async docRef => {
    const d = await docRef.get();
    if (!d.exists) return;
    if (!!(d.data().leftAt) === !!left) return; // কোনো পরিবর্তন নেই
    await docRef.set(patch, { merge: true });
    refIds.add(d.data().ref);
  };
  await touch(db.doc('referrals/tg' + tgId));
  for (const v of [tgId, Number(tgId)]) {
    if (v !== v) continue;
    const us = await db.collection('users').where('tgUserId', '==', v).get();
    for (const u of us.docs) await touch(db.doc('referrals/' + u.id));
  }
  for (const r of refIds) await recalcReferrer(r);
}

/* ---------------- পাঠানোর ইঞ্জিন ---------------- */
async function sendOne(chatId, job) {
  const extra = { parse_mode: 'HTML' };
  if (job.buttons && job.buttons.length) extra.reply_markup = { inline_keyboard: job.buttons };
  for (let k = 0; k < 3; k++) {
    try {
      if (job.photo) await bot.telegram.sendPhoto(chatId, job.photo, Object.assign({ caption: job.text }, extra));
      else await bot.telegram.sendMessage(chatId, job.text, Object.assign({ disable_web_page_preview: true }, extra));
      return { ok: true };
    } catch (e) {
      const code = e.response && e.response.error_code;
      if (code === 429) { await sleep(((e.response.parameters && e.response.parameters.retry_after) || 2) * 1000 + 300); continue; }
      if (code === 403) return { ok: false, blocked: true };
      // ছবি পাঠানো না গেলে (ভুল লিংক ইত্যাদি) অন্তত লেখাটুকু যাক
      if (job.photo && code === 400 && k === 0) { job = Object.assign({}, job, { photo: '' }); continue; }
      return { ok: false, err: e.message };
    }
  }
  return { ok: false, err: 'retry' };
}

/** সক্রিয় সবাই = bot_users (ব্লক বাদে) ∪ সাইটে ঢোকা সব টেলিগ্রাম ইউজার */
async function audienceIds() {
  const botSnap = await db.collection('bot_users').get();
  const blocked = new Set(), ids = new Set();
  botSnap.forEach(d => { if (d.data().active === false) blocked.add(d.id); else ids.add(d.id); });
  const us = await db.collection('users').get();
  us.forEach(d => { const t = d.data().tgUserId; if (t && !blocked.has(String(t))) ids.add(String(t)); });
  return Array.from(ids);
}

/** সবাইকে একসাথে: প্রতি সেকেন্ডে ২৫ জন (টেলিগ্রামের সীমা ~৩০/সেকেন্ড) */
async function broadcast(job, onProgress) {
  const ids = await audienceIds();
  const total = ids.length;
  let sent = 0, failed = 0, blocked = 0, done = 0;
  if (onProgress) await onProgress({ total, sent, failed, done });
  const BATCH = 25;
  for (let i = 0; i < ids.length; i += BATCH) {
    const t0 = Date.now();
    const batch = ids.slice(i, i + BATCH);
    const res = await Promise.all(batch.map(id => sendOne(id, job)));
    for (let j = 0; j < res.length; j++) {
      done++;
      if (res[j].ok) sent++;
      else {
        failed++;
        if (res[j].blocked) {
          blocked++;
          db.doc('bot_users/' + batch[j]).set({ tgUserId: batch[j], active: false, blockedAt: Date.now() }, { merge: true }).catch(() => {});
          markLeft(batch[j], true).catch(() => {});
        }
      }
    }
    if (onProgress && (done % 100 === 0 || done === total)) await onProgress({ total, sent, failed, done });
    const spent = Date.now() - t0;
    if (spent < 1000) await sleep(1000 - spent);
  }
  if (onProgress) await onProgress({ total, sent, failed, done });
  return { total, sent, failed, blocked };
}

/* ---------------- স্বাগত বার্তা (এডমিন প্যানেল → স্বাগত পেজ = settings/welcome) ---------------- */
let welcomeCache = { at: 0, data: null };
async function getWelcome() {
  if (Date.now() - welcomeCache.at < 30000) return welcomeCache.data;
  let data = null;
  try { const d = await db.doc('settings/welcome').get(); data = d.exists ? d.data() : null; } catch (e) {}
  welcomeCache = { at: Date.now(), data };
  return data;
}
function welcomeCaption(w, name) {
  const nm = esc(name || 'বন্ধু');
  const parts = [];
  if (w.title) parts.push('<b>' + esc(w.title).split('{name}').join(nm) + '</b>');
  if (w.text) parts.push(esc(w.text).split('{name}').join(nm));
  const opts = [];
  if (w.b1Label) opts.push(esc(w.b1Label) + (w.b1Desc ? '\n' + esc(w.b1Desc) : ''));
  if (w.b2Label && w.b2Url) opts.push(esc(w.b2Label) + (w.b2Desc ? '\n' + esc(w.b2Desc) : ''));
  if (opts.length) parts.push(opts.join('\n\n'));
  return parts.join('\n\n');
}
async function welcomeButtons(w, refId) {
  const rows = [];
  if (w.b1Label) {
    // সাইট লিংক থাকলে সরাসরি টেলিগ্রামের ভেতরে ওয়েব অ্যাপ; নইলে বটের Mini App লিংক (রেফারার থাকলে সাথে যায়)
    if (/^https:\/\//i.test(w.site || '')) rows.push([{ text: w.b1Label, web_app: { url: w.site } }]);
    else rows.push([{ text: w.b1Label, url: await startappLink(refId ? 'r-' + refId : 'home') }]);
  }
  if (w.b2Label && /^https?:\/\//i.test(w.b2Url || '')) rows.push([{ text: w.b2Label, url: w.b2Url }]);
  return rows;
}
/* অবস্থা/ত্রুটি Firestore-এ লিখে রাখি (settings/botStatus) — এডমিন প্যানেলের "বট যাচাই করুন" বাটনে দেখা যায় */
function noteStatus(patch) { db.doc('settings/botStatus').set(patch, { merge: true }).catch(() => {}); }
function noteError(where, e) {
  const msg = where + ': ' + (e && e.message ? e.message : String(e));
  console.error('ERROR', msg);
  noteStatus({ lastError: msg.slice(0, 400), lastErrorAt: Date.now() });
}

/** ছবি+লেখা+বাটন; কোনো ধাপে (নষ্ট ছবি/বাটন লিংক) আটকালে ধাপে ধাপে সহজ রূপে পাঠায়, যাতে ইউজার কিছু একটা পায়ই */
async function sendWelcome(ctx, w, refId) {
  const cap = welcomeCaption(w, ctx.from.first_name);
  let rows = [];
  try { rows = await welcomeButtons(w, refId); } catch (e) { noteError('welcomeButtons', e); }
  const kb = { inline_keyboard: rows };
  const text = cap || '🎬 স্বাগতম!';
  // ১) ছবি + ক্যাপশন + বাটন
  try {
    if (w.image && cap.length <= 1000) { await ctx.replyWithPhoto(w.image, { caption: cap, parse_mode: 'HTML', reply_markup: kb }); return; }
    if (w.image) await ctx.replyWithPhoto(w.image).catch(e => noteError('welcome photo', e));
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true }); return;
  } catch (e) { noteError('welcome(ছবি+বাটন)', e); }
  // ২) ছবি ছাড়া, লেখা + বাটন
  try { await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true }); return; }
  catch (e) { noteError('welcome(লেখা+বাটন)', e); }
  // ৩) শুধু লেখা, বাটন ছাড়া
  try { await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true }); return; }
  catch (e) { noteError('welcome(শুধু লেখা)', e); }
  // ৪) একদম সাদামাটা
  await ctx.reply('🎬 Movi Lover-এ স্বাগতম!').catch(e => noteError('welcome(plain)', e));
}

/* ---------------- হ্যান্ডলার ---------------- */
function registerHandlers() {
  bot.start(async ctx => {
    const from = ctx.from;
    const payload = (ctx.startPayload || '').trim();
    console.log('/start পেয়েছি: ' + from.id + (payload ? ' payload=' + payload : ''));
    noteStatus({ lastStart: Date.now(), lastStartUser: String(from.id) });

    // ডাটাবেসের কাজ ব্যর্থ হলেও স্বাগত বার্তা যাবেই (আগে এখানে ত্রুটি হলে ইউজার কিছুই পেত না)
    let isNew = false, referrer = null, refRaw = '';
    try {
      isNew = await upsertBotUser(from);
      if (payload && !/^(v-|tk-)/.test(payload)) { referrer = await recordReferral(from, payload); refRaw = referrer || await resolveRef(payload); }
      if (!isNew) await markLeft(from.id, false).catch(() => {});
    } catch (e) { noteError('Firestore (/start)', e); }

    let w = null;
    try { w = await getWelcome(); } catch (e) { noteError('getWelcome', e); }
    try {
      if (w && w.enabled !== false && (w.text || w.title || w.image)) {
        await sendWelcome(ctx, w, refRaw);
      } else {
        const rows = [];
        if (SITE_URL) rows.push([Markup.button.webApp('▶️ সাইট খুলুন', SITE_URL)]);
        else rows.push([Markup.button.url('▶️ সাইট খুলুন', await webappBase() + '?startapp=home')]);
        await ctx.reply(
          `🎬 <b>Movi Lover-এ স্বাগতম, ${esc(from.first_name || 'বন্ধু')}!</b>\n\nনতুন ভিডিও আসলেই সবার আগে এখানে পাবেন। নিচের বাটনে চাপ দিয়ে সাইট খুলুন।`,
          { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }
        );
      }
    } catch (e) {
      noteError('/start reply', e);
      await ctx.reply('🎬 Movi Lover-এ স্বাগতম!').catch(() => {});
    }
    if (isNew) console.log('new user', from.id, referrer ? '(ref ' + referrer + ')' : '');
  });

  bot.command('mylink', async ctx => {
    await upsertBotUser(ctx.from);
    const d = await db.doc('bot_users/' + ctx.from.id).get();
    const x = d.data() || {};
    await ctx.reply(
      `🔗 আপনার রেফারেল লিংক:\n${x.referralLink || await startappLink('r-' + ctx.from.id)}\n\n` +
      `👥 সফল জয়েন: ${x.validReferrals || 0}\n💰 আয়: ৳${(x.totalEarnings || 0).toFixed(2)}`
    );
  });

  bot.on('my_chat_member', async ctx => {
    const u = ctx.myChatMember;
    if (u.chat.type !== 'private') return;
    const st = u.new_chat_member.status, id = String(u.from.id);
    if (st === 'kicked' || st === 'left') {
      await db.doc('bot_users/' + id).set({ tgUserId: id, active: false, blockedAt: Date.now() }, { merge: true });
      await markLeft(id, true).catch(e => console.error(e.message));
    } else if (st === 'member') {
      await db.doc('bot_users/' + id).set({ tgUserId: id, active: true, blockedAt: null }, { merge: true });
      await markLeft(id, false).catch(() => {});
    }
  });

  bot.on('chat_member', async ctx => {
    const u = ctx.chatMember;
    if (CHANNEL_ID && String(u.chat.id) !== String(CHANNEL_ID)) return;
    const st = u.new_chat_member.status, id = String(u.new_chat_member.user.id);
    if (st === 'left' || st === 'kicked') await markLeft(id, true).catch(e => console.error(e.message));
    if (st === 'member') await markLeft(id, false).catch(() => {});
  });

  /* মিনি অ্যাপে "মেসেজ পাঠানোর অনুমতি" দিলে টেলিগ্রাম এই সার্ভিস মেসেজ পাঠায় -> ইউজারকে সক্রিয় ধরি */
  bot.on('message', async (ctx, next) => {
    try {
      if (ctx.message && ctx.message.write_access_allowed && ctx.chat.type === 'private') {
        await upsertBotUser(ctx.from);
        await markLeft(ctx.from.id, false).catch(() => {});
      }
    } catch (e) {}
    return next();
  });
}

/* ---------------- নতুন ভিডিও -> ইনস্ট্যান্ট ব্রডকাস্ট ---------------- */
function watchVideos() {
  let first = true;
  db.collection('videos').onSnapshot(snap => {
    if (first) { first = false; return; }
    snap.docChanges().forEach(async ch => {
      if (ch.type !== 'added') return;
      const v = ch.doc.data();
      if (v.botBroadcastAt || v.skipBotBroadcast) return;
      try { await ch.doc.ref.update({ botBroadcastAt: Date.now() }); } catch (e) { return; } // আগে দাবি করি, যেন দুইবার না যায়
      const text = `🎬 <b>${esc(v.title || 'নতুন ভিডিও')}</b>` + (v.description ? `\n\n${esc(String(v.description).slice(0, 600))}` : '');
      console.log('নতুন ভিডিও ব্রডকাস্ট:', ch.doc.id);
      const r = await broadcast({
        text, photo: v.thumbnail || '',
        buttons: [[{ text: '▶️ Watch Now', url: await startappLink('v-' + ch.doc.id) }]]
      });
      await ch.doc.ref.update({ botBroadcastResult: r }).catch(() => {});
      console.log('ভিডিও ব্রডকাস্ট শেষ', r);
    });
  }, e => console.error('videos listener', e.message));
}

/* ---------------- এডমিন ব্রডকাস্ট কিউ ---------------- */
function watchJobs() {
  db.collection('broadcast_jobs').where('status', '==', 'queued').onSnapshot(snap => {
    snap.docChanges().forEach(async ch => {
      if (ch.type !== 'added') return;
      const ref = ch.doc.ref;
      try { await ref.update({ status: 'sending', startedAt: Date.now() }); } catch (e) { return; }
      const j = ch.doc.data();
      const buttons = (j.buttons || []).filter(b => b.text && /^https?:\/\//i.test(b.url || '')).map(b => [{ text: b.text, url: b.url }]);
      try {
        const r = await broadcast({ text: j.text || ' ', photo: j.imageUrl || '', buttons }, p => ref.update({ progress: p }).catch(() => {}));
        await ref.update({ status: 'done', result: r, finishedAt: Date.now() });
      } catch (e) { await ref.update({ status: 'failed', error: e.message }).catch(() => {}); }
    });
  }, e => console.error('broadcast_jobs listener', e.message));
}

/* ---------------- চালু ---------------- */
(async () => {
  let token = (process.env.BOT_TOKEN || '').trim();
  if (!token) {
    try { const d = await db.doc('settings/videobot').get(); if (d.exists) token = String(d.data().token || '').trim(); } catch (e) {}
  }
  if (!token) { console.error('বট টোকেন নেই: BOT_TOKEN env দিন, অথবা এডমিন প্যানেল → ভিডিও বট-এ টোকেন সংরক্ষণ করুন।'); process.exit(1); }

  bot = new Telegraf(token);
  registerHandlers();
  bot.catch((err, ctx) => noteError('bot ' + (ctx && ctx.updateType), err));

  const me = await bot.telegram.getMe();
  bot.botInfo = me;
  console.log('বট চালু: @' + me.username);
  if (SITE_URL) {
    bot.telegram.setChatMenuButton({ menuButton: { type: 'web_app', text: '🎬 সাইট', web_app: { url: SITE_URL } } }).catch(e => console.error('menu button', e.message));
  }
  bot.telegram.setMyCommands([{ command: 'start', description: 'বট চালু করুন' }, { command: 'mylink', description: 'আমার রেফারেল লিংক' }]).catch(() => {});

  // হার্টবিট: এডমিন প্যানেল দেখে বট সার্ভার চালু আছে কি না (বন্ধ থাকলে ভিডিও ব্রাউজার থেকে পাঠানো হয়)
  const beat = () => db.doc('settings/botStatus').set({ lastBeat: Date.now(), username: me.username }, { merge: true }).catch(() => {});
  beat(); setInterval(beat, 60000);

  watchVideos();
  watchJobs();
  await bot.launch({ allowedUpdates: ['message', 'my_chat_member', 'chat_member', 'callback_query'] });
})().catch(e => { console.error('চালু করা যায়নি:', e.message); process.exit(1); });

process.on('unhandledRejection', e => noteError('unhandledRejection', e));
process.on('uncaughtException', e => noteError('uncaughtException', e));
process.once('SIGINT', () => bot && bot.stop('SIGINT'));
process.once('SIGTERM', () => bot && bot.stop('SIGTERM'));