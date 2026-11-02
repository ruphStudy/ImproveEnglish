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
export function buildFreeActivationPayload(formData, promo) {
  const { name, phone, country, email, level, planDuration } = formData;
  return { name, phone, country, email, level, planDuration, promoCode: promo.code };
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

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Next 7:00 AM India time - when the daily lesson job sends lessons. */
export function nextLessonDelivery(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  let next = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 7, 0) - IST_OFFSET_MS;
  if (next <= now.getTime()) next += 24 * 60 * 60 * 1000;
  return new Date(next);
}

export function formatLessonDelivery(date) {
  return `${date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
  })} (India time)`;
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
  const lesson = `Your first lesson notification will arrive on WhatsApp at ${firstLesson}.`;
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
