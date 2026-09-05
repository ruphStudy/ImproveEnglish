const User = require('../models/User');
const PaymentHistory = require('../models/PaymentHistory');
const Log = require('../models/Log');
const {
  calculateFunnelMetrics,
  calculateRetentionMetrics,
  calculateEngagementMetrics,
  calculateSubscriptionSignals
} = require('../services/retentionService');

const VALID_LEVELS = ['beginner', 'intermediate', 'advanced'];
const VALID_GOALS = ['daily_english', 'workplace', 'interview', 'college_placement', 'customer_service', 'sales', 'travel'];

/** Shared cohort-filter parsing/validation for the funnel/retention/engagement/subscriptions endpoints. */
function parseAnalyticsFilters(query) {
  const filters = {};
  const errors = [];

  if (query.from) {
    const d = new Date(query.from);
    if (Number.isNaN(d.getTime())) errors.push('Invalid "from" date'); else filters.from = d;
  }
  if (query.to) {
    const d = new Date(query.to);
    if (Number.isNaN(d.getTime())) errors.push('Invalid "to" date'); else filters.to = d;
  }
  if (query.level) {
    if (!VALID_LEVELS.includes(query.level)) errors.push(`Invalid "level" - must be one of ${VALID_LEVELS.join(', ')}`);
    else filters.level = query.level;
  }
  if (query.learningGoal) {
    if (!VALID_GOALS.includes(query.learningGoal)) errors.push(`Invalid "learningGoal" - must be one of ${VALID_GOALS.join(', ')}`);
    else filters.learningGoal = query.learningGoal;
  }
  if (query.planDuration) {
    const n = parseInt(query.planDuration, 10);
    if (Number.isNaN(n) || n <= 0) errors.push('Invalid "planDuration" - must be a positive number');
    else filters.planDuration = n;
  }

  return { filters, errors };
}

/**
 * Get Revenue Analytics
 * GET /api/analytics/revenue
 */
exports.getRevenueAnalytics = async (req, res, next) => {
  try {
    console.log('📊 Fetching revenue analytics...');

    // 1. Get total revenue from PaymentHistory
    const totalRevenueResult = await PaymentHistory.aggregate([
      {
        $match: { paymentStatus: 'success' }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$amountPaid' }
        }
      }
    ]);

    const totalRevenue = totalRevenueResult[0]?.totalRevenue || 0;

    // 2. Get plan breakdown (revenue by plan duration)
    const planBreakdown = await PaymentHistory.aggregate([
      {
        $match: { paymentStatus: 'success' }
      },
      {
        $group: {
          _id: '$planDuration',
          count: { $sum: 1 },
          revenue: { $sum: '$amountPaid' }
        }
      },
      {
        $sort: { _id: 1 }
      }
    ]);

    // Format plan breakdown for readability
    const formattedPlanBreakdown = planBreakdown.map(plan => ({
      planDuration: plan._id,
      planName: `${plan._id} Days`,
      subscriptions: plan.count,
      revenue: plan.revenue
    }));

    // 3. Get active and expired users count
    const today = new Date();
    
    const activeUsers = await User.countDocuments({
      isActive: true,
      expiryDate: { $gte: today }
    });

    const expiredUsers = await User.countDocuments({
      isActive: false,
      expiryDate: { $lt: today }
    });

    const totalUsers = await User.countDocuments();

    // 4. Get revenue by level
    const revenueByLevel = await PaymentHistory.aggregate([
      {
        $match: { paymentStatus: 'success' }
      },
      {
        $group: {
          _id: '$level',
          count: { $sum: 1 },
          revenue: { $sum: '$amountPaid' }
        }
      }
    ]);

    // 5. Get recent payments (last 10)
    const recentPayments = await PaymentHistory.find({ paymentStatus: 'success' })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('name phone level planDuration amountPaid createdAt');

    // 6. Calculate monthly revenue (current month)
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthlyRevenueResult = await PaymentHistory.aggregate([
      {
        $match: {
          paymentStatus: 'success',
          createdAt: { $gte: startOfMonth }
        }
      },
      {
        $group: {
          _id: null,
          monthlyRevenue: { $sum: '$amountPaid' },
          monthlyCount: { $sum: 1 }
        }
      }
    ]);

    const monthlyRevenue = monthlyRevenueResult[0]?.monthlyRevenue || 0;
    const monthlyPaymentsCount = monthlyRevenueResult[0]?.monthlyCount || 0;

    // 7. Get average revenue per user
    const avgRevenuePerUser = totalUsers > 0 ? (totalRevenue / totalUsers).toFixed(2) : 0;

    const analytics = {
      summary: {
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        totalUsers,
        activeUsers,
        expiredUsers,
        avgRevenuePerUser: parseFloat(avgRevenuePerUser)
      },
      monthly: {
        revenue: parseFloat(monthlyRevenue.toFixed(2)),
        paymentsCount: monthlyPaymentsCount,
        month: today.toLocaleString('en-US', { month: 'long', year: 'numeric' })
      },
      planBreakdown: formattedPlanBreakdown,
      revenueByLevel: revenueByLevel.map(level => ({
        level: level._id,
        subscriptions: level.count,
        revenue: parseFloat(level.revenue.toFixed(2))
      })),
      recentPayments: recentPayments.map(payment => ({
        name: payment.name,
        phone: payment.phone,
        level: payment.level,
        plan: `${payment.planDuration} Days`,
        amount: payment.amountPaid,
        date: payment.createdAt
      }))
    };

    console.log('✅ Revenue analytics fetched successfully');
    console.log(`   Total Revenue: ₹${totalRevenue}`);
    console.log(`   Active Users: ${activeUsers}`);
    console.log(`   Total Payments: ${formattedPlanBreakdown.reduce((sum, p) => sum + p.subscriptions, 0)}`);

    res.json({
      success: true,
      data: analytics
    });

  } catch (error) {
    console.error('❌ Error fetching revenue analytics:', error);
    next(error);
  }
};

/**
 * Get User Activity Analytics
 * GET /api/analytics/activity
 */
exports.getUserActivityAnalytics = async (req, res, next) => {
  try {
    console.log('📈 Fetching user activity analytics...');

    // Get streak distribution
    const streakDistribution = await User.aggregate([
      {
        $match: { isActive: true }
      },
      {
        $bucket: {
          groupBy: '$streak',
          boundaries: [0, 1, 7, 14, 30, 100],
          default: '30+',
          output: {
            count: { $sum: 1 },
            avgCurrentDay: { $avg: '$currentDay' }
          }
        }
      }
    ]);

    // Get weekly completion stats
    const weeklyCompletionStats = await User.aggregate([
      {
        $match: { isActive: true }
      },
      {
        $group: {
          _id: null,
          avgWeeklyCompleted: { $avg: '$weeklyCompletedCount' },
          totalWeeklyCompleted: { $sum: '$weeklyCompletedCount' }
        }
      }
    ]);

    // Get state distribution
    const stateDistribution = await User.aggregate([
      {
        $match: { isActive: true }
      },
      {
        $group: {
          _id: '$state',
          count: { $sum: 1 }
        }
      }
    ]);

    const analytics = {
      streakDistribution,
      weeklyActivity: {
        avgWeeklyCompleted: weeklyCompletionStats[0]?.avgWeeklyCompleted.toFixed(2) || 0,
        totalWeeklyCompleted: weeklyCompletionStats[0]?.totalWeeklyCompleted || 0
      },
      stateDistribution
    };

    console.log('✅ User activity analytics fetched successfully');

    res.json({
      success: true,
      data: analytics
    });

  } catch (error) {
    console.error('❌ Error fetching activity analytics:', error);
    next(error);
  }
};

/**
 * Funnel/activation analytics: onboarding completion, first-START/lesson/DONE/
 * voice rates, and median/average time-to-milestone. All computed locally from
 * stored LearnerEvent timestamps - no AI calls.
 * GET /api/analytics/funnel?from&to&level&learningGoal&planDuration
 */
exports.getFunnelAnalytics = async (req, res, next) => {
  try {
    const { filters, errors } = parseAnalyticsFilters(req.query);
    if (errors.length) return res.status(400).json({ success: false, errors });

    const data = await calculateFunnelMetrics(filters);
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error fetching funnel analytics:', error);
    next(error);
  }
};

/**
 * D1/D3/D7/D14/D30 retention: cohort size (users old enough to have reached
 * that day), retained count (real DAY_N_ACTIVE activity), and rate.
 * GET /api/analytics/retention?from&to&level&learningGoal&planDuration
 */
exports.getRetentionAnalytics = async (req, res, next) => {
  try {
    const { filters, errors } = parseAnalyticsFilters(req.query);
    if (errors.length) return res.status(400).json({ success: false, errors });

    const data = await calculateRetentionMetrics(filters);
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error fetching retention analytics:', error);
    next(error);
  }
};

/**
 * Engagement analytics: lesson/speaking-practice volume and averages, streak
 * distribution, onboarding rate, goal/level distribution, assessed-level mismatch.
 * GET /api/analytics/engagement?from&to&level&learningGoal&planDuration
 */
exports.getEngagementAnalytics = async (req, res, next) => {
  try {
    const { filters, errors } = parseAnalyticsFilters(req.query);
    if (errors.length) return res.status(400).json({ success: false, errors });

    const data = await calculateEngagementMetrics(filters);
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error fetching engagement analytics:', error);
    next(error);
  }
};

/**
 * Subscription signals: active / expiring-soon / expired counts, renewed/
 * upgraded milestone counts, and plan-duration distribution (derived from
 * PaymentHistory, not a stored field).
 * GET /api/analytics/subscriptions?from&to&level&learningGoal&planDuration
 */
exports.getSubscriptionAnalytics = async (req, res, next) => {
  try {
    const { filters, errors } = parseAnalyticsFilters(req.query);
    if (errors.length) return res.status(400).json({ success: false, errors });

    const data = await calculateSubscriptionSignals(filters);
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error fetching subscription analytics:', error);
    next(error);
  }
};
