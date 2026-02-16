const express = require('express');
const router = express.Router();
const registrationLogController = require('../controllers/registrationLogController');

router.get('/registration-logs', registrationLogController.getRegistrationLogs);
router.get('/registration-stats', registrationLogController.getRegistrationStats);

module.exports = router;
