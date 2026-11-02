const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const adminAuth = require('../middleware/adminAuth');

// Disabled: the deprecated Google Form registration created active READY users
// with no payment or expiry (indefinite free lessons). Accounts are now created
// only by a verified Razorpay payment (see services/paymentProcessingService.js).
router.post('/register', (req, res) => {
  console.warn('[Security] Rejected call to disabled public /api/register');
  res.status(410).json({
    success: false,
    error: 'Registration via this endpoint has been discontinued. Please subscribe at https://www.fluencyloop.in/buy'
  });
});

// Admin-only - lists/exposes user PII and mutates account state
router.get('/users', adminAuth, userController.getUsers);
router.get('/users/phone/:phone', adminAuth, userController.getUserByPhone);
router.patch('/users/:id', adminAuth, userController.updateUser);

module.exports = router;
