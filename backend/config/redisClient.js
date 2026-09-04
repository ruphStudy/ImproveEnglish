const Redis = require('ioredis');
const { redisConfig } = require('./queueConfig');

// Shared general-purpose Redis client (separate from Bull's own internal
// connections) for lightweight app-level operations: WhatsApp message
// dedupe and distributed cron locks. Reuses the same connection config
// as the queue - no new Redis package/service required.
const redisClient = new Redis({
  ...redisConfig,
  retryStrategy(times) {
    return Math.min(times * 50, 2000);
  }
});

redisClient.on('error', (err) => {
  console.error('[Redis Client] Connection error:', err.message);
});

module.exports = redisClient;
