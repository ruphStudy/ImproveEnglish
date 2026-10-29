const express = require('express');

/**
 * Body parsing for the app. Razorpay and Meta both sign the exact raw request
 * bytes, so their webhook routes must get an unparsed Buffer before
 * express.json() runs (express.json skips bodies that were already read).
 */
module.exports = function applyBodyParsers(app) {
  app.use('/api/payments/razorpay-webhook', express.raw({ type: 'application/json' }));
  app.use('/api/webhook', express.raw({ type: '*/*' }));
  app.use(express.json());
};
