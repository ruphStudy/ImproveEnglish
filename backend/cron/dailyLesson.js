const cron = require('node-cron');
const User = require('../models/User');
const { lessonQueue } = require('../config/queueConfig');
const Log = require('../models/Log');

/**
 * Daily Lesson Cron V3 - Queue-based for scalability
 * Runs every day at 7:00 AM IST
 * 
 * Flow:
 * 1. Find active users with state=READY
 * 2. Enqueue jobs to Bull queue (fast: <1 second for 1000 users)
 * 3. Workers process jobs in parallel (15 concurrent)
 * 4. Each worker handles: topic fetch, AI generation, WhatsApp send
 * 
 * Performance:
 * - Sequential (old): 1000 users × 21s = 5.8 hours ❌
 * - Queue (new): 1000 users ÷ 15 workers × 21s = ~23 minutes ✅
 */
cron.schedule('0 7 * * *', async () => {
  const startTime = Date.now();
  
  try {
    console.log('☀️ Daily lesson cron V3 (Queue-based) started at 7:00 AM');
    
    // Find active users who are READY for new lesson AND not expired
    // Use lean() for faster query (read-only)
    const users = await User.find({ 
      isActive: true,
      state: 'READY',
      $or: [
        { expiryDate: { $gte: new Date() } },
        { expiryDate: null }
      ]
    }).select('_id name phone').lean();
    
    console.log(`📋 Found ${users.length} active users ready for lessons`);
    
    if (users.length === 0) {
      console.log('ℹ️  No users to process, exiting cron');
      await Log.create({
        type: 'CRON_LESSON',
        message: `Daily lesson cron V3: 0 users found`
      });
      return;
    }
    
    // Enqueue all users to the job queue (very fast)
    const jobs = [];
    for (const user of users) {
      const job = await lessonQueue.add(
        { userId: user._id.toString() },
        {
          priority: 1, // Higher priority = processed first
          removeOnComplete: 100, // Keep last 100 completed jobs
          removeOnFail: 200, // Keep last 200 failed jobs
        }
      );
      jobs.push(job);
    }
    
    const enqueueTime = Date.now() - startTime;
    console.log(`✅ Enqueued ${jobs.length} jobs to lesson queue in ${enqueueTime}ms`);
    console.log(`⚙️  Workers will process jobs in parallel (concurrency: 15)`);
    console.log(`📊 Estimated completion time: ~${Math.ceil((users.length / 15) * 21000 / 1000 / 60)} minutes`);
    
    await Log.create({
      type: 'CRON_LESSON',
      message: `Daily lesson cron V3: Enqueued ${jobs.length} jobs in ${enqueueTime}ms. Workers processing in parallel.`,
      metadata: {
        userCount: users.length,
        enqueueTime: `${enqueueTime}ms`,
        estimatedMinutes: Math.ceil((users.length / 15) * 21000 / 1000 / 60)
      }
    });
    
  } catch (err) {
    console.error('❌ Daily lesson cron error:', err);
    await Log.create({ 
      type: 'ERROR', 
      message: `Lesson cron error: ${err.message}` 
    });
  }
}, {
  timezone: 'Asia/Kolkata'
});
