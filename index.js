import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import session from 'express-session';
import bookRoutes from './routes/book.js';
import { upload } from './upload-config.js';
import {
  initDatabase,
  createUser,
  findUserByEmail,
  verifyPassword,
  savePayment,
  createOrUpdateSubscription,
  getSubscription,
  saveReferral,
  getReferral,
  updateReferral,
  getDemoUsage,
  incrementDemoUsage,
  getPaymentLink,
  getAllPendingPayments,
  findPaymentByTransactionId
} from './database.js';
import {
  createPaymentLink,
  verifyPaymentLink,
  submitPaymentProof,
  markPaymentComplete,
  activateSubscription
} from './secure-payment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const PAPERS_STORE_PATH = path.join(DATA_DIR, 'saved-papers.json');
const ANALYTICS_STORE_PATH = path.join(DATA_DIR, 'weak-areas.json');

function readJsonStore(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonStore(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/data/uploads', express.static(path.join(__dirname, 'data', 'uploads')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'paperify-default-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 
  }
}));

function loadBoardData(board) {
  try {
    const safeBoard = board.trim().toLowerCase();
    const filePath = path.join(__dirname, 'syllabus', `${safeBoard}_board_syllabus.json`);
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`Error loading ${board} board:`, error);
    return [];
  }
}

const REFERRAL_REQUIRED_PAID_USERS = 10;
const REFERRAL_FREE_PAPER_LIMIT = 15;
const DEMO_LIMIT = 4;
const STRIPE_PLANS = {
  weekly_unlimited: { amount: 450, discountAmount: 400, name: 'Weekly Unlimited (14 Days)', backendPlan: 'weekly_unlimited', durationDays: 14 },
  monthly_specific: { amount: 800, discountAmount: 750, name: 'Monthly Specific (30 Papers)', backendPlan: 'monthly_specific', durationDays: 30 },
  monthly_unlimited: { amount: 1200, discountAmount: 1150, name: 'Monthly Unlimited (30 Days)', backendPlan: 'monthly_unlimited', durationDays: 30 }
};

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function generateReferralCode(email) {
  const base = normalizeEmail(email).split('@')[0].replace(/[^a-z0-9]/g, '').slice(0, 6).toUpperCase() || 'USER';
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}${suffix}`;
}

async function ensureReferralProfile(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  let profile = await getReferral(normalizedEmail);
  if (!profile) {
    await saveReferral(normalizedEmail, generateReferralCode(normalizedEmail));
    profile = await getReferral(normalizedEmail);
  }
  return profile;
}

async function getReferralStatus(email) {
  const profile = await ensureReferralProfile(email);
  if (!profile) return null;
  const paidReferralUsers = JSON.parse(profile.paid_referral_users || '[]');
  const paidReferrals = paidReferralUsers.length;
  const unlocked = paidReferrals >= REFERRAL_REQUIRED_PAID_USERS || !!profile.unlocked_at;
  if (unlocked && !profile.unlocked_at) {
    await updateReferral(email, { unlockedAt: new Date().toISOString() });
  }
  return {
    referralCode: profile.referral_code,
    referredBy: profile.referred_by || null,
    paidReferrals,
    requiredPaidReferrals: REFERRAL_REQUIRED_PAID_USERS,
    unlocked,
    freePaperCount: profile.free_paper_count || 0,
    freePaperLimit: REFERRAL_FREE_PAPER_LIMIT
  };
}

async function applyReferralCode(userEmail, referralCode) {
  const normalizedCode = String(referralCode || '').trim().toUpperCase();
  if (!normalizedCode) return { ok: false, error: 'Referral code is required' };
  const userProfile = await getReferral(normalizeEmail(userEmail));
  if (!userProfile) return { ok: false, error: 'User not found' };
  if (userProfile.referred_by) return { ok: false, error: 'Referral code already applied' };
  if (userProfile.referral_code === normalizedCode) return { ok: false, error: 'Cannot use own code' };
  await updateReferral(normalizeEmail(userEmail), { referredBy: normalizedCode });
  return { ok: true };
}

async function creditReferrerForPaidUser(paidUserEmail) {
  const paidUserProfile = await getReferral(normalizeEmail(paidUserEmail));
  if (!paidUserProfile || !paidUserProfile.referred_by) return { credited: false };
  const referrerProfile = await getReferral(paidUserProfile.referred_by);
  if (!referrerProfile) return { credited: false };
  const paidReferralUsers = JSON.parse(referrerProfile.paid_referral_users || '[]');
  if (paidReferralUsers.includes(normalizeEmail(paidUserEmail))) return { credited: false, alreadyCredited: true };
  paidReferralUsers.push(normalizeEmail(paidUserEmail));
  const updateData = { paidReferralUsers };
  if (paidReferralUsers.length >= REFERRAL_REQUIRED_PAID_USERS) {
    updateData.unlockedAt = new Date().toISOString();
  }
  await updateReferral(referrerProfile.email, updateData);
  return { credited: true, paidReferrals: paidReferralUsers.length };
}

function parseBooks(booksInput) {
  try {
    if (!booksInput) return [];
    if (Array.isArray(booksInput)) return booksInput;
    return JSON.parse(booksInput);
  } catch {
    return [];
  }
}

function getPlanConfigOrNull(planKey) {
  return STRIPE_PLANS[planKey] || null;
}

function getUserEmailFromRequest(req) {
  return normalizeEmail(req.session?.userEmail || req.body?.userEmail || '');
}

// Auth Routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, subject, age, institution, country, preferredBooks, referralCode } = req.body;
    const existingUser = await findUserByEmail(email);
    if (existingUser) return res.status(400).json({ error: 'User already exists' });
    const userId = await createUser({ email, password, name, subject, age, institution, country, preferredBooks });
    req.session.userId = userId;
    req.session.userEmail = email;
    await ensureReferralProfile(email);
    if (referralCode) await applyReferralCode(email, referralCode);
    res.json({ success: true, userId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await findUserByEmail(email);
    if (!user || !await verifyPassword(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.userId = user.id;
    req.session.userEmail = user.email;
    await ensureReferralProfile(user.email);
    res.json({ success: true, user: { id: user.id, email: user.email, name: user.name } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = await findUserByEmail(req.session.userEmail);
  res.json({ user: { id: user.id, email: user.email, name: user.name } });
});

app.get('/api/referral/status', async (req, res) => {
  try {
    if (!req.session?.userEmail) return res.status(401).json({ success: false, error: 'Please login' });
    const status = await getReferralStatus(req.session.userEmail);
    res.json({ success: true, referral: status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/referral/apply', async (req, res) => {
  try {
    if (!req.session?.userEmail) return res.status(401).json({ success: false, error: 'Please login' });
    const result = await applyReferralCode(req.session.userEmail, req.body?.referralCode);
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, message: 'Referral code applied' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/user/subscription', async (req, res) => {
  try {
    if (!req.session.userId) return res.json({ subscription: null });
    const sub = await getSubscription(req.session.userId);
    if (sub) {
      const now = new Date();
      const expiresAt = new Date(sub.expiresAt);
      const daysRemaining = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
      res.json({
        subscription: {
          plan: sub.plan,
          books: sub.books,
          expiresAt: sub.expiresAt,
          isExpired: false,
          daysRemaining,
          isActive: true
        }
      });
    } else {
      res.json({ subscription: null });
    }
  } catch (error) {
    res.json({ subscription: null });
  }
});

app.post('/api/payment/create-link', async (req, res) => {
  try {
    const userEmail = getUserEmailFromRequest(req);
    if (!userEmail) return res.status(401).json({ success: false, error: 'Please login first' });
    const planKey = req.body?.plan;
    const plan = getPlanConfigOrNull(planKey);
    if (!plan) return res.status(400).json({ success: false, error: 'Invalid plan' });
    const books = parseBooks(req.body?.books);
    if (planKey === 'monthly_specific' && books.length !== 1) {
      return res.status(400).json({ success: false, error: 'Monthly specific requires 1 book' });
    }
    const discountEnabled = req.body?.applyDiscount === true;
    const finalAmount = discountEnabled ? plan.discountAmount : plan.amount;
    const linkId = await createPaymentLink(userEmail, plan.backendPlan, finalAmount, books);
    res.json({
      success: true,
      linkId,
      amount: finalAmount,
      originalAmount: plan.amount,
      discountApplied: discountEnabled,
      plan: planKey,
      paymentUrl: `${req.protocol}://${req.get('host')}/payment/${linkId}`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/payment/submit/:linkId', upload.single('screenshot'), async (req, res) => {
  try {
    const { linkId } = req.params;
    const { transactionId } = req.body;
    const screenshot = req.file;

    if (!transactionId || transactionId.length < 6) {
      return res.status(400).json({ success: false, error: 'Valid transaction ID required' });
    }

    if (!screenshot) {
      return res.status(400).json({ success: false, error: 'Payment screenshot required' });
    }

    // 1️⃣ Check transaction ID uniqueness (prevent receipt reuse)
    const existing = await findPaymentByTransactionId(transactionId);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Transaction ID already used. Each payment must be unique.' });
    }

    const verification = await verifyPaymentLink(linkId);
    if (!verification.valid) {
      return res.status(400).json({ success: false, error: verification.error });
    }

    await submitPaymentProof(linkId, transactionId, screenshot.filename);
    res.json({ success: true, message: 'Payment submitted for verification' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/payment/confirm/:linkId', async (req, res) => {
  try {
    const superEmail = (process.env.SUPERUSER_EMAIL || 'bilal@paperify.com').toLowerCase();
    const currentEmail = String(req.session?.userEmail || '').toLowerCase();
    
    if (!currentEmail || currentEmail !== superEmail) {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { linkId } = req.params;
    const verification = await verifyPaymentLink(linkId);
    if (!verification.valid) return res.status(400).json({ success: false, error: verification.error });
    
    if (verification.link.status !== 'pending_verification') {
      return res.status(400).json({ success: false, error: 'Payment not ready for verification' });
    }

    await markPaymentComplete(linkId);
    const subscription = await activateSubscription(linkId);
    if (!subscription) return res.status(500).json({ success: false, error: 'Failed to activate' });
    
    const user = await findUserByEmail(subscription.userEmail);
    if (user) {
      const durationDays = subscription.plan === 'weekly_unlimited' ? 14 : 30;
      await createOrUpdateSubscription(user.id, user.email, subscription.plan, subscription.books, durationDays);
    }
    
    await creditReferrerForPaidUser(subscription.userEmail);
    res.json({ success: true, message: 'Payment verified and subscription activated', expiresAt: subscription.expiresAt });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Payment link verification endpoint - returns link ID for security tracking
app.get('/payment/:linkId', async (req, res) => {
  const { linkId } = req.params;
  const verification = await verifyPaymentLink(linkId);
  if (!verification.valid) {
    return res.status(400).json({ 
      success: false, 
      error: verification.error,
      linkId: linkId 
    });
  }
  // Return link details as JSON for security tracking
  res.json({ 
    success: true,
    linkId: verification.link.linkId,
    userEmail: verification.link.userEmail,
    plan: verification.link.plan,
    amount: verification.link.amount,
    status: verification.link.status,
    expiresAt: verification.link.expiresAt,
    message: 'Payment link verified. Submit proof via popup modal.'
  });
});

app.post('/api/admin/temp-unlimited', (req, res) => {
  try {
    const superEmail = (process.env.SUPERUSER_EMAIL || 'bilal@paperify.com').toLowerCase();
    const currentEmail = String(req.session?.userEmail || '').toLowerCase();
    if (!currentEmail || currentEmail !== superEmail) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const durationMs = Math.min(Number(req.body?.durationMs) || (60 * 60 * 1000), 24 * 60 * 60 * 1000);
    const until = Date.now() + durationMs;
    req.session.tempUnlimitedUntil = until;
    res.json({ success: true, tempUnlimitedUntil: until });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/demo/track', async (req, res) => {
  try {
    const userId = req.body.userId || 'guest';
    const isGuest = userId.startsWith('guest_') || userId === 'guest';
    if (isGuest) {
      const count = await incrementDemoUsage(userId);
      return res.json({ count, limit: DEMO_LIMIT });
    }
    const userEmail = req.session.userEmail;
    if (!userEmail) return res.status(401).json({ error: 'Session expired' });
    if (req.session?.tempUnlimitedUntil && Date.now() < Number(req.session.tempUnlimitedUntil)) {
      return res.json({ count: 0, limit: 99999, unlimited: true, plan: 'temp_unlimited' });
    }
    const referral = await getReferralStatus(userEmail);
    if (referral?.unlocked) {
      return res.json({ count: 0, limit: 99999, unlimited: true, plan: 'referral_unlocked', referral });
    }
    const activeSub = await getSubscription(req.session.userId);
    if (activeSub) {
      if (activeSub.plan === 'monthly_specific') {
        const count = await incrementDemoUsage(`${userEmail}_monthly`);
        return res.json({ count, limit: 30, plan: 'monthly_specific' });
      }
      return res.json({ count: 0, limit: 99999, unlimited: true, plan: activeSub.plan });
    }
    const profile = await getReferral(userEmail);
    const freeUsed = profile?.free_paper_count || 0;
    if (freeUsed >= REFERRAL_FREE_PAPER_LIMIT) {
      return res.json({ count: freeUsed, limit: REFERRAL_FREE_PAPER_LIMIT, plan: 'referral_free', error: 'Free limit reached', referral });
    }
    await updateReferral(userEmail, { freePaperCount: freeUsed + 1 });
    return res.json({ count: freeUsed + 1, limit: REFERRAL_FREE_PAPER_LIMIT, plan: 'referral_free', referral });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/api/demo/check', async (req, res) => {
  try {
    const userId = req.query.userId || 'guest';
    const isGuest = userId.startsWith('guest_') || userId === 'guest';
    if (isGuest) {
      const count = await getDemoUsage(userId);
      return res.json({ count, limit: DEMO_LIMIT });
    }
    const userEmail = req.session.userEmail;
    if (!userEmail) return res.json({ count: 0, limit: DEMO_LIMIT, error: 'Please login' });
    if (req.session?.tempUnlimitedUntil && Date.now() < Number(req.session.tempUnlimitedUntil)) {
      return res.json({ count: 0, limit: 99999, unlimited: true, plan: 'temp_unlimited' });
    }
    const referral = await getReferralStatus(userEmail);
    if (referral?.unlocked) return res.json({ count: 0, limit: 99999, unlimited: true, plan: 'referral_unlocked', referral });
    const activeSub = await getSubscription(req.session.userId);
    if (activeSub) {
      if (activeSub.plan === 'monthly_specific') {
        const count = await getDemoUsage(`${userEmail}_monthly`);
        return res.json({ count, limit: 30, plan: 'monthly_specific' });
      }
      return res.json({ count: 0, limit: 99999, unlimited: true, plan: activeSub.plan });
    }
    const profile = await getReferral(userEmail);
    const count = profile?.free_paper_count || 0;
    if (count >= REFERRAL_FREE_PAPER_LIMIT) {
      return res.json({ count, limit: REFERRAL_FREE_PAPER_LIMIT, plan: 'referral_free', error: 'Free limit reached', referral });
    }
    return res.json({ count, limit: REFERRAL_FREE_PAPER_LIMIT, plan: 'referral_free', referral });
  } catch (error) {
    res.json({ count: 0, limit: DEMO_LIMIT, error: error.message });
  }
});

app.get('/api/data/:board', (req, res) => res.json(loadBoardData(req.params.board)));

app.get('/api/books/all', (req, res) => {
  try {
    const boards = ['punjab', 'sindh', 'fedral'];
    const allBooks = new Set();
    boards.forEach(board => {
      const data = loadBoardData(board);
      if (Array.isArray(data)) {
        data.forEach(classData => {
          if (classData.subjects && Array.isArray(classData.subjects)) {
            classData.subjects.forEach(subject => {
              const name = subject.name?.en || subject.name;
              if (name) allBooks.add(name.trim());
            });
          }
        });
      }
    });
    res.json({ books: Array.from(allBooks).sort() });
  } catch (error) {
    res.status(500).json({ books: [], error: error.message });
  }
});

app.get('/api/subjects/:board/:class/:group', (req, res) => {
  try {
    const { board, class: className, group } = req.params;
    const data = loadBoardData(board);
    const classData = data.find(c => c.class.toString() === className.toString());
    if (!classData || !classData.subjects) return res.json([]);
    
    // If group is 'all' or not specified, return all subjects
    if (!group || group.toLowerCase() === 'all' || group === 'null' || group === 'undefined') {
      const subjects = classData.subjects.map(subject => {
        const nameObj = subject.name;
        const displayName = typeof nameObj === 'object' ? (nameObj.en || nameObj.ur || '') : (nameObj || '');
        return {
          ...subject,
          name: typeof nameObj === 'object' ? nameObj : { en: displayName },
          displayName: displayName
        };
      });
      return res.json(subjects);
    }
    
    const science = ['biology', 'chemistry', 'physics', 'mathematics', 'computer science', 'english', 'urdu'];
    const arts = ['civics', 'food and nutrition', 'general mathematics', 'general science', 'home economics', 'pakistan studies', 'physical education', 'poultry farming', 'english', 'urdu', 'islamic studies', 'history', 'geography', 'economics'];
    
    const subjects = classData.subjects.filter(subject => {
      const name = (subject.name?.en || subject.name || '').toLowerCase().trim();
      if (!name) return false;
      if (group.toLowerCase() === 'science') return science.includes(name);
      if (group.toLowerCase() === 'arts') return arts.includes(name);
      return false;
    }).map(subject => {
      const nameObj = subject.name;
      const displayName = typeof nameObj === 'object' ? (nameObj.en || nameObj.ur || '') : (nameObj || '');
      return {
        ...subject,
        name: typeof nameObj === 'object' ? nameObj : { en: displayName },
        displayName: displayName
      };
    });
    
    res.json(subjects);
  } catch (error) {
    console.error('Error loading subjects:', error);
    res.status(500).json({ error: 'Failed to load subjects' });
  }
});

app.get('/api/subjects/:board/:class', (req, res) => {
  try {
    const { board, class: className } = req.params;
    const data = loadBoardData(board);
    const classData = data.find(c => c.class.toString() === className.toString());
    if (!classData || !classData.subjects) {
      console.log(`No subjects found for ${board} class ${className}`);
      return res.json([]);
    }
    const subjects = classData.subjects.map(subject => {
      const nameObj = subject.name;
      const displayName = typeof nameObj === 'object' ? (nameObj.en || nameObj.ur || '') : (nameObj || '');
      return {
        ...subject,
        name: typeof nameObj === 'object' ? nameObj : { en: displayName },
        displayName: displayName
      };
    });
    console.log(`Found ${subjects.length} subjects for ${board} class ${className}`);
    res.json(subjects);
  } catch (error) {
    console.error('Error loading subjects:', error);
    res.status(500).json({ error: 'Failed to load subjects' });
  }
});

app.get('/api/chapters/:board/:class/:subject', (req, res) => {
  try {
    const { board, class: className, subject } = req.params;
    const data = loadBoardData(board);
    const classData = data.find(c => c.class.toString() === className.toString());
    if (!classData) return res.json([]);
    const decodedSubject = decodeURIComponent(subject).toLowerCase().trim();
    const subjectData = classData.subjects.find(s => {
      const name = s.name?.en || s.name || '';
      return name.toLowerCase().trim() === decodedSubject;
    });
    if (!subjectData) return res.json([]);
    
    // For Urdu subject, return chapter names properly
    const chapters = (subjectData.chapters || []).map(ch => {
      const chapterObj = ch.chapter || ch.title || ch;
      return {
        title: typeof chapterObj === 'object' ? (chapterObj.en || chapterObj.ur || '') : (chapterObj || ''),
        title_ur: typeof chapterObj === 'object' ? (chapterObj.ur || '') : ''
      };
    });
    res.json(chapters);
  } catch (error) {
    res.json([]);
  }
});

app.get('/api/topics/:board/:class/:subject/:chapter', (req, res) => {
  try {
    const { board, class: className, subject, chapter } = req.params;
    const data = loadBoardData(board);
    const classData = data.find(c => c.class.toString() === className.toString());
    if (!classData) return res.json([]);
    const decodedSubject = decodeURIComponent(subject).toLowerCase().trim();
    const decodedChapter = decodeURIComponent(chapter).toLowerCase().trim();

    const subjectData = classData.subjects.find(s => {
      const name = s.name?.en || s.name || '';
      return String(name).toLowerCase().trim() === decodedSubject;
    });
    if (!subjectData) return res.json([]);

    const chapterData = (subjectData.chapters || []).find(ch => {
      const nameEn = ch.title?.en || ch.chapter?.en || ch.chapter || '';
      return String(nameEn).toLowerCase().trim() === decodedChapter;
    });
    if (!chapterData || !Array.isArray(chapterData.topics)) return res.json([]);

    const topics = chapterData.topics.map(t => ({
      title: t.topic?.en || t.topic || '',
      title_ur: t.topic?.ur || ''
    }));
    res.json(topics);
  } catch {
    res.json([]);
  }
});

app.post('/api/user/subscription/lock-book', async (req, res) => {
  try {
    if (!req.session?.userId || !req.session?.userEmail) {
      return res.status(401).json({ success: false, error: 'Please login' });
    }
    const book = String(req.body?.book || '').trim();
    if (!book) return res.status(400).json({ success: false, error: 'Book is required' });
    const sub = await getSubscription(req.session.userId);
    if (!sub) return res.status(400).json({ success: false, error: 'No active subscription' });
    if (sub.plan !== 'monthly_specific') {
      return res.json({ success: true, message: 'Book lock not required for this plan', books: sub.books || [] });
    }
    const remainingDays = Math.max(1, Math.ceil((new Date(sub.expiresAt) - new Date()) / (1000 * 60 * 60 * 24)));
    await createOrUpdateSubscription(req.session.userId, req.session.userEmail, sub.plan, [book], remainingDays);
    return res.json({ success: true, books: [book] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/payments', async (req, res) => {
  const superEmail = (process.env.SUPERUSER_EMAIL || 'bilal@paperify.com').toLowerCase();
  const currentEmail = String(req.session?.userEmail || '').toLowerCase();
  if (!currentEmail || currentEmail !== superEmail) {
    return res.status(403).json({ success: false, error: 'Forbidden', payments: [] });
  }
  const payments = await getAllPendingPayments();
  return res.json({ success: true, payments });
});

// Task Review API with AI feedback
app.post('/api/task-review', async (req, res) => {
  try {
    const { task, url, description, goal } = req.body;
    
    // Simple rule-based feedback (can be replaced with AI API)
    const feedback = {
      strengths: 'Good effort on completing the task. The project shows understanding of core concepts.',
      improvements: 'Consider adding error handling, improving UI/UX design, adding comments to code, and implementing responsive design.',
      nextSteps: 'Deploy the project, add it to your portfolio, share on LinkedIn, and move to the next task.',
      score: Math.floor(Math.random() * 3) + 7 // Random score 7-10
    };
    
    // Store submission in database (optional)
    // You can add database storage here
    
    res.json({ success: true, feedback });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/approve-payment', (req, res) => {
  const superEmail = (process.env.SUPERUSER_EMAIL || 'bilal@paperify.com').toLowerCase();
  const currentEmail = String(req.session?.userEmail || '').toLowerCase();
  if (!currentEmail || currentEmail !== superEmail) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  return res.json({ success: true, message: 'Compatibility endpoint active. No pending payments in legacy table.' });
});

app.post('/api/admin/reject-payment', (req, res) => {
  const superEmail = (process.env.SUPERUSER_EMAIL || 'bilal@paperify.com').toLowerCase();
  const currentEmail = String(req.session?.userEmail || '').toLowerCase();
  if (!currentEmail || currentEmail !== superEmail) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  return res.json({ success: true, message: 'Compatibility endpoint active. No pending payments in legacy table.' });
});

// API endpoint to save custom questions
app.post('/api/custom-question', async (req, res) => {
  try {
    const { board, className, selections, questionType, question } = req.body;
    
    if (!board || !className || !questionType || !question) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    // Load the syllabus file
    const safeBoard = board.trim().toLowerCase();
    const filePath = path.join(__dirname, 'syllabus', `${safeBoard}_board_syllabus.json`);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Board syllabus not found' });
    }
    
    const syllabusData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const classData = syllabusData.find(c => c.class.toString() === className.toString());
    
    if (!classData) {
      return res.status(404).json({ success: false, error: 'Class not found' });
    }
    
    // Parse selections to find the target chapter
    const selectionsArray = JSON.parse(decodeURIComponent(selections || '[]'));
    if (selectionsArray.length === 0) {
      return res.status(400).json({ success: false, error: 'No chapter selected' });
    }
    
    const firstSelection = selectionsArray[0];
    const subjectName = firstSelection.subject.toLowerCase().trim();
    const chapterTitle = typeof firstSelection.chapters[0] === 'string' 
      ? firstSelection.chapters[0] 
      : firstSelection.chapters[0].title;
    
    // Find subject and chapter
    const subject = classData.subjects.find(s => {
      const name = s.name?.en || s.name || '';
      return name.toLowerCase().trim() === subjectName;
    });
    
    if (!subject) {
      return res.status(404).json({ success: false, error: 'Subject not found' });
    }
    
    const chapter = subject.chapters.find(ch => {
      const nameEn = typeof ch.chapter === 'object' ? ch.chapter.en : (ch.chapter || ch.title?.en || "");
      return nameEn.trim().toLowerCase() === chapterTitle.trim().toLowerCase();
    });
    
    if (!chapter) {
      return res.status(404).json({ success: false, error: 'Chapter not found' });
    }

    const chapterNameObj = (typeof chapter.chapter === 'object' && chapter.chapter)
      || (typeof chapter.title === 'object' && chapter.title)
      || {};
    const hasEnglish = Boolean(
      chapterNameObj.en
      || (typeof chapter.chapter === 'string' && chapter.chapter.trim())
      || (typeof chapter.title === 'string' && chapter.title.trim())
    );
    const hasUrdu = Boolean(chapterNameObj.ur);

    let normalizedQuestionEn = (question.en || '').trim();
    let normalizedQuestionUr = (question.ur || '').trim();

    if (hasEnglish && hasUrdu) {
      if (normalizedQuestionEn && !normalizedQuestionUr) normalizedQuestionUr = normalizedQuestionEn;
      if (normalizedQuestionUr && !normalizedQuestionEn) normalizedQuestionEn = normalizedQuestionUr;
    } else if (hasEnglish && !hasUrdu) {
      if (!normalizedQuestionEn) {
        return res.status(400).json({ success: false, error: 'This chapter supports English only' });
      }
      normalizedQuestionUr = '';
    } else if (hasUrdu && !hasEnglish) {
      if (!normalizedQuestionUr) {
        return res.status(400).json({ success: false, error: 'This chapter supports Urdu only' });
      }
      normalizedQuestionEn = '';
    }
    
    // Add question to appropriate array
    if (questionType === 'mcqs') {
      if (!chapter.mcqs) chapter.mcqs = [];
      chapter.mcqs.push({
        question: normalizedQuestionEn || '',
        question_ur: normalizedQuestionUr || '',
        options: question.options || [],
        options_ur: hasEnglish && hasUrdu ? (question.options_ur?.length ? question.options_ur : (question.options || [])) : (question.options_ur || []),
        correct: null,
        custom: true
      });
    } else if (questionType === 'short') {
      if (!chapter.short_questions) chapter.short_questions = [];
      if (!chapter.short_questions_ur) chapter.short_questions_ur = [];
      chapter.short_questions.push(normalizedQuestionEn || '');
      chapter.short_questions_ur.push(normalizedQuestionUr || '');
    } else if (questionType === 'long') {
      if (!chapter.long_questions) chapter.long_questions = [];
      if (!chapter.long_questions_ur) chapter.long_questions_ur = [];
      chapter.long_questions.push(normalizedQuestionEn || '');
      chapter.long_questions_ur.push(normalizedQuestionUr || '');
    }
    
    // Save back to file
    fs.writeFileSync(filePath, JSON.stringify(syllabusData, null, 2), 'utf8');
    
    res.json({ success: true, message: 'Question added successfully' });
  } catch (error) {
    console.error('Error saving custom question:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/papers/save', (req, res) => {
  try {
    const ownerEmail = normalizeEmail(req.session?.userEmail || req.body?.ownerEmail || 'guest@paperify.local');
    const {
      board,
      className,
      group = '',
      selections = [],
      config = {},
      totalMarks = 0,
      instituteName = '',
      title = ''
    } = req.body || {};

    if (!board || !className) {
      return res.status(400).json({ success: false, error: 'board and className are required' });
    }

    const allPapers = readJsonStore(PAPERS_STORE_PATH, []);
    const paperId = crypto.randomBytes(10).toString('hex');
    const createdAt = new Date().toISOString();
    const paper = {
      paperId,
      ownerEmail,
      title: title || `${board.toUpperCase()} Class ${className} Paper`,
      board,
      className,
      group,
      selections,
      config,
      totalMarks: Number(totalMarks) || 0,
      instituteName: String(instituteName || '').trim(),
      createdAt,
      updatedAt: createdAt,
      collaboration: {
        shareId: null,
        editors: [ownerEmail],
        staff: []
      }
    };

    allPapers.push(paper);
    writeJsonStore(PAPERS_STORE_PATH, allPapers);
    res.json({ success: true, paper });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/papers/history', (req, res) => {
  try {
    const ownerEmail = normalizeEmail(req.session?.userEmail || req.query?.ownerEmail || 'guest@paperify.local');
    const allPapers = readJsonStore(PAPERS_STORE_PATH, []);
    const papers = allPapers
      .filter(p => normalizeEmail(p.ownerEmail) === ownerEmail || (p.collaboration?.staff || []).includes(ownerEmail))
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
    res.json({ success: true, papers });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/papers/shared/:shareId', (req, res) => {
  try {
    const { shareId } = req.params;
    const allPapers = readJsonStore(PAPERS_STORE_PATH, []);
    const paper = allPapers.find(p => p.collaboration?.shareId === shareId);
    if (!paper) return res.status(404).json({ success: false, error: 'Shared paper not found' });
    res.json({ success: true, paper });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/papers/share/:paperId', (req, res) => {
  try {
    const { paperId } = req.params;
    const ownerEmail = normalizeEmail(req.session?.userEmail || req.body?.ownerEmail || 'guest@paperify.local');
    const allPapers = readJsonStore(PAPERS_STORE_PATH, []);
    const index = allPapers.findIndex(p => p.paperId === paperId && normalizeEmail(p.ownerEmail) === ownerEmail);
    if (index === -1) return res.status(404).json({ success: false, error: 'Paper not found' });

    const shareId = allPapers[index].collaboration?.shareId || crypto.randomBytes(8).toString('hex');
    const staff = Array.isArray(req.body?.staff) ? req.body.staff.map(normalizeEmail).filter(Boolean) : [];
    allPapers[index].collaboration = {
      ...(allPapers[index].collaboration || {}),
      shareId,
      editors: Array.from(new Set([...(allPapers[index].collaboration?.editors || []), ownerEmail])),
      staff: Array.from(new Set([...(allPapers[index].collaboration?.staff || []), ...staff]))
    };
    allPapers[index].updatedAt = new Date().toISOString();
    writeJsonStore(PAPERS_STORE_PATH, allPapers);

    res.json({
      success: true,
      shareId,
      shareUrl: `${req.protocol}://${req.get('host')}/pape?shared=${shareId}`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/papers/collab/:shareId', (req, res) => {
  try {
    const { shareId } = req.params;
    const editorEmail = normalizeEmail(req.session?.userEmail || req.body?.editorEmail || '');
    if (!editorEmail) return res.status(400).json({ success: false, error: 'editorEmail required' });

    const allPapers = readJsonStore(PAPERS_STORE_PATH, []);
    const index = allPapers.findIndex(p => p.collaboration?.shareId === shareId);
    if (index === -1) return res.status(404).json({ success: false, error: 'Share link not found' });

    const existing = allPapers[index].collaboration || { shareId, editors: [], staff: [] };
    allPapers[index].collaboration = {
      ...existing,
      editors: Array.from(new Set([...(existing.editors || []), editorEmail])),
      staff: Array.from(new Set([...(existing.staff || []), editorEmail]))
    };
    allPapers[index].updatedAt = new Date().toISOString();
    writeJsonStore(PAPERS_STORE_PATH, allPapers);
    res.json({ success: true, paper: allPapers[index] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/analytics/record', (req, res) => {
  try {
    const ownerEmail = normalizeEmail(req.session?.userEmail || req.body?.ownerEmail || 'guest@paperify.local');
    const { paperId = '', board = '', className = '', weakAreas = [] } = req.body || {};
    const areas = Array.isArray(weakAreas) ? weakAreas.map(a => String(a || '').trim()).filter(Boolean) : [];
    if (!areas.length) return res.json({ success: true, message: 'No weak areas submitted' });

    const rows = readJsonStore(ANALYTICS_STORE_PATH, []);
    rows.push({
      id: crypto.randomBytes(8).toString('hex'),
      ownerEmail,
      paperId,
      board,
      className,
      weakAreas: areas,
      createdAt: new Date().toISOString()
    });
    writeJsonStore(ANALYTICS_STORE_PATH, rows);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/analytics/weak-areas', (req, res) => {
  try {
    const ownerEmail = normalizeEmail(req.session?.userEmail || req.query?.ownerEmail || 'guest@paperify.local');
    const rows = readJsonStore(ANALYTICS_STORE_PATH, []);
    const ownerRows = rows.filter(r => normalizeEmail(r.ownerEmail) === ownerEmail);
    const counts = {};
    ownerRows.forEach(r => {
      (r.weakAreas || []).forEach(area => {
        counts[area] = (counts[area] || 0) + 1;
      });
    });
    const weakAreas = Object.entries(counts)
      .map(([area, count]) => ({ area, count }))
      .sort((a, b) => b.count - a.count);
    res.json({ success: true, weakAreas, totalRecords: ownerRows.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use('/book', bookRoutes);
app.get('/', (req, res) => {
  const superEmail = process.env.SUPERUSER_EMAIL || 'bilal@paperify.com';
  const paymentNumber = process.env.PAYMENT_NUMBER || '03XXXXXXXXX';
  res.render('Welcomepage', {
    userEmail: req.session?.userEmail || null,
    isSuperUser: req.session?.userEmail === superEmail,
    tempUnlimitedUntil: req.session?.tempUnlimitedUntil || null,
    superEmail,
    paymentNumber
  });
});
app.get('/board', (req, res) => res.render('board'));
app.get('/paper', (req, res) => res.render('classes'));
app.get('/group', (req, res) => res.render('groups'));
app.get('/books', (req, res) => res.render('books'));
app.get('/questions', (req, res) => res.render('questions'));
app.get('/pape', (req, res) => res.render('paper-generator'));
app.get('/courses', (req, res) => res.render('Courses'));
app.get('/roadmap', (req, res) => res.render('roadmap'));
app.get('/roadmap/', (req, res) => res.render('roadmap'));
app.get('/ans', (req, res) => res.render('answer'));
app.get('/ai-mentor', (req, res) => res.render('ai-mentor'));
app.get('/pricing', (req, res) => res.render('pricing'));
app.get('/quiz', (req, res) => res.render('quiz'));


app.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  try {
    await initDatabase();
    console.log('Database initialized');
  } catch (err) {
    console.error('Database failed:', err);
  }
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use!`);
    console.log(`\n🔧 Solutions:`);
    console.log(`1. Stop the other server running on port ${PORT}`);
    console.log(`2. Or set a different port: PORT=3001 node index.js`);
    console.log(`3. Or kill the process: npx kill-port ${PORT}\n`);
    process.exit(1);
  }
  throw err;
});
