import crypto from 'crypto';
import { savePaymentLink, getPaymentLink, updatePaymentLink } from './database.js';

/**
 * ⚠️ SECURITY WARNING ⚠️
 * 
 * This is a MANUAL VERIFICATION system, NOT a fully secure payment gateway.
 * 
 * Known Limitations:
 * - Transaction IDs can be faked (no bank API verification)
 * - Screenshots can be Photoshopped
 * - No automatic confirmation from EasyPaisa/JazzCash
 * - Requires manual admin review (not scalable)
 * - Users could reuse someone else's receipt
 * 
 * This system is ACCEPTABLE for:
 * - Small startups with low transaction volume
 * - Manual EasyPaisa/JazzCash payments
 * - When you personally review each payment
 * 
 * You MUST upgrade to real gateway (EasyPaisa API/JazzCash API/Stripe) when:
 * - Transaction volume grows
 * - You need instant auto-activation
 * - You want fraud protection
 * - You need to scale
 * 
 * See PAYMENT_SECURITY_WARNING.md for full details.
 */

const SECRET_KEY = process.env.PAYMENT_SECRET || process.env.SESSION_SECRET || 'paperify-dev-payment-secret';

export async function createPaymentLink(userEmail, plan, amount, books = []) {
  const linkId = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  
  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(`${linkId}:${userEmail}:${plan}:${amount}`)
    .digest('hex');

  await savePaymentLink({
    linkId,
    userEmail,
    plan,
    amount,
    books,
    signature,
    status: 'pending_payment',
    expiresAt: expiresAt.toISOString()
  });

  return linkId;
}

export async function verifyPaymentLink(linkId) {
  const link = await getPaymentLink(linkId);
  
  if (!link) return { valid: false, error: 'Invalid payment link' };
  if (new Date(link.expires_at) < new Date()) return { valid: false, error: 'Payment link expired' };
  if (link.status === 'completed') return { valid: false, error: 'Payment already processed' };

  const expectedSig = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(`${link.link_id}:${link.user_email}:${link.plan}:${link.amount}`)
    .digest('hex');

  if (link.signature !== expectedSig) return { valid: false, error: 'Invalid signature - security check failed' };

  return { 
    valid: true, 
    link: {
      linkId: link.link_id,
      userEmail: link.user_email,
      plan: link.plan,
      amount: link.amount,
      books: JSON.parse(link.books || '[]'),
      expiresAt: link.expires_at,
      status: link.status
    }
  };
}

export async function submitPaymentProof(linkId, transactionId, screenshotPath) {
  await updatePaymentLink(linkId, 'pending_verification', new Date().toISOString(), transactionId, screenshotPath);
  return true;
}

export async function markPaymentComplete(linkId) {
  await updatePaymentLink(linkId, 'completed', new Date().toISOString());
  return true;
}

export async function activateSubscription(linkId) {
  const link = await getPaymentLink(linkId);
  
  if (!link || link.status !== 'completed') return null;

  const durationDays = link.plan === 'weekly_unlimited' ? 14 : 30;
  const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

  return {
    userEmail: link.user_email,
    plan: link.plan,
    books: JSON.parse(link.books || '[]'),
    expiresAt: expiresAt.toISOString()
  };
}
