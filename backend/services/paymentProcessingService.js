const User = require('../models/User');
const PendingOrder = require('../models/PendingOrder');
const PaymentHistory = require('../models/PaymentHistory');
const Log = require('../models/Log');
const { markPromoAsUsed } = require('./promoService');

/**
 * Extend from the existing expiry if it's still in the future, otherwise from now.
 */
function computeExtendedExpiry(existingExpiryDate, planDurationDays) {
  const now = new Date();
  const base = existingExpiryDate && existingExpiryDate > now ? new Date(existingExpiryDate) : now;
  const newExpiry = new Date(base);
  newExpiry.setDate(newExpiry.getDate() + planDurationDays);
  return newExpiry;
}

/**
 * Single source of truth for turning a successful Razorpay payment into
 * subscription/user state changes. Used by both the payment.captured webhook
 * and the Payment Link callback so a payment is processed exactly once
 * regardless of which one arrives first.
 *
 * Idempotency: the PendingOrder is atomically claimed via a findOneAndUpdate
 * that only matches status:'created'. Concurrent/duplicate calls for the same
 * order will fail the claim and are reported as alreadyProcessed instead of
 * re-running any side effect. PaymentHistory additionally has a unique index
 * on razorpayPaymentId as a second, persistent guard.
 */
async function processSuccessfulPayment({ pendingOrder, razorpayPaymentId, paymentMethod, amountPaidPaise }) {
  if (typeof amountPaidPaise === 'number' && amountPaidPaise !== pendingOrder.amountPaise) {
    await Log.create({
      type: 'PAYMENT_ERROR',
      userPhone: pendingOrder.phone,
      message: 'Amount mismatch in payment',
      status: 'ERROR',
      metadata: {
        pendingOrderId: pendingOrder._id.toString(),
        expected: pendingOrder.amountPaise,
        received: amountPaidPaise
      }
    });
    return { success: false, reason: 'AMOUNT_MISMATCH' };
  }

  // Atomic claim - only the first caller (webhook OR callback, whichever wins the race) proceeds
  const claimed = await PendingOrder.findOneAndUpdate(
    { _id: pendingOrder._id, status: 'created' },
    { $set: { status: 'processing', razorpayPaymentId } },
    { new: true }
  );

  if (!claimed) {
    const current = await PendingOrder.findById(pendingOrder._id).lean();
    return { success: true, alreadyProcessed: true, status: current ? current.status : null };
  }

  try {
    const existingUser = await User.findOne({ phone: claimed.phone });
    const isNewUser = !existingUser;

    // Crash/retry safety: if this exact Razorpay payment was already applied to this
    // user (e.g. the process died after user.save() but before PendingOrder reached
    // 'paid', and reconciliation later released the claim), skip re-mutating the user
    // entirely instead of extending expiry / resetting progress a second time.
    const alreadyAppliedToUser = !!existingUser && existingUser.lastAppliedPaymentId === razorpayPaymentId;

    let user, levelChanged, newExpiryDate;

    if (alreadyAppliedToUser) {
      user = existingUser;
      levelChanged = false;
      newExpiryDate = existingUser.expiryDate;
    } else {
      levelChanged = !!existingUser && existingUser.level !== claimed.level;
      newExpiryDate = computeExtendedExpiry(existingUser ? existingUser.expiryDate : null, claimed.planDuration);

      if (isNewUser) {
        user = new User({
          name: claimed.name,
          phone: claimed.phone,
          email: claimed.email,
          level: claimed.level,
          isActive: true,
          state: 'READY',
          currentDay: 1,
          lessonText: '',
          lessonCompleted: false,
          expiryDate: newExpiryDate,
          lastAppliedPaymentId: razorpayPaymentId
        });
      } else {
        existingUser.isActive = true;
        existingUser.expiryDate = newExpiryDate;
        existingUser.level = claimed.level;
        existingUser.name = claimed.name || existingUser.name;
        existingUser.email = claimed.email || existingUser.email;
        // Same level: preserve currentDay/state/progress. Different level: restart at Day 1.
        // Streak is never reset here either way.
        if (levelChanged) {
          existingUser.currentDay = 1;
          existingUser.state = 'READY';
          existingUser.lessonText = '';
          existingUser.lessonCompleted = false;
        }
        existingUser.sevenDayReminderSent = false;
        existingUser.threeDayReminderSent = false;
        existingUser.lastAppliedPaymentId = razorpayPaymentId;
        user = existingUser;
      }
      await user.save();
    }

    try {
      await PaymentHistory.create({
        userId: user._id,
        name: claimed.name,
        phone: claimed.phone,
        email: claimed.email,
        level: claimed.level,
        planDuration: claimed.planDuration,
        planName: `plan${claimed.planDuration}`,
        amountPaid: claimed.amountPaise / 100,
        promoCode: claimed.promoCode || null,
        originalAmount: claimed.originalAmountPaise ? claimed.originalAmountPaise / 100 : null,
        discountAmount: claimed.discountAmountPaise ? claimed.discountAmountPaise / 100 : 0,
        currency: 'INR',
        razorpayOrderId: claimed.razorpayOrderId,
        razorpayPaymentId,
        paymentMethod: paymentMethod || 'unknown',
        paymentStatus: 'success',
        expiryDate: newExpiryDate,
        utmSource: claimed.utmSource
      });
    } catch (phErr) {
      if (phErr.code !== 11000) throw phErr; // duplicate key = already recorded, safe to continue
    }

    if (claimed.promoCode) {
      try {
        await markPromoAsUsed(
          claimed.promoCode,
          user._id.toString(),
          user.name,
          user.phone,
          claimed.originalAmountPaise ? claimed.originalAmountPaise / 100 : claimed.amountPaise / 100,
          claimed.discountAmountPaise ? claimed.discountAmountPaise / 100 : 0,
          claimed.amountPaise / 100,
          claimed._id.toString()
        );
      } catch (promoErr) {
        console.error('⚠️ Promo consumption failed (non-fatal):', promoErr.message);
      }
    }

    claimed.status = 'paid';
    await claimed.save();

    await Log.create({
      type: 'PAYMENT_SUCCESS',
      userPhone: claimed.phone,
      message: isNewUser
        ? `User activated with ${claimed.planDuration}-day plan`
        : `Subscription extended by ${claimed.planDuration} days${levelChanged ? ` (level changed to ${claimed.level})` : ''}`,
      status: 'SUCCESS',
      metadata: {
        orderId: claimed.razorpayOrderId,
        paymentId: razorpayPaymentId,
        planDuration: claimed.planDuration,
        expiryDate: newExpiryDate,
        levelChanged,
        streakPreserved: user.streak
      }
    });

    return { success: true, alreadyProcessed: false, isNewUser, levelChanged, user, newExpiryDate };

  } catch (err) {
    // Release the claim so the next webhook/callback retry can safely reprocess
    await PendingOrder.updateOne(
      { _id: claimed._id, status: 'processing' },
      { $set: { status: 'created' } }
    ).catch(() => {});
    throw err;
  }
}

/**
 * Minimal reconciliation for PendingOrders stuck in 'processing' (e.g. the process
 * crashed mid-flight before the catch handler could revert them). Does not call
 * Razorpay.
 *
 * For each stuck order:
 *  - If a PaymentHistory record already exists for its razorpayPaymentId, processing
 *    had already completed its persistent side effects before the crash - finalize
 *    directly to 'paid' rather than releasing it (releasing would just cause a
 *    pointless full re-run; processSuccessfulPayment's per-step idempotency would
 *    no-op it anyway, but finalizing directly avoids that work).
 *  - Otherwise release it back to 'created'. This is safe: processSuccessfulPayment's
 *    user mutation is itself guarded by User.lastAppliedPaymentId and promo
 *    consumption by a per-order filter, so a replay cannot double-extend expiry,
 *    double-reset progress, or double-consume a promo code even if the crash
 *    happened after those steps had already run.
 */
async function reconcileStuckPendingOrders(maxAgeMinutes = 15) {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  const stuck = await PendingOrder.find({ status: 'processing', updatedAt: { $lt: cutoff } });

  let released = 0;
  let finalized = 0;

  for (const order of stuck) {
    const existingHistory = order.razorpayPaymentId
      ? await PaymentHistory.findOne({ razorpayPaymentId: order.razorpayPaymentId })
      : null;

    if (existingHistory) {
      order.status = 'paid';
      await order.save();
      finalized++;
      await Log.create({
        type: 'PAYMENT_RECONCILE',
        userPhone: order.phone,
        message: `Finalized stuck processing order ${order._id} to paid (PaymentHistory already recorded)`,
        status: 'INFO',
        metadata: { pendingOrderId: order._id.toString(), razorpayPaymentId: order.razorpayPaymentId }
      });
      continue;
    }

    order.status = 'created';
    await order.save();
    released++;
    await Log.create({
      type: 'PAYMENT_RECONCILE',
      userPhone: order.phone,
      message: `Released stuck processing order ${order._id} back to created for retry`,
      status: 'INFO',
      metadata: { pendingOrderId: order._id.toString(), razorpayPaymentId: order.razorpayPaymentId }
    });
  }

  return { checked: stuck.length, released, finalized };
}

module.exports = { processSuccessfulPayment, reconcileStuckPendingOrders, computeExtendedExpiry };
