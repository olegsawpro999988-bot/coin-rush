require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'super_secret_admin_key_2026';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-domain.com';

// Инициализация Telegram-бота
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Инициализация базы данных SQLite
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error('DB Connection Error:', err);
    else console.log('Connected to SQLite Database.');
});

// Создание таблиц
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            telegram_id INTEGER PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            coins INTEGER DEFAULT 0,
            energy INTEGER DEFAULT 1000,
            max_energy INTEGER DEFAULT 1000,
            energy_refill_rate INTEGER DEFAULT 1,
            last_energy_sync INTEGER DEFAULT 0,
            multiplier REAL DEFAULT 1.0,
            multiplier_expires_at INTEGER DEFAULT 0,
            level INTEGER DEFAULT 1,
            experience INTEGER DEFAULT 0,
            referrer_id INTEGER,
            daily_streak INTEGER DEFAULT 0,
            last_daily_claim INTEGER DEFAULT 0,
            created_at INTEGER
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            description TEXT,
            reward_coins INTEGER,
            reward_exp INTEGER,
            link TEXT,
            task_type TEXT,
            is_active INTEGER DEFAULT 1
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS user_tasks (
            user_id INTEGER,
            task_id INTEGER,
            completed_at INTEGER,
            PRIMARY KEY (user_id, task_id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS shop_items (
            id TEXT PRIMARY KEY,
            title TEXT,
            description TEXT,
            stars_price INTEGER,
            item_type TEXT,
            item_value REAL
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS purchases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            item_id TEXT,
            stars_amount INTEGER,
            telegram_payment_charge_id TEXT,
            created_at INTEGER
        )
    `);

    // Начальное заполнение магазина
    const defaultShop = [
        ['boost_2x_1h', 'Бустер 2x на 1 час', 'Удваивает добычу монет при кликах на 60 минут', 50, 'multiplier_boost', 2.0],
        ['energy_full', 'Восстановление энергии', 'Мгновенно заполняет шкалу энергии на 100%', 25, 'energy_refill', 1000.0],
        ['boost_perm_pass', 'Премиум Бустер', 'Постоянный множитель x1.5 ко всем наградам навсегда', 250, 'permanent_multiplier', 1.5],
        ['pack_coins_100k', 'Набор 100,000 Монет', 'Мгновенное пополнение игрового баланса', 100, 'coins_pack', 100000.0]
    ];
    defaultShop.forEach(item => {
        db.run(`INSERT OR IGNORE INTO shop_items (id, title, description, stars_price, item_type, item_value) VALUES (?, ?, ?, ?, ?, ?)`, item);
    });

    // Начальные задания
    const defaultTasks = [
        ['Подписка на канал', 'Подпишитесь на официальный канал новостей игры', 5000, 50, 'https://t.me/telegram', 'channel_sub'],
        ['Пригласить 3 друзей', 'Пригласите друзей в игру по своей реферальной ссылке', 15000, 150, '', 'referral_3'],
        ['Сделать 1000 кликов', 'Нажмите на главную монету 1000 раз', 3000, 30, '', 'clicks_1000']
    ];
    defaultTasks.forEach(task => {
        db.run(`INSERT OR IGNORE INTO tasks (title, description, reward_coins, reward_exp, link, task_type) VALUES (?, ?, ?, ?, ?, ?)`, task);
    });
});

// Валидация Telegram WebApp InitData (Криптографическая проверка HMAC)
function verifyTelegramInitData(initData) {
    if (!initData) return false;
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');

        const params = [];
        for (const [key, value] of urlParams.entries()) {
            params.push(`${key}=${value}`);
        }
        params.sort();
        const dataCheckString = params.join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        if (calculatedHash === hash) {
            const userStr = urlParams.get('user');
            return JSON.parse(userStr);
        }
        return false;
    } catch (e) {
        return false;
    }
}

// Хелпер расчета энергии и уровней
function syncUserState(user) {
    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - user.last_energy_sync;
    if (elapsed > 0 && user.energy < user.max_energy) {
        const regenerated = elapsed * user.energy_refill_rate;
        user.energy = Math.min(user.max_energy, user.energy + regenerated);
        user.last_energy_sync = now;
    }
    // Проверка активности временного бустера
    if (user.multiplier_expires_at > 0 && user.multiplier_expires_at < now) {
        user.multiplier = 1.0;
        user.multiplier_expires_at = 0;
    }
    // Проверка уровня (уровень = 1 + floor(exp / 500))
    user.level = 1 + Math.floor(user.experience / 500);
    return user;
}

// ----------------- API ЭНДПОИНТЫ ИГРЫ -----------------

// Синхронизация / Вход пользователя
app.post('/api/auth/sync', (req, res) => {
    const { initData, ref } = req.body;
    const tgUser = verifyTelegramInitData(initData);
    
    // Fallback для локальной отладки вне Telegram WebApp
    const userId = tgUser ? tgUser.id : (req.body.debugId ? parseInt(req.body.debugId) : null);
    const username = tgUser ? tgUser.username : 'GuestPlayer';
    const firstName = tgUser ? tgUser.first_name : 'Guest';

    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized Telegram session.' });
    }

    const now = Math.floor(Date.now() / 1000);

    db.get(`SELECT * FROM users WHERE telegram_id = ?`, [userId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });

        if (!row) {
            const referrerId = (ref && parseInt(ref) !== userId) ? parseInt(ref) : null;
            const newUser = {
                telegram_id: userId,
                username: username,
                first_name: firstName,
                coins: 500, // Стартовый баланс
                energy: 1000,
                max_energy: 1000,
                energy_refill_rate: 2,
                last_energy_sync: now,
                multiplier: 1.0,
                multiplier_expires_at: 0,
                level: 1,
                experience: 0,
                referrer_id: referrerId,
                daily_streak: 0,
                last_daily_claim: 0,
                created_at: now
            };

            db.run(
                `INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                Object.values(newUser),
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    // Если есть реферер, начисляем ему бонус
                    if (referrerId) {
                        db.run(`UPDATE users SET coins = coins + 2500, experience = experience + 100 WHERE telegram_id = ?`, [referrerId]);
                    }
                    return res.json({ user: newUser, isNew: true });
                }
            );
        } else {
            let user = syncUserState(row);
            db.run(
                `UPDATE users SET energy = ?, last_energy_sync = ?, multiplier = ?, multiplier_expires_at = ?, level = ? WHERE telegram_id = ?`,
                [user.energy, user.last_energy_sync, user.multiplier, user.multiplier_expires_at, user.level, user.telegram_id],
                () => {
                    return res.json({ user, isNew: false });
                }
            );
        }
    });
});

// Клик по монете (добыча)
app.post('/api/game/tap', (req, res) => {
    const { initData, taps } = req.body;
    const tgUser = verifyTelegramInitData(initData);
    const userId = tgUser ? tgUser.id : (req.body.debugId ? parseInt(req.body.debugId) : null);
    
    if (!userId || !taps || taps <= 0 || taps > 50) {
        return res.status(400).json({ error: 'Invalid tap parameters' });
    }

    db.get(`SELECT * FROM users WHERE telegram_id = ?`, [userId], (err, user) => {
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        user = syncUserState(user);
        const energyCost = taps;
        
        if (user.energy < energyCost) {
            return res.status(400).json({ error: 'Not enough energy', energy: user.energy });
        }

        const earned = Math.round(taps * user.multiplier);
        const expGained = taps;
        
        user.energy -= energyCost;
        user.coins += earned;
        user.experience += expGained;
        user.level = 1 + Math.floor(user.experience / 500);

        db.run(
            `UPDATE users SET coins = ?, energy = ?, experience = ?, level = ?, last_energy_sync = ? WHERE telegram_id = ?`,
            [user.coins, user.energy, user.experience, user.level, Math.floor(Date.now() / 1000), userId],
            () => {
                res.json({
                    coins: user.coins,
                    energy: user.energy,
                    experience: user.experience,
                    level: user.level,
                    earned
                });
            }
        );
    });
});

// Ежедневный бонус за вход
app.post('/api/game/claim-daily', (req, res) => {
    const { initData } = req.body;
    const tgUser = verifyTelegramInitData(initData);
    const userId = tgUser ? tgUser.id : (req.body.debugId ? parseInt(req.body.debugId) : null);

    db.get(`SELECT * FROM users WHERE telegram_id = ?`, [userId], (err, user) => {
        if (!user) return res.status(404).json({ error: 'User not found' });

        const now = Math.floor(Date.now() / 1000);
        const oneDay = 86400;
        const timePassed = now - user.last_daily_claim;

        if (timePassed < oneDay && user.last_daily_claim !== 0) {
            const timeLeft = oneDay - timePassed;
            return res.status(400).json({ error: 'Too early', timeLeft });
        }

        let newStreak = (timePassed < oneDay * 2 && user.last_daily_claim !== 0) ? user.daily_streak + 1 : 1;
        if (newStreak > 7) newStreak = 1;

        const bonusCoins = newStreak * 1000;
        const bonusExp = newStreak * 25;

        db.run(
            `UPDATE users SET coins = coins + ?, experience = experience + ?, daily_streak = ?, last_daily_claim = ? WHERE telegram_id = ?`,
            [bonusCoins, bonusExp, newStreak, now, userId],
            () => {
                res.json({ success: true, reward: bonusCoins, streak: newStreak, nextIn: oneDay });
            }
        );
    });
});

// Получение списка заданий
app.post('/api/tasks/list', (req, res) => {
    const { initData } = req.body;
    const tgUser = verifyTelegramInitData(initData);
    const userId = tgUser ? tgUser.id : (req.body.debugId ? parseInt(req.body.debugId) : null);

    db.all(`SELECT t.*, CASE WHEN ut.completed_at IS NOT NULL THEN 1 ELSE 0 END as completed 
            FROM tasks t 
            LEFT JOIN user_tasks ut ON t.id = ut.task_id AND ut.user_id = ? 
            WHERE t.is_active = 1`, [userId], (err, tasks) => {
        res.json({ tasks });
    });
});

// Выполнение задания
app.post('/api/tasks/complete', (req, res) => {
    const { initData, taskId } = req.body;
    const tgUser = verifyTelegramInitData(initData);
    const userId = tgUser ? tgUser.id : (req.body.debugId ? parseInt(req.body.debugId) : null);

    db.get(`SELECT * FROM tasks WHERE id = ? AND is_active = 1`, [taskId], (err, task) => {
        if (!task) return res.status(404).json({ error: 'Task not found' });

        db.get(`SELECT * FROM user_tasks WHERE user_id = ? AND task_id = ?`, [userId, taskId], (err, done) => {
            if (done) return res.status(400).json({ error: 'Task already completed' });

            const now = Math.floor(Date.now() / 1000);
            db.run(`INSERT INTO user_tasks VALUES (?, ?, ?)`, [userId, taskId, now], () => {
                db.run(`UPDATE users SET coins = coins + ?, experience = experience + ? WHERE telegram_id = ?`, 
                    [task.reward_coins, task.reward_exp, userId], () => {
                        res.json({ success: true, rewardCoins: task.reward_coins, rewardExp: task.reward_exp });
                });
            });
        });
    });
});

// Таблица лидеров (Топ 20)
app.get('/api/leaderboard', (req, res) => {
    db.all(`SELECT telegram_id, first_name, username, coins, level FROM users ORDER BY coins DESC LIMIT 20`, (err, top) => {
        res.json({ leaderboard: top || [] });
    });
});

// Каталог магазина
app.get('/api/shop/items', (req, res) => {
    db.all(`SELECT * FROM shop_items`, (err, items) => {
        res.json({ items });
    });
});

// ----------------- МОНЕТИЗАЦИЯ: TELEGRAM STARS PAYMENTS -----------------

// 1. Создание ссылки на инвойс Telegram Stars (валюта XTR)
app.post('/api/payment/create-invoice', async (req, res) => {
    const { initData, itemId } = req.body;
    const tgUser = verifyTelegramInitData(initData);
    const userId = tgUser ? tgUser.id : (req.body.debugId ? parseInt(req.body.debugId) : null);

    db.get(`SELECT * FROM shop_items WHERE id = ?`, [itemId], async (err, item) => {
        if (!item) return res.status(404).json({ error: 'Item not found' });

        try {
            // Telegram Stars использует валюту 'XTR'
            const invoiceLink = await bot.createInvoiceLink(
                item.title,
                item.description,
                JSON.stringify({ userId, itemId }),
                '', // Provider token пустой для Telegram Stars!
                'XTR',
                [{ label: item.title, amount: item.stars_price }]
            );

            res.json({ invoiceLink });
        } catch (error) {
            console.error('Invoice creation error:', error);
            res.status(500).json({ error: 'Failed to generate Stars invoice' });
        }
    });
});

// Обработка PreCheckoutQuery от Telegram
bot.on('pre_checkout_query', (query) => {
    bot.answerPreCheckoutQuery(query.id, true).catch(console.error);
});

// Обработка успешного платежа Telegram Stars
bot.on('message', (msg) => {
    if (msg.successful_payment) {
        const payment = msg.successful_payment;
        if (payment.currency === 'XTR') {
            const payload = JSON.parse(payment.invoice_payload);
            const userId = payload.userId;
            const itemId = payload.itemId;
            const chargeId = payment.telegram_payment_charge_id;
            const now = Math.floor(Date.now() / 1000);

            db.get(`SELECT * FROM shop_items WHERE id = ?`, [itemId], (err, item) => {
                if (item) {
                    // Фиксация покупки в истории
                    db.run(`INSERT INTO purchases (user_id, item_id, stars_amount, telegram_payment_charge_id, created_at) VALUES (?, ?, ?, ?, ?)`,
                        [userId, itemId, item.stars_price, chargeId, now]);

                    // Применение купленного товара
                    if (item.item_type === 'multiplier_boost') {
                        const expires = now + 3600; // 1 час
                        db.run(`UPDATE users SET multiplier = ?, multiplier_expires_at = ? WHERE telegram_id = ?`, [item.item_value, expires, userId]);
                    } else if (item.item_type === 'energy_refill') {
                        db.run(`UPDATE users SET energy = max_energy WHERE telegram_id = ?`, [userId]);
                    } else if (item.item_type === 'permanent_multiplier') {
                        db.run(`UPDATE users SET multiplier = multiplier + ? WHERE telegram_id = ?`, [item.item_value, userId]);
                    } else if (item.item_type === 'coins_pack') {
                        db.run(`UPDATE users SET coins = coins + ? WHERE telegram_id = ?`, [item.item_value, userId]);
                    }

                    bot.sendMessage(userId, `🎉 Оплата получена! Вы успешно приобрели: "${item.title}". Предмет уже начислен в игре!`);
                }
            });
        }
    }
});

// Команда /start в Telegram боте для запуска WebApp и обработки рефералов
bot.onText(/\/start(.*)/, (msg, match) => {
    const chatId = msg.chat.id;
    const refParam = match[1] ? match[1].trim() : '';
    const gameUrl = refParam ? `${WEBAPP_URL}?ref=${refParam}` : WEBAPP_URL;

    bot.sendMessage(chatId, `⚡️ Добро пожаловать в **Coin Rush**!\n\nДобывайте монеты, улучшайте уровень, покупайте бустеры за Telegram Stars и соревнуйтесь за первые места в таблице лидеров!`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🚀 Играть в 1 клик', web_app: { url: gameUrl } }],
                [{ text: '📢 Официальный канал', url: 'https://t.me/telegram' }]
            ]
        }
    });
});

// ----------------- ЗАЩИЩЕННАЯ АДМИН-ПАНЕЛЬ -----------------

const authAdmin = (req, res, next) => {
    const key = req.headers['x-admin-key'] || req.query.key;
    if (key === ADMIN_SECRET) next();
    else res.status(403).json({ error: 'Access denied: Invalid Admin Key' });
};

// Общая сводка
app.get('/api/admin/stats', authAdmin, (req, res) => {
    db.serialize(() => {
        db.get(`SELECT COUNT(*) as total_users, SUM(coins) as total_coins FROM users`, (err, userStats) => {
            db.get(`SELECT COUNT(*) as total_purchases, COALESCE(SUM(stars_amount), 0) as total_stars FROM purchases`, (err, purchaseStats) => {
                db.get(`SELECT COUNT(*) as total_referred FROM users WHERE referrer_id IS NOT NULL`, (err, refStats) => {
                    res.json({
                        users: userStats.total_users || 0,
                        coins: userStats.total_coins || 0,
                        purchasesCount: purchaseStats.total_purchases || 0,
                        revenueStars: purchaseStats.total_stars || 0,
                        referredUsers: refStats.total_referred || 0
                    });
                });
            });
        });
    });
});

// Список пользователей
app.get('/api/admin/users', authAdmin, (req, res) => {
    db.all(`SELECT u.*, (SELECT COUNT(*) FROM users r WHERE r.referrer_id = u.telegram_id) as invited_count FROM users u ORDER BY u.created_at DESC LIMIT 50`, (err, users) => {
        res.json({ users });
    });
});

// История транзакций Stars
app.get('/api/admin/purchases', authAdmin, (req, res) => {
    db.all(`SELECT p.*, u.first_name, u.username, s.title as item_title 
            FROM purchases p 
            LEFT JOIN users u ON p.user_id = u.telegram_id 
            LEFT JOIN shop_items s ON p.item_id = s.id 
            ORDER BY p.created_at DESC LIMIT 50`, (err, purchases) => {
        res.json({ purchases });
    });
});

// Изменение цен в магазине
app.post('/api/admin/shop/update-price', authAdmin, (req, res) => {
    const { itemId, starsPrice } = req.body;
    db.run(`UPDATE shop_items SET stars_price = ? WHERE id = ?`, [starsPrice, itemId], function() {
        res.json({ success: true, updated: this.changes });
    });
});

// Создание нового задания
app.post('/api/admin/tasks/create', authAdmin, (req, res) => {
    const { title, description, rewardCoins, rewardExp, link, taskType } = req.body;
    db.run(`INSERT INTO tasks (title, description, reward_coins, reward_exp, link, task_type) VALUES (?, ?, ?, ?, ?, ?)`,
        [title, description, rewardCoins, rewardExp, link, taskType], function() {
            res.json({ success: true, taskId: this.lastID });
    });
});

app.listen(PORT, () => {
    console.log(`Coin Rush Mini App Server running at http://localhost:${PORT}`);
});
