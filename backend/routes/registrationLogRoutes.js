const express = require('express');
const router = express.Router();
const registrationLogController = require('../controllers/registrationLogController');
const adminAuth = require('../middleware/adminAuth');

router.get('/registration-logs', adminAuth, registrationLogController.getRegistrationLogs);
router.get('/registration-stats', adminAuth, registrationLogController.getRegistrationStats);

module.exports = router;
