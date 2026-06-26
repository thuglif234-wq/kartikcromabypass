const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");
const fs = require("fs");

const TOKEN    = "8886757834:AAHBChGEoCndNDtKWPp22bL-B1PGN52_CfQ";
const ADMIN_ID = "7485181331";
const DATA_FILE = "./data.json";
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || `http://localhost:${PORT}`;

// ─── KEEP-ALIVE ─────────────────────────────────────────────────────────────
const app = express();
app.get("/", (_, res) => res.send("Bot is running!"));
app.get("/ping", (_, res) => res.json({ ok: true }));
app.listen(PORT, () => log("SYSTEM", `Server on port ${PORT}`));
setInterval(() => axios.get(`${RENDER_URL}/ping`).catch(() => {}), 25000);

// ─── LOGGER ─────────────────────────────────────────────────────────────────
function log(tag, msg) {
  const ts = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  console.log(`[${ts}] [${tag}] ${msg}`);
}

// ─── DB ─────────────────────────────────────────────────────────────────────
let db = { users: {}, pendingUsers: {} };
if (fs.existsSync(DATA_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (_) {}
}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

const bot = new TelegramBot(TOKEN, { polling: true });
const userStates = {};
const intervals  = {};

// ─── CROMA PRICE SCRAPER (3 strategies + retry) ─────────────────────────────
async function fetchCromaPrice(url, pincode) {
  const pidMatch  = url.match(/\/p\/(\d+)/i);
  const productId = pidMatch ? pidMatch[1] : null;

  // ── Strategy 1: Croma REST API ────────────────────────────────────────────
  if (productId) {
    try {
      const apiUrl = `https://api.croma.com/products/v2/${productId}?pincode=${pincode}`;
      const r = await axios.get(apiUrl, {
        timeout: 12000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124",
          "Accept": "application/json",
          "Origin": "https://www.croma.com",
          "Referer": "https://www.croma.com/",
          "app-version": "3",
        },
      });
      const d     = r.data;
      const raw   = d?.price?.sellingPrice ?? d?.sellingPrice ?? d?.data?.sellingPrice ?? null;
      const name  = d?.name ?? d?.data?.name ?? d?.productName ?? null;
      if (raw) {
        const price = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
        log("API ✅", `[${pincode}] ${(name||productId).substring(0,35)} → ₹${price}`);
        return { price, name, method: "api" };
      }
    } catch (e) {
      log("API ❌", `[${pincode}] ${e.message.substring(0,60)}`);
    }
  }

  // ── Strategy 2: HTML page + __NEXT_DATA__ / LD+JSON ───────────────────────
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      "Cookie": `pincode=${pincode}; selectedPincode=${pincode}; crompincode=${pincode}`,
      "Referer": "https://www.croma.com/",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
    };

    const resp = await axios.get(url, { timeout: 18000, headers });
    const html  = resp.data;
    const $     = cheerio.load(html);

    // 2a: __NEXT_DATA__ JSON (most reliable)
    const nextScript = $("script#__NEXT_DATA__").html();
    if (nextScript) {
      try {
        const nextData = JSON.parse(nextScript);
        // Walk the props tree for price fields
        const str = JSON.stringify(nextData);
        const sellingMatch = str.match(/"sellingPrice"\s*:\s*([\d.]+)/);
        const mrpMatch     = str.match(/"mrp"\s*:\s*([\d.]+)/);
        if (sellingMatch) {
          const price = parseFloat(sellingMatch[1]);
          const nameEl = $("h1").first().text().trim() || "Croma Product";
          log("NEXT✅", `[${pincode}] ${nameEl.substring(0,35)} → ₹${price}`);
          return { price, name: nameEl, method: "next_data" };
        }
      } catch (_) {}
    }

    // 2b: LD+JSON schema
    let ldPrice = null, ldName = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (ldPrice) return;
      try {
        const j = JSON.parse($(el).html());
        const p = j?.offers?.price ?? j?.price ?? j?.offers?.[0]?.price ?? null;
        if (p) { ldPrice = parseFloat(p); ldName = j?.name || null; }
      } catch (_) {}
    });
    if (ldPrice) {
      const name = ldName || $("h1").first().text().trim() || "Croma Product";
      log("LD ✅", `[${pincode}] ${name.substring(0,35)} → ₹${ldPrice}`);
      return { price: ldPrice, name, method: "ldjson" };
    }

    // 2c: CSS selectors fallback
    const selectors = [
      ".pdp-selling-price",
      '[data-testid="pdp-selling-price"]',
      '[data-testid="selling-price"]',
      ".selling-price",
      ".new-price",
      ".offer-price",
      ".price-current",
      '[class*="sellingPrice"]',
      '[class*="selling-price"]',
      '[class*="offerPrice"]',
      '[class*="offer-price"]',
      ".amount",
    ];
    let cssPrice = null, cssName = null;
    for (const sel of selectors) {
      const el = $(sel).first();
      if (!el.length) continue;
      const raw = el.text().replace(/[^\d]/g, "");
      if (raw.length >= 3) {
        cssPrice = parseInt(raw, 10);
        cssName  = $("h1").first().text().trim() || "Croma Product";
        log("CSS✅", `[${pincode}] sel=${sel} → ₹${cssPrice}`);
        break;
      }
    }
    if (cssPrice) return { price: cssPrice, name: cssName, method: "css" };

    // 2d: regex on raw HTML (last resort)
    const regexes = [
      /"sellingPrice"\s*:\s*"?([\d.]+)"?/,
      /"finalPrice"\s*:\s*"?([\d.]+)"?/,
      /"discountedPrice"\s*:\s*"?([\d.]+)"?/,
      /₹\s*([\d,]+)/,
      /Rs\.?\s*([\d,]+)/i,
    ];
    for (const rx of regexes) {
      const m = html.match(rx);
      if (m) {
        const price = parseFloat(m[1].replace(/,/g, ""));
        if (price > 100) {
          const name = $("h1").first().text().trim() || "Croma Product";
          log("REG✅", `[${pincode}] regex=${rx.source.substring(0,25)} → ₹${price}`);
          return { price, name, method: "regex" };
        }
      }
    }

    log("MISS ", `[${pincode}] No price found in HTML`);
  } catch (e) {
    log("HTML❌", `[${pincode}] ${e.message.substring(0,60)}`);
  }

  return { price: null, name: null, method: null };
}

// ─── FETCH WITH RETRY (3 attempts) ──────────────────────────────────────────
async function fetchWithRetry(url, pincode, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    const r = await fetchCromaPrice(url, pincode);
    if (r.price !== null) return r;
    if (i < attempts) {
      log("RETRY", `[${pincode}] attempt ${i}/${attempts} failed — retrying in 3s`);
      await new Promise(res => setTimeout(res, 3000));
    }
  }
  return { price: null, name: null, method: null };
}

// ─── LIVE PRICES FOR ALL PINCODES (on add) ──────────────────────────────────
async function fetchLiveAll(userId, trackId) {
  const user = db.users[userId];
  if (!user?.trackings?.[trackId]) return {};
  const t      = user.trackings[trackId];
  const pins   = user.pincodes || [];
  const prices = {};

  for (const pin of pins) {
    log("LIVE", `[${pin}] fetching for new track ${trackId}`);
    const r = await fetchWithRetry(t.url, pin, 3);
    if (r.price !== null) {
      prices[pin]       = r.price;
      t.lastPrices[pin] = r.price;
      if (!t.productName && r.name) t.productName = r.name;
    }
  }
  save();
  return prices;
}

// ─── 30s CHECK LOOP ─────────────────────────────────────────────────────────
async function checkAllPrices(userId) {
  const user = db.users[userId];
  if (!user?.approved || !user.pincodes?.length) return;
  const active = Object.entries(user.trackings || {}).filter(([, t]) => t.active);
  if (!active.length) return;

  log("CHECK", `User ${userId} | ${active.length} products | ${user.pincodes.length} pincodes`);

  for (const [trackId, t] of active) {
    for (const pin of user.pincodes) {
      const r = await fetchWithRetry(t.url, pin, 2);
      if (r.price == null) continue;

      const prev = t.lastPrices?.[pin];
      if (!t.lastPrices) t.lastPrices = {};

      if (prev !== undefined && prev !== r.price) {
        const diff  = r.price - prev;
        const emoji = diff < 0 ? "📉" : "📈";
        const word  = diff < 0 ? "कम हुई" : "बढ़ी";
        log("ALERT", `[${pin}] ${t.productName||"?"} ₹${prev} → ₹${r.price}`);

        bot.sendMessage(userId,
          `🔔 *Price Alert — ${word}!*\n\n` +
          `📦 *${t.productName || "Product"}*\n` +
          `📍 Pincode: \`${pin}\`\n\n` +
          `${emoji} ₹${Number(prev).toLocaleString("en-IN")} ➜ ₹${r.price.toLocaleString("en-IN")}\n` +
          `💰 Change: ${diff < 0 ? "−" : "+"}₹${Math.abs(diff).toLocaleString("en-IN")}\n\n` +
          `🔗 [Croma पर देखें](${t.url})`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }

      t.lastPrices[pin] = r.price;
      if (!t.productName && r.name) t.productName = r.name;
    }
  }
  save();
}

function startTracking(uid) {
  if (intervals[uid]) clearInterval(intervals[uid]);
  intervals[uid] = setInterval(() => checkAllPrices(uid), 30000);
}

// ─── KEYBOARDS ──────────────────────────────────────────────────────────────
const mainMenu = {
  reply_markup: {
    keyboard: [
      ["➕ Add Price Alert", "📋 Active Trackings"],
      ["📍 Manage Pincodes",  "🗑️ Stop Tracking"],
    ],
    resize_keyboard: true,
    persistent: true,
  },
};

// ─── /start ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const uid       = String(msg.from.id);
  const firstName = msg.from.first_name || "User";
  const username  = msg.from.username || "";
  log("BOT", `/start → ${uid}`);

  if (uid === ADMIN_ID) {
    if (!db.users[uid]) {
      db.users[uid] = { approved: true, pincodes: [], trackings: {}, isAdmin: true };
      save();
    }
    startTracking(uid);
    return bot.sendMessage(uid,
      `👑 *Welcome Admin!*\n\nBot चालू है 🟢\n\n/admin — Panel\n/logs — Live prices\n/setpincodes 400001,110001 — Pincodes\n/broadcast text`,
      { parse_mode: "Markdown", ...mainMenu });
  }

  if (db.users[uid]?.approved) {
    startTracking(uid);
    return bot.sendMessage(uid, `✅ *Welcome back, ${firstName}!*`, { parse_mode: "Markdown", ...mainMenu });
  }

  if (db.pendingUsers[uid]) {
    return bot.sendMessage(uid, "⏳ Request pending है। Admin की approval का इंतज़ार करें।");
  }

  db.pendingUsers[uid] = { firstName, username, requestTime: new Date().toISOString() };
  save();

  bot.sendMessage(ADMIN_ID,
    `🔔 *New User Request*\n\n👤 ${firstName}\n🆔 \`${uid}\`\n📱 @${username || "N/A"}`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[
        { text: "✅ Approve", callback_data: `APPROVE_${uid}` },
        { text: "❌ Reject",  callback_data: `REJECT_${uid}` },
      ]]},
    });

  bot.sendMessage(uid, `👋 Hello ${firstName}!\n\n✅ Request Admin को भेज दी।\n⏳ Approval का इंतज़ार करें।`);
});

// ─── CALLBACKS ──────────────────────────────────────────────────────────────
bot.on("callback_query", async (q) => {
  const caller = String(q.from.id);
  const d = q.data;

  if (d.startsWith("APPROVE_") && caller === ADMIN_ID) {
    const uid = d.replace("APPROVE_", "");
    db.users[uid] = { approved: true, pincodes: [], trackings: {} };
    delete db.pendingUsers[uid];
    save();
    startTracking(uid);
    bot.sendMessage(Number(uid),
      `✅ *Request approve हो गई!*\n\n⚠️ पहले 📍 *Manage Pincodes* से pincode add करें।`,
      { parse_mode: "Markdown", ...mainMenu });
    bot.editMessageText(`✅ User ${uid} approved!`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    return bot.answerCallbackQuery(q.id, { text: "✅ Approved" });
  }

  if (d.startsWith("REJECT_") && caller === ADMIN_ID) {
    const uid = d.replace("REJECT_", "");
    delete db.pendingUsers[uid];
    save();
    bot.sendMessage(Number(uid), "❌ Request reject कर दी।");
    bot.editMessageText(`❌ Rejected.`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    return bot.answerCallbackQuery(q.id, { text: "❌ Rejected" });
  }

  if (d.startsWith("STOP_")) {
    const parts   = d.split("_");
    const uid     = parts[1];
    const trackId = parts.slice(2).join("_");
    if (uid !== caller) return bot.answerCallbackQuery(q.id, { text: "❌ Unauthorized" });
    if (db.users[uid]?.trackings?.[trackId]) {
      db.users[uid].trackings[trackId].active = false;
      save();
      const name = db.users[uid].trackings[trackId].productName || "Product";
      bot.editMessageText(`🛑 Stopped:\n${name}`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    }
    return bot.answerCallbackQuery(q.id, { text: "🛑 Stopped" });
  }

  if (d.startsWith("STOPALL_")) {
    const uid = d.replace("STOPALL_", "");
    if (uid !== caller) return bot.answerCallbackQuery(q.id, { text: "❌ Unauthorized" });
    Object.values(db.users[uid]?.trackings || {}).forEach(t => (t.active = false));
    save();
    bot.editMessageText("🛑 सभी trackings बंद!", { chat_id: q.message.chat.id, message_id: q.message.message_id });
    return bot.answerCallbackQuery(q.id, { text: "🛑 All stopped" });
  }

  bot.answerCallbackQuery(q.id);
});

// ─── MESSAGES ───────────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const uid   = String(msg.from.id);
  const text  = msg.text.trim();

  if (!db.users[uid]?.approved) {
    return bot.sendMessage(uid, db.pendingUsers[uid] ? "⏳ Pending." : "❌ /start करें।");
  }

  const user  = db.users[uid];
  const state = userStates[uid];

  // ── Waiting for URL ──────────────────────────────────────────────────────
  if (state?.action === "add_url") {
    if (!user.pincodes?.length) {
      delete userStates[uid];
      return bot.sendMessage(uid,
        `⚠️ *पहले Pincode add करें!*\n\n📍 Manage Pincodes से pincode add करें।`,
        { parse_mode: "Markdown", ...mainMenu });
    }
    if (!text.includes("croma.com")) {
      return bot.sendMessage(uid, "❌ Valid Croma.com URL भेजें।\n\nExample:\nhttps://www.croma.com/product.../p/261373");
    }
    const active = Object.values(user.trackings || {}).filter(t => t.active);
    if (active.length >= 40) {
      delete userStates[uid];
      return bot.sendMessage(uid, "❌ Max 40 trackings। पहले कुछ बंद करें।", mainMenu);
    }

    const trackId = `T${Date.now()}`;
    if (!user.trackings) user.trackings = {};
    user.trackings[trackId] = { url: text, active: true, addedAt: new Date().toISOString(), lastPrices: {}, productName: null };
    save();
    delete userStates[uid];

    log("TRACK", `User ${uid} added URL → fetching ${user.pincodes.length} pincodes`);

    // ── "Fetching..." message ──
    const loadMsg = await bot.sendMessage(uid,
      `🔄 *Live prices fetch हो रही हैं...*\n\n` +
      `📍 Pincodes: ${user.pincodes.join(", ")}\n` +
      `⏳ कृपया कुछ सेकंड रुकें...`,
      { parse_mode: "Markdown" });

    // ── Fetch ALL pincodes with retry ──
    const prices = await fetchLiveAll(uid, trackId);
    const t      = db.users[uid].trackings[trackId];
    const name   = t.productName || "Croma Product";
    const pinCount = user.pincodes.length;
    const gotCount = Object.keys(prices).length;

    log("LIVE", `User ${uid} got ${gotCount}/${pinCount} prices`);

    if (gotCount > 0) {
      // ✅ Got prices — show them
      let priceLines = "";
      for (const [pin, price] of Object.entries(prices)) {
        priceLines += `📍 \`${pin}\` ➜ *₹${Number(price).toLocaleString("en-IN")}*\n`;
      }
      // If some pincodes failed, note them
      const failedPins = user.pincodes.filter(p => prices[p] == null);
      const failedLine = failedPins.length
        ? `\n⚠️ Price नहीं मिली: ${failedPins.map(p => `\`${p}\``).join(", ")}\n`
        : "";

      await bot.editMessageText(
        `✅ *Tracking शुरू हुई!*\n\n` +
        `📦 *${name.substring(0, 60)}*\n\n` +
        `💰 *Live Prices अभी:*\n${priceLines}${failedLine}\n` +
        `🔔 Price change होते ही alert मिलेगा`,
        { chat_id: loadMsg.chat.id, message_id: loadMsg.message_id, parse_mode: "Markdown" }
      ).catch(() => {});

    } else {
      // ❌ No prices at all — tell user to check URL
      await bot.editMessageText(
        `✅ *Tracking add हो गई!*\n\n` +
        `📦 URL registered\n` +
        `📍 Pincodes: ${user.pincodes.join(", ")}\n\n` +
        `⚠️ *3 बार try करने के बाद भी price नहीं मिली।*\n` +
        `कृपया URL check करें — product available है?\n\n` +
        `🔔 अगले cycle में फिर try होगी।`,
        { chat_id: loadMsg.chat.id, message_id: loadMsg.message_id, parse_mode: "Markdown" }
      ).catch(() => {});
    }

    return bot.sendMessage(uid, "📋 Menu:", mainMenu);
  }

  // ── Waiting for pincodes ─────────────────────────────────────────────────
  if (state?.action === "set_pincodes") {
    const pins = text.split("\n").map(p => p.trim()).filter(p => /^\d{6}$/.test(p));
    if (!pins.length) {
      return bot.sendMessage(uid, "❌ Valid pincode नहीं मिला। 6-digit, एक line में एक।\n\nExample:\n400001\n110001");
    }
    user.pincodes = pins;
    save();
    delete userStates[uid];
    log("PIN", `User ${uid} → ${pins.join(", ")}`);
    return bot.sendMessage(uid,
      `✅ *Pincodes save हो गई!*\n\n${pins.map(p => `📍 \`${p}\``).join("\n")}\n\nअब ➕ Add Price Alert से tracking करें।`,
      { parse_mode: "Markdown", ...mainMenu });
  }

  // ── Menu ─────────────────────────────────────────────────────────────────
  if (text === "➕ Add Price Alert") {
    if (!user.pincodes?.length) {
      return bot.sendMessage(uid,
        `⚠️ *पहले Pincode add करें!*\n\n📍 Manage Pincodes button दबाएं।`,
        { parse_mode: "Markdown", ...mainMenu });
    }
    userStates[uid] = { action: "add_url" };
    const cur = Object.values(user.trackings || {}).filter(t => t.active).length;
    return bot.sendMessage(uid,
      `🔗 *Price Alert Add करें*\n\n📍 Pincodes: ${user.pincodes.join(", ")}\n📊 Active: ${cur}/40\n\nCroma product URL भेजें:`,
      { parse_mode: "Markdown" });
  }

  if (text === "📋 Active Trackings") {
    const active = Object.entries(user.trackings || {}).filter(([, t]) => t.active);
    if (!active.length) return bot.sendMessage(uid, "📭 कोई active tracking नहीं है।", mainMenu);
    let out = `📋 *Active Trackings (${active.length}/40)*\n\n`;
    active.forEach(([, t], i) => {
      out += `*${i + 1}. ${(t.productName || "Product").substring(0, 55)}*\n`;
      (user.pincodes || []).forEach(p => {
        const pr = t.lastPrices?.[p];
        out += `  📍 \`${p}\` ➜ ${pr ? "₹" + Number(pr).toLocaleString("en-IN") : "⏳ Fetching..."}\n`;
      });
      out += `  🔗 [Link](${t.url})\n\n`;
    });
    return bot.sendMessage(uid, out, { parse_mode: "Markdown", ...mainMenu });
  }

  if (text === "📍 Manage Pincodes") {
    const cur = user.pincodes || [];
    userStates[uid] = { action: "set_pincodes" };
    const curText = cur.length
      ? `Current:\n${cur.map(p => `📍 \`${p}\``).join("\n")}\n\n`
      : `⚠️ अभी कोई pincode नहीं है!\n\n`;
    return bot.sendMessage(uid,
      `📍 *Pincodes Manage करें*\n\n${curText}नए pincodes भेजें (एक line में एक):\n\nExample:\n400001\n110001\n560001`,
      { parse_mode: "Markdown" });
  }

  if (text === "🗑️ Stop Tracking") {
    const active = Object.entries(user.trackings || {}).filter(([, t]) => t.active);
    if (!active.length) return bot.sendMessage(uid, "📭 कोई tracking नहीं है।", mainMenu);
    const kb = active.map(([id, t], i) => [{
      text: `${i + 1}. ${(t.productName || "Product").substring(0, 35)}`,
      callback_data: `STOP_${uid}_${id}`,
    }]);
    kb.push([{ text: "🛑 सभी बंद करें", callback_data: `STOPALL_${uid}` }]);
    return bot.sendMessage(uid, "🗑️ *कौनसी tracking बंद करें?*", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: kb },
    });
  }
});

// ─── ADMIN COMMANDS ──────────────────────────────────────────────────────────
bot.onText(/\/admin/, (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) return;
  const pending  = Object.keys(db.pendingUsers).length;
  const approved = Object.keys(db.users).length;
  const total    = Object.values(db.users).reduce((s, u) =>
    s + Object.values(u.trackings || {}).filter(t => t.active).length, 0);

  let info = "";
  Object.entries(db.users).forEach(([uid, u]) => {
    const a = Object.values(u.trackings || {}).filter(t => t.active);
    if (!a.length) return;
    info += `\n👤 \`${uid}\` — ${a.length} products, pins: ${(u.pincodes||[]).join(", ")||"none"}\n`;
    a.forEach(t => { info += `  • ${(t.productName||"?").substring(0,45)}\n`; });
  });

  let out = `👑 *Admin Panel*\n\n👥 Users: ${approved}\n⏳ Pending: ${pending}\n📊 Trackings: ${total}`;
  if (info) out += `\n\n*Active:*${info}`;
  if (pending) {
    out += `\n\n*Pending:*\n`;
    Object.entries(db.pendingUsers).forEach(([id, u]) => {
      out += `• ${u.firstName} (@${u.username||"N/A"}) \`${id}\`\n`;
    });
  }
  bot.sendMessage(ADMIN_ID, out, { parse_mode: "Markdown" });
});

bot.onText(/\/logs/, (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) return;
  let out = `📊 *Live Prices*\n\n`;
  let any = false;
  Object.entries(db.users).forEach(([uid, u]) => {
    const a = Object.entries(u.trackings || {}).filter(([, t]) => t.active);
    if (!a.length) return;
    any = true;
    out += `👤 *${uid}*\n`;
    a.forEach(([, t]) => {
      out += `  📦 ${(t.productName||"?").substring(0,50)}\n`;
      Object.entries(t.lastPrices||{}).forEach(([p, pr]) => {
        out += `    📍 ${p} ➜ ₹${Number(pr).toLocaleString("en-IN")}\n`;
      });
    });
    out += "\n";
  });
  if (!any) out += "कोई active tracking नहीं।";
  bot.sendMessage(ADMIN_ID, out, { parse_mode: "Markdown" });
});

bot.onText(/\/setpincodes (.+)/, (msg, match) => {
  if (String(msg.from.id) !== ADMIN_ID) return;
  const pins = match[1].split(",").map(p => p.trim()).filter(p => /^\d{6}$/.test(p));
  if (!pins.length) return bot.sendMessage(ADMIN_ID, "❌ /setpincodes 400001,110001,560001");
  if (!db.users[ADMIN_ID]) db.users[ADMIN_ID] = { approved: true, pincodes: [], trackings: {}, isAdmin: true };
  db.users[ADMIN_ID].pincodes = pins;
  save();
  bot.sendMessage(ADMIN_ID, `✅ Admin pincodes:\n${pins.map(p => `📍 ${p}`).join("\n")}`);
});

bot.onText(/\/broadcast (.+)/, (msg, match) => {
  if (String(msg.from.id) !== ADMIN_ID) return;
  const uids = Object.keys(db.users);
  uids.forEach(uid => bot.sendMessage(uid, `📢 *Admin:*\n\n${match[1]}`, { parse_mode: "Markdown" }).catch(() => {}));
  bot.sendMessage(ADMIN_ID, `✅ Sent to ${uids.length} users.`);
});

// ─── BOOT ────────────────────────────────────────────────────────────────────
Object.entries(db.users).forEach(([uid, u]) => {
  if (u.approved) {
    startTracking(uid);
    const a = Object.values(u.trackings || {}).filter(t => t.active).length;
    log("BOOT", `User ${uid} — ${a} products, ${(u.pincodes||[]).length} pincodes`);
  }
});
log("SYSTEM", `Bot STARTED | Admin: ${ADMIN_ID}`);
