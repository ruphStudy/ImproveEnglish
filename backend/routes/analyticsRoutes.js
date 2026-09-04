const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const adminAuth = require('../middleware/adminAuth');

// Revenue analytics
router.get('/revenue', adminAuth, analyticsController.getRevenueAnalytics);

// User activity analytics
router.get('/activity', adminAuth, analyticsController.getUserActivityAnalytics);

module.exports = router;
