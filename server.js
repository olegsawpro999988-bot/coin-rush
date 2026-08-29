const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';

app.use(express.json());
app.use(express.static(__dirname));

// SQLite DB Initialization
const db = new sqlite3.Database('./game.db', (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('Connected to SQLite Database.');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    coins INTEGER DEFAULT 0,
    multiplier INTEGER DEFAULT 1,
    energy INTEGER DEFAULT 1000,
    last_update INTEGER
  )`);
});

// Telegram Bot Webhook / Polling setup
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Welcome to Coin Rush! Click below to play.', {
    reply_markup: {
      inline_keyboard: [[
        { text: '🎮 Play Coin Rush', web_app: { url: `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'coin-rush-j9uz.onrender.com'}` } }
      ]]
    }
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Basic API endpoints for game sync
app.post('/api/sync', (req, res) => {
  const { userId, username, coins, energy } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const now = Date.now();
  db.run(
    `INSERT INTO users (id, username, coins, energy, last_update) 
     VALUES (?, ?, ?, ?, ?) 
     ON CONFLICT(id) DO UPDATE SET coins=?, energy=?, last_update=?`,
    [userId, username, coins, energy, now, coins, energy, now],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ status: 'success' });
    }
  );
});

app.listen(PORT, () => {
  console.log(`Coin Rush Mini App Server running on port ${PORT}`);
});
