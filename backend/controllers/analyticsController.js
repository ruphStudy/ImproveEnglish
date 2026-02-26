const User = require('../models/User');
const PaymentHistory = require('../models/PaymentHistory');
const Log = require('../models/Log');

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
