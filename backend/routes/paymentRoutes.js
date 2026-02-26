const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

// Create Razorpay order
router.post('/create-order', paymentController.createOrder);

// Razorpay webhook - IMPORTANT: uses raw body middleware
router.post('/razorpay-webhook', paymentController.handleWebhook);

// Get order status (for frontend polling)
router.get('/order-status/:orderId', paymentController.getOrderStatus);

// Verify upgrade payment (callback from Razorpay Payment Link)
router.get('/verify-upgrade', paymentController.verifyUpgradePayment);

module.exports = router;
