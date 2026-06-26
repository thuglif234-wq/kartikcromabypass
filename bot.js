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
app.get("/", (req, res) => res.send("🤖 Croma Price Alert Bot is LIVE!"));
app.get("/ping", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));
app.listen(PORT, () => console.log(`✅ Keep-alive server on port ${PORT}`));

// Self-ping every 25 seconds to prevent Render free-tier sleep
setInterval(() => {
  axios.get(`${RENDER_URL}/ping`).catch(() => {});
}, 25000);

// ─── DATA STORE ────────────────────────────────────────────────────────────
let db = {
  users: {},          // { userId: { approved, pincodes[], trackings{} } }
  pendingUsers: {},   // { userId: { firstName, username, requestTime } }
  defaultPincodes: ["400001", "110001", "560001", "500001", "700001"],
};

if (fs.existsSync(DATA_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch (e) { console.log("Fresh db start"); }
}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

// ─── BOT INIT ──────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
const userStates = {};    // multi-step state per user
const intervals = {};     // setInterval handles per user

// ─── PRICE SCRAPER ─────────────────────────────────────────────────────────
async function fetchCromaPrice(url, pincode) {
  try {
    // Extract product ID from URL  (e.g. /p/261373)
    const pidMatch = url.match(/\/p\/(\d+)/);
    const productId = pidMatch ? pidMatch[1] : null;

    // Try Croma's internal price API first
    if (productId) {
      try {
        const apiUrl = `https://api.croma.com/products/v2/${productId}?pincode=${pincode}`;
        const apiResp = await axios.get(apiUrl, {
          timeout: 10000,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120",
            "Accept": "application/json",
            "Origin": "https://www.croma.com",
            "Referer": "https://www.croma.com/",
          },
        });
        const d = apiResp.data;
        const price =
          d?.price?.sellingPrice ||
          d?.sellingPrice ||
          d?.data?.sellingPrice ||
          null;
        const name =
          d?.name || d?.data?.name || d?.productName || null;
        if (price) return { price: parseFloat(String(price).replace(/[^0-9.]/g, "")), name, url, productId };
      } catch (_) {}
    }

    // Fallback: scrape HTML page with pincode cookie
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

    // Price selectors (Croma uses these class names)
    const priceSelectors = [
      ".pdp-selling-price",
      '[data-testid="pdp-selling-price"]',
      ".selling-price",
      ".new-price",
      ".amount",
      ".price-current",
      ".offer-price",
      "span.pdp-price",
    ];

    let price = null;
    for (const sel of priceSelectors) {
      const el = $(sel).first();
      if (el.length) {
        const raw = el.text().replace(/[^\d]/g, "");
        if (raw.length >= 2) { price = parseInt(raw, 10); break; }
      }
    }

    // Fallback: JSON-LD schema
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
      $("title").text().split("|")[0].trim() ||
      "Croma Product";

    return { price, name, url, productId };
  } catch (err) {
    console.error(`Price fetch error [${pincode}]: ${err.message}`);
    return { price: null, name: null, url, productId: null };
  }
}

// ─── PRICE CHECK LOOP ─────────────────────────────────────────────────────
async function checkAllPrices(userId) {
  const user = db.users[userId];
  if (!user?.approved) return;

  const pincodes = user.pincodes?.length ? user.pincodes : db.defaultPincodes;
  const trackings = user.trackings || {};

  for (const [trackId, t] of Object.entries(trackings)) {
    if (!t.active) continue;

    for (const pin of pincodes) {
      const result = await fetchCromaPrice(t.url, pin);
      if (result.price == null) continue;

      const prev = t.lastPrices?.[pin];
      if (!t.lastPrices) t.lastPrices = {};

      if (prev !== undefined && prev !== result.price) {
        const diff = result.price - prev;
        const emoji = diff < 0 ? "📉" : "📈";
        const word = diff < 0 ? "घटी" : "बढ़ी";
        const msg =
          `🔔 *Price Alert — ${word}!*\n\n` +
          `📦 *Product:* ${t.productName || result.name || "Product"}\n` +
          `📍 *Pincode:* ${pin}\n\n` +
          `${emoji} ₹${prev.toLocaleString("en-IN")} → ₹${result.price.toLocaleString("en-IN")}\n` +
          `💰 Change: ${diff < 0 ? "-" : "+"}₹${Math.abs(diff).toLocaleString("en-IN")}\n\n` +
          `🔗 [Croma पर देखें](${t.url})`;

        bot.sendMessage(userId, msg, { parse_mode: "Markdown" }).catch(() => {});
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
  const uid = String(msg.from.id);
  const firstName = msg.from.first_name || "User";
  const username  = msg.from.username  || "";

  if (uid === ADMIN_ID) {
    if (!db.users[uid]) {
      db.users[uid] = { approved: true, pincodes: [], trackings: {}, isAdmin: true };
      save();
    }
    startTracking(uid);
    return bot.sendMessage(uid,
      `👑 *Welcome Admin!*\n\nCroma Price Alert Bot चालू है।\n📍 Default Pincodes: ${db.defaultPincodes.join(", ")}\n\nCommands:\n/admin — Admin panel\n/setpincodes 400001,110001 — Default pincodes बदलें`,
      { parse_mode: "Markdown", ...mainMenu });
  }

  if (db.users[uid]?.approved) {
    startTracking(uid);
    return bot.sendMessage(uid,
      `✅ *Welcome back, ${firstName}!*\n\nPrice alerts चालू हैं। नीचे से option चुनें।`,
      { parse_mode: "Markdown", ...mainMenu });
  }

  if (db.pendingUsers[uid]) {
    return bot.sendMessage(uid, "⏳ आपकी request admin के पास pending है। थोड़ा इंतज़ार करें।");
  }

  db.pendingUsers[uid] = { firstName, username, requestTime: new Date().toISOString() };
  save();

  // Notify admin
  bot.sendMessage(ADMIN_ID,
    `🔔 *New User Request*\n\n👤 Name: ${firstName}\n🆔 ID: ${uid}\n📱 @${username || "N/A"}`,
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
    `👋 Hello ${firstName}!\n\n✅ आपकी access request Admin को भेज दी गई है।\n⏳ Approval के बाद आप bot use कर सकेंगे।`);
});

// ─── CALLBACK QUERIES ─────────────────────────────────────────────────────
bot.on("callback_query", async (q) => {
  const callerId = String(q.from.id);
  const data_str = q.data;

  // ── Admin: Approve/Reject user ──
  if (data_str.startsWith("APPROVE_") && callerId === ADMIN_ID) {
    const targetUid = data_str.replace("APPROVE_", "");
    db.users[targetUid] = { approved: true, pincodes: [], trackings: {} };
    delete db.pendingUsers[targetUid];
    save();
    startTracking(targetUid);
    bot.sendMessage(Number(targetUid),
      "✅ *आपकी request approve हो गई!*\n\nCroma Price Alert Bot में आपका स्वागत है!\nनीचे menu से शुरू करें।",
      { parse_mode: "Markdown", ...mainMenu });
    bot.editMessageText(`✅ User ${targetUid} approved!`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    return bot.answerCallbackQuery(q.id, { text: "✅ Approved" });
  }

  if (data_str.startsWith("REJECT_") && callerId === ADMIN_ID) {
    const targetUid = data_str.replace("REJECT_", "");
    delete db.pendingUsers[targetUid];
    save();
    bot.sendMessage(Number(targetUid), "❌ Admin ने आपकी request reject कर दी।");
    bot.editMessageText(`❌ User ${targetUid} rejected.`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    return bot.answerCallbackQuery(q.id, { text: "❌ Rejected" });
  }

  // ── Stop single tracking ──
  if (data_str.startsWith("STOP_")) {
    const [, uid, ...rest] = data_str.split("_");
    if (uid !== callerId) return bot.answerCallbackQuery(q.id, { text: "❌ Unauthorized" });
    const trackId = rest.join("_");
    if (db.users[uid]?.trackings?.[trackId]) {
      db.users[uid].trackings[trackId].active = false;
      save();
      const name = db.users[uid].trackings[trackId].productName || "Product";
      bot.editMessageText(`🛑 Tracking stopped:\n${name}`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
      bot.answerCallbackQuery(q.id, { text: "🛑 Stopped" });
    }
    return;
  }

  // ── Stop ALL trackings ──
  if (data_str.startsWith("STOPALL_")) {
    const uid = data_str.replace("STOPALL_", "");
    if (uid !== callerId) return bot.answerCallbackQuery(q.id, { text: "❌ Unauthorized" });
    Object.values(db.users[uid]?.trackings || {}).forEach(t => (t.active = false));
    save();
    bot.editMessageText("🛑 सभी trackings बंद कर दी गईं!", { chat_id: q.message.chat.id, message_id: q.message.message_id });
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

  const user = db.users[uid];

  // ── Multi-step state handler ──
  const state = userStates[uid];

  if (state?.action === "add_url") {
    if (!text.includes("croma.com")) {
      return bot.sendMessage(uid, "❌ कृपया valid Croma.com product URL भेजें।");
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

    const pins = user.pincodes?.length ? user.pincodes : db.defaultPincodes;
    bot.sendMessage(uid,
      `✅ *Tracking शुरू हुई!*\n\n🔗 URL add हो गई\n📍 Pincodes: ${pins.join(", ")}\n⏰ हर 30 सेकंड में price check होगी।`,
      { parse_mode: "Markdown", ...mainMenu });

    // Immediate first check
    setTimeout(() => checkAllPrices(uid), 3000);
    return;
  }

  if (state?.action === "set_pincodes") {
    const pins = text.split("\n").map(p => p.trim()).filter(p => /^\d{6}$/.test(p));
    if (!pins.length) {
      return bot.sendMessage(uid, "❌ Valid pincodes नहीं मिले। 6-digit pincode एक line में एक लिखें।");
    }
    user.pincodes = pins;
    save();
    delete userStates[uid];
    return bot.sendMessage(uid,
      `✅ *Pincodes update हो गई!*\n\n${pins.map(p => `📍 ${p}`).join("\n")}`,
      { parse_mode: "Markdown", ...mainMenu });
  }

  // ── Main menu buttons ──
  if (text === "➕ Add Price Alert") {
    userStates[uid] = { action: "add_url" };
    return bot.sendMessage(uid,
      "🔗 *Price Alert Add करें*\n\nCroma product का URL भेजें:\n\nExample:\nhttps://www.croma.com/apple-iphone.../p/261373",
      { parse_mode: "Markdown" });
  }

  if (text === "📋 Active Trackings") {
    const active = Object.entries(user.trackings || {}).filter(([, t]) => t.active);
    if (!active.length) {
      return bot.sendMessage(uid, "📭 कोई active tracking नहीं है।", mainMenu);
    }
    const pins = user.pincodes?.length ? user.pincodes : db.defaultPincodes;
    let out = `📋 *Active Trackings (${active.length}/40)*\n\n`;
    active.forEach(([, t], i) => {
      out += `*${i + 1}. ${(t.productName || "Product").substring(0, 50)}*\n`;
      pins.forEach(p => {
        const pr = t.lastPrices?.[p];
        out += `  📍 ${p}: ${pr ? "₹" + pr.toLocaleString("en-IN") : "Fetching..."}\n`;
      });
      out += `  🔗 [Link](${t.url})\n\n`;
    });
    return bot.sendMessage(uid, out, { parse_mode: "Markdown", ...mainMenu });
  }

  if (text === "📍 Manage Pincodes") {
    const cur = user.pincodes?.length ? user.pincodes : db.defaultPincodes;
    userStates[uid] = { action: "set_pincodes" };
    return bot.sendMessage(uid,
      `📍 *Pincodes Manage करें*\n\nCurrent pincodes:\n${cur.map(p => p).join("\n")}\n\n✏️ नए pincodes भेजें (एक line में एक):\n\nExample:\n400001\n110001\n560001`,
      { parse_mode: "Markdown" });
  }

  if (text === "🗑️ Stop Tracking") {
    const active = Object.entries(user.trackings || {}).filter(([, t]) => t.active);
    if (!active.length) {
      return bot.sendMessage(uid, "📭 बंद करने के लिए कोई tracking नहीं है।", mainMenu);
    }
    const kb = active.map(([id, t], i) => [{
      text: `${i + 1}. ${(t.productName || t.url.split("/").slice(-2, -1)[0] || "Product").substring(0, 35)}`,
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

  let out =
    `👑 *Admin Panel*\n\n` +
    `👥 Approved Users: ${approved}\n` +
    `⏳ Pending: ${pending}\n` +
    `📊 Total Active Trackings: ${total}\n` +
    `📍 Default Pincodes: ${db.defaultPincodes.join(", ")}\n\n`;

  if (pending) {
    out += "*Pending Requests:*\n";
    Object.entries(db.pendingUsers).forEach(([id, u]) => {
      out += `• ${u.firstName} (@${u.username || "N/A"}) — \`${id}\`\n`;
    });
  }
  bot.sendMessage(ADMIN_ID, out, { parse_mode: "Markdown" });
});

// /setpincodes 400001,110001,560001
bot.onText(/\/setpincodes (.+)/, (msg, match) => {
  if (String(msg.from.id) !== ADMIN_ID) return;
  const pins = match[1].split(",").map(p => p.trim()).filter(p => /^\d{6}$/.test(p));
  if (!pins.length) return bot.sendMessage(ADMIN_ID, "❌ Format: /setpincodes 400001,110001,560001");
  db.defaultPincodes = pins;
  save();
  bot.sendMessage(ADMIN_ID, `✅ Default pincodes set: ${pins.join(", ")}`);
});

// /broadcast <message>
bot.onText(/\/broadcast (.+)/, (msg, match) => {
  if (String(msg.from.id) !== ADMIN_ID) return;
  const text = match[1];
  let count = 0;
  Object.keys(db.users).forEach(uid => {
    bot.sendMessage(uid, `📢 *Admin Message:*\n\n${text}`, { parse_mode: "Markdown" })
      .then(() => count++).catch(() => {});
  });
  bot.sendMessage(ADMIN_ID, `✅ Broadcast भेजा ${Object.keys(db.users).length} users को।`);
});

// ─── STARTUP ───────────────────────────────────────────────────────────────
Object.entries(db.users).forEach(([uid, u]) => {
  if (u.approved) startTracking(uid);
});

console.log("🤖 Croma Price Alert Bot STARTED");
console.log(`👑 Admin: ${ADMIN_ID}`);
console.log(`📍 Default Pincodes: ${db.defaultPincodes.join(", ")}`);
console.log(`👥 Approved users: ${Object.keys(db.users).length}`);
