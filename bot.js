/**
 * Movi Lover — Telegram bot (Telegraf + Firebase Admin)
 *
 * What it does
 *  1. /start <code>   -> records the click + the join for the referrer (ref_ID, r-ID, or a custom slug)
 *  2. Saves every bot user in Firestore `bot_users` (profile, referrer, active/blocked, counters)
 *  3. Detects leaves (user blocks the bot / leaves the channel) and marks the referral as left
 *  4. NEW VIDEO  -> the moment the admin saves a video, the bot sends thumbnail + title + "Watch Now"
 *                   to ALL active bot users at once (parallel batches, flood-limit safe)
 *  5. Admin "server broadcast" queue (`broadcast_jobs`) -> sends text/photo to all users, writes progress back
 *
 * Setup
 *   npm i telegraf firebase-admin
 *   Firebase Console -> Project settings -> Service accounts -> Generate new private key -> serviceAccount.json
 *   BOT_TOKEN=123:ABC  GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json  node bot.js
 * Optional env
 *   WEBAPP_LINK   default https://t.me/movilovervairal_bot/webapp
 *   CHANNEL_ID    channel where the bot is admin; leaving it counts as a referral "leave"
 *   DEFAULT_RATE  default 5 (BDT per valid join; admin panel value in settings/referralRate wins)
 */
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('BOT_TOKEN missing'); process.exit(1); }
const WEBAPP_LINK = (process.env.WEBAPP_LINK || 'https://t.me/movilovervairal_bot/webapp').replace(/\/$/, '');
const CHANNEL_ID = process.env.CHANNEL_ID || '';
const DEFAULT_RATE = parseFloat(process.env.DEFAULT_RATE || '5');

admin.initializeApp(); // uses GOOGLE_APPLICATION_CREDENTIALS
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const bot = new Telegraf(BOT_TOKEN);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------------- helpers ---------------- */
async function getRate() {
  try {
    const d = await db.doc('settings/referralRate').get();
    const r = d.exists ? parseFloat(d.data().ratePerJoin) : NaN;
    return isNaN(r) ? DEFAULT_RATE : r;
  } catch (e) { return DEFAULT_RATE; }
}
function refLinkFor(id, slug) { return `${WEBAPP_LINK}?startapp=r-${slug || id}`; }

/** "ref_123", "r-123", "123" or a custom slug  ->  real referrer id (string) */
async function resolveRef(raw) {
  let code = String(raw || '').trim();
  if (!code) return '';
  code = code.replace(/^ref_/i, '').replace(/^r-/i, '');
  if (!code) return '';
  try {
    const s = await db.doc('referral_slugs/' + code).get();
    if (s.exists && s.data().userId) return String(s.data().userId);
  } catch (e) {}
  return code;
}

/** keep the referrer's counters on their bot_users doc (valid joins x rate) */
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
      referralLink: refLinkFor(refId, slug),
      totalReferrals: total, leftReferrals: left, validReferrals: valid,
      totalEarnings: Math.round(valid * rate * 100) / 100
    }, { merge: true });
  } catch (e) { console.error('recalcReferrer', e.message); }
}

async function upsertBotUser(from, extra) {
  const id = String(from.id);
  const ref = db.doc('bot_users/' + id);
  const snap = await ref.get();
  const base = {
    tgUserId: id, username: from.username || '', firstName: from.first_name || '',
    lastName: from.last_name || '', languageCode: from.language_code || '',
    isPremium: !!from.is_premium, lastSeenAt: Date.now(), active: true
  };
  if (!snap.exists) {
    base.startedAt = Date.now();
    base.referralLink = refLinkFor(id);
    base.totalReferrals = 0; base.totalEarnings = 0;
  }
  await ref.set(Object.assign(base, extra || {}), { merge: true });
  return !snap.exists; // true = brand new user
}

async function recordReferral(from, rawCode) {
  const refId = await resolveRef(rawCode);
  const me = String(from.id);
  if (!refId || refId === me) return null;
  // unique click per (visitor, referrer)
  try {
    await db.doc(`referral_clicks/tg${me}_${refId}`).create({ ref: refId, userId: 'tg' + me, source: 'bot', createdAt: Date.now() });
  } catch (e) { /* already counted */ }
  // join: first referrer only, one doc per telegram user
  try {
    await db.doc('referrals/tg' + me).create({ ref: refId, refTelegramId: refId, userId: 'tg' + me, source: 'bot', createdAt: Date.now() });
    await db.doc('bot_users/' + me).set({ referredBy: refId }, { merge: true });
    await recalcReferrer(refId);
    return refId;
  } catch (e) { return null; } // already joined earlier
}

/** a referred user left (blocked the bot / left the channel) */
async function markLeft(tgId, left) {
  tgId = String(tgId);
  const patch = left ? { leftAt: Date.now(), status: 'left' } : { leftAt: null, status: 'active' };
  const refIds = new Set();
  const touch = async docRef => {
    const d = await docRef.get();
    if (!d.exists) return;
    await docRef.set(patch, { merge: true });
    refIds.add(d.data().ref);
  };
  await touch(db.doc('referrals/tg' + tgId));
  // web users: users/{firebaseUid}.tgUserId == this id
  for (const v of [tgId, Number(tgId)]) {
    if (v !== v) continue;
    const us = await db.collection('users').where('tgUserId', '==', v).get();
    for (const u of us.docs) await touch(db.doc('referrals/' + u.id));
  }
  for (const r of refIds) await recalcReferrer(r);
}

/* ---------------- commands ---------------- */
bot.start(async ctx => {
  const from = ctx.from;
  const payload = (ctx.startPayload || '').trim();
  const isNew = await upsertBotUser(from);
  let referrer = null;
  if (payload) referrer = await recordReferral(from, payload);
  if (!isNew) await markLeft(from.id, false).catch(() => {}); // came back -> valid again

  const name = esc(from.first_name || 'বন্ধু');
  await ctx.reply(
    `🎬 <b>Movi Lover-এ স্বাগতম, ${name}!</b>\n\nনতুন ভিডিও আসলেই এখানে সবার আগে পাবেন।`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.url('▶️ সাইট খুলুন', WEBAPP_LINK)]]) }
  );
  if (isNew) console.log('new user', from.id, referrer ? '(ref ' + referrer + ')' : '');
});

bot.command('mylink', async ctx => {
  await upsertBotUser(ctx.from);
  const d = await db.doc('bot_users/' + ctx.from.id).get();
  const x = d.data() || {};
  await ctx.reply(
    `🔗 আপনার রেফারেল লিংক:\n${x.referralLink || refLinkFor(ctx.from.id)}\n\n` +
    `👥 সফল জয়েন: ${x.validReferrals || 0}\n💰 আয়: ৳${(x.totalEarnings || 0).toFixed(2)}`
  );
});

/* user blocks / unblocks the bot (private chat) */
bot.on('my_chat_member', async ctx => {
  const u = ctx.myChatMember;
  if (u.chat.type !== 'private') return;
  const st = u.new_chat_member.status;
  const id = String(u.from.id);
  if (st === 'kicked' || st === 'left') {
    await db.doc('bot_users/' + id).set({ active: false, blockedAt: Date.now() }, { merge: true });
    await markLeft(id, true).catch(e => console.error(e.message));
  } else if (st === 'member') {
    await db.doc('bot_users/' + id).set({ active: true, blockedAt: null }, { merge: true });
    await markLeft(id, false).catch(() => {});
  }
});

/* user leaves / is removed from the channel */
bot.on('chat_member', async ctx => {
  const u = ctx.chatMember;
  if (CHANNEL_ID && String(u.chat.id) !== String(CHANNEL_ID)) return;
  const st = u.new_chat_member.status;
  const id = String(u.new_chat_member.user.id);
  if (st === 'left' || st === 'kicked') await markLeft(id, true).catch(e => console.error(e.message));
  if (st === 'member') await markLeft(id, false).catch(() => {});
});

/* ---------------- sending engine ---------------- */
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
      return { ok: false, err: e.message };
    }
  }
  return { ok: false, err: 'retry' };
}

/** send to every active bot user at once: 25 parallel per second (Telegram allows ~30/s) */
async function broadcast(job, onProgress) {
  const snap = await db.collection('bot_users').get();
  const ids = snap.docs.filter(d => d.data().active !== false).map(d => d.id);
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
          db.doc('bot_users/' + batch[j]).set({ active: false, blockedAt: Date.now() }, { merge: true }).catch(() => {});
          markLeft(batch[j], true).catch(() => {});
        }
      }
    }
    if (onProgress) await onProgress({ total, sent, failed, done });
    const spent = Date.now() - t0;
    if (spent < 1000) await sleep(1000 - spent);
  }
  return { total, sent, failed, blocked };
}

/* ---------------- NEW VIDEO -> instant broadcast ---------------- */
let firstVideoSnap = true;
db.collection('videos').onSnapshot(snap => {
  if (firstVideoSnap) { firstVideoSnap = false; return; } // ignore existing videos on startup
  snap.docChanges().forEach(async ch => {
    if (ch.type !== 'added') return;
    const v = ch.doc.data();
    if (v.botBroadcastAt || v.skipBotBroadcast) return; // already sent / admin sent it from the panel
    try {
      await ch.doc.ref.update({ botBroadcastAt: Date.now() }); // claim it first (no double send)
    } catch (e) { return; }
    const link = `${WEBAPP_LINK}?startapp=v-${ch.doc.id}`;
    const text = `🎬 <b>${esc(v.title || 'নতুন ভিডিও')}</b>` + (v.description ? `\n\n${esc(String(v.description).slice(0, 600))}` : '');
    console.log('broadcasting new video', ch.doc.id);
    const r = await broadcast({
      text, photo: v.thumbnail || '',
      buttons: [[{ text: '▶️ Watch Now', url: link }]]
    });
    await ch.doc.ref.update({ botBroadcastResult: r }).catch(() => {});
    console.log('video broadcast done', r);
  });
}, e => console.error('videos listener', e.message));

/* ---------------- admin broadcast queue ---------------- */
db.collection('broadcast_jobs').where('status', '==', 'queued').onSnapshot(snap => {
  snap.docChanges().forEach(async ch => {
    if (ch.type !== 'added') return;
    const ref = ch.doc.ref;
    try { await ref.update({ status: 'sending', startedAt: Date.now() }); } catch (e) { return; }
    const j = ch.doc.data();
    const buttons = (j.buttons || []).filter(b => b.text && /^https?:\/\//i.test(b.url || '')).map(b => [{ text: b.text, url: b.url }]);
    try {
      const r = await broadcast(
        { text: j.text || ' ', photo: j.imageUrl || '', buttons },
        p => ref.update({ progress: p }).catch(() => {})
      );
      await ref.update({ status: 'done', result: r, finishedAt: Date.now() });
    } catch (e) {
      await ref.update({ status: 'failed', error: e.message }).catch(() => {});
    }
  });
}, e => console.error('broadcast_jobs listener', e.message));

/* ---------------- launch ---------------- */
bot.catch((err, ctx) => console.error('bot error', ctx && ctx.updateType, err.message));
bot.launch({ allowedUpdates: ['message', 'my_chat_member', 'chat_member', 'callback_query'] })
  .then(() => console.log('Movi Lover bot running'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));