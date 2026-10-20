/**
 * Movie Lover — Telegram ভিডিও স্ট্রিম সার্ভার
 *
 * কাজ: টেলিগ্রাম স্টোরেজ চ্যানেলে রাখা ভিডিও (২০–৫০MB বা আরও বড়) সাইট/অ্যাপের প্লেয়ারে চালানো।
 * (টেলিগ্রাম বট API ২০MB-এর বেশি ফাইল ওয়েবসাইটকে দেয় না — তাই এই সার্ভার MTProto দিয়ে সরাসরি নামায়।)
 *
 * ব্যবহার:  GET /stream?m=<মেসেজ ID>      (Range/সিক সাপোর্টসহ)
 *           GET /health
 *
 * দরকারি Environment Variables:
 *   API_ID, API_HASH   — my.telegram.org থেকে
 *   BOT_TOKEN          — ভিডিও বটের টোকেন (যে বট চ্যানেলে ভিডিও পাঠায়)
 *   STORAGE_CHAT_ID    — স্টোরেজ চ্যানেলের ID, যেমন -1001234567890
 *   PORT               — হোস্টিং নিজেই দেয়
 *   ALLOWED_ORIGINS    — (ঐচ্ছিক) কমা দিয়ে আলাদা ডোমেইন, যেমন: mysite.com,t.me — দিলে অন্য সাইট থেকে হটলিংক বন্ধ
 */
"use strict";
const http = require("http");

const CHUNK = 512 * 1024;            // 512KB — টেলিগ্রামের নিয়ম (৪০৯৬-এর গুণিতক, ১MB সীমা পার হয় না)
const CACHE_MS = 20 * 60 * 1000;     // মেসেজ/ফাইল রেফারেন্স ক্যাশ
const ALLOWED = String(process.env.ALLOWED_ORIGINS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
function originAllowed(req) {
  if (!ALLOWED.length) return true;
  const h = req.headers.origin || req.headers.referer || "";
  if (!h) return true;                       // অ্যাপের ওয়েবভিউ/প্লেয়ার অনেক সময় হেডার পাঠায় না
  try { const host = new URL(h).hostname.toLowerCase(); return ALLOWED.some((a) => host === a || host.endsWith("." + a)); }
  catch (_) { return false; }
}

/* ---------- HTTP অংশ (টেলিগ্রাম থেকে আলাদা, তাই পরীক্ষা করা যায়) ---------- */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim());
  if (!m || (m[1] === "" && m[2] === "")) return "bad";
  let start, end;
  if (m[1] === "") {                           // bytes=-N  (শেষের N বাইট)
    const n = parseInt(m[2], 10);
    if (!n) return "bad";
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start > end || start >= size) return "bad";
  return { start, end };
}

function createApp({ getFileInfo, openChunks, isReady, waitReady }) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  };
  const json = (res, code, obj) => {
    res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors));
    res.end(JSON.stringify(obj));
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
      if (url.pathname === "/" || url.pathname === "/health") return json(res, 200, { ok: true, ready: !!isReady() });
      if (url.pathname !== "/stream" || (req.method !== "GET" && req.method !== "HEAD")) return json(res, 404, { ok: false, error: "not found" });

      if (!originAllowed(req)) return json(res, 403, { ok: false, error: "forbidden" });
      const msgId = parseInt(url.searchParams.get("m") || "", 10);
      if (!msgId || msgId < 1) return json(res, 400, { ok: false, error: "m (message id) দিন" });

      if (!isReady()) { await waitReady(40000); if (!isReady()) return json(res, 503, { ok: false, error: "সার্ভার চালু হচ্ছে, একটু পর আবার চেষ্টা করুন" }); }

      let info;
      try { info = await getFileInfo(msgId); }
      catch (e) { return json(res, 502, { ok: false, error: "টেলিগ্রাম থেকে ফাইল আনা যায়নি: " + (e.message || e) }); }
      if (!info) return json(res, 404, { ok: false, error: "এই মেসেজে ভিডিও নেই" });

      const size = info.size;
      const range = parseRange(req.headers.range, size);
      if (range === "bad") {
        res.writeHead(416, Object.assign({ "Content-Range": "bytes */" + size }, cors));
        return res.end();
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : size - 1;
      const headers = Object.assign({
        "Content-Type": info.mime || "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
      }, cors);
      if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === "HEAD") return res.end();

      let closed = false;
      req.on("close", () => { closed = true; });
      const aligned = start - (start % CHUNK);
      const count = Math.ceil((end + 1 - aligned) / CHUNK);
      let pos = aligned;
      try {
        for await (const buf of openChunks(info, aligned, count)) {
          if (closed) break;
          const from = Math.max(start - pos, 0);
          const to = Math.min(end + 1 - pos, buf.length);
          if (to > from) {
            if (!res.write(buf.subarray(from, to))) {
              await new Promise((r) => { res.once("drain", r); res.once("close", r); });
            }
          }
          pos += buf.length;
          if (pos > end) break;
        }
        res.end();
      } catch (e) {
        console.error("stream error:", e && e.message);
        res.destroy();
      }
    } catch (e) {
      console.error("request error:", e && e.message);
      try { json(res, 500, { ok: false, error: "সার্ভার ত্রুটি" }); } catch (_) { /* ignore */ }
    }
  });
}

/* ---------- টেলিগ্রাম অংশ (GramJS) ---------- */
function createTelegramBackend() {
  const { TelegramClient, Api } = require("telegram");
  const { StringSession } = require("telegram/sessions");
  const { LogLevel } = require("telegram/extensions/Logger");
  const bigInt = require("big-integer");

  const API_ID = parseInt(process.env.API_ID || "", 10);
  const API_HASH = process.env.API_HASH || "";
  const BOT_TOKEN = process.env.BOT_TOKEN || "";
  const CHAT = String(process.env.STORAGE_CHAT_ID || "").trim();
  if (!API_ID || !API_HASH || !BOT_TOKEN || !CHAT) {
    throw new Error("API_ID, API_HASH, BOT_TOKEN, STORAGE_CHAT_ID — চারটাই Environment Variables-এ দিন");
  }
  // -1001234567890 -> channelId 1234567890
  const channelId = CHAT.replace(/^-100/, "").replace(/^-/, "");
  const peer = new Api.PeerChannel({ channelId: bigInt(channelId) });

  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 10 });
  client.setLogLevel(LogLevel.ERROR);

  let ready = false;
  let readyResolvers = [];
  async function connect() {
    for (let attempt = 1; ; attempt++) {
      try {
        await client.start({ botAuthToken: BOT_TOKEN });
        ready = true;
        readyResolvers.forEach((r) => r());
        readyResolvers = [];
        console.log("Telegram সংযুক্ত ✅");
        return;
      } catch (e) {
        console.error("Telegram সংযোগ ব্যর্থ (চেষ্টা " + attempt + "):", e && e.message);
        await new Promise((r) => setTimeout(r, Math.min(30000, attempt * 3000)));
      }
    }
  }

  const cache = new Map();           // msgId -> { at, info } | { at, promise }
  async function getFileInfo(msgId) {
    const hit = cache.get(msgId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise ? hit.promise : hit.info;
    const promise = (async () => {
      const msgs = await client.getMessages(peer, { ids: [msgId] });
      const msg = msgs && msgs[0];
      const media = msg && msg.media;
      const doc = media && media.document;
      if (!doc || !doc.size) return null;
      return { media, size: Number(doc.size.toString()), mime: doc.mimeType || "video/mp4" };
    })();
    cache.set(msgId, { at: Date.now(), promise });
    try {
      const info = await promise;
      if (info) cache.set(msgId, { at: Date.now(), info }); else cache.delete(msgId);
      return info;
    } catch (e) { cache.delete(msgId); throw e; }
  }

  async function* openChunks(info, offset, count) {
    for await (const chunk of client.iterDownload({
      file: info.media,
      offset: bigInt(offset),
      requestSize: CHUNK,
      chunkSize: CHUNK,
      stride: CHUNK,
      limit: count,
      fileSize: bigInt(info.size),
    })) {
      yield chunk;
    }
  }

  return {
    connect,
    getFileInfo,
    openChunks,
    isReady: () => ready,
    waitReady: (ms) => new Promise((resolve) => {
      if (ready) return resolve();
      const t = setTimeout(resolve, ms);
      readyResolvers.push(() => { clearTimeout(t); resolve(); });
    }),
  };
}

module.exports = { createApp, parseRange, CHUNK };

if (require.main === module) {
  const backend = createTelegramBackend();
  const app = createApp(backend);
  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, "0.0.0.0", () => console.log("স্ট্রিম সার্ভার চালু, পোর্ট " + port));
  backend.connect();
  process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e && e.message));
}
