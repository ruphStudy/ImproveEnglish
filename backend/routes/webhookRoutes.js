const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');
const verifyMetaSignature = require('../middleware/verifyMetaSignature');

router.get('/webhook', webhookController.verify);
router.post('/webhook', verifyMetaSignature, webhookController.handleWebhook);

module.exports = router;
