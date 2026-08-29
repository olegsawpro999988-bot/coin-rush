const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;

app.use(express.json());
app.use(express.static(__dirname));

const db = new sqlite3.Database('./game.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    coins REAL DEFAULT 1000,
    pvp_wins INTEGER DEFAULT 0,
    stars_spent INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS pool (id INTEGER PRIMARY KEY, total_stars INTEGER DEFAULT 0)`);
  db.run(`INSERT OR IGNORE INTO pool (id, total_stars) VALUES (1, 500)`);
});

let bot;
if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '⚔️ Coin Rush PvP: Бийся на монети та забирай Stars!', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔥 Грати та Битися', web_app: { url: `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'coin-rush-j9uz.onrender.com'}` } }
        ]]
      }
    });
  });

  bot.on('pre_checkout_query', (query) => bot.answerPreCheckoutQuery(query.id, true));

  bot.on('successful_payment', (msg) => {
    const payload = JSON.parse(msg.successful_payment.invoice_payload);
    const userId = msg.from.id;
    const stars = msg.successful_payment.total_amount;

    db.run('UPDATE pool SET total_stars = total_stars + ? WHERE id = 1', [Math.floor(stars * 0.5)]);
    db.run('UPDATE users SET stars_spent = stars_spent + ? WHERE id = ?', [stars, userId]);

    if (payload.item === 'lootbox') {
      const rewardCoins = Math.floor(Math.random() * 50000) + 5000;
      db.run('UPDATE users SET coins = coins + ? WHERE id = ?', [rewardCoins, userId]);
    }
  });
}

// Завантаження профілю та пулу
app.post('/api/user/load', (req, res) => {
  const { id, username } = req.body;
  db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
    if (!user) {
      db.run('INSERT INTO users (id, username, coins) VALUES (?, ?, 1000)', [id, username || 'Player']);
      user = { id, username: username || 'Player', coins: 1000, pvp_wins: 0 };
    }
    db.get('SELECT total_stars FROM pool WHERE id = 1', (err, pool) => {
      res.json({ ...user, poolStars: pool ? pool.total_stars : 0 });
    });
  });
});

// Розрахунок результату PvP Дуелі (Симуляція реального бота/суперника)
app.post('/api/pvp/fight', (req, res) => {
  const { id, bet } = req.body;
  db.get('SELECT coins, pvp_wins FROM users WHERE id = ?', [id], (err, user) => {
    if (!user || user.coins < bet) return res.status(400).json({ error: 'Недостатньо монет' });

    const isWin = Math.random() > 0.45; // 55% шанс виграшу або поразки
    const resultCoins = isWin ? user.coins + Math.floor(bet * 0.9) : user.coins - bet;
    const newWins = isWin ? user.pvp_wins + 1 : user.pvp_wins;

    db.run('UPDATE users SET coins = ?, pvp_wins = ? WHERE id = ?', [resultCoins, newWins, id], () => {
      res.json({ win: isWin, newCoins: resultCoins, newWins });
    });
  });
});

// Інвойс на Скриню (Lootbox)
app.post('/api/buy-box', async (req, res) => {
  const { id, stars } = req.body;
  if (!bot) return res.status(500).json({ error: 'Bot not configured' });

  try {
    const link = await bot.createInvoiceLink(
      '🎁 Таємнича Скриня',
      'Шанс вибити від 5,000 до 50,000 монет!',
      JSON.stringify({ item: 'lootbox', userId: id }),
      '', 'XTR', [{ label: 'Скриня', amount: stars }]
    );
    res.json({ invoiceLink: link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ТОП переможців
app.get('/api/leaderboard', (req, res) => {
  db.all('SELECT username, pvp_wins, coins FROM users ORDER BY pvp_wins DESC LIMIT 10', (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
