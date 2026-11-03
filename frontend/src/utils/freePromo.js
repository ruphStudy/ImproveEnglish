// Display/flow helpers for the free (100%) promo on BuyPlan. The backend stays
// authoritative: nothing here decides a price, it only decides what to show
// and which existing endpoint to call.

/** Is `days` one of the plan lengths the applied code covers (null = all)? */
export function isPlanEligible(promo, days) {
  if (!promo) return false;
  return !promo.applicableDurations || promo.applicableDurations.includes(Number(days));
}

/** 'free' only when the server quoted ₹0 for exactly the selected plan. */
export function checkoutMode(promo, selectedDays) {
  return promo && promo.isFree && promo.planDuration === Number(selectedDays) ? 'free' : 'paid';
}

/** What happens to an applied code when a form field changes. */
export function promoResetAction(field) {
  if (['phone', 'country', 'level'].includes(field)) return 'clear';
  if (field === 'planDuration') return 'revalidate';
  return null;
}

/** Body for POST /api/payments/activate-free - deliberately carries no amount. */
export function buildFreeActivationPayload(formData, promo, timezone) {
  const { name, phone, country, level, planDuration } = formData;
  const email = String(formData.email || '').trim();
  // Email is optional for free activation: omitted when blank, never a placeholder.
  return { name, phone, country, ...(email ? { email } : {}), level, planDuration, promoCode: promo.code, timezone };
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Error message for the email field, or '' when acceptable. Mirrors the backend check. */
export function checkEmail(value, { required }) {
  const email = String(value || '').trim();
  if (!email) return required ? 'Please enter your email address' : '';
  return email.length <= 254 && EMAIL_SHAPE.test(email) ? '' : 'Please enter a valid email address';
}

const FRIENDLY_ERRORS = [
  [/expired/i, 'This promo code has expired.'],
  [/usage limit|fully used/i, 'This promo code has been fully used.'],
  [/already used/i, 'This WhatsApp number has already used this promo code.'],
  [/not valid for .*plan/i, 'This promo code is not valid for the selected plan.'],
  [/not valid for .*level/i, 'This promo code is not valid for the selected level.'],
  [/valid from/i, 'This promo code is not active yet.'],
  [/new learners|already has an account/i, 'Free access is for new learners only. This WhatsApp number already has an account.'],
  [/too many/i, 'Too many attempts. Please wait a few minutes and try again.'],
  [/whatsapp number/i, 'Please check your WhatsApp number and country, then apply the code again.']
];

/** Specific, friendly promo error that keeps the paid option visible. */
export function friendlyPromoError(message) {
  const match = FRIENDLY_ERRORS.find(([re]) => re.test(String(message || '')));
  const text = match ? match[1] : 'This promo code is not valid. Please check the code.';
  return `${text} You can still continue with regular payment.`;
}

/** Runs `fn` unless a run is already in progress (blocks double submits before re-render). */
export async function runExclusive(ref, fn) {
  if (ref.current) return false;
  ref.current = true;
  try {
    await fn();
    return true;
  } finally {
    ref.current = false;
  }
}

import { nextLocalSevenAm, timezoneCity } from './timezone.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const isLocalSchedule = (timezone, localScheduling) => localScheduling && !!timezone && timezone !== 'Asia/Kolkata';

/**
 * When the first daily lesson notification is scheduled: next 7:00 AM in the
 * learner's zone when the backend schedules locally, otherwise 7:00 AM India time.
 */
export function nextLessonDelivery(now = new Date(), timezone, localScheduling = false) {
  if (isLocalSchedule(timezone, localScheduling)) return nextLocalSevenAm(now, timezone);
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  let next = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 7, 0) - IST_OFFSET_MS;
  if (next <= now.getTime()) next += 24 * 60 * 60 * 1000;
  return new Date(next);
}

const DELIVERY_FORMAT = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };

/** Scheduled time in the learner's zone (local scheduling), or India time plus the local equivalent. */
export function formatLessonDelivery(date, timezone, localScheduling = false) {
  if (isLocalSchedule(timezone, localScheduling)) {
    return `${date.toLocaleString('en-IN', { timeZone: timezone, ...DELIVERY_FORMAT })} (${timezoneCity(timezone)} time)`;
  }
  const india = `${date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', ...DELIVERY_FORMAT })} (India time)`;
  if (!timezone || timezone === 'Asia/Kolkata') return india;
  const city = timezone.split('/').pop().replace(/_/g, ' ');
  return `${india} = ${date.toLocaleString('en-IN', { timeZone: timezone, ...DELIVERY_FORMAT })} (${city} time)`;
}

export function levelLabel(level) {
  const s = String(level || 'beginner');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Success-screen wording for the activation's welcomeStatus. "accepted" means
 * WhatsApp accepted the message, not that it was delivered, so nothing here
 * ever says "delivered" - and skipped/failed never claim a message was sent.
 */
export function welcomeNotice(status, { phone, firstLesson }) {
  const lesson = `Your first lesson notification is scheduled for ${firstLesson}.`;
  switch (status) {
    case 'accepted':
      return {
        tone: 'success',
        title: 'Welcome message on its way',
        text: `WhatsApp has accepted our welcome message for ${phone}. It usually arrives within a few minutes. ${lesson}`
      };
    case 'failed':
      return {
        tone: 'warning',
        title: 'Welcome message could not be sent',
        text: `We could not send a WhatsApp welcome message right now, but your plan is active. ${lesson}`
      };
    case 'not_sent':
      return {
        tone: 'info',
        title: 'No welcome message yet',
        text: `We have not sent a WhatsApp welcome message. You do not need one to start. ${lesson}`
      };
    default:
      return {
        tone: 'info',
        title: 'Welcome message not confirmed',
        text: `We cannot confirm a WhatsApp welcome message yet. Your plan is active. ${lesson}`
      };
  }
}
