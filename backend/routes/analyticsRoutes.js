const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const adminAuth = require('../middleware/adminAuth');

// Revenue analytics
router.get('/revenue', adminAuth, analyticsController.getRevenueAnalytics);

// User activity analytics
router.get('/activity', adminAuth, analyticsController.getUserActivityAnalytics);

// Funnel/activation, retention, engagement, subscription-signal analytics
router.get('/funnel', adminAuth, analyticsController.getFunnelAnalytics);
router.get('/retention', adminAuth, analyticsController.getRetentionAnalytics);
router.get('/engagement', adminAuth, analyticsController.getEngagementAnalytics);
router.get('/subscriptions', adminAuth, analyticsController.getSubscriptionAnalytics);

module.exports = router;
