const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");
const fs = require("fs");
const puppeteer = require("puppeteer");

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

setInterval(() => {
  axios.get(`${RENDER_URL}/ping`).catch(() => {});
}, 25000);

// ─── DATA STORE (NO DEFAULT PINCODES) ──────────────────────────────────────
let db = {
  users: {},          // { userId: { approved, pincodes[], trackings{} } }
  pendingUsers: {},   // { userId: { firstName, username, requestTime } }
};

if (fs.existsSync(DATA_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch (e) { console.log("Fresh db start"); }
}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

// ─── BOT INIT ──────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
const userStates = {};
const intervals = {};

// ─── PUPPETEER PRICE SCRAPER ───────────────────────────────────────────────
async function fetchCromaPrice(url, pincode) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });

    await page.setCookie(
      { name: 'pincode', value: pincode, domain: '.croma.com' },
      { name: 'selectedPincode', value: pincode, domain: '.croma.com' }
    );
    
    await page.reload({ waitUntil: 'domcontentloaded' });

    const priceSelector = '.pdp-selling-price, [data-testid="pdp-selling-price"], .cp-price, .pdp-price';
    const titleSelector = 'h1.pdp-title, h1, title';

    await page.waitForSelector(priceSelector, { timeout: 8000 });

    const priceText = await page.$eval(priceSelector, el => el.textContent);
    const nameText = await page.$eval(titleSelector, el => el.textContent.split("|")[0].trim());

    const price = parseInt(priceText.replace(/[^\d]/g, ""), 10);

    return { price: price || null, name: nameText || "Croma Product", url };
  } catch (err) {
    return { price: null, name: null, url };
  } finally {
    if (browser) await browser.close();
  }
}

// ─── PRICE CHECK LOOP WITH LIVE LOGGING ────────────────────────────────────
async function checkAllPrices(userId) {
  const user = db.users[userId];
  if (!user?.approved) return;

  // Agar pincodes khali hain, to check nahi karega
  const pincodes = user.pincodes || [];
  if (pincodes.length === 0) {
    console.log(`⚠️  [SKIPPED LOOP] User ID: ${userId} has not set any pincodes yet.`);
    return;
  }

  const trackings = user.trackings || {};
  const activeTracksCount = Object.values(trackings).filter(t => t.active).length;

  if (activeTracksCount > 0) {
    console.log(`\n⏰ [${new Date().toLocaleTimeString()}] Starting price check for User ID: ${userId}...`);
  }

  for (const [trackId, t] of Object.entries(trackings)) {
    if (!t.active) continue;

    const shortName = (t.productName || "Product").substring(0, 30);

    for (const pin of pincodes) {
      const result = await fetchCromaPrice(t.url, pin);
      if (result.price == null) {
        console.log(`⚠️  [SKIPPED] Fetch Error for ${shortName} at Pin: ${pin}`);
        continue;
      }

      const prev = t.lastPrices?.[pin];
      if (!t.lastPrices) t.lastPrices = {};

      if (prev !== undefined && prev !== result.price) {
        const diff = result.price - prev;
        const emoji = diff < 0 ? "📉" : "📈";
        const word = diff < 0 ? "DECREASED" : "INCREASED";
        
        console.log(`🚨 [ALERT] Price changed for ${shortName} at Pin: ${pin}! ₹${prev} -> ₹${result.price}`);

        const msg =
          `🔔 *Price Alert — Price ${word}!*\n\n` +
          `📦 *Product:* ${t.productName || result.name || "Product"}\n` +
          `📍 *Pincode:* ${pin}\n\n` +
          `${emoji} ₹${prev.toLocaleString("en-IN")} → ₹${result.price.toLocaleString("en-IN")}\n` +
          `💰 Change: ${diff < 0 ? "-" : "+"}₹${Math.abs(diff).toLocaleString("en-IN")}\n\n` +
          `🔗 [View on Croma](${t.url})`;

        bot.sendMessage(userId, msg, { parse_mode: "Markdown" }).catch(() => {});
      } else {
        console.log(`🔍 [STABLE] User: ${userId} | ${shortName} | Pin: ${pin} | Price: ₹${result.price}`);
      }

      t.lastPrices[pin] = result.price;
      if (!t.productName && result.name) t.productName = result.name;
    }
  }
  save();
}

function startTracking(userId) {
  const user = db.users[userId];
  if (!user?.pincodes || user.pincodes.length === 0) return; // Don't start loop if no pincodes
  if (intervals[userId]) clearInterval(intervals[userId]);
  intervals[userId] = setInterval(() => checkAllPrices(userId), 30000);
}

// ─── KEYBOARDS (Hinglish/English) ──────────────────────────────────────────
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
    const pinsSet = db.users[uid].pincodes?.length ? db.users[uid].pincodes.join(", ") : "None Set (Please set pincodes first)";
    return bot.sendMessage(uid,
      `👑 *Welcome Admin!*\n\nCroma Price Alert Bot is RUNNING.\n📍 Your Pincodes: ${pinsSet}\n\nCommands:\n/admin — Admin panel`,
      { parse_mode: "Markdown", ...mainMenu });
  }

  if (db.users[uid]?.approved) {
    startTracking(uid);
    return bot.sendMessage(uid,
      `✅ *Welcome back, ${firstName}!*\n\nPrice alerts are active. Choose an option below.`,
      { parse_mode: "Markdown", ...mainMenu });
  }

  if (db.pendingUsers[uid]) {
    return bot.sendMessage(uid, "⏳ Aapki request admin ke paas pending hai. Please wait.");
  }

  db.pendingUsers[uid] = { firstName, username, requestTime: new Date().toISOString() };
  save();

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
    `👋 Hello ${firstName}!\n\n✅ Aapki access request Admin ko bhej di gayi hai.\n⏳ Approval ke baad aap bot use kar sakenge.`);
});

// ─── CALLBACK QUERIES ─────────────────────────────────────────────────────
bot.on("callback_query", async (q) => {
  const callerId = String(q.from.id);
  const data_str = q.data;

  if (data_str.startsWith("APPROVE_") && callerId === ADMIN_ID) {
    const targetUid = data_str.replace("APPROVE_", "");
    db.users[targetUid] = { approved: true, pincodes: [], trackings: {} };
    delete db.pendingUsers[targetUid];
    save();
    bot.sendMessage(Number(targetUid),
      "✅ *Aapki request approve ho gayi!*\n\n⚠️ *Important:* Pehle '📍 Manage Pincodes' button daba kar apne pincode set karein, tabhi tracking kaam karegi.",
      { parse_mode: "Markdown", ...mainMenu });
    bot.editMessageText(`✅ User ${targetUid} approved!`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    return bot.answerCallbackQuery(q.id, { text: "✅ Approved" });
  }

  if (data_str.startsWith("REJECT_") && callerId === ADMIN_ID) {
    const targetUid = data_str.replace("REJECT_", "");
    delete db.pendingUsers[targetUid];
    save();
    bot.sendMessage(Number(targetUid), "❌ Admin ne aapki request reject kar di.");
    bot.editMessageText(`❌ User ${targetUid} rejected.`, { chat_id: q.message.chat.id, message_id: q.message.message_id });
    return bot.answerCallbackQuery(q.id, { text: "❌ Rejected" });
  }

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

  if (data_str.startsWith("STOPALL_")) {
    const uid = data_str.replace("STOPALL_", "");
    if (uid !== callerId) return bot.answerCallbackQuery(q.id, { text: "❌ Unauthorized" });
    Object.values(db.users[uid]?.trackings || {}).forEach(t => (t.active = false));
    save();
    bot.editMessageText("🛑 Sabhi trackings band kar di gayi hain!", { chat_id: q.message.chat.id, message_id: q.message.message_id });
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
      ? "⏳ Request pending hai."
      : "❌ Access nahi hai. /start karein.");
  }

  const user = db.users[uid];
  const state = userStates[uid];

  if (state?.action === "add_url") {
    if (!text.includes("croma.com")) {
      return bot.sendMessage(uid, "❌ Kripya valid Croma.com product URL bhejein.");
    }

    // Pincode validation check before letting them add URL
    if (!user.pincodes || user.pincodes.length === 0) {
      delete userStates[uid];
      return bot.sendMessage(uid, "❌ Tracking nahi start ho sakti! Pehle '📍 Manage Pincodes' option me jaakar kam se kam ek pincode add karein.", mainMenu);
    }

    const active = Object.values(user.trackings || {}).filter(t => t.active);
    if (active.length >= 40) {
      delete userStates[uid];
      return bot.sendMessage(uid, "❌ Maximum 40 trackings ho gayi hain. Pehle kuch band karein.", mainMenu);
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

    bot.sendMessage(uid, `⏳ *Link Added! Fetching Live Price instantly...* Please wait.`);

    // INSTANT LIVE PRICE FETCH CHECK
    const targetPin = user.pincodes[0]; // First target pincode for live display
    const liveCheck = await fetchCromaPrice(text, targetPin);

    if (liveCheck.price) {
      user.trackings[trackId].productName = liveCheck.name;
      user.trackings[trackId].lastPrices[targetPin] = liveCheck.price;
      save();

      bot.sendMessage(uid, 
        `🚀 *Tracking Successfully Started!*\n\n` +
        `📦 *Product Name:* ${liveCheck.name}\n` +
        `💰 *Live Current Price:* ₹${liveCheck.price.toLocaleString("en-IN")} (At Pin: ${targetPin})\n` +
        `📍 *Total Tracking Pincodes:* ${user.pincodes.join(", ")}\n` +
        `⏰ Bot will check prices every 30 seconds now.`, 
        { parse_mode: "Markdown", ...mainMenu }
      );
    } else {
      bot.sendMessage(uid, `✅ Link queued! Prices will update in the next background cycle (within 30s).`, mainMenu);
    }

    // Start background loop immediately
    startTracking(uid);
    return;
  }

  if (state?.action === "set_pincodes") {
    const pins = text.split("\n").map(p => p.trim()).filter(p => /^\d{6}$/.test(p));
    if (!pins.length) {
      return bot.sendMessage(uid, "❌ Valid pincodes nahi mile. 6-digit pincode ek line me ek likhein.");
    }
    user.pincodes = pins;
    save();
    delete userStates[uid];

    // Restart looping if they have items tracking
    startTracking(uid);

    return bot.sendMessage(uid,
      `✅ *Pincodes update ho gaye!*\n\n${pins.map(p => `📍 ${p}`).join("\n")}`,
      { parse_mode: "Markdown", ...mainMenu });
  }

  if (text === "➕ Add Price Alert") {
    if (!user.pincodes || user.pincodes.length === 0) {
      return bot.sendMessage(uid, "⚠️ Pehle '📍 Manage Pincodes' ka use karke pincodes set karein, uske baad hi alert add hoga.");
    }
    userStates[uid] = { action: "add_url" };
    return bot.sendMessage(uid,
      "🔗 *Price Alert Add Karein*\n\nCroma product ka URL bhejein:\n\nExample:\nhttps://www.croma.com/apple-iphone.../p/261373",
      { parse_mode: "Markdown" });
  }

  if (text === "📋 Active Trackings") {
    const active = Object.entries(user.trackings || {}).filter(([, t]) => t.active);
    if (!active.length) {
      return bot.sendMessage(uid, "📭 Koi active tracking nahi hai.", mainMenu);
    }
    const pins = user.pincodes || [];
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
    const cur = user.pincodes || [];
    userStates[uid] = { action: "set_pincodes" };
    return bot.sendMessage(uid,
      `📍 *Pincodes Manage Karein*\n\nCurrent pincodes:\n${cur.length ? cur.join("\n") : "None Set"}\n\n✏️ Naye pincodes bhejein (ek line me ek):\n\nExample:\n400001\n110001\n560001`,
      { parse_mode: "Markdown" });
  }

  if (text === "🗑️ Stop Tracking") {
    const active = Object.entries(user.trackings || {}).filter(([, t]) => t.active);
    if (!active.length) {
      return bot.sendMessage(uid, "📭 Band karne ke liye koi tracking nahi hai.", mainMenu);
    }
    const kb = active.map(([id, t], i) => [{
      text: `${i + 1}. ${(t.productName || t.url.split("/").slice(-2, -1)[0] || "Product").substring(0, 35)}`,
      callback_data: `STOP_${uid}_${id}`,
    }]);
    kb.push([{ text: "🛑 Sabhi band karein", callback_data: `STOPALL_${uid}` }]);
    return bot.sendMessage(uid, "🗑️ *Kaunsi tracking band karein?*", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: kb },
    });
  }
});

// ─── ADMIN PANEL ───────────────────────────────────────────────────────────
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
    `📊 Total Active Trackings: ${total}\n\n`;

  if (pending) {
    out += "*Pending Requests:*\n";
    Object.entries(db.pendingUsers).forEach(([id, u]) => {
      out += `• ${u.firstName} (@${u.username || "N/A"}) — \`${id}\`\n`;
    });
  }
  bot.sendMessage(ADMIN_ID, out, { parse_mode: "Markdown" });
});

bot.onText(/\/broadcast (.+)/, (msg, match) => {
  if (String(msg.from.id) !== ADMIN_ID) return;
  const text = match[1];
  let count = 0;
  Object.keys(db.users).forEach(uid => {
    bot.sendMessage(uid, `📢 *Admin Message:*\n\n${text}`, { parse_mode: "Markdown" })
      .then(() => count++).catch(() => {});
  });
  bot.sendMessage(ADMIN_ID, `✅ Broadcast bheja ${Object.keys(db.users).length} users ko.`);
});

// ─── STARTUP ───────────────────────────────────────────────────────────────
Object.entries(db.users).forEach(([uid, u]) => {
  if (u.approved && u.pincodes && u.pincodes.length > 0) startTracking(uid);
});

console.log("🤖 Croma Price Alert Bot STARTED (No Defaults Mode)");
console.log(`👑 Admin: ${ADMIN_ID}`);
