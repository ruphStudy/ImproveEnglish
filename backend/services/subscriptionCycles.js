// Read-only view of each learner's current subscription cycle, from either a
// successful Razorpay payment (PaymentHistory) or a free BETA100 activation
// (FreeActivation). Nothing is written - free learners never get payment rows.
const PaymentHistory = require('../models/PaymentHistory');
const FreeActivation = require('../models/FreeActivation');

/**
 * Latest cycle per user: { source: 'PAID' | 'FREE_PROMO', startedAt, planDuration, cycleKey }.
 * cycleKey is stable per cycle (payment id / activation id) for once-per-cycle dedupe.
 */
async function getSubscriptionCycleMap(userIds) {
  const map = new Map();
  if (!userIds || !userIds.length) return map;

  const [paidRows, freeRows] = await Promise.all([
    PaymentHistory.aggregate([
      { $match: { paymentStatus: 'success', userId: { $in: userIds } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$userId', planDuration: { $first: '$planDuration' }, razorpayPaymentId: { $first: '$razorpayPaymentId' }, createdAt: { $first: '$createdAt' } } }
    ]),
    FreeActivation.find({ userId: { $in: userIds }, status: 'activated' })
      .select('userId planDuration activatedAt').lean()
  ]);

  const consider = (userId, cycle) => {
    const key = String(userId);
    const current = map.get(key);
    if (!current || cycle.startedAt > current.startedAt) map.set(key, cycle);
  };
  for (const r of paidRows) {
    consider(r._id, { source: 'PAID', startedAt: new Date(r.createdAt), planDuration: r.planDuration, cycleKey: `paid:${r.razorpayPaymentId}` });
  }
  for (const a of freeRows) {
    if (!a.activatedAt) continue;
    consider(a.userId, { source: 'FREE_PROMO', startedAt: new Date(a.activatedAt), planDuration: a.planDuration, cycleKey: `free:${a._id}` });
  }
  return map;
}

module.exports = { getSubscriptionCycleMap };
