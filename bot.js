const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");
const fs = require("fs");

const TOKEN    = "8886757834:AAHBChGEoCndNDtKWPp22bL-B1PGN52_CfQ";
const ADMIN_ID = "7485181331";
const DATA_FILE = "./data.json";
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || `http://localhost:${PORT}`;

// ─── EXPRESS KEEP-ALIVE ──────────────────────────────────────────────────────
const app = express();
app.get("/", (_, res) => res.send("Bot running ✅"));
app.get("/ping", (_, res) => res.json({ ok: true, ts: Date.now() }));
app.listen(PORT, () => log("SYS", `Server on :${PORT}`));
setInterval(() => axios.get(`${RENDER_URL}/ping`).catch(() => {}), 25000);

// ─── LOGGER ─────────────────────────────────────────────────────────────────
function log(tag, msg) {
  const ts = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  console.log(`[${ts}] [${tag.padEnd(6)}] ${msg}`);
}

// ─── DB ─────────────────────────────────────────────────────────────────────
let db = { users: {}, pendingUsers: {} };
try { if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE)); } catch (_) {}
const save = () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch(e) { log("DB_ERR", e.message); } };

const bot = new TelegramBot(TOKEN, { polling: true });
const userStates = {};
const intervals  = {};

// ─── EXTRACT PRODUCT ID & NAME FROM URL ─────────────────────────────────────
function extractProductId(url) {
  const m = url.match(/\/p\/(\d+)/i);
  return m ? m[1] : null;
}

function extractProductName(url) {
  const m = url.match(/croma\.com\/([^\/]+)\/p\/\d+/i);
  if (m && m[1] && m[1].length > 2) {
    return m[1].replace(/-+/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim();
  }
  return null;
}

// ─── CROMA PRICE API (direct — no auth needed) ───────────────────────────────
async function fetchCromaPrice(productId, pincode) {
  const url = `https://api.croma.com/pricing-services/v2/price/national?itemIds=${productId}&pincode=${pincode}`;
  try {
    const resp = await axios.get(url, {
      timeout: 12000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "channel": "EC",
        "Referer": "https://www.croma.com/",
        "Origin": "https://www.croma.com",
      },
    });

    const item = resp.data?.pricelist?.[0];
    if (!item) { log("API❌ ", `[${pincode}] No pricelist in response`); return null; }
    if (item.errorMessage) { log("API⚠ ", `[${pincode}] ${item.errorMessage}`); return null; }

    // sellingPriceValue is clean number, sellingPrice has ₹ symbol
    const raw = item.sellingPriceValue ?? item.sellingPrice ?? null;
    if (!raw) { log("API❌ ", `[${pincode}] No price field in item`); return null; }

    const price = parseFloat(String(raw).replace(/[^\d.]/g, ""));
    if (isNaN(price) || price <= 0) { log("API❌ ", `[${pincode}] Invalid price: ${raw}`); return null; }

    log("API✅ ", `[${pincode}] pid=${productId} → ₹${price.toLocaleString("en-IN")} (MRP ₹${item.mrpValue||"?"})`);
    return price;
  } catch (e) {
    log("API❌ ", `[${pincode}] ${e.message.substring(0, 80)}`);
    return null;
  }
}

// ─── FETCH WITH RETRY ────────────────────────────────────────────────────────
async function fetchWithRetry(productId, pincode, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    const price = await fetchCromaPrice(productId, pincode);
    if (price !== null) return price;
    if (i < attempts) {
      log("RETRY", `[${pincode}] attempt ${i}/${attempts} → wait 3s`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  log("GIVE↑", `[${pincode}] All ${attempts} attempts failed`);
  return null;
}

// ─── LIVE PRICES ON ADD (all pincodes) ──────────────────────────────────────
async function fetchLiveAll(userId, trackId) {
  const user = db.users[userId];
  if (!user?.trackings?.[trackId]) return {};
  const t    = user.trackings[trackId];
  const pins = user.pincodes || [];
  const pid  = extractProductId(t.url);
  if (!pid) return {};

  const prices = {};
  for (const pin of pins) {
    log("LIVE", `[${pin}] initial fetch → pid=${pid}`);
    const price = await fetchWithRetry(pid, pin, 3);
    if (price !== null) {
      prices[pin]       = price;
      t.lastPrices[pin] = price;
    }
  }
  save();
  return prices;
}

// ─── 30s PRICE CHECK ────────────────────────────────────────────────────────
async function checkAllPrices(userId) {
  try {
    const user = db.users[userId];
    if (!user?.approved || !user.pincodes?.length) return;
    const active = Object.entries(user.trackings || {}).filter(([, t]) => t.active);
    if (!active.length) return;

    log("CHK", `uid=${userId} | ${active.length} products | ${user.pincodes.length} pincodes`);

    for (const [trackId, t] of active) {
      const pid = extractProductId(t.url);
      if (!pid) continue;

      for (const pin of user.pincodes) {
        const price = await fetchCromaPrice(pid, pin);
        if (price === null) continue;

        const prev = t.lastPrices?.[pin];
        if (!t.lastPrices) t.lastPrices = {};

        if (prev !== undefined && prev !== price) {
          const diff  = price - prev;
          const emoji = diff < 0 ? "📉" : "📈";
          const word  = diff < 0 ? "कम हुई" : "बढ़ी";
          log("ALERT", `uid=${userId} [${pin}] ${t.productName||pid} ₹${prev}→₹${price}`);

          bot.sendMessage(userId,
            `🔔 *Price ${word}!*\n\n` +
            `📦 *${(t.productName || "Product").substring(0, 60)}*\n` +
            `📍 Pincode: \`${pin}\`\n\n` +
            `${emoji} ₹${Number(prev).toLocaleString("en-IN")} ➜ *₹${price.toLocaleString("en-IN")}*\n` +
            `💰 Change: ${diff < 0 ? "−" : "+"}₹${Math.abs(diff).toLocaleString("en-IN")}\n\n` +
            `🛒 [Croma पर देखें](${t.url})`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
        }

        t.lastPrices[pin] = price;
      }
    }
    save();
  } catch (err) {
    log("ERR", `checkAllPrices uid=${userId} → ${err.message}`);
  }
}

function startTracking(uid) {
  if (intervals[uid]) clearInterval(intervals[uid]);
  intervals[uid] = setInterval(() => checkAllPrices(uid), 30000);
  log("START", `Tracking loop started for uid=${uid}`);
}

// ─── KEYBOARDS ──────────────────────────────────────────────────────────────
const mainMenu = {
  reply_markup: {
    keyboard: [
      ["➕ Add Price Alert",  "📋 Active Trackings"],
      ["📍 Manage Pincodes", "🗑️ Stop Tracking"],
    ],
    resize_keyboard: true,
    persistent: true,
  },
};

// ─── /start ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const uid       = String(msg.from.id);
  const firstName = msg.from.first_name || "User";
  const username  = msg.from.username   || "";
  log("BOT", `/start → ${uid}`);

  if (uid === ADMIN_ID) {
    if (!db.users[uid]) {
      db.users[uid] = { approved: true, pincodes: [], trackings: {}, isAdmin: true };
      save();
    }
    startTracking(uid);
    return bot.sendMessage(uid,
      `👑 *Admin Panel*\n\n✅ Bot चालू है\n\n` +
      `/admin — Dashboard\n/logs — Live prices\n/setpincodes 400001,110001 — Apne pincodes\n/broadcast text — Sabko msg`,
      { parse_mode: "Markdown", ...mainMenu });
  }

  if (db.users[uid]?.approved) {
    startTracking(uid);
    return bot.sendMessage(uid, `✅ *Welcome back, ${firstName}!*`, { parse_mode: "Markdown", ...mainMenu });
  }

  if (db.pendingUsers[uid]) {
    return bot.sendMessage(uid, "⏳ Request pending है। Admin approval का इंतज़ार करें।");
  }

  db.pendingUsers[uid] = { firstName, username, requestTime: new Date().toISOString() };
  save();

  bot.sendMessage(ADMIN_ID,
    `🔔 *New User Request*\n\n👤 ${firstName}  @${username || "N/A"}\n🆔 \`${uid}\``,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[
      { text: "✅ Approve", callback_data: `APPROVE_${uid}` },
      { text: "❌ Reject",  callback_data: `REJECT_${uid}` },
    ]]}});

  bot.sendMessage(uid, `👋 Hello ${firstName}!\n\n✅ Request भेज दी।\n⏳ Admin approval का इंतज़ार करें।`);
});

// ─── CALLBACKS ──────────────────────────────────────────────────────────────
bot.on("callback_query", async (q) => {
  const caller = String(q.from.id);
  const d = q.data;
  bot.answerCallbackQuery(q.id).catch(() => {});

  if (d.startsWith("APPROVE_") && caller === ADMIN_ID) {
    const uid = d.replace("APPROVE_", "");
    db.users[uid] = { approved: true, pincodes: [], trackings: {} };
    delete db.pendingUsers[uid];
    save();
    startTracking(uid);
    bot.sendMessage(Number(uid),
      `✅ *Approved! Bot access मिल गया।*\n\n⚠️ पहले 📍 *Manage Pincodes* से apna pincode add karo, phir tracking शुरू करें।`,
      { parse_mode: "Markdown", ...mainMenu });
    bot.editMessageText(`✅ User ${uid} approved`, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
    return;
  }

  if (d.startsWith("REJECT_") && caller === ADMIN_ID) {
    const uid = d.replace("REJECT_", "");
    delete db.pendingUsers[uid];
    save();
    bot.sendMessage(Number(uid), "❌ Request reject कर दी।");
    bot.editMessageText(`❌ Rejected ${uid}`, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
    return;
  }

  if (d.startsWith("STOP_")) {
    const parts   = d.split("_");
    const uid     = parts[1];
    const trackId = parts.slice(2).join("_");
    if (uid !== caller) return;
    if (db.users[uid]?.trackings?.[trackId]) {
      const name = db.users[uid].trackings[trackId].productName || "Product";
      db.users[uid].trackings[trackId].active = false;
      save();
      bot.editMessageText(`🛑 Stopped:\n${name}`, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
    }
    return;
  }

  if (d.startsWith("STOPALL_")) {
    const uid = d.replace("STOPALL_", "");
    if (uid !== caller) return;
    Object.values(db.users[uid]?.trackings || {}).forEach(t => (t.active = false));
    save();
    bot.editMessageText("🛑 सभी trackings बंद!", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
    return;
  }
});

// ─── MESSAGES ───────────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const uid  = String(msg.from.id);
  const text = msg.text.trim();

  if (!db.users[uid]?.approved) {
    return bot.sendMessage(uid, db.pendingUsers[uid] ? "⏳ Request pending है।" : "❌ /start करें।");
  }

  const user  = db.users[uid];
  const state = userStates[uid];

  // ── Waiting for URL ──────────────────────────────────────────────────────
  if (state?.action === "add_url") {
    if (!user.pincodes?.length) {
      delete userStates[uid];
      return bot.sendMessage(uid,
        `⚠️ *पहले Pincode add करें!*\n\n📍 Manage Pincodes → apna pincode dale`,
        { parse_mode: "Markdown", ...mainMenu });
    }
    if (!text.includes("croma.com")) {
      return bot.sendMessage(uid, "❌ Valid Croma.com URL भेजें।\n\nExample:\nhttps://www.croma.com/product-name/p/261373");
    }
    const pid = extractProductId(text);
    if (!pid) {
      return bot.sendMessage(uid, "❌ URL से Product ID नहीं मिला। URL check करें।\n\nhttps://www.croma.com/.../p/261373");
    }
    const active = Object.values(user.trackings || {}).filter(t => t.active);
    if (active.length >= 40) {
      delete userStates[uid];
      return bot.sendMessage(uid, "❌ Max 40 trackings। पहले कुछ बंद करें।", mainMenu);
    }

    const trackId    = `T${Date.now()}`;
    const nameFromUrl = extractProductName(text) || `Product #${pid}`;
    if (!user.trackings) user.trackings = {};
    user.trackings[trackId] = {
      url: text, pid, active: true,
      addedAt: new Date().toISOString(),
      lastPrices: {},
      productName: nameFromUrl,
    };
    save();
    delete userStates[uid];

    log("ADD", `uid=${uid} pid=${pid} name="${nameFromUrl}" pins=${user.pincodes.join(",")}`);

    // Admin log
    bot.sendMessage(ADMIN_ID,
      `📊 *New Tracking*\n\n👤 uid=${uid}\n📦 ${nameFromUrl}\n📍 Pins: ${user.pincodes.join(", ")}\n🔗 [Link](${text})`,
      { parse_mode: "Markdown" }).catch(() => {});

    // Loading message
    const loadMsg = await bot.sendMessage(uid,
      `🔄 *Live prices fetch हो रही हैं...*\n\n📦 ${nameFromUrl}\n📍 Pincodes: ${user.pincodes.join(", ")}\n⏳ कृपया रुकें...`,
      { parse_mode: "Markdown" });

    // Fetch all pincodes
    const prices = await fetchLiveAll(uid, trackId);
    const gotCount = Object.keys(prices).length;
    const t = db.users[uid].trackings[trackId];

    log("ADD", `uid=${uid} got ${gotCount}/${user.pincodes.length} prices`);

    if (gotCount > 0) {
      let lines = "";
      for (const [pin, price] of Object.entries(prices)) {
        lines += `📍 \`${pin}\` ➜ *₹${Number(price).toLocaleString("en-IN")}*\n`;
      }
      const failed = user.pincodes.filter(p => prices[p] == null);
      const failLine = failed.length ? `\n⚠️ Price नहीं मिली (out of stock?): ${failed.map(p => `\`${p}\``).join(", ")}\n` : "";

      bot.editMessageText(
        `✅ *Tracking शुरू हुई!*\n\n📦 *${(t.productName||nameFromUrl).substring(0,60)}*\n\n💰 *Live Prices अभी:*\n${lines}${failLine}\n🔔 Price change होते ही alert मिलेगा`,
        { chat_id: loadMsg.chat.id, message_id: loadMsg.message_id, parse_mode: "Markdown" }
      ).catch(() => {});
    } else {
      bot.editMessageText(
        `✅ *Tracking add हुई!*\n\n📦 ${nameFromUrl}\n📍 pid=${pid}\n\n` +
        `❌ *Price अभी नहीं मिली*\n` +
        `यह product current pincodes पर available नहीं है\n` +
        `या temporarily out of stock है।\n\n` +
        `🔔 Jaise hi available hoga, price alert aayega.`,
        { chat_id: loadMsg.chat.id, message_id: loadMsg.message_id, parse_mode: "Markdown" }
      ).catch(() => {});
    }

    return bot.sendMessage(uid, "📋 Menu:", mainMenu);
  }

  // ── Waiting for pincodes ─────────────────────────────────────────────────
  if (state?.action === "set_pincodes") {
    const pins = text.split(/[\n,]+/).map(p => p.trim()).filter(p => /^\d{6}$/.test(p));
    if (!pins.length) {
      return bot.sendMessage(uid,
        "❌ Valid pincode नहीं मिला।\n\n6 digit, एक line में एक:\n\n400001\n110001\n560001");
    }
    user.pincodes = [...new Set(pins)];
    save();
    delete userStates[uid];
    log("PIN", `uid=${uid} → ${user.pincodes.join(", ")}`);
    return bot.sendMessage(uid,
      `✅ *Pincodes Save!*\n\n${user.pincodes.map(p => `📍 \`${p}\``).join("\n")}\n\nअब ➕ Add Price Alert से tracking shuru karo.`,
      { parse_mode: "Markdown", ...mainMenu });
  }

  // ── Menu buttons ─────────────────────────────────────────────────────────
  if (text === "➕ Add Price Alert") {
    if (!user.pincodes?.length) {
      return bot.sendMessage(uid,
        `⚠️ *पहले Pincode add करें!*\n\n📍 Manage Pincodes button dabao.`,
        { parse_mode: "Markdown", ...mainMenu });
    }
    userStates[uid] = { action: "add_url" };
    const cur = Object.values(user.trackings || {}).filter(t => t.active).length;
    return bot.sendMessage(uid,
      `🔗 *Price Alert Add करें*\n\n📍 Pincodes: ${user.pincodes.join(", ")}\n📊 Active: ${cur}/40\n\n✏️ Croma product URL भेजें:`,
      { parse_mode: "Markdown" });
  }

  if (text === "📋 Active Trackings") {
    const active = Object.entries(user.trackings || {}).filter(([, t]) => t.active);
    if (!active.length) return bot.sendMessage(uid, "📭 कोई active tracking नहीं है।", mainMenu);
    let out = `📋 *Active Trackings (${active.length}/40)*\n\n`;
    active.forEach(([, t], i) => {
      out += `*${i + 1}. ${(t.productName || `pid:${t.pid}`).substring(0, 55)}*\n`;
      (user.pincodes || []).forEach(p => {
        const pr = t.lastPrices?.[p];
        out += `  📍 \`${p}\` ➜ ${pr != null ? "₹" + Number(pr).toLocaleString("en-IN") : "⏳"}\n`;
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
      : `⚠️ अभी कोई pincode नहीं!\n\n`;
    return bot.sendMessage(uid,
      `📍 *Pincodes Update*\n\n${curText}नए pincodes भेजें (एक line में एक):\n\n400001\n110001\n560001`,
      { parse_mode: "Markdown" });
  }

  if (text === "🗑️ Stop Tracking") {
    const active = Object.entries(user.trackings || {}).filter(([, t]) => t.active);
    if (!active.length) return bot.sendMessage(uid, "📭 कोई tracking नहीं है।", mainMenu);
    const kb = active.map(([id, t], i) => [{
      text: `${i + 1}. ${(t.productName || `pid:${t.pid}`).substring(0, 35)}`,
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
    info += `\n👤 \`${uid}\` — ${a.length} products | pins: ${(u.pincodes||[]).join(",")||"none"}\n`;
    a.forEach(t => { info += `  • ${(t.productName||t.pid||"?").substring(0,45)}\n`; });
  });

  let out = `👑 *Admin Panel*\n\n👥 Users: ${approved} | ⏳ Pending: ${pending} | 📊 Trackings: ${total}`;
  if (info) out += `\n\n*Active:*${info}`;
  if (pending) {
    out += `\n\n*Pending:*\n`;
    Object.entries(db.pendingUsers).forEach(([id, u]) => {
      out += `• ${u.firstName} @${u.username||"N/A"} \`${id}\`\n`;
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
      out += `  📦 ${(t.productName||t.pid||"?").substring(0, 50)}\n`;
      Object.entries(t.lastPrices || {}).forEach(([p, pr]) => {
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
    log("BOOT", `uid=${uid} | ${a} active products | ${(u.pincodes||[]).length} pincodes`);
  }
});
log("SYS", `Bot STARTED ✅ | Admin=${ADMIN_ID}`);
