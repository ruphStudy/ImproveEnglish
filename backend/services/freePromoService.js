const User = require('../models/User');
const PromoCode = require('../models/PromoCode');
const PlanMaster = require('../models/PlanMaster');
const FreeActivation = require('../models/FreeActivation');
const Log = require('../models/Log');
const { validatePromoCode } = require('./promoService');
const { computeExtendedExpiry } = require('./paymentProcessingService');
const { sendTemplateMessage } = require('./whatsappService');

// Same mapping as paymentController's LEVEL_MAP (PlanMaster stores these spellings)
const LEVEL_MAP = { beginner: 'bigenner', intermediate: 'intermidiate', advanced: 'advance' };
const STALE_RESERVATION_MINUTES = 15;

/**
 * Free-beta activation without multi-document transactions. Consistency comes from:
 *  1. FreeActivation unique {promoCode, phone}: one activation doc per phone+code,
 *     shared by retries and concurrent requests.
 *  2. A single atomic conditional update on the PromoCode doc that both checks
 *     (expiry, global cap, per-phone cap, plan/level) and reserves a slot,
 *     guarded by usedBy.freeActivationId so one activation reserves at most once.
 *  3. User.phone unique + user.freeActivationId, so a retry recognises the user
 *     it created and never touches a pre-existing learner.
 *  4. A reserved -> activated conditional transition, so side effects (log,
 *     event, WhatsApp) run exactly once.
 * A crash between steps leaves status 'reserved'; a retry resumes it, and
 * reconcileStaleFreeActivations() finalises or releases abandoned ones.
 */

async function getPlanPriceInr(level, planDuration) {
  if (!LEVEL_MAP[level]) return null;
  const days = Number(planDuration);
  if (!Number.isInteger(days) || days <= 0) return null;
  const plan = await PlanMaster.findOne({ level: LEVEL_MAP[level], days });
  return plan ? plan.price : null;
}

function isFreePromoDoc(promo) {
  return promo && promo.discountType === 'percentage' && promo.discountValue === 100 && !promo.maxDiscount;
}

/**
 * Server-side quote - price always from PlanMaster, never from the client.
 * Returns { ok, status, message, originalAmount, discountAmount, finalAmount, isFree }.
 */
async function quotePromo({ code, phone, level, planDuration }) {
  if (!code || typeof code !== 'string') return { ok: false, status: 400, message: 'Promo code is required' };
  const price = await getPlanPriceInr(level, planDuration);
  if (price === null) return { ok: false, status: 400, message: 'Selected plan is not available' };

  const result = await validatePromoCode(code, null, price, level, Number(planDuration), phone);
  if (!result.valid) {
    return { ok: false, status: 400, message: result.message || 'Invalid promo code', originalAmount: price, finalAmount: price };
  }

  const promo = await PromoCode.findOne({ code: result.code });
  const isFree = isFreePromoDoc(promo) && result.finalAmount === 0;
  if (isFree && await User.exists({ phone })) {
    return { ok: false, status: 409, message: 'Free beta access is for new learners only. This WhatsApp number already has an account.', originalAmount: price, finalAmount: price };
  }

  return {
    ok: true,
    status: 200,
    code: result.code,
    originalAmount: price,
    discountAmount: result.discountAmount,
    finalAmount: result.finalAmount,
    isFree,
    description: result.description,
    // Plan lengths the code covers (null = all) - lets the page mark eligible plans.
    applicableDurations: promo && promo.applicableDurations && promo.applicableDurations.length
      ? promo.applicableDurations.map(Number)
      : null
  };
}

async function releaseSlot(code, activationId) {
  // Conditional on the entry existing, so a slot is never released twice.
  await PromoCode.updateOne(
    { code, 'usedBy.freeActivationId': activationId },
    { $pull: { usedBy: { freeActivationId: activationId } }, $inc: { currentUses: -1 } }
  );
}

async function reject(activation, reason, status, message, { release = false } = {}) {
  if (release) await releaseSlot(activation.promoCode, activation._id);
  await FreeActivation.updateOne(
    { _id: activation._id, status: { $ne: 'activated' } },
    { $set: { status: 'rejected', rejectReason: reason } }
  );
  return { ok: false, status, message, reason };
}

async function reserveSlot(activation, now) {
  const { promoCode: code, phone, level, planDuration, listPriceInr, name, _id } = activation;
  const reserved = await PromoCode.findOneAndUpdate(
    {
      code,
      isActive: true,
      discountType: 'percentage',
      discountValue: 100,
      validFrom: { $lte: now },
      'usedBy.freeActivationId': { $ne: _id },
      $and: [
        { $or: [{ validUntil: null }, { validUntil: { $gt: now } }] },
        { $or: [{ maxUses: null }, { maxUses: 0 }, { $expr: { $lt: ['$currentUses', '$maxUses'] } }] },
        { $expr: { $lt: [{ $size: { $filter: { input: { $ifNull: ['$usedBy', []] }, cond: { $eq: ['$$this.userPhone', phone] } } } }, { $ifNull: ['$perUserLimit', 1] }] } },
        { $or: [{ applicableLevels: { $exists: false } }, { applicableLevels: { $size: 0 } }, { applicableLevels: level }] },
        { $or: [{ applicableDurations: { $exists: false } }, { applicableDurations: { $size: 0 } }, { applicableDurations: planDuration }] }
      ]
    },
    {
      $inc: { currentUses: 1 },
      $push: {
        usedBy: {
          userId: null,
          userName: name,
          userPhone: phone,
          usedAt: now,
          orderAmount: listPriceInr,
          discountAmount: listPriceInr,
          finalAmount: 0,
          freeActivationId: _id
        }
      }
    },
    { new: true }
  );
  if (reserved) return true;
  // Already reserved by this same activation (retry / concurrent duplicate)?
  return !!(await PromoCode.exists({ code, 'usedBy.freeActivationId': _id }));
}

async function sendFreeWelcome(activation, user) {
  // FREE_PROMO welcome only (e.g. subscription_welcome); paid flows use payment_welcome_new.
  const template = (process.env.WHATSAPP_FREE_WELCOME_TEMPLATE || '').trim();
  if (!template) {
    // No approved free-beta template yet - deliberately send nothing rather
    // than the paid "payment_welcome_new" wording.
    await FreeActivation.updateOne({ _id: activation._id }, { $set: { welcomeStatus: 'skipped_no_template' } });
    return 'skipped_no_template';
  }
  try {
    const response = await sendTemplateMessage(
      user.phone,
      template,
      [user.name || 'Learner', String(activation.planDuration), activation.level, user.expiryDate.toISOString().split('T')[0]],
      process.env.WHATSAPP_FREE_WELCOME_TEMPLATE_LANG || 'en_US'
    );
    const messageId = response?.messages?.[0]?.id || null;
    await FreeActivation.updateOne({ _id: activation._id }, { $set: { welcomeStatus: 'sent', welcomeMessageId: messageId } });
    return 'sent';
  } catch (err) {
    // The subscription stays active - a failed notification never reverses it.
    const message = (err.response?.data?.error?.message || err.message || 'unknown error').slice(0, 200);
    await FreeActivation.updateOne({ _id: activation._id }, { $set: { welcomeStatus: 'failed', welcomeError: message } });
    await Log.create({
      type: 'FREE_PROMO_WELCOME_FAILED',
      userPhone: user.phone,
      message: `Free beta welcome template failed: ${message}`,
      status: 'ERROR',
      metadata: { activationId: String(activation._id) }
    }).catch(() => {});
    return 'failed';
  }
}

/** Creates the user for this activation, or recognises the one it already created. */
async function ensureUser(activation) {
  const findOwn = async () => {
    const existing = await User.findOne({ phone: activation.phone });
    if (!existing) return { user: null };
    return String(existing.freeActivationId || '') === String(activation._id) ? { user: existing } : { conflict: true };
  };

  const first = await findOwn();
  if (first.user || first.conflict) return first;

  try {
    const user = await User.create({
      name: activation.name,
      phone: activation.phone,
      email: activation.email,
      level: activation.level,
      isActive: true,
      state: 'READY', // picked up by the next 7 AM daily lesson run
      currentDay: 1,
      lessonText: '',
      lessonCompleted: false,
      expiryDate: computeExtendedExpiry(null, activation.planDuration),
      freeActivationId: activation._id
    });
    return { user };
  } catch (err) {
    if (err.code === 11000) return findOwn(); // concurrent create - resolve who owns it
    throw err;
  }
}

// Public (API) view of the stored welcome status. The Cloud API only tells us
// it ACCEPTED a message; delivery receipts are not processed, so delivery is
// never claimed. Error details stay server-side.
const PUBLIC_WELCOME_STATUS = {
  sent: 'accepted',
  skipped_no_template: 'not_sent',
  failed: 'failed',
  pending: 'pending'
};

function publicWelcomeStatus(welcomeStatus) {
  return PUBLIC_WELCOME_STATUS[welcomeStatus] || 'pending';
}

// Retries return the stored welcome status and never send a message - so
// already-activated learners are not messaged when a template is configured later.
function activatedResult(activation, alreadyActivated) {
  return {
    ok: true,
    status: 200,
    alreadyActivated,
    expiryDate: activation.expiryDate,
    level: activation.level,
    planDuration: activation.planDuration,
    welcomeStatus: activation.welcomeStatus || 'pending'
  };
}

/**
 * Activates a free-beta subscription. `phone` must already be normalized.
 * Safe to call repeatedly/concurrently for the same phone + code.
 */
async function activateFreePromo({ name, email, phone, level, planDuration, code }) {
  const promoCode = String(code || '').toUpperCase().trim();
  const days = Number(planDuration);

  // Idempotent replay of an already-completed activation (the user now exists,
  // so the new-learner check below would otherwise reject the retry).
  const done = await FreeActivation.findOne({ promoCode, phone, status: 'activated' });
  if (done) return activatedResult(done, true);

  const resuming = await FreeActivation.findOne({ promoCode, phone, status: 'reserved' });
  if (!resuming) {
    const quote = await quotePromo({ code: promoCode, phone, level, planDuration: days });
    if (!quote.ok || !quote.isFree) {
      // A concurrent request for this same phone may have already reserved the
      // slot / created the user, which makes the quote fail - join it instead.
      const inFlight = await FreeActivation.exists({ promoCode, phone, status: { $in: ['reserved', 'activated'] } });
      if (!inFlight) {
        return quote.ok
          ? { ok: false, status: 400, message: 'This code is not a free beta code. Please continue with regular payment.' }
          : quote;
      }
    } else {
      // Create (or, after a rejection, re-open) the single activation doc for this phone+code.
      const fields = { name, email, level, planDuration: days, listPriceInr: quote.originalAmount };
      try {
        await FreeActivation.create({ promoCode, phone, ...fields, status: 'reserved' });
      } catch (err) {
        if (err.code !== 11000) throw err;
        await FreeActivation.updateOne(
          { promoCode, phone, status: 'rejected' },
          { $set: { ...fields, status: 'reserved', rejectReason: null } }
        );
      }
    }
  }

  const activation = await FreeActivation.findOne({ promoCode, phone });
  if (activation.status === 'activated') return activatedResult(activation, true);
  if (activation.status !== 'reserved') {
    return { ok: false, status: 409, message: 'This promo code could not be applied. Please try again.' };
  }

  const now = new Date();
  if (!(await reserveSlot(activation, now))) {
    return reject(activation, 'promo_unavailable', 409, 'This promo code is no longer available (expired, fully redeemed, or not valid for this plan).');
  }

  // Heartbeat: refresh updatedAt right before creating the user. Reconcile only
  // releases reservations it can atomically claim while still stale, so it can
  // never release a slot that an in-flight request is about to use.
  const touched = await FreeActivation.updateOne(
    { _id: activation._id, status: 'reserved' },
    { $set: { updatedAt: new Date() } }
  );
  if (!touched.matchedCount) {
    const current = await FreeActivation.findById(activation._id);
    if (current && current.status === 'activated') return activatedResult(current, true);
    return { ok: false, status: 409, message: 'This activation expired. Please try again.' };
  }

  const { user, conflict } = await ensureUser(activation);
  if (conflict) {
    return reject(activation, 'existing_learner', 409, 'Free beta access is for new learners only. This WhatsApp number already has an account.', { release: true });
  }

  await PromoCode.updateOne(
    { code: promoCode, 'usedBy.freeActivationId': activation._id },
    { $set: { 'usedBy.$.userId': user._id } }
  );

  // Exactly one caller wins this transition and performs the side effects.
  const finalized = await FreeActivation.findOneAndUpdate(
    { _id: activation._id, status: 'reserved' },
    { $set: { status: 'activated', userId: user._id, expiryDate: user.expiryDate, activatedAt: new Date() } },
    { new: true }
  );
  if (!finalized) {
    const current = await FreeActivation.findById(activation._id);
    if (current && current.status === 'activated') return activatedResult(current, true);
    // Never report success for an activation that is no longer reserved/activated.
    return { ok: false, status: 409, message: 'This activation could not be completed. Please contact support.' };
  }

  await Log.create({
    type: 'FREE_PROMO_ACTIVATED',
    userPhone: user.phone,
    message: `Free beta activated with ${promoCode} (${finalized.planDuration} days, ${finalized.level})`,
    status: 'SUCCESS',
    metadata: { activationId: String(finalized._id), promoCode, listPriceInr: finalized.listPriceInr, amountPaid: 0 }
  }).catch(() => {});

  const { recordLearnerEvent } = require('./retentionService');
  await recordLearnerEvent(user._id, 'SUBSCRIPTION_ACTIVATED', {
    metadata: { planDuration: finalized.planDuration, level: finalized.level, source: 'FREE_PROMO' }
  });

  const welcomeStatus = await sendFreeWelcome(finalized, user);
  return { ...activatedResult(finalized, false), welcomeStatus };
}

/**
 * Recovery for reservations abandoned by a crash: if the user was created,
 * finish the activation (without re-sending anything); otherwise release the
 * promo slot and reject. Dry-run unless execute=true.
 */
async function reconcileStaleFreeActivations({ execute = false, olderThanMinutes = STALE_RESERVATION_MINUTES, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60 * 1000);
  const stale = await FreeActivation.find({ status: 'reserved', updatedAt: { $lt: cutoff } });
  const actions = [];

  for (const activation of stale) {
    const user = await User.findOne({ phone: activation.phone, freeActivationId: activation._id });
    if (user) {
      actions.push({ id: String(activation._id), action: 'finalize' });
      if (execute) {
        await PromoCode.updateOne(
          { code: activation.promoCode, 'usedBy.freeActivationId': activation._id },
          { $set: { 'usedBy.$.userId': user._id } }
        );
        await FreeActivation.updateOne(
          { _id: activation._id, status: 'reserved' },
          { $set: { status: 'activated', userId: user._id, expiryDate: user.expiryDate, activatedAt: now } }
        );
      }
    } else {
      actions.push({ id: String(activation._id), action: 'release' });
      if (execute) {
        // Claim atomically, and only while still stale: a request that touched it
        // (heartbeat) in the meantime keeps its reservation.
        const claimed = await FreeActivation.findOneAndUpdate(
          { _id: activation._id, status: 'reserved', updatedAt: { $lt: cutoff } },
          { $set: { status: 'rejected', rejectReason: 'abandoned_reservation' } },
          { new: true, timestamps: false }
        );
        if (!claimed) continue;
        const lateUser = await User.findOne({ phone: activation.phone, freeActivationId: activation._id });
        if (lateUser) {
          // A stalled request created the user after all - keep the slot and finalize.
          await FreeActivation.updateOne(
            { _id: activation._id },
            { $set: { status: 'activated', rejectReason: null, userId: lateUser._id, expiryDate: lateUser.expiryDate, activatedAt: now } }
          );
          await PromoCode.updateOne(
            { code: activation.promoCode, 'usedBy.freeActivationId': activation._id },
            { $set: { 'usedBy.$.userId': lateUser._id } }
          );
        } else {
          await releaseSlot(activation.promoCode, activation._id);
        }
      }
    }
  }
  return { stale: stale.length, actions, executed: execute };
}

module.exports = { quotePromo, activateFreePromo, reconcileStaleFreeActivations, getPlanPriceInr, isFreePromoDoc, publicWelcomeStatus };
