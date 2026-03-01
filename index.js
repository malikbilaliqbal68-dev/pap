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
  findPaymentByTransactionId,
  getSubscriptionByEmail,
  getLatestCompletedPaymentLinkByEmail
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
const PORT = process.env.PORT || 8000;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const PAPERS_STORE_PATH = path.join(DATA_DIR, 'saved-papers.json');
const ANALYTICS_STORE_PATH = path.join(DATA_DIR, 'weak-areas.json');
const TEMP_CUSTOM_QUESTIONS_PATH = path.join(DATA_DIR, 'temp-custom-questions.json');
const ROADMAP_INTAKES_STORE_PATH = path.join(DATA_DIR, 'roadmap-intakes.json');
const ROADMAPS_STORE_PATH = path.join(DATA_DIR, 'roadmaps.json');
const COURSE_RECOMMENDATIONS_STORE_PATH = path.join(DATA_DIR, 'course-recommendations.json');
const VOICE_ASSETS_STORE_PATH = path.join(DATA_DIR, 'voice-assets.json');
const PROJECT_SUBMISSIONS_STORE_PATH = path.join(DATA_DIR, 'project-submissions.json');
const PROJECT_CHECKS_STORE_PATH = path.join(DATA_DIR, 'project-checks.json');
const HOSTING_APPS_STORE_PATH = path.join(DATA_DIR, 'hosting-apps.json');
const HOSTING_TIERS_STORE_PATH = path.join(DATA_DIR, 'hosting-tiers.json');
const REWARD_EVENTS_STORE_PATH = path.join(DATA_DIR, 'reward-events.json');
const ABUSE_FLAGS_STORE_PATH = path.join(DATA_DIR, 'abuse-flags.json');
const CUSTOM_QUESTION_TTL_MS = 15 * 60 * 1000;
const FREE_MODE = String(process.env.FREE_MODE || 'true').toLowerCase() !== 'false';

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

function normalizeTextKey(value) {
  return String(value || '').trim().toLowerCase();
}

function getActiveCustomQuestions() {
  const all = readJsonStore(TEMP_CUSTOM_QUESTIONS_PATH, []);
  const now = Date.now();
  const active = all.filter(item => {
    const exp = new Date(item?.expiresAt || 0).getTime();
    return Number.isFinite(exp) && exp > now;
  });
  if (active.length !== all.length) {
    writeJsonStore(TEMP_CUSTOM_QUESTIONS_PATH, active);
  }
  return active;
}

function saveTemporaryCustomQuestion(entry) {
  const active = getActiveCustomQuestions();
  active.push(entry);
  writeJsonStore(TEMP_CUSTOM_QUESTIONS_PATH, active);
}

function appendTemporaryQuestionToChapter(chapter, item) {
  if (!chapter || !item) return;
  if (item.questionType === 'mcqs') {
    if (!Array.isArray(chapter.mcqs)) chapter.mcqs = [];
    chapter.mcqs.push({
      question: String(item.question?.en || ''),
      question_ur: String(item.question?.ur || ''),
      options: Array.isArray(item.question?.options) ? item.question.options : [],
      options_ur: Array.isArray(item.question?.options_ur) ? item.question.options_ur : [],
      correct: null,
      custom: true,
      temporary: true,
      expires_at: item.expiresAt
    });
    return;
  }
  if (item.questionType === 'short') {
    if (!Array.isArray(chapter.short_questions)) chapter.short_questions = [];
    if (!Array.isArray(chapter.short_questions_ur)) chapter.short_questions_ur = [];
    chapter.short_questions.push(String(item.question?.en || ''));
    chapter.short_questions_ur.push(String(item.question?.ur || ''));
    return;
  }
  if (item.questionType === 'long') {
    if (!Array.isArray(chapter.long_questions)) chapter.long_questions = [];
    if (!Array.isArray(chapter.long_questions_ur)) chapter.long_questions_ur = [];
    chapter.long_questions.push(String(item.question?.en || ''));
    chapter.long_questions_ur.push(String(item.question?.ur || ''));
  }
}

function applyTemporaryCustomQuestions(board, syllabusData) {
  if (!Array.isArray(syllabusData) || !syllabusData.length) return syllabusData;
  const active = getActiveCustomQuestions().filter(item => normalizeTextKey(item.board) === normalizeTextKey(board));
  if (!active.length) return syllabusData;

  active.forEach(item => {
    const classData = syllabusData.find(c => String(c.class) === String(item.className));
    if (!classData || !Array.isArray(classData.subjects)) return;

    const subject = classData.subjects.find(s => {
      const name = s.name?.en || s.name?.ur || s.name || '';
      return normalizeTextKey(name) === normalizeTextKey(item.subjectKey);
    });
    if (!subject || !Array.isArray(subject.chapters)) return;

    const chapter = subject.chapters.find(ch => {
      const cEn = ch.title?.en || ch.chapter?.en || (typeof ch.chapter === 'string' ? ch.chapter : '');
      const cUr = ch.title?.ur || ch.chapter?.ur || '';
      return normalizeTextKey(cEn) === normalizeTextKey(item.chapterKey) || normalizeTextKey(cUr) === normalizeTextKey(item.chapterKey);
    });
    if (!chapter) return;

    appendTemporaryQuestionToChapter(chapter, item);
  });

  return syllabusData;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/data/uploads', express.static(path.join(DATA_DIR, 'uploads')));
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
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return applyTemporaryCustomQuestions(safeBoard, parsed);
  } catch (error) {
    console.error(`Error loading ${board} board:`, error);
    return [];
  }
}

const TRANSFER_TTL_MS = 30 * 60 * 1000;
const transferStore = new Map();

function cleanupExpiredTransfers() {
  const now = Date.now();
  for (const [key, value] of transferStore.entries()) {
    if (!value || Number(value.expiresAt || 0) <= now) {
      transferStore.delete(key);
    }
  }
}

function saveTransferPayload(key, payload, ttlMs = TRANSFER_TTL_MS) {
  cleanupExpiredTransfers();
  if (!key || typeof key !== 'string') return false;
  transferStore.set(key, {
    payload,
    expiresAt: Date.now() + Math.max(30 * 1000, Number(ttlMs) || TRANSFER_TTL_MS)
  });
  return true;
}

function getTransferPayload(key) {
  cleanupExpiredTransfers();
  const entry = transferStore.get(key);
  if (!entry) return null;
  if (Number(entry.expiresAt || 0) <= Date.now()) {
    transferStore.delete(key);
    return null;
  }
  return entry.payload;
}

function hasUrduChars(text) {
  return /[\u0600-\u06FF]/.test(String(text || ''));
}

function normalizeLooseKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\-_.,:;'"`()[\]{}\\/|]+/g, '')
    .trim();
}

function deriveTopicsFromChapterTitle(chapterData) {
  const chapterObj = chapterData?.title || chapterData?.chapter || '';
  const titleEn = typeof chapterObj === 'object' ? String(chapterObj.en || '') : String(chapterObj || '');
  if (!titleEn) return [];

  const out = [];
  const bracketMatch = titleEn.match(/\(([^)]+)\)/);
  if (bracketMatch && bracketMatch[1]) {
    bracketMatch[1]
      .split(/,| and | & |\//i)
      .map(v => String(v || '').trim())
      .filter(Boolean)
      .forEach(v => out.push(v));
  }

  if (out.length === 0) {
    titleEn
      .split(/:|-|,| and | & |\//i)
      .map(v => String(v || '').trim())
      .filter(Boolean)
      .forEach(v => out.push(v));
  }

  const seen = new Set();
  return out
    .map(v => v.replace(/^chapter\s*\d+\s*:?/i, '').trim())
    .filter(Boolean)
    .filter(v => {
      const key = normalizeLooseKey(v);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12)
    .map(v => ({ topic: { en: v, ur: '' }, status: 'active' }));
}

function fallbackUrduText(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  const map = {
    what: 'کیا',
    why: 'کیوں',
    how: 'کیسے',
    define: 'تعریف کریں',
    explain: 'وضاحت کریں',
    describe: 'بیان کریں',
    disease: 'بیماری',
    human: 'انسان',
    humans: 'انسانوں',
    blood: 'خون',
    cell: 'خلیہ',
    cells: 'خلیات',
    system: 'نظام',
    function: 'فنکشن',
    process: 'عمل',
    importance: 'اہمیت'
  };
  const translated = normalized
    .split(/\s+/)
    .map((word) => {
      const key = word.replace(/[^a-zA-Z]/g, '').toLowerCase();
      return map[key] || word;
    })
    .join(' ');
  return translated === normalized ? `${normalized} (اردو)` : translated;
}

async function translateToUrdu(text) {
  const input = String(text || '').trim();
  if (!input) return '';
  const timeoutMs = 8000;
  const endpoints = [
    {
      url: 'https://translate.argosopentech.com/translate',
      body: { q: input, source: 'en', target: 'ur', format: 'text' },
      pick: (data) => String(data?.translatedText || '').trim()
    },
    {
      url: 'https://libretranslate.com/translate',
      body: { q: input, source: 'en', target: 'ur', format: 'text' },
      pick: (data) => String(data?.translatedText || '').trim()
    },
    {
      url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ur&dt=t&q=${encodeURIComponent(input)}`,
      method: 'GET',
      pick: (data) => Array.isArray(data?.[0]) ? data[0].map(item => String(item?.[0] || '')).join('').trim() : ''
    }
  ];

  for (const endpoint of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(endpoint.url, {
        method: endpoint.method || 'POST',
        headers: endpoint.method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
        body: endpoint.method === 'GET' ? undefined : JSON.stringify(endpoint.body),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) continue;
      const data = await response.json();
      const translated = endpoint.pick(data);
      if (translated && hasUrduChars(translated) && translated.toLowerCase() !== input.toLowerCase()) {
        return translated;
      }
    } catch {
      // Try next provider.
    }
  }

  return fallbackUrduText(input);
}

const REFERRAL_REQUIRED_PAID_USERS = 10;
const REFERRAL_FREE_PAPER_LIMIT = 2;
const DEMO_LIMIT = 2;
const QUIZ_DEMO_LIMIT = 2;
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
  return normalizeEmail(req.session?.userEmail || '');
}

function getUserEmailFromAnySource(req) {
  return normalizeEmail(
    req.session?.userEmail
    || req.body?.userEmail
    || req.query?.userEmail
    || req.headers['x-user-email']
    || ''
  );
}

function getPlanDurationDays(plan) {
  if (String(plan) === 'weekly_unlimited') return 14;
  return 30;
}

async function getFallbackActiveAccessByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const directSub = await getSubscriptionByEmail(normalized);
  if (directSub) return directSub;
  const latestCompletedPayment = await getLatestCompletedPaymentLinkByEmail(normalized);
  if (!latestCompletedPayment) return null;
  const plan = String(latestCompletedPayment.plan || '');
  const paidAtRaw = latestCompletedPayment.paid_at || latestCompletedPayment.created_at;
  const paidAt = new Date(paidAtRaw);
  if (!plan || Number.isNaN(paidAt.getTime())) return null;
  const expiresAt = new Date(paidAt.getTime() + (getPlanDurationDays(plan) * 24 * 60 * 60 * 1000));
  if (expiresAt < new Date()) return null;
  return {
    plan,
    books: JSON.parse(latestCompletedPayment.books || '[]'),
    expiresAt: expiresAt.toISOString()
  };
}

function getGuestQuizUserId(req) {
  const fromBody = String(req.body?.userId || req.query?.userId || '').trim();
  if (fromBody) return fromBody.startsWith('guest_') ? fromBody : `guest_${fromBody}`;
  const ip = String(req.ip || 'guest').replace(/[^a-zA-Z0-9_.:-]/g, '_');
  return `guest_${ip}`;
}

async function getQuizAccessState(req, consume = false) {
  if (req.session?.tempUnlimitedUntil && Date.now() < Number(req.session.tempUnlimitedUntil)) {
    return { allowed: true, unlimited: true, plan: 'temp_unlimited', count: 0, limit: 99999, remaining: 99999 };
  }

  const userEmail = normalizeEmail(req.session?.userEmail || '');
  if (userEmail) {
    const referral = await getReferralStatus(userEmail);
    if (referral?.unlocked) {
      return { allowed: true, unlimited: true, plan: 'referral_unlocked', count: 0, limit: 99999, remaining: 99999, referral };
    }
  }

  if (req.session?.userId) {
    const activeSub = await getSubscription(req.session.userId);
    if (activeSub) {
      return { allowed: true, unlimited: true, plan: activeSub.plan, count: 0, limit: 99999, remaining: 99999 };
    }
  }

  const usageKey = userEmail ? `${userEmail}_quiz_demo` : getGuestQuizUserId(req);
  const current = await getDemoUsage(usageKey);
  if (!consume) {
    return {
      allowed: current < QUIZ_DEMO_LIMIT,
      unlimited: false,
      plan: 'quiz_demo',
      count: current,
      limit: QUIZ_DEMO_LIMIT,
      remaining: Math.max(QUIZ_DEMO_LIMIT - current, 0)
    };
  }

  if (current >= QUIZ_DEMO_LIMIT) {
    return {
      allowed: false,
      unlimited: false,
      plan: 'quiz_demo',
      count: current,
      limit: QUIZ_DEMO_LIMIT,
      remaining: 0,
      paywall: true
    };
  }

  const count = await incrementDemoUsage(usageKey);
  return {
    allowed: true,
    unlimited: false,
    plan: 'quiz_demo',
    count,
    limit: QUIZ_DEMO_LIMIT,
    remaining: Math.max(QUIZ_DEMO_LIMIT - count, 0)
  };
}

function normalizeMcqItem(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    return {
      question: raw,
      questionUr: '',
      options: [],
      optionsUr: [],
      correctIndex: -1,
      explanation: 'No answer key is available for this MCQ.'
    };
  }

  const question = String(raw.question || raw.en || raw.text || '').trim();
  const questionUr = String(raw.question_ur || raw.ur || '').trim();
  const options = Array.isArray(raw.options) ? raw.options.map(o => String(o || '').trim()).filter(Boolean) : [];
  const optionsUr = Array.isArray(raw.options_ur) ? raw.options_ur.map(o => String(o || '').trim()) : [];

  let correctIndex = -1;
  if (Number.isInteger(raw.correct)) correctIndex = raw.correct;
  else if (Number.isInteger(raw.correctIndex)) correctIndex = raw.correctIndex;
  else if (typeof raw.answer === 'string' && options.length) {
    const ans = raw.answer.trim().toLowerCase();
    const idx = options.findIndex(o => String(o || '').trim().toLowerCase() === ans);
    if (idx >= 0) correctIndex = idx;
  }

  const explanation = String(raw.explanation || raw.reason || '').trim();
  if (!question && !questionUr) return null;

  return {
    question: question || questionUr,
    questionUr,
    options,
    optionsUr,
    correctIndex: correctIndex >= 0 && correctIndex < options.length ? correctIndex : -1,
    explanation: explanation || 'The selected option does not match the answer key for this MCQ.'
  };
}

function extractMcqsFromSource(src, out) {
  if (!src || typeof src !== 'object') return;
  const pools = [src.mcqs, src.mcqs_extended, src.mcq_pick_questions, src.objective_questions];
  pools.forEach(pool => {
    if (!Array.isArray(pool)) return;
    pool.forEach(item => {
      const mcq = normalizeMcqItem(item);
      if (mcq) out.push(mcq);
    });
  });
}

function pickRandomUnique(items, count) {
  const source = Array.isArray(items) ? items.slice() : [];
  for (let i = source.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [source[i], source[j]] = [source[j], source[i]];
  }
  const limit = Math.max(0, Math.min(Number(count) || source.length, source.length));
  return source.slice(0, limit);
}

function getActorKey(req) {
  const email = normalizeEmail(req.session?.userEmail || '');
  if (email) return email;
  const guestId = String(req.session?.userId || req.body?.userId || req.query?.userId || '').trim();
  if (guestId) return guestId.startsWith('guest_') ? guestId : `guest_${guestId}`;
  const ip = String(req.ip || 'guest').replace(/[^a-zA-Z0-9_.:-]/g, '_');
  return `guest_${ip}`;
}

function sanitizeRoadmapIntake(raw = {}) {
  const allowedLanguages = new Set(['en', 'ur', 'hi']);
  const language = String(raw.preferred_language || 'en').toLowerCase();
  return {
    career_goal: String(raw.career_goal || '').trim(),
    has_laptop: String(raw.has_laptop || '').toLowerCase() === 'yes' ? 'yes' : 'no',
    location_country: String(raw.location_country || '').trim(),
    location_city: String(raw.location_city || '').trim(),
    preferred_language: allowedLanguages.has(language) ? language : 'en',
    education_level: String(raw.education_level || '').trim(),
    current_skill_level: String(raw.current_skill_level || '').trim().toLowerCase(),
    weekly_hours_available: Math.max(1, Math.min(80, Number(raw.weekly_hours_available) || 6)),
    internet_quality: String(raw.internet_quality || '').trim().toLowerCase(),
    budget_level: String(raw.budget_level || '').trim().toLowerCase()
  };
}

function getGlobalLaptopLinks() {
  return [
    { name: 'Amazon Renewed Laptops', monthlyInfo: 'Use monthly installment options where available', url: 'https://www.amazon.com/s?k=renewed+laptop' },
    { name: 'Back Market (Refurbished)', monthlyInfo: 'Monthly payment options on selected products', url: 'https://www.backmarket.com/en-us/l/laptops/7f5f658f-9e0f-4f33-8d8f-6a3870d7b0e8' },
    { name: 'eBay Refurbished', monthlyInfo: 'Check seller financing and protection terms', url: 'https://www.ebay.com/b/Laptops-Netbooks/175672/bn_1648276' },
    { name: 'Best Buy Laptops', monthlyInfo: 'Installment plans based on region/card eligibility', url: 'https://www.bestbuy.com/site/laptops/all-laptops/pcmcat138500050001.c' },
    { name: 'Newegg Laptops', monthlyInfo: 'Monthly plans may be available through checkout partners', url: 'https://www.newegg.com/Laptops-Notebooks/SubCategory/ID-32' }
  ];
}

function localizeText(language, key, vars = {}) {
  const pack = {
    en: {
      title: `Roadmap for ${vars.goal || 'Your Goal'}`,
      intro: `This roadmap is generated in free mode for ${vars.goal || 'your career'} and optimized for ${vars.hours || 6} hours/week.`,
      milestone1: 'Build foundations with beginner-friendly free playlists.',
      milestone2: 'Create one project every 2 weeks and publish progress.',
      milestone3: 'Complete portfolio + project checks to unlock hosting rewards.',
      submitTip: 'Submit your project inside this platform for automated checking.',
      hostingReady: 'Hosting unlock requires score >= 75 and clean checks.'
    },
    ur: {
      title: `${vars.goal || 'آپ کے مقصد'} کے لئے روڈ میپ`,
      intro: `یہ روڈ میپ مفت موڈ میں تیار کیا گیا ہے اور ${vars.hours || 6} گھنٹے فی ہفتہ کے حساب سے بنایا گیا ہے۔`,
      milestone1: 'مفت اور آسان پلی لسٹس سے بنیادی چیزیں مکمل کریں۔',
      milestone2: 'ہر 2 ہفتے میں ایک پراجیکٹ بنائیں اور پیش رفت شائع کریں۔',
      milestone3: 'پورٹ فولیو مکمل کریں اور چیکس پاس کر کے ہوسٹنگ انعام حاصل کریں۔',
      submitTip: 'اپنا پراجیکٹ اسی پلیٹ فارم پر جمع کریں تاکہ خودکار چیک ہو سکے۔',
      hostingReady: 'ہوسٹنگ انلاک کے لئے اسکور 75 یا زیادہ ہونا ضروری ہے۔'
    },
    hi: {
      title: `${vars.goal || 'आपके लक्ष्य'} के लिए रोडमैप`,
      intro: `यह रोडमैप फ्री मोड में तैयार किया गया है और ${vars.hours || 6} घंटे/सप्ताह के हिसाब से है।`,
      milestone1: 'फ्री और आसान प्लेलिस्ट से बेसिक्स मजबूत करें।',
      milestone2: 'हर 2 हफ्ते में एक प्रोजेक्ट बनाएं और प्रोग्रेस दिखाएं।',
      milestone3: 'पोर्टफोलियो पूरा करें और चेक पास करके होस्टिंग रिवॉर्ड अनलॉक करें।',
      submitTip: 'ऑटोमेटेड चेक के लिए प्रोजेक्ट इसी वेबसाइट पर सबमिट करें।',
      hostingReady: 'होस्टिंग अनलॉक के लिए स्कोर 75+ जरूरी है।'
    }
  };
  const langPack = pack[language] || pack.en;
  return langPack[key] || pack.en[key] || '';
}

function buildFreeCourseRecommendations(goal = '', language = 'en', level = 'beginner') {
  const g = String(goal || '').toLowerCase();
  const webTrack = g.includes('web') || g.includes('developer') || g.includes('frontend') || g.includes('backend');
  const dataTrack = g.includes('data') || g.includes('ai') || g.includes('ml');
  const designTrack = g.includes('design') || g.includes('graphic') || g.includes('ui');
  const mobileTrack = g.includes('mobile') || g.includes('android') || g.includes('ios') || g.includes('flutter');

  const base = webTrack ? [
    { title: 'HTML & CSS Full Course', provider: 'freeCodeCamp', youtubeLink: 'https://www.youtube.com/watch?v=mU6anWqZJcc', duration: '6-8h' },
    { title: 'JavaScript Full Course', provider: 'Bro Code', youtubeLink: 'https://www.youtube.com/watch?v=lfmg-EJ8gm4', duration: '12h' },
    { title: 'React Course', provider: 'freeCodeCamp', youtubeLink: 'https://www.youtube.com/watch?v=bMknfKXIFA8', duration: '11h' },
    { title: 'Node.js & Express', provider: 'Traversy Media', youtubeLink: 'https://www.youtube.com/watch?v=Oe421EPjeBE', duration: '1.5h' }
  ] : dataTrack ? [
    { title: 'Python for Beginners', provider: 'Programming with Mosh', youtubeLink: 'https://www.youtube.com/watch?v=_uQrJ0TkZlc', duration: '6h' },
    { title: 'Data Analysis with Python', provider: 'freeCodeCamp', youtubeLink: 'https://www.youtube.com/watch?v=r-uOLxNrNk8', duration: '10h' },
    { title: 'Machine Learning Full Course', provider: 'freeCodeCamp', youtubeLink: 'https://www.youtube.com/watch?v=i_LwzRVP7bg', duration: '9h' }
  ] : designTrack ? [
    { title: 'Figma UI Design Full Course', provider: 'freeCodeCamp', youtubeLink: 'https://www.youtube.com/watch?v=jwCmIBJ8Jtc', duration: '4h' },
    { title: 'Graphic Design Basics', provider: 'Envato Tuts+', youtubeLink: 'https://www.youtube.com/watch?v=WONZVnlam6U', duration: '2h' },
    { title: 'Canva Tutorial', provider: 'Canva Official', youtubeLink: 'https://www.youtube.com/watch?v=un50Bs4BvDk', duration: '1h' }
  ] : mobileTrack ? [
    { title: 'Flutter Course', provider: 'freeCodeCamp', youtubeLink: 'https://www.youtube.com/watch?v=VPvVD8t02U8', duration: '12h' },
    { title: 'React Native Course', provider: 'Programming with Mosh', youtubeLink: 'https://www.youtube.com/watch?v=0-S5a0eXPoc', duration: '2h' },
    { title: 'Android Basics', provider: 'Google Developers', youtubeLink: 'https://www.youtube.com/watch?v=fis26HvvDII', duration: 'Playlist' }
  ] : [
    { title: 'Career Fundamentals', provider: 'freeCodeCamp', youtubeLink: 'https://www.youtube.com/@freecodecamp', duration: 'Playlist' },
    { title: 'Skill Building Playlist', provider: 'Traversy Media', youtubeLink: 'https://www.youtube.com/@TraversyMedia', duration: 'Playlist' },
    { title: 'Project Based Learning', provider: 'The Net Ninja', youtubeLink: 'https://www.youtube.com/@NetNinja', duration: 'Playlist' }
  ];

  return base.map(item => ({
    ...item,
    language,
    level,
    costType: 'free'
  }));
}

function buildRoadmapPayload(intake) {
  const goal = intake.career_goal || 'Career Growth';
  const courses = buildFreeCourseRecommendations(goal, intake.preferred_language, intake.current_skill_level || 'beginner');
  return {
    language: intake.preferred_language,
    freeMode: FREE_MODE,
    title: localizeText(intake.preferred_language, 'title', { goal }),
    intro: localizeText(intake.preferred_language, 'intro', { goal, hours: intake.weekly_hours_available }),
    learningPath: [
      localizeText(intake.preferred_language, 'milestone1'),
      localizeText(intake.preferred_language, 'milestone2'),
      localizeText(intake.preferred_language, 'milestone3')
    ],
    weeklyPlan: [
      { week: 'Week 1-2', focus: 'Foundations', targetHours: intake.weekly_hours_available, outcome: 'Complete first free course + notes' },
      { week: 'Week 3-4', focus: 'Core skills', targetHours: intake.weekly_hours_available, outcome: 'Build small project #1' },
      { week: 'Week 5-6', focus: 'Project depth', targetHours: intake.weekly_hours_available, outcome: 'Build project #2 + improve quality' },
      { week: 'Week 7-8', focus: 'Portfolio & checks', targetHours: intake.weekly_hours_available, outcome: 'Submit projects for website checks' }
    ],
    milestones: [
      { name: 'First Project', criteria: 'Publish a working project link' },
      { name: 'Quality Check Pass', criteria: 'Project score >= 75' },
      { name: 'Hosting Unlock', criteria: localizeText(intake.preferred_language, 'hostingReady') }
    ],
    courses,
    tips: [
      localizeText(intake.preferred_language, 'submitTip'),
      'All resources are free/free-tier for growth stage.',
      'Prefer YouTube playlists with subtitles if your language resource is limited.'
    ],
    laptopOptions: intake.has_laptop === 'no' ? getGlobalLaptopLinks() : []
  };
}

function findOrCreateHostingTier(level = 'free') {
  const tiers = readJsonStore(HOSTING_TIERS_STORE_PATH, []);
  let tier = tiers.find(t => t.level === level);
  if (!tier) {
    tier = level === 'reward_plus'
      ? { level: 'reward_plus', maxApps: 1, maxBuildMinutesMonthly: 500, maxRuntimeHoursMonthly: 120, maxStorageMb: 1024, maxBandwidthGbMonthly: 20, dailyProjectChecks: 8 }
      : { level: 'free', maxApps: 1, maxBuildMinutesMonthly: 150, maxRuntimeHoursMonthly: 40, maxStorageMb: 256, maxBandwidthGbMonthly: 5, dailyProjectChecks: 3 };
    tiers.push(tier);
    writeJsonStore(HOSTING_TIERS_STORE_PATH, tiers);
  }
  return tier;
}

function getActorTier(actorKey) {
  const rewards = readJsonStore(REWARD_EVENTS_STORE_PATH, []);
  const unlocked = rewards.some(r => r.actorKey === actorKey && r.type === 'hosting_upgrade' && r.toTier === 'reward_plus');
  return findOrCreateHostingTier(unlocked ? 'reward_plus' : 'free');
}

function getTodayProjectCheckCount(actorKey) {
  const checks = readJsonStore(PROJECT_CHECKS_STORE_PATH, []);
  const today = new Date().toISOString().slice(0, 10);
  return checks.filter(c => c.actorKey === actorKey && String(c.createdAt || '').startsWith(today)).length;
}

function runLightweightProjectChecks(submission) {
  const checks = [];
  let score = 40;
  if (submission.repoUrl) { checks.push({ name: 'Repo URL provided', passed: true, weight: 15 }); score += 15; }
  else checks.push({ name: 'Repo URL provided', passed: false, weight: 15 });
  if (submission.liveUrl) { checks.push({ name: 'Live URL provided', passed: true, weight: 15 }); score += 15; }
  else checks.push({ name: 'Live URL provided', passed: false, weight: 15 });
  if (submission.notes.length >= 60) { checks.push({ name: 'Project notes quality', passed: true, weight: 15 }); score += 15; }
  else checks.push({ name: 'Project notes quality', passed: false, weight: 15 });
  if (/github\.com|gitlab\.com/i.test(submission.repoUrl || '')) { checks.push({ name: 'Valid source host', passed: true, weight: 10 }); score += 10; }
  else checks.push({ name: 'Valid source host', passed: false, weight: 10 });
  score = Math.max(0, Math.min(100, score));
  return {
    score,
    verdict: score >= 75 ? 'pass' : 'fail',
    checks,
    summary: score >= 75
      ? 'Great project quality for free-growth stage. Eligible for hosting unlock.'
      : 'Improve repo quality, add better notes, and provide a live demo to pass.'
  };
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
    let sub = null;
    if (req.session.userId) {
      sub = await getSubscription(req.session.userId);
    }
    if (!sub) {
      const emailFallback = getUserEmailFromAnySource(req);
      if (emailFallback) sub = await getFallbackActiveAccessByEmail(emailFallback);
    }
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
    const userEmail = getUserEmailFromAnySource(req);
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
    const normalizedTransactionId = String(req.body?.transactionId || '').trim().toUpperCase();
    const screenshot = req.file;

    if (!normalizedTransactionId || normalizedTransactionId.length < 6 || normalizedTransactionId.length > 64) {
      return res.status(400).json({ success: false, error: 'Valid transaction ID required' });
    }
    if (!/^[A-Z0-9_-]+$/.test(normalizedTransactionId)) {
      return res.status(400).json({ success: false, error: 'Transaction ID format is invalid' });
    }

    if (!screenshot) {
      return res.status(400).json({ success: false, error: 'Payment screenshot required' });
    }

    // 1️⃣ Check transaction ID uniqueness (prevent receipt reuse)
    const existing = await findPaymentByTransactionId(normalizedTransactionId);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Transaction ID already used. Each payment must be unique.' });
    }

    const verification = await verifyPaymentLink(linkId);
    if (!verification.valid) {
      return res.status(400).json({ success: false, error: verification.error });
    }
    if (verification.link.status !== 'pending_payment') {
      return res.status(400).json({ success: false, error: 'Payment proof already submitted or link not payable' });
    }

    await submitPaymentProof(linkId, normalizedTransactionId, screenshot.filename);
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
    const userEmail = getUserEmailFromAnySource(req);
    const isGuest = userId.startsWith('guest_') || userId === 'guest';
    if (!userEmail && isGuest) {
      const count = await incrementDemoUsage(userId);
      return res.json({ count, limit: DEMO_LIMIT });
    }
    if (!userEmail) return res.status(401).json({ error: 'Session expired' });
    if (req.session?.tempUnlimitedUntil && Date.now() < Number(req.session.tempUnlimitedUntil)) {
      return res.json({ count: 0, limit: 99999, unlimited: true, plan: 'temp_unlimited' });
    }
    const referral = await getReferralStatus(userEmail);
    if (referral?.unlocked) {
      return res.json({ count: 0, limit: 99999, unlimited: true, plan: 'referral_unlocked', referral });
    }
    let activeSub = null;
    if (req.session?.userId) {
      activeSub = await getSubscription(req.session.userId);
    }
    if (!activeSub) {
      activeSub = await getFallbackActiveAccessByEmail(userEmail);
    }
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
    const userEmail = getUserEmailFromAnySource(req);
    const isGuest = userId.startsWith('guest_') || userId === 'guest';
    if (!userEmail && isGuest) {
      const count = await getDemoUsage(userId);
      return res.json({ count, limit: DEMO_LIMIT });
    }
    if (!userEmail) return res.json({ count: 0, limit: DEMO_LIMIT, error: 'Please login' });
    if (req.session?.tempUnlimitedUntil && Date.now() < Number(req.session.tempUnlimitedUntil)) {
      return res.json({ count: 0, limit: 99999, unlimited: true, plan: 'temp_unlimited' });
    }
    const referral = await getReferralStatus(userEmail);
    if (referral?.unlocked) return res.json({ count: 0, limit: 99999, unlimited: true, plan: 'referral_unlocked', referral });
    let activeSub = null;
    if (req.session?.userId) {
      activeSub = await getSubscription(req.session.userId);
    }
    if (!activeSub) {
      activeSub = await getFallbackActiveAccessByEmail(userEmail);
    }
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
      const chapterObj = ch.title || ch.chapter || '';
      const nameEn = typeof chapterObj === 'object' ? (chapterObj.en || '') : String(chapterObj || '');
      const nameUr = typeof chapterObj === 'object' ? (chapterObj.ur || '') : '';
      const currentEn = String(nameEn || '').toLowerCase().trim();
      const currentUr = String(nameUr || '').toLowerCase().trim();
      const currentEnLoose = normalizeLooseKey(currentEn);
      const currentUrLoose = normalizeLooseKey(currentUr);
      const decodedLoose = normalizeLooseKey(decodedChapter);
      return currentEn === decodedChapter
        || currentUr === decodedChapter
        || (decodedLoose && (currentEnLoose === decodedLoose || currentUrLoose === decodedLoose));
    });
    if (!chapterData) return res.json([]);

    let topics = Array.isArray(chapterData.topics) ? chapterData.topics
      .map((t) => {
        if (typeof t === 'string') {
          return {
            topic: { en: t, ur: '' },
            status: 'active'
          };
        }
        const rawTopic = t?.topic ?? t?.title ?? '';
        const topicObj = typeof rawTopic === 'object'
          ? { en: String(rawTopic.en || rawTopic.ur || '').trim(), ur: String(rawTopic.ur || '').trim() }
          : { en: String(rawTopic || '').trim(), ur: '' };
        if (!topicObj.en && !topicObj.ur) return null;
        return {
          topic: topicObj,
          status: String(t?.status || 'active').toLowerCase()
        };
      })
      .filter(Boolean) : [];

    if (topics.length === 0) {
      topics = deriveTopicsFromChapterTitle(chapterData);
    }

    res.json(topics);
  } catch {
    res.json([]);
  }
});

app.post('/api/transfer', (req, res) => {
  try {
    const key = String(req.body?.key || '').trim();
    const payload = req.body?.payload;
    if (!key || !payload || typeof payload !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid transfer payload' });
    }
    const saved = saveTransferPayload(key, payload, Number(req.body?.ttlMs) || TRANSFER_TTL_MS);
    if (!saved) return res.status(400).json({ success: false, error: 'Failed to store transfer payload' });
    return res.json({ success: true, key });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/transfer/:key', (req, res) => {
  const key = String(req.params?.key || '').trim();
  if (!key) return res.status(400).json({ success: false, error: 'Transfer key is required' });
  const payload = getTransferPayload(key);
  if (!payload) return res.status(404).json({ success: false, error: 'Transfer payload not found or expired' });
  return res.json({ success: true, payload });
});

app.post('/api/translate/urdu', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ success: false, error: 'Text is required' });
    const translatedText = await translateToUrdu(text);
    if (!translatedText) return res.status(502).json({ success: false, error: 'Translation failed' });
    return res.json({ success: true, translatedText });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/quiz/access', async (req, res) => {
  try {
    const access = await getQuizAccessState(req, false);
    return res.json({ success: true, access });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/quiz/mcqs', async (req, res) => {
  try {
    const access = await getQuizAccessState(req, true);
    if (!access.allowed) {
      return res.status(402).json({
        success: false,
        error: `Free quiz demo limit reached (${QUIZ_DEMO_LIMIT}). Please upgrade your plan.`,
        paywall: true,
        access
      });
    }

    const board = String(req.body?.board || '').trim().toLowerCase();
    const className = String(req.body?.className || '').trim();
    const requestedCount = Number(req.body?.count) || 20;
    const selections = Array.isArray(req.body?.selections) ? req.body.selections : [];

    if (!board || !className) {
      return res.status(400).json({ success: false, error: 'board and className are required' });
    }

    const data = loadBoardData(board);
    const classData = data.find(c => String(c.class) === String(className));
    if (!classData) return res.json({ success: true, questions: [], totalPool: 0 });

    const mcqPool = [];
    const normalize = (s) => String(s || '').trim().toLowerCase();

    selections.forEach(sel => {
      const subjectName = normalize(sel?.subject);
      const subject = (classData.subjects || []).find(s => normalize(s.name?.en || s.name?.ur || s.name) === subjectName);
      if (!subject) return;

      (sel.chapters || []).forEach(chapObj => {
        const chapTitleRaw = typeof chapObj === 'string' ? chapObj : (chapObj.title || chapObj);
        const chapTitle = typeof chapTitleRaw === 'object' ? (chapTitleRaw.en || chapTitleRaw.ur || '') : chapTitleRaw;
        const selectedTopics = (typeof chapObj === 'object' && Array.isArray(chapObj.topics)) ? chapObj.topics : [];

        const chapter = (subject.chapters || []).find(ch => {
          const cEn = ch.title?.en || ch.chapter?.en || (typeof ch.chapter === 'string' ? ch.chapter : '');
          const cUr = ch.title?.ur || ch.chapter?.ur || '';
          return normalize(cEn) === normalize(chapTitle) || normalize(cUr) === normalize(chapTitle);
        });
        if (!chapter) return;

        extractMcqsFromSource(chapter, mcqPool);

        if (Array.isArray(chapter.topics)) {
          chapter.topics.forEach(tp => {
            const topicName = tp.topic?.en || tp.topic?.ur || tp.topic || '';
            if (selectedTopics.length > 0 && !selectedTopics.some(t => normalize(t) === normalize(topicName))) return;
            extractMcqsFromSource(tp, mcqPool);
          });
        }
      });
    });

    const deduped = [];
    const seen = new Set();
    mcqPool.forEach(q => {
      const key = `${q.question}|${(q.options || []).join('|')}`.toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      deduped.push(q);
    });

    const questions = pickRandomUnique(deduped, requestedCount);
    return res.json({ success: true, questions, totalPool: deduped.length, access });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/user/subscription/lock-book', async (req, res) => {
  try {
    const fallbackEmail = getUserEmailFromAnySource(req);
    let userId = req.session?.userId || null;
    let userEmail = normalizeEmail(req.session?.userEmail || fallbackEmail || '');
    if (!userId && userEmail) {
      const user = await findUserByEmail(userEmail);
      if (user) userId = user.id;
    }
    if (!userId || !userEmail) {
      return res.status(401).json({ success: false, error: 'Please login' });
    }
    const book = String(req.body?.book || '').trim();
    if (!book) return res.status(400).json({ success: false, error: 'Book is required' });
    let sub = await getSubscription(userId);
    if (!sub) sub = await getFallbackActiveAccessByEmail(userEmail);
    if (!sub) return res.status(400).json({ success: false, error: 'No active subscription' });
    if (sub.plan !== 'monthly_specific') {
      return res.json({ success: true, message: 'Book lock not required for this plan', books: sub.books || [] });
    }
    const remainingDays = Math.max(1, Math.ceil((new Date(sub.expiresAt) - new Date()) / (1000 * 60 * 60 * 24)));
    await createOrUpdateSubscription(userId, userEmail, sub.plan, [book], remainingDays);
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

app.post('/api/roadmap/intake', (req, res) => {
  try {
    const actorKey = getActorKey(req);
    const intake = sanitizeRoadmapIntake(req.body || {});
    if (!intake.career_goal) {
      return res.status(400).json({ success: false, error: 'career_goal is required' });
    }
    if (!intake.location_country) {
      return res.status(400).json({ success: false, error: 'location_country is required' });
    }
    const intakes = readJsonStore(ROADMAP_INTAKES_STORE_PATH, []);
    const intakeId = crypto.randomBytes(10).toString('hex');
    const record = {
      intakeId,
      actorKey,
      intake,
      createdAt: new Date().toISOString(),
      freeMode: FREE_MODE
    };
    intakes.push(record);
    writeJsonStore(ROADMAP_INTAKES_STORE_PATH, intakes);
    return res.json({ success: true, intakeId, profile: intake, freeMode: FREE_MODE });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/roadmap/generate', (req, res) => {
  try {
    const actorKey = getActorKey(req);
    const intakeId = String(req.body?.intakeId || '').trim();
    if (!intakeId) return res.status(400).json({ success: false, error: 'intakeId is required' });
    const intakes = readJsonStore(ROADMAP_INTAKES_STORE_PATH, []);
    const source = intakes.find(i => i.intakeId === intakeId && i.actorKey === actorKey);
    if (!source) return res.status(404).json({ success: false, error: 'Intake not found' });

    const roadmapJson = buildRoadmapPayload(source.intake);
    const roadmaps = readJsonStore(ROADMAPS_STORE_PATH, []);
    const roadmapId = crypto.randomBytes(10).toString('hex');
    const record = {
      roadmapId,
      intakeId,
      actorKey,
      language: source.intake.preferred_language,
      model: FREE_MODE ? 'free-rule-engine-v1' : 'hybrid-model-v1',
      roadmap: roadmapJson,
      createdAt: new Date().toISOString()
    };
    roadmaps.push(record);
    writeJsonStore(ROADMAPS_STORE_PATH, roadmaps);
    return res.json({ success: true, roadmapId, roadmap: roadmapJson, freeMode: FREE_MODE });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/roadmap/:id', (req, res) => {
  try {
    const actorKey = getActorKey(req);
    const roadmapId = String(req.params?.id || '').trim();
    const roadmaps = readJsonStore(ROADMAPS_STORE_PATH, []);
    const record = roadmaps.find(r => r.roadmapId === roadmapId && r.actorKey === actorKey);
    if (!record) return res.status(404).json({ success: false, error: 'Roadmap not found' });
    return res.json({ success: true, roadmap: record.roadmap, roadmapId: record.roadmapId, language: record.language });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/courses/recommend', (req, res) => {
  try {
    const actorKey = getActorKey(req);
    const goal = String(req.body?.career_goal || '').trim();
    const language = String(req.body?.language || 'en').toLowerCase();
    const skillLevel = String(req.body?.skill_level || 'beginner').toLowerCase();
    if (!goal) return res.status(400).json({ success: false, error: 'career_goal is required' });
    const recommendations = buildFreeCourseRecommendations(goal, ['en', 'ur', 'hi'].includes(language) ? language : 'en', skillLevel);
    const rows = readJsonStore(COURSE_RECOMMENDATIONS_STORE_PATH, []);
    rows.push({
      id: crypto.randomBytes(8).toString('hex'),
      actorKey,
      goal,
      language,
      skillLevel,
      recommendations,
      createdAt: new Date().toISOString()
    });
    writeJsonStore(COURSE_RECOMMENDATIONS_STORE_PATH, rows);
    return res.json({ success: true, recommendations, freeOnly: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/voice/synthesize', (req, res) => {
  try {
    const actorKey = getActorKey(req);
    const text = String(req.body?.text || '').trim();
    const language = String(req.body?.language || 'en').toLowerCase();
    const voiceStyle = String(req.body?.voiceStyle || 'default');
    if (!text) return res.status(400).json({ success: false, error: 'text is required' });
    const hash = crypto.createHash('sha1').update(`${language}|${voiceStyle}|${text}`).digest('hex');
    const assets = readJsonStore(VOICE_ASSETS_STORE_PATH, []);
    let asset = assets.find(a => a.hash === hash && a.actorKey === actorKey);
    if (!asset) {
      asset = {
        assetId: crypto.randomBytes(8).toString('hex'),
        actorKey,
        hash,
        text,
        language,
        voiceStyle,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)).toISOString()
      };
      assets.push(asset);
      writeJsonStore(VOICE_ASSETS_STORE_PATH, assets);
    }
    return res.json({
      success: true,
      audioUrl: null,
      assetId: asset.assetId,
      useBrowserTTS: true,
      fallbackText: text
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/project/submit', (req, res) => {
  try {
    const actorKey = getActorKey(req);
    const roadmapId = String(req.body?.roadmapId || '').trim();
    const repoUrl = String(req.body?.repoUrl || '').trim();
    const liveUrl = String(req.body?.liveUrl || '').trim();
    const notes = String(req.body?.notes || '').trim();
    if (!roadmapId) return res.status(400).json({ success: false, error: 'roadmapId is required' });
    if (!repoUrl && !liveUrl) return res.status(400).json({ success: false, error: 'repoUrl or liveUrl is required' });

    const tier = getActorTier(actorKey);
    const dailyCount = getTodayProjectCheckCount(actorKey);
    if (dailyCount >= Number(tier.dailyProjectChecks || 3)) {
      return res.status(429).json({ success: false, error: 'Daily project-check limit reached for free mode' });
    }

    const submissions = readJsonStore(PROJECT_SUBMISSIONS_STORE_PATH, []);
    const checks = readJsonStore(PROJECT_CHECKS_STORE_PATH, []);
    const submissionId = crypto.randomBytes(10).toString('hex');
    const jobId = `job_${crypto.randomBytes(6).toString('hex')}`;
    const submission = {
      submissionId,
      actorKey,
      roadmapId,
      repoUrl,
      liveUrl,
      notes,
      createdAt: new Date().toISOString(),
      status: 'checked'
    };
    submissions.push(submission);
    const result = runLightweightProjectChecks(submission);
    checks.push({
      checkId: crypto.randomBytes(10).toString('hex'),
      submissionId,
      actorKey,
      jobId,
      status: 'completed',
      ...result,
      createdAt: new Date().toISOString()
    });
    writeJsonStore(PROJECT_SUBMISSIONS_STORE_PATH, submissions);
    writeJsonStore(PROJECT_CHECKS_STORE_PATH, checks);
    return res.json({ success: true, submissionId, jobId, status: 'completed' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/project/check/:submissionId', (req, res) => {
  try {
    const actorKey = getActorKey(req);
    const submissionId = String(req.params?.submissionId || '').trim();
    const checks = readJsonStore(PROJECT_CHECKS_STORE_PATH, []);
    const check = checks.find(c => c.submissionId === submissionId && c.actorKey === actorKey);
    if (!check) return res.status(404).json({ success: false, error: 'Check result not found' });
    return res.json({
      success: true,
      submissionId,
      status: check.status,
      score: check.score,
      verdict: check.verdict,
      summary: check.summary,
      checks: check.checks
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/hosting/provision', (req, res) => {
  try {
    const actorKey = getActorKey(req);
    const submissionId = String(req.body?.submissionId || '').trim();
    if (!submissionId) return res.status(400).json({ success: false, error: 'submissionId is required' });

    const checks = readJsonStore(PROJECT_CHECKS_STORE_PATH, []);
    const check = checks.find(c => c.submissionId === submissionId && c.actorKey === actorKey);
    if (!check) return res.status(404).json({ success: false, error: 'Project check not found' });
    if (check.verdict !== 'pass') return res.status(400).json({ success: false, error: 'Project must pass checks before hosting provision' });

    const apps = readJsonStore(HOSTING_APPS_STORE_PATH, []);
    const tier = getActorTier(actorKey);
    const activeApps = apps.filter(a => a.actorKey === actorKey && a.status === 'active');
    if (activeApps.length >= Number(tier.maxApps || 1)) {
      return res.status(400).json({ success: false, error: 'Free hosting limit reached: only 1 active app allowed' });
    }

    const appId = crypto.randomBytes(9).toString('hex');
    const appRecord = {
      appId,
      actorKey,
      submissionId,
      status: 'active',
      runtime: 'container-free-tier',
      sleepAfterIdleMinutes: 20,
      endpoint: `/hosting/app/${appId}`,
      limits: tier,
      createdAt: new Date().toISOString()
    };
    apps.push(appRecord);
    writeJsonStore(HOSTING_APPS_STORE_PATH, apps);
    return res.json({ success: true, app: appRecord, message: 'Free hosting provisioned (MVP simulated deployment)' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/hosting/apps', (req, res) => {
  try {
    const actorKey = getActorKey(req);
    const apps = readJsonStore(HOSTING_APPS_STORE_PATH, []).filter(a => a.actorKey === actorKey);
    const tier = getActorTier(actorKey);
    return res.json({ success: true, apps, tier, freeMode: FREE_MODE });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/hosting/reward-upgrade', (req, res) => {
  try {
    const actorKey = getActorKey(req);
    const submissionId = String(req.body?.submissionId || '').trim();
    if (!submissionId) return res.status(400).json({ success: false, error: 'submissionId is required' });
    const checks = readJsonStore(PROJECT_CHECKS_STORE_PATH, []);
    const check = checks.find(c => c.submissionId === submissionId && c.actorKey === actorKey);
    if (!check) return res.status(404).json({ success: false, error: 'Project check not found' });
    if (Number(check.score || 0) < 85) {
      return res.status(400).json({ success: false, error: 'Upgrade requires score >= 85' });
    }

    const rewards = readJsonStore(REWARD_EVENTS_STORE_PATH, []);
    const already = rewards.find(r => r.actorKey === actorKey && r.type === 'hosting_upgrade' && r.submissionId === submissionId);
    if (already) return res.json({ success: true, reward: already, message: 'Reward already granted' });
    const reward = {
      id: crypto.randomBytes(8).toString('hex'),
      actorKey,
      submissionId,
      type: 'hosting_upgrade',
      fromTier: 'free',
      toTier: 'reward_plus',
      createdAt: new Date().toISOString()
    };
    rewards.push(reward);
    writeJsonStore(REWARD_EVENTS_STORE_PATH, rewards);
    return res.json({ success: true, reward, tier: findOrCreateHostingTier('reward_plus') });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
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
    if (!['mcqs', 'short', 'long'].includes(String(questionType))) {
      return res.status(400).json({ success: false, error: 'Invalid question type' });
    }

    const safeBoard = board.trim().toLowerCase();
    const syllabusData = loadBoardData(safeBoard);
    const classData = syllabusData.find(c => c.class.toString() === className.toString());
    if (!classData) {
      return res.status(404).json({ success: false, error: 'Class not found' });
    }

    let selectionsArray = [];
    if (Array.isArray(selections)) {
      selectionsArray = selections;
    } else {
      try {
        selectionsArray = JSON.parse(String(selections || '[]'));
      } catch {
        try {
          selectionsArray = JSON.parse(decodeURIComponent(String(selections || '[]')));
        } catch {
          selectionsArray = [];
        }
      }
    }
    if (!Array.isArray(selectionsArray) || selectionsArray.length === 0) {
      return res.status(400).json({ success: false, error: 'No chapter selected' });
    }
    
    const firstSelection = selectionsArray[0];
    const subjectName = normalizeTextKey(firstSelection?.subject || '');
    const chapterTitle = typeof firstSelection.chapters[0] === 'string' 
      ? firstSelection.chapters[0] 
      : firstSelection.chapters[0].title;
    
    // Find subject and chapter
    const subject = classData.subjects.find(s => {
      const name = s.name?.en || s.name?.ur || s.name || '';
      return normalizeTextKey(name) === subjectName;
    });
    
    if (!subject) {
      return res.status(404).json({ success: false, error: 'Subject not found' });
    }
    
    const chapter = subject.chapters.find(ch => {
      const nameEn = typeof ch.chapter === 'object' ? ch.chapter.en : (ch.chapter || ch.title?.en || '');
      const nameUr = typeof ch.chapter === 'object' ? ch.chapter.ur : (ch.title?.ur || '');
      const target = normalizeTextKey(typeof chapterTitle === 'object' ? (chapterTitle.en || chapterTitle.ur || '') : chapterTitle);
      return normalizeTextKey(nameEn) === target || normalizeTextKey(nameUr) === target;
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
    
    const normalizedQuestion = {
      en: normalizedQuestionEn || '',
      ur: normalizedQuestionUr || ''
    };

    if (questionType === 'mcqs') {
      normalizedQuestion.options = Array.isArray(question.options)
        ? question.options.map(v => String(v || '').trim()).filter(Boolean)
        : [];
      normalizedQuestion.options_ur = hasEnglish && hasUrdu
        ? (Array.isArray(question.options_ur) && question.options_ur.length
          ? question.options_ur.map(v => String(v || '').trim())
          : normalizedQuestion.options.slice())
        : (Array.isArray(question.options_ur) ? question.options_ur.map(v => String(v || '').trim()) : []);
    }

    const chapterNameEn = typeof chapter.chapter === 'object'
      ? (chapter.chapter.en || '')
      : (chapter.chapter || chapter.title?.en || '');
    const chapterNameUr = typeof chapter.chapter === 'object'
      ? (chapter.chapter.ur || '')
      : (chapter.title?.ur || '');

    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + CUSTOM_QUESTION_TTL_MS).toISOString();
    const tempEntry = {
      id: crypto.randomBytes(8).toString('hex'),
      board: safeBoard,
      className: String(className),
      subjectKey: subjectName,
      chapterKey: normalizeTextKey(chapterNameEn || chapterNameUr),
      questionType,
      question: normalizedQuestion,
      createdAt,
      expiresAt
    };
    saveTemporaryCustomQuestion(tempEntry);

    res.json({
      success: true,
      message: 'Question added successfully. It will auto-remove after 15 minutes.',
      temporary: true,
      expiresAt
    });
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
app.get('/quiz', (req, res) => res.render('quiz'));
app.get('/courses', (req, res) => res.render('Courses'));
app.get('/roadmap', (req, res) => res.render('roadmap'));
app.get('/roadmap/', (req, res) => res.render('roadmap'));
app.get('/ans', (req, res) => res.render('answer'));
app.get('/ai-mentor', (req, res) => res.render('ai-mentor'));
app.get('/pricing', (req, res) => res.render('pricing'));

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
