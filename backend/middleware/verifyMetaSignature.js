const crypto = require('crypto');

/**
 * Verifies Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body
 * with META_APP_SECRET) before any WhatsApp webhook processing, then parses
 * the JSON body for the controller. Expects req.body to be the raw Buffer
 * (see middleware/bodyParsers.js).
 *
 * Fails CLOSED: if META_APP_SECRET isn't configured, every event is rejected.
 * Never logs the secret, the signature or the payload.
 */
module.exports = function verifyMetaSignature(req, res, next) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    console.error('[MetaWebhook] META_APP_SECRET is not configured - rejecting webhook');
    return res.sendStatus(403);
  }

  const header = req.headers['x-hub-signature-256'];
  const match = typeof header === 'string' && /^sha256=([0-9a-f]{64})$/i.exec(header);
  if (!match) {
    console.warn('[MetaWebhook] Missing or malformed signature - rejected');
    return res.sendStatus(403);
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const provided = Buffer.from(match[1], 'hex');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    console.warn('[MetaWebhook] Invalid signature - rejected');
    return res.sendStatus(403);
  }

  try {
    req.body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
  } catch (err) {
    console.warn('[MetaWebhook] Signed payload is not valid JSON - rejected');
    return res.sendStatus(400);
  }

  next();
};
