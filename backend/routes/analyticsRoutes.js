const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');

// Revenue analytics
router.get('/revenue', analyticsController.getRevenueAnalytics);

// User activity analytics
router.get('/activity', analyticsController.getUserActivityAnalytics);

module.exports = router;
