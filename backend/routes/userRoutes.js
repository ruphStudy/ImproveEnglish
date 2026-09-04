const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const adminAuth = require('../middleware/adminAuth');

// Public - called by the Google Apps Script form integration
router.post('/register', userController.register);

// Admin-only - lists/exposes user PII and mutates account state
router.get('/users', adminAuth, userController.getUsers);
router.get('/users/phone/:phone', adminAuth, userController.getUserByPhone);
router.patch('/users/:id', adminAuth, userController.updateUser);

module.exports = router;
