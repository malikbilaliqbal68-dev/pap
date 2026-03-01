import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db = null;

export async function initDatabase() {
  if (db) return db;

  const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'paperify.db');
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT,
      google_id TEXT,
      name TEXT NOT NULL,
      subject TEXT,
      age INTEGER,
      institution TEXT,
      country TEXT,
      preferred_books TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      email TEXT,
      plan TEXT NOT NULL,
      amount INTEGER NOT NULL,
      transaction_id TEXT UNIQUE,
      screenshot TEXT,
      books TEXT,
      phone TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      verified_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE,
      email TEXT UNIQUE,
      plan TEXT,
      books TEXT,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      referral_code TEXT UNIQUE NOT NULL,
      referred_by TEXT,
      paid_referral_users TEXT DEFAULT '[]',
      free_paper_count INTEGER DEFAULT 0,
      unlocked_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payment_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id TEXT UNIQUE NOT NULL,
      user_email TEXT NOT NULL,
      plan TEXT NOT NULL,
      amount INTEGER NOT NULL,
      books TEXT DEFAULT '[]',
      signature TEXT NOT NULL,
      status TEXT DEFAULT 'pending_payment',
      transaction_id TEXT,
      screenshot TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      paid_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS demo_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}

export async function createUser(userData) {
  const database = await initDatabase();
  const { email, password, name, subject, age, institution, country, preferredBooks } = userData;

  const hashedPassword = password ? await bcrypt.hash(password, 10) : null;

  const result = await database.run(
    `INSERT INTO users (email, password, name, subject, age, institution, country, preferred_books) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [email, hashedPassword, name, subject, age, institution, country, JSON.stringify(preferredBooks)]
  );

  return result.lastID;
}

export async function findUserByEmail(email) {
  const database = await initDatabase();
  return await database.get('SELECT * FROM users WHERE email = ?', [email]);
}

export async function verifyPassword(password, hashedPassword) {
  return await bcrypt.compare(password, hashedPassword);
}

export async function savePayment(paymentData) {
  const database = await initDatabase();
  const { userId, email, plan, amount, transactionId, screenshot, books, phone } = paymentData;

  const result = await database.run(
    `INSERT INTO payments (user_id, email, plan, amount, transaction_id, screenshot, books, phone) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId || null, email, plan, amount, transactionId, screenshot, JSON.stringify(books), phone]
  );

  return result.lastID;
}

export async function findPaymentByTransactionId(transactionId) {
  const database = await initDatabase();
  const paymentLink = await database.get('SELECT * FROM payment_links WHERE transaction_id = ?', [transactionId]);
  if (paymentLink) return paymentLink;
  return await database.get('SELECT * FROM payments WHERE transaction_id = ?', [transactionId]);
}

export async function createOrUpdateSubscription(userId, email, plan, books, daysValid) {
  const database = await initDatabase();
  const expiresAt = new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000).toISOString();

  const existing = await database.get('SELECT * FROM subscriptions WHERE user_id = ?', [userId]);

  if (existing) {
    await database.run(
      `UPDATE subscriptions SET plan = ?, books = ?, expires_at = ? WHERE user_id = ?`,
      [plan, JSON.stringify(books), expiresAt, userId]
    );
  } else {
    await database.run(
      `INSERT INTO subscriptions (user_id, email, plan, books, expires_at) VALUES (?, ?, ?, ?, ?)`,
      [userId, email, plan, JSON.stringify(books), expiresAt]
    );
  }
}

export async function getSubscription(userId) {
  const database = await initDatabase();
  const sub = await database.get('SELECT * FROM subscriptions WHERE user_id = ?', [userId]);

  if (sub) {
    if (new Date(sub.expires_at) < new Date()) {
      await database.run('DELETE FROM subscriptions WHERE id = ?', [sub.id]);
      return null;
    }
    return {
      plan: sub.plan,
      books: JSON.parse(sub.books || '[]'),
      expiresAt: sub.expires_at
    };
  }
  return null;
}

export async function getSubscriptionByEmail(email) {
  const database = await initDatabase();
  const sub = await database.get('SELECT * FROM subscriptions WHERE email = ?', [email]);
  if (sub) {
    if (new Date(sub.expires_at) < new Date()) {
      await database.run('DELETE FROM subscriptions WHERE id = ?', [sub.id]);
      return null;
    }
    return {
      plan: sub.plan,
      books: JSON.parse(sub.books || '[]'),
      expiresAt: sub.expires_at
    };
  }
  return null;
}

export async function getLatestCompletedPaymentLinkByEmail(email) {
  const database = await initDatabase();
  return await database.get(
    "SELECT * FROM payment_links WHERE user_email = ? AND status = 'completed' ORDER BY paid_at DESC, created_at DESC LIMIT 1",
    [email]
  );
}

export async function saveReferral(email, referralCode, referredBy = null) {
  const database = await initDatabase();
  await database.run(
    'INSERT OR IGNORE INTO referrals (email, referral_code, referred_by) VALUES (?, ?, ?)',
    [email, referralCode, referredBy]
  );
}

export async function getReferral(email) {
  const database = await initDatabase();
  return await database.get('SELECT * FROM referrals WHERE email = ?', [email]);
}

export async function updateReferral(email, data) {
  const database = await initDatabase();
  const fields = [];
  const values = [];
  
  if (data.paidReferralUsers) {
    fields.push('paid_referral_users = ?');
    values.push(JSON.stringify(data.paidReferralUsers));
  }
  if (data.freePaperCount !== undefined) {
    fields.push('free_paper_count = ?');
    values.push(data.freePaperCount);
  }
  if (data.unlockedAt) {
    fields.push('unlocked_at = ?');
    values.push(data.unlockedAt);
  }
  if (data.referredBy) {
    fields.push('referred_by = ?');
    values.push(data.referredBy);
  }
  
  values.push(email);
  await database.run(`UPDATE referrals SET ${fields.join(', ')} WHERE email = ?`, values);
}

export async function savePaymentLink(linkData) {
  const database = await initDatabase();
  await database.run(
    'INSERT INTO payment_links (link_id, user_email, plan, amount, books, signature, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [linkData.linkId, linkData.userEmail, linkData.plan, linkData.amount, JSON.stringify(linkData.books), linkData.signature, linkData.status, linkData.expiresAt]
  );
}

export async function getPaymentLink(linkId) {
  const database = await initDatabase();
  return await database.get('SELECT * FROM payment_links WHERE link_id = ?', [linkId]);
}

export async function updatePaymentLink(linkId, status, paidAt = null, transactionId = null, screenshot = null) {
  const database = await initDatabase();
  if (transactionId || screenshot) {
    await database.run(
      'UPDATE payment_links SET status = ?, paid_at = ?, transaction_id = ?, screenshot = ? WHERE link_id = ?',
      [status, paidAt, transactionId, screenshot, linkId]
    );
  } else {
    await database.run('UPDATE payment_links SET status = ?, paid_at = ? WHERE link_id = ?', [status, paidAt, linkId]);
  }
}

export async function getAllPendingPayments() {
  const database = await initDatabase();
  return await database.all(
    "SELECT * FROM payment_links WHERE status = 'pending_verification' ORDER BY created_at DESC"
  );
}

export async function getDemoUsage(userId) {
  const database = await initDatabase();
  const row = await database.get('SELECT count FROM demo_usage WHERE user_id = ?', [userId]);
  return row ? row.count : 0;
}

export async function incrementDemoUsage(userId) {
  const database = await initDatabase();
  const existing = await database.get('SELECT * FROM demo_usage WHERE user_id = ?', [userId]);
  if (existing) {
    await database.run('UPDATE demo_usage SET count = count + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [userId]);
  } else {
    await database.run('INSERT INTO demo_usage (user_id, count) VALUES (?, 1)', [userId]);
  }
  const row = await database.get('SELECT count FROM demo_usage WHERE user_id = ?', [userId]);
  return row.count;
}
