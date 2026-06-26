const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");
const fs = require("fs");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const TOKEN = "8886757834:AAHBChGEoCndNDtKWPp22bL-B1PGN52_CfQ";
const ADMIN_ID = "7485181331";
const DATA_FILE = "./data.json";
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || `http://localhost:${PORT}`;

// ─── KEEP-ALIVE SERVER ─────────────────────────────────────────────────────
const app = express();
app.get("/", (req, res) => res.send("Bot is running!"));
app.get("/ping", (req, res) => res.json({ ok: true }));
app.listen(PORT, () => log("SYSTEM", `Server started on port ${PORT}`));
setInterval(() => axios.get(`${RENDER_URL}/ping`).catch(() => {}), 25000);

// ─── LOGGER ────────────────────────────────────────────────────────────────
function log(tag, msg) {
  const ts = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  console.log(`[${ts}] [${tag}] ${msg}`);
}

// ─── DATA STORE ────────────────────────────────────────────────────────────
let db = { users: {}, pendingUsers: {} };

if (fs.existsSync(DATA_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch (e) { log("DB", "Fresh start"); }
}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

// ─── BOT ───────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
const userStates = {};
const intervals  = {};

// ─── PRICE SCRAPER ─────────────────────────────────────────────────────────
async function fetchCromaPrice(url, pincode) {
  try {
    const pidMatch = url.match(/\/p\/(\d+)/);
    const productId = pidMatch ? pidMatch[1] : null;

    // Try Croma internal API first
    if (productId) {
      try {
        const apiUrl = `https://api.croma.com/products/v2/${productId}?pincode=${pincode}`;
        const r = await axios.get(apiUrl, {
          timeout: 10000,
          headers: {
            "User-Agent": "Mozilla/5.0 Chrome/120",
            "Accept": "application/json",
            "Origin": "https://www.croma.com",
            "Referer": "https://www.croma.com/",
          },
        });
        const d = r.data;
        const price = d?.price?.sellingPrice || d?.sellingPrice || d?.data?.sellingPrice || null;
        const name  = d?.name || d?.data?.name || d?.productName || null;
        if (price) {
          const p = parseFloat(String(price).replace(/[^0-9.]/g, ""));
          log("API", `[${pincode}] ${(name || productId).substring(0,40)} → ₹${p}`);
          return { price: p, name, url, productId };
        }
      } catch (_) {}
    }

    // Fallback: HTML scraping with pincode cookie
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
        "Cookie": `pincode=${pincode}; selectedPincode=${pincode}; storeId=${pincode}`,
        "Referer": "https://www.croma.com/",
      },
    });

    const $ = cheerio.load(resp.data);
    const priceSelectors = [
      ".pdp-selling-price",
      '[data-testid="pdp-selling-price"]',
      ".selling-price", ".new-price", ".amount",
      ".price-current", ".offer-price", "span.pdp-price",
    ];

    let price = null;
    for (const sel of priceSelectors) {
      const el = $(sel).first();
      if (el.length) {
        const raw = el.text().replace(/[^\d]/g, "");
        if (raw.length >= 2) { price = parseInt(raw, 10); break; }
      }
    }

    // JSON-LD fallback
    if (!price) {
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const json = JSON.parse($(el).html());
          const p = json?.offers?.price || json?.price;
          if (p && !price) price = parseFloat(p);
        } catch (_) {}
      });
    }

    const name =
      $("h1.pdp-title").first().text().trim() ||
      $("h1").first().text().trim() ||
      $("title").text().split("|")[0].trim() || "Croma Product";

    log("SCRAPE", `[${pincode}] ${name.substring(0,40)} → ${price ? "₹" + price : "Not found"}`);
    return { price, name, url, productId };
  } catch (err) {
    log("ERROR", `[${pincode}] ${err.message}`);
    return { price: null, name: null, url, productId: null };
  }
}

// ─── PRICE CHECK LOOP (every 30s) ──────────────────────────────────────────
async function checkAllPrices(userId) {
  const user = db.users[userId];
  if (!user?.approved) return;
  if (!user.pincodes?.length) return;

  const trackings = user.trackings || {};
  const active    = Object.entries(trackings).filter(([, t]) => t.active);
  if (!active.length) return;

  log("CHECK", `User ${userId} | ${active.length} products | ${user.pincodes.length} pincodes`);

  for (const [trackId, t] of active) {
    for (const pin of user.pincodes) {
      const result = await fetchCromaPrice(t.url, pin);
      if (result.price == null) continue;

      const prev = t.lastPrices?.[pin];
      if (!t.lastPrices) t.lastPrices = {};

      // Price changed — send alert
      if (prev !== undefined && prev !== result.price) {
        const diff  = result.price - prev;
        const emoji = diff < 0 ? "📉" : "📈";
        const word  = diff < 0 ? "कम हुई" : "बढ़ी";
        log("ALERT", `User ${userId} | ${t.productName || "?"} | Pin ${pin} | ₹${prev} → ₹${result.price}`);

        bot.sendMessage(userId,
          `🔔 *Price Alert — ${word}!*\n\n` +
          `📦 *${t.productName || "Product"}*\n` +
          `📍 Pincode: \`${pin}\`\n\n` +
          `${emoji} ₹${Number(prev).toLocaleString("en-IN")} ➜ ₹${result.price.toLocaleString("en-IN")}\n` +
          `💰 Change: ${diff < 0 ? "−" : "+"}₹${Math.abs(diff).toLocaleString("en-IN")}\n\n` +
          `🔗 [Croma पर देखें](${t.url})`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }

      t.lastPrices[pin] = result.price;
      if (!t.productName && result.name) t.productName = result.name;
    }
  }
  save();
}

function startTracking(userId) {
  if (intervals[userId]) clearInterval(intervals[userId]);
  intervals[userId] = setInterval(() => checkAllPrices(userId), 30000);
}

// ─── KEYBOARDS ────────────────────────────────────────────────────────────
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

// ─── /start ───────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const uid       = String(msg.from.id);
  const firstName = msg.from.first_name || "User";
  const username  = msg.from.username || "";

  log("BOT", `/start → ${uid} (${firstName})`);

  if (uid === ADMIN_ID) {
    if (!db.users[uid]) {
      db.users[uid] = { approved: true, pincodes: [], trackings: {}, isAdmin: true };
      save();
    }
    startTracking(uid);
    return bot.sendMessage(uid,
      `👑 *Welcome Admin!*\n\nBot चालू है 🟢\n\n*Commands:*\n/admin — Panel\n/logs — Live prices\n/setpincodes 400001,110001 — Pincodes set करें\n/broadcast text — सबको message`,
      { parse_mode: "Markdown", ...mainMenu });
  }

  if (db.users[uid]?.approved) {
    startTracking(uid);
    return bot.sendMessage(uid,
      `✅ *Welcome back, ${firstName}!*\n\nनीचे से option चुनें।`,
      { parse_mode: "Markdown", ...mainMenu });
  }

  if (db.pendingUsers[uid]) {
    return bot.sendMessage(uid, "⏳ आपकी request pending है। Admin की approval का इंतज़ार करें।");
  }

  db.pendingUsers[uid] = { firstName, username, requestTime: new Date().toISOString() };
  save();

  bot.sendMessage(ADMIN_ID,
    `🔔 *New User Request*\n\n👤 ${firstName}\n🆔 \`${uid}\`\n📱 @${username || "N/A"}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `APPROVE_${uid}` },
          { text: "❌ Reject",  callback_data: `REJECT_${uid}` },
        ]],
      },
    });

  bot.sendMessage(uid,
    `👋 Hello ${firstName}!\n\n✅ आपकी request Admin को भेज दी गई है।\n⏳ Approval का इंतज़ार करें।`);
});

// ─── CALLBACKS ────────────────────────────────────────────────────────────
bot.on("callback_query", async (q) => {
  const callerId = String(q.from.id);
  const d = q.data;

  if (d.startsWith("APPROVE_") && callerId === ADMIN_ID) {
    const uid = d.replace("APPROVE_", "");
    db.users[uid] = { approved: true, pincodes: [], trackings: {} };
    delete db.pendingUsers[uid];
    save();
    startTracking(uid);
    log("ADMIN", `Approved ${uid}`);
    bot.sendMessage(Number(uid),
      `✅ *Request approve हो गई!*\n\nBot में स्वागत है!\n\n⚠️ पहले *📍 Manage Pincodes* से pincode add करें, फिर tracking शुरू कर सकते हैं।`,
      { parse_mode: "Markdown", ...mainMenu });
    bot.editMessageText(`✅ User ${uid} approved!`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    return bot.answerCallbackQuery(q.id, { text: "✅ Approved" });
  }

  if (d.startsWith("REJECT_") && callerId === ADMIN_ID) {
    const uid = d.replace("REJECT_", "");
    delete db.pendingUsers[uid];
    save();
    log("ADMIN", `Rejected ${uid}`);
    bot.sendMessage(Number(uid), "❌ Admin ने आपकी request reject कर दी।");
    bot.editMessageText(`❌ User ${uid} rejected.`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    return bot.answerCallbackQuery(q.id, { text: "❌ Rejected" });
  }

  if (d.startsWith("STOP_")) {
    const parts   = d.split("_");
    const uid     = parts[1];
    const trackId = parts.slice(2).join("_");
    if (uid !== callerId) return bot.answerCallbackQuery(q.id, { text: "❌ Unauthorized" });
    if (db.users[uid]?.trackings?.[trackId]) {
      db.users[uid].trackings[trackId].active = false;
      save();
      const name = db.users[uid].trackings[trackId].productName || "Product";
      log("TRACK", `User ${uid} stopped → ${name}`);
      bot.editMessageText(`🛑 Tracking stopped:\n${name}`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    }
    return bot.answerCallbackQuery(q.id, { text: "🛑 Stopped" });
  }

  if (d.startsWith("STOPALL_")) {
    const uid = d.replace("STOPALL_", "");
    if (uid !== callerId) return bot.answerCallbackQuery(q.id, { text: "❌ Unauthorized" });
    Object.values(db.users[uid]?.trackings || {}).forEach(t => (t.active = false));
    save();
    log("TRACK", `User ${uid} stopped ALL`);
    bot.editMessageText("🛑 सभी trackings बंद!", { chat_id: q.message.chat.id, message_id: q.message.message_id });
    return bot.answerCallbackQuery(q.id, { text: "🛑 All stopped" });
  }

  bot.answerCallbackQuery(q.id);
});

// ─── MESSAGES ─────────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const uid  = String(msg.from.id);
  const text = msg.text.trim();

  if (!db.users[uid]?.approved) {
    return bot.sendMessage(uid, db.pendingUsers[uid]
      ? "⏳ Request pending है।"
      : "❌ Access नहीं है। /start करें।");
  }

  const user  = db.users[uid];
  const state = userStates[uid];

  // ── State: waiting for URL ──────────────────────────────────────────────
  if (state?.action === "add_url") {

    // Block if no pincode set
    if (!user.pincodes?.length) {
      delete userStates[uid];
      return bot.sendMessage(uid,
        `⚠️ *पहले Pincode add करें!*\n\nBina pincode के tracking नहीं होगी।\n\n📍 *Manage Pincodes* से pincode add करें।`,
        { parse_mode: "Markdown", ...mainMenu });
    }

    if (!text.includes("croma.com")) {
      return bot.sendMessage(uid,
        "❌ Valid Croma.com URL नहीं है।\n\nExample:\nhttps://www.croma.com/apple-iphone.../p/261373");
    }

    const active = Object.values(user.trackings || {}).filter(t => t.active);
    if (active.length >= 40) {
      delete userStates[uid];
      return bot.sendMessage(uid, "❌ Maximum 40 trackings हो गई हैं। पहले कुछ बंद करें।", mainMenu);
    }

    const trackId = `T${Date.now()}`;
    if (!user.trackings) user.trackings = {};
    user.trackings[trackId] = {
      url: text, active: true,
      addedAt: new Date().toISOString(),
      lastPrices: {}, productName: null,
    };
    save();
    delete userStates[uid];

    log("TRACK", `User ${uid} added URL — fetching live prices for ${user.pincodes.length} pincodes`);

    // Send "fetching" message immediately
    const fetchMsg = await bot.sendMessage(uid,
      `⏳ *Prices fetch हो रही हैं...*\n\n📍 Pincodes: ${user.pincodes.join(", ")}\n\nकृपया कुछ सेकंड इंतज़ार करें...`,
      { parse_mode: "Markdown" });

    // Fetch live prices for all pincodes NOW
    const t = user.trackings[trackId];
    const priceResults = {};

    for (const pin of user.pincodes) {
      const r = await fetchCromaPrice(t.url, pin);
      if (r.price !== null) {
        priceResults[pin] = r.price;
        t.lastPrices[pin] = r.price;
        if (!t.productName && r.name) t.productName = r.name;
      }
    }
    save();

    const productName = t.productName || "Product";
    const hasPrices   = Object.keys(priceResults).length > 0;

    if (hasPrices) {
      let priceLines = "";
      for (const [pin, price] of Object.entries(priceResults)) {
        priceLines += `📍 \`${pin}\` ➜ ₹${Number(price).toLocaleString("en-IN")}\n`;
      }

      bot.editMessageText(
        `✅ *Tracking शुरू हुई!*\n\n` +
        `📦 *${productName.substring(0, 60)}*\n\n` +
        `💰 *Live Prices अभी:*\n${priceLines}\n` +
        `🔔 Price change होते ही alert आएगा`,
        { chat_id: fetchMsg.chat.id, message_id: fetchMsg.message_id, parse_mode: "Markdown" }
      ).catch(() => {});

    } else {
      bot.editMessageText(
        `✅ *Tracking add हो गई!*\n\n` +
        `📦 URL registered\n` +
        `📍 Pincodes: ${user.pincodes.join(", ")}\n\n` +
        `⚠️ अभी price नहीं मिली — अगले cycle में retry होगी\n` +
        `🔔 Price change होते ही alert आएगा`,
        { chat_id: fetchMsg.chat.id, message_id: fetchMsg.message_id, parse_mode: "Markdown" }
      ).catch(() => {});
    }

    return bot.sendMessage(uid, "📋 Menu:", mainMenu);
  }

  // ── State: waiting for pincodes ──────────────────────────────────────────
  if (state?.action === "set_pincodes") {
    const pins = text.split("\n").map(p => p.trim()).filter(p => /^\d{6}$/.test(p));
    if (!pins.length) {
      return bot.sendMessage(uid,
        "❌ Valid pincode नहीं मिला।\n\n6-digit pincode, एक line में एक लिखें।\n\nExample:\n400001\n110001");
    }
    user.pincodes = pins;
    save();
    delete userStates[uid];
    log("PINCODE", `User ${uid} set: ${pins.join(", ")}`);
    return bot.sendMessage(uid,
      `✅ *Pincodes save हो गई!*\n\n${pins.map(p => `📍 \`${p}\``).join("\n")}\n\nअब ➕ Add Price Alert से tracking शुरू करें।`,
      { parse_mode: "Markdown", ...mainMenu });
  }

  // ── Menu buttons ──────────────────────────────────────────────────────────
  if (text === "➕ Add Price Alert") {
    // Block if no pincode
    if (!user.pincodes?.length) {
      return bot.sendMessage(uid,
        `⚠️ *पहले Pincode add करें!*\n\n📍 *Manage Pincodes* button से pincode add करें।\n\nBina pincode ke tracking नहीं होगी।`,
        { parse_mode: "Markdown", ...mainMenu });
    }
    userStates[uid] = { action: "add_url" };
    const cur = Object.values(user.trackings || {}).filter(t => t.active).length;
    return bot.sendMessage(uid,
      `🔗 *Price Alert Add करें*\n\n` +
      `📍 Your Pincodes: ${user.pincodes.join(", ")}\n` +
      `📊 Active: ${cur}/40\n\n` +
      `Croma product का URL भेजें:`,
      { parse_mode: "Markdown" });
  }

  if (text === "📋 Active Trackings") {
    const active = Object.entries(user.trackings || {}).filter(([, t]) => t.active);
    if (!active.length) {
      return bot.sendMessage(uid, "📭 कोई active tracking नहीं है।\n\n➕ Add Price Alert से शुरू करें।", mainMenu);
    }
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
    const cur = user.pincodes?.length ? user.pincodes : [];
    userStates[uid] = { action: "set_pincodes" };
    const curText = cur.length
      ? `Current pincodes:\n${cur.map(p => `📍 \`${p}\``).join("\n")}\n\n`
      : `⚠️ अभी कोई pincode नहीं है।\n\n`;
    return bot.sendMessage(uid,
      `📍 *Pincodes Manage करें*\n\n${curText}✏️ नए pincodes भेजें (एक line में एक):\n\nExample:\n400001\n110001\n560001`,
      { parse_mode: "Markdown" });
  }

  if (text === "🗑️ Stop Tracking") {
    const active = Object.entries(user.trackings || {}).filter(([, t]) => t.active);
    if (!active.length) {
      return bot.sendMessage(uid, "📭 बंद करने के लिए कोई tracking नहीं है।", mainMenu);
    }
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

// ─── ADMIN COMMANDS ────────────────────────────────────────────────────────
bot.onText(/\/admin/, (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) return;
  const pending  = Object.keys(db.pendingUsers).length;
  const approved = Object.keys(db.users).length;
  const total    = Object.values(db.users).reduce(
    (s, u) => s + Object.values(u.trackings || {}).filter(t => t.active).length, 0);

  let trackInfo = "";
  Object.entries(db.users).forEach(([uid, u]) => {
    const uActive = Object.values(u.trackings || {}).filter(t => t.active);
    if (uActive.length) {
      trackInfo += `\n👤 \`${uid}\` — ${uActive.length} products, pincodes: ${(u.pincodes||[]).join(", ") || "none"}\n`;
      uActive.forEach(t => {
        trackInfo += `  • ${(t.productName || "Unknown").substring(0, 45)}\n`;
      });
    }
  });

  let out =
    `👑 *Admin Panel*\n\n` +
    `👥 Users: ${approved}\n⏳ Pending: ${pending}\n📊 Total Trackings: ${total}\n`;
  if (trackInfo) out += `\n*Currently Tracking:*${trackInfo}`;
  if (pending) {
    out += `\n*Pending:*\n`;
    Object.entries(db.pendingUsers).forEach(([id, u]) => {
      out += `• ${u.firstName} (@${u.username || "N/A"}) — \`${id}\`\n`;
    });
  }
  bot.sendMessage(ADMIN_ID, out, { parse_mode: "Markdown" });
});

bot.onText(/\/logs/, (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) return;
  let out = `📊 *Live Prices Log*\n\n`;
  let found = false;
  Object.entries(db.users).forEach(([uid, u]) => {
    const active = Object.entries(u.trackings || {}).filter(([, t]) => t.active);
    if (!active.length) return;
    found = true;
    out += `👤 *User ${uid}*\n`;
    active.forEach(([, t]) => {
      out += `  📦 ${(t.productName || "Unknown").substring(0, 50)}\n`;
      Object.entries(t.lastPrices || {}).forEach(([pin, price]) => {
        out += `    📍 ${pin} ➜ ₹${Number(price).toLocaleString("en-IN")}\n`;
      });
    });
    out += "\n";
  });
  if (!found) out += "कोई active tracking नहीं।";
  bot.sendMessage(ADMIN_ID, out, { parse_mode: "Markdown" });
});

bot.onText(/\/setpincodes (.+)/, (msg, match) => {
  if (String(msg.from.id) !== ADMIN_ID) return;
  const pins = match[1].split(",").map(p => p.trim()).filter(p => /^\d{6}$/.test(p));
  if (!pins.length) return bot.sendMessage(ADMIN_ID, "❌ /setpincodes 400001,110001,560001");
  if (!db.users[ADMIN_ID]) db.users[ADMIN_ID] = { approved: true, pincodes: [], trackings: {}, isAdmin: true };
  db.users[ADMIN_ID].pincodes = pins;
  save();
  bot.sendMessage(ADMIN_ID, `✅ Pincodes set:\n${pins.map(p => `📍 ${p}`).join("\n")}`);
});

bot.onText(/\/broadcast (.+)/, (msg, match) => {
  if (String(msg.from.id) !== ADMIN_ID) return;
  const uids = Object.keys(db.users);
  uids.forEach(uid => {
    bot.sendMessage(uid, `📢 *Admin:*\n\n${match[1]}`, { parse_mode: "Markdown" }).catch(() => {});
  });
  bot.sendMessage(ADMIN_ID, `✅ Sent to ${uids.length} users.`);
});

// ─── STARTUP ───────────────────────────────────────────────────────────────
Object.entries(db.users).forEach(([uid, u]) => {
  if (u.approved) {
    startTracking(uid);
    const active = Object.values(u.trackings || {}).filter(t => t.active).length;
    log("BOOT", `User ${uid} resumed — ${active} products, ${(u.pincodes||[]).length} pincodes`);
  }
});

log("SYSTEM", "Bot STARTED");
log("SYSTEM", `Admin: ${ADMIN_ID}`);
