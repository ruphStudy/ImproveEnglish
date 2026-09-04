const redisClient = require('../config/redisClient');
const Log = require('../models/Log');

/**
 * Runs `fn` only if this process acquires the distributed lock for `lockKey`.
 * If another instance already holds it (i.e. is already running the same
 * cron), this run is skipped safely - no error, no duplicate WhatsApp sends.
 * The lock always carries a TTL so a crashed holder can never deadlock it.
 *
 * Fails OPEN on a Redis error: a Redis outage must not silently stop
 * critical notifications, so the job runs anyway (duplicate execution is
 * the lesser risk versus notifications never going out).
 */
async function runWithCronLock(lockKey, ttlSeconds, fn) {
  const key = `cron:lock:${lockKey}`;
  let acquired = true;

  try {
    const result = await redisClient.set(key, '1', 'NX', 'EX', ttlSeconds);
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
    await redisClient.del(key).catch((err) => {
      console.error(`[Cron Lock] Failed to release lock ${lockKey} (will expire via TTL):`, err.message);
    });
  }
}

module.exports = { runWithCronLock };
