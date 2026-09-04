const express = require('express');
const router = express.Router();
const logController = require('../controllers/logController');
const adminAuth = require('../middleware/adminAuth');

router.get('/logs', adminAuth, logController.getLogs);

module.exports = router;
