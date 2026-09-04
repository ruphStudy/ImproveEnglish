const crypto = require('crypto');
const redisClient = require('../config/redisClient');
const Log = require('../models/Log');

// Atomic compare-and-delete: only removes the key if it still holds the
// token this caller set. A plain GET-then-DEL would itself race with
// another instance acquiring the key in between the two calls.
const RELEASE_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/**
 * Runs `fn` only if this process acquires the distributed lock for `lockKey`.
 * If another instance already holds it (i.e. is already running the same
 * cron), this run is skipped safely - no error, no duplicate WhatsApp sends.
 * The lock always carries a TTL so a crashed holder can never deadlock it.
 *
 * Release is ownership-safe: each acquisition stores a unique token as the
 * lock value, and release only deletes the key if it still holds that same
 * token. Without this, a slow run whose TTL expires could delete a lock a
 * different instance has since legitimately acquired for the same key.
 *
 * Fails OPEN on a Redis error: a Redis outage must not silently stop
 * critical notifications, so the job runs anyway (duplicate execution is
 * the lesser risk versus notifications never going out).
 */
async function runWithCronLock(lockKey, ttlSeconds, fn) {
  const key = `cron:lock:${lockKey}`;
  const token = crypto.randomUUID();
  let acquired = true;

  try {
    const result = await redisClient.set(key, token, 'NX', 'EX', ttlSeconds);
    acquired = result === 'OK';
  } catch (err) {
    console.error(`[Cron Lock] Redis error acquiring lock for ${lockKey}, running anyway:`, err.message);
    acquired = true;
  }

  if (!acquired) {
    console.log(`⏭️  [Cron Lock] Skipped ${lockKey} - another instance already running it`);
    await Log.create({
      type: 'CRON_LOCK_SKIP',
      message: `Skipped ${lockKey} - lock already held by another instance`,
      status: 'INFO'
    }).catch(() => {});
    return { skipped: true, lockKey };
  }

  try {
    return await fn();
  } finally {
    await redisClient.eval(RELEASE_IF_OWNER_SCRIPT, 1, key, token).catch((err) => {
      console.error(`[Cron Lock] Failed to release lock ${lockKey} (will expire via TTL):`, err.message);
    });
  }
}

module.exports = { runWithCronLock };
