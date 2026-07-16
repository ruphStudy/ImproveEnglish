const Queue = require('bull');
const Redis = require('ioredis');

// Redis connection configuration
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

// Create Redis client for Bull
const createRedisClient = (type) => {
  return new Redis({
    ...redisConfig,
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
  });
};

// Queue options
const queueOptions = {
  createClient: (type) => createRedisClient(type),
  defaultJobOptions: {
    attempts: 3, // Retry failed jobs 3 times
    backoff: {
      type: 'exponential',
      delay: 5000, // Start with 5 seconds, doubles each retry
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 200, // Keep last 200 failed jobs
  },
};

// Create lesson generation queue
const lessonQueue = new Queue('lesson-generation', queueOptions);

// Queue event handlers for monitoring
lessonQueue.on('error', (error) => {
  console.error('[Queue Error]', error);
});

lessonQueue.on('failed', (job, err) => {
  console.error(`[Job Failed] Job ${job.id} failed:`, err.message);
});

lessonQueue.on('completed', (job) => {
  console.log(`[Job Completed] Job ${job.id} completed successfully`);
});

lessonQueue.on('stalled', (job) => {
  console.warn(`[Job Stalled] Job ${job.id} stalled`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Queue] Shutting down gracefully...');
  await lessonQueue.close();
  process.exit(0);
});

module.exports = {
  lessonQueue,
  redisConfig,
};
