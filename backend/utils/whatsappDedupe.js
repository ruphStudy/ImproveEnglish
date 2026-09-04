const redisClient = require('../config/redisClient');

// Covers Meta's webhook redelivery window with margin
const DEDUPE_TTL_SECONDS = 24 * 60 * 60;

/**
 * True if this WhatsApp message ID has already been seen and should be
 * skipped. Backed by Redis (SET NX EX) so dedupe state survives restarts
 * and is shared across multiple backend instances - an in-memory Set
 * cannot do either.
 *
 * Fails OPEN on a Redis error: a transient Redis outage must not block
 * legitimate webhook processing, so the message is treated as new.
 */
async function isDuplicateMessage(messageId) {
  if (!messageId) return false;
  try {
    const result = await redisClient.set(`wa:msg:${messageId}`, '1', 'NX', 'EX', DEDUPE_TTL_SECONDS);
    return result !== 'OK'; // null => key already existed => duplicate
  } catch (err) {
    console.error('[WhatsApp Dedupe] Redis error, failing open:', err.message);
    return false;
  }
}

module.exports = { isDuplicateMessage, DEDUPE_TTL_SECONDS };
