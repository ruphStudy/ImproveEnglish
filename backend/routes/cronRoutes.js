const express = require('express');
const router = express.Router();
const User = require('../models/User');
const CurriculumTopic = require('../models/CurriculumTopic');
const TutorMemory = require('../models/TutorMemory');
const Lesson = require('../models/Lesson');
const { generateLesson } = require('../services/lessonGeneratorV2');
const { sendTemplateMessage } = require('../services/whatsappService');
const Log = require('../models/Log');
const { runExpiryReminderJob } = require('../cron/expiryReminder');
const { runStreakResetJob } = require('../cron/streakReset');
const { runWeeklySummaryJob } = require('../cron/weeklySummary');
const { lessonQueue } = require('../config/queueConfig');

/**
 * Manual Cron Trigger - For Testing (V3 - Queue-Based)
 * GET/POST /api/cron/trigger-daily-lesson
 * Manually runs the daily lesson logic (same as 7am cron)
 * Enqueues all eligible users to Bull Queue for parallel processing
 * Supports both GET and POST for easy browser testing
 */
const triggerDailyLesson = async (req, res) => {
  try {
    console.log('🔧 Manual cron trigger V3 started (Queue-based)...');
    const startTime = Date.now();
    
    // Find active users who are READY
    const users = await User.find({ 
      isActive: true,
      state: 'READY',
      $or: [
        { expiryDate: { $gte: new Date() } },
        { expiryDate: null }
      ]
    }).lean().select('_id name phone level currentDay');
    
    const userCount = users.length;
    console.log(`📋 Found ${userCount} active users to enqueue`);
    
    if (userCount === 0) {
      await Log.create({
        type: 'CRON_LESSON',
        message: '[MANUAL] No users to process'
      });
      
      return res.json({
        success: true,
        message: 'No users to process',
        totalUsers: 0,
        jobsEnqueued: 0
      });
    }
    
    // Enqueue all users to Bull Queue
    const jobPromises = users.map(user => 
      lessonQueue.add(
        { userId: user._id.toString() },
        { 
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 200
        }
      )
    );
    
    await Promise.all(jobPromises);
    
    const enqueueTime = Date.now() - startTime;
    
    // Calculate estimated completion time
    const concurrency = parseInt(process.env.LESSON_WORKER_CONCURRENCY) || 15;
    const avgProcessingTime = 21; // seconds per lesson
    const estimatedMinutes = Math.ceil((userCount / concurrency) * avgProcessingTime / 60);
    
    await Log.create({
      type: 'CRON_LESSON',
      message: `[MANUAL] Daily lesson trigger: ${userCount} users enqueued in ${enqueueTime}ms`
    });
    
    console.log(`🎉 Manual cron trigger completed! ${userCount} jobs enqueued in ${enqueueTime}ms`);
    console.log(`⏱️  Estimated completion: ~${estimatedMinutes} minutes with ${concurrency} parallel workers`);
    
    res.json({
      success: true,
      message: 'Daily lesson jobs enqueued successfully',
      totalUsers: userCount,
      jobsEnqueued: userCount,
      enqueueTime: `${enqueueTime}ms`,
      estimatedCompletion: `~${estimatedMinutes} minutes`,
      parallelWorkers: concurrency
    });
    
  } catch (err) {
    console.error('❌ Manual cron trigger error:', err);
    await Log.create({ type: 'ERROR', message: `Manual cron trigger error: ${err.message}` });
    res.status(500).json({ success: false, error: err.message });
  }
};

// Support both GET and POST for easy testing
router.get('/trigger-daily-lesson', triggerDailyLesson);
router.post('/trigger-daily-lesson', triggerDailyLesson);

/**
 * Manual Midnight Reset Trigger - For Testing
 * POST /api/cron/trigger-midnight-reset
 */
router.post('/trigger-midnight-reset', async (req, res) => {
  try {
    console.log('🌙 Manual midnight reset started...');
    
    const result = await User.updateMany(
      { state: 'COMPLETED_TODAY' },
      { 
        state: 'READY',
        lessonCompleted: false
      }
    );
    
    await Log.create({
      type: 'CRON_RESET',
      message: `[MANUAL] Midnight reset: ${result.modifiedCount} users reset to READY`
    });
    
    console.log(`✅ Midnight reset: ${result.modifiedCount} users reset`);
    
    res.json({
      success: true,
      message: 'Midnight reset triggered successfully',
      usersReset: result.modifiedCount
    });
    
  } catch (err) {
    console.error('❌ Manual reset error:', err);
    await Log.create({ type: 'ERROR', message: `Manual reset error: ${err.message}` });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Manual Expiry Reminder Trigger - For Testing
 * POST /api/cron/trigger-expiry-reminder
 * Manually runs the expiry reminder logic (same as 9am cron)
 */
router.post('/trigger-expiry-reminder', async (req, res) => {
  try {
    console.log('🔔 Manual expiry reminder trigger started...');
    
    const result = await runExpiryReminderJob();
    
    console.log('✅ Manual expiry reminder trigger completed!');
    
    res.json({
      success: true,
      message: 'Expiry reminder cron triggered successfully',
      ...result
    });
    
  } catch (err) {
    console.error('❌ Manual expiry reminder trigger error:', err);
    await Log.create({ type: 'ERROR', message: `Manual expiry reminder trigger error: ${err.message}` });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Manual Streak Reset Trigger - For Testing
 * POST /api/cron/trigger-streak-reset
 * Manually runs the streak reset logic (same as 00:10 AM cron)
 */
router.post('/trigger-streak-reset', async (req, res) => {
  try {
    console.log('🔥 Manual streak reset trigger started...');
    
    const result = await runStreakResetJob();
    
    console.log('✅ Manual streak reset trigger completed!');
    
    res.json({
      success: true,
      message: 'Streak reset cron triggered successfully',
      ...result
    });
    
  } catch (err) {
    console.error('❌ Manual streak reset trigger error:', err);
    await Log.create({ type: 'ERROR', message: `Manual streak reset trigger error: ${err.message}` });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Manual Weekly Summary Trigger - For Testing
 * POST /api/cron/trigger-weekly-summary
 * Manually runs the weekly summary logic (same as Sunday 6PM cron)
 */
router.post('/trigger-weekly-summary', async (req, res) => {
  try {
    console.log('📊 Manual weekly summary trigger started...');
    
    const result = await runWeeklySummaryJob();
    
    console.log('✅ Manual weekly summary trigger completed!');
    
    res.json({
      success: true,
      message: 'Weekly summary cron triggered successfully',
      ...result
    });
    
  } catch (err) {
    console.error('❌ Manual weekly summary trigger error:', err);
    await Log.create({ type: 'ERROR', message: `Manual weekly summary trigger error: ${err.message}` });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Manual Noon Reminder Trigger - For Testing
 * POST /api/cron/trigger-noon-reminder
 * Manually sends 12 PM lesson reminders to users in WAITING_START state
 */
router.post('/trigger-noon-reminder', async (req, res) => {
  try {
    console.log('🔔 Manual noon reminder trigger started...');
    
    const { runNoonReminderJob } = require('../cron/lessonReminder');
    const result = await runNoonReminderJob();
    
    console.log('✅ Manual noon reminder trigger completed!');
    
    res.json({
      success: true,
      message: 'Noon reminder triggered successfully',
      ...result
    });
    
  } catch (err) {
    console.error('❌ Manual noon reminder trigger error:', err);
    await Log.create({ type: 'ERROR', message: `Manual noon reminder trigger error: ${err.message}` });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Manual Evening Reminder Trigger - For Testing
 * POST /api/cron/trigger-evening-reminder
 * Manually sends 6 PM lesson reminders to users in WAITING_START state
 */
router.post('/trigger-evening-reminder', async (req, res) => {
  try {
    console.log('🔔 Manual evening reminder trigger started...');
    
    const { runEveningReminderJob } = require('../cron/lessonReminder');
    const result = await runEveningReminderJob();
    
    console.log('✅ Manual evening reminder trigger completed!');
    
    res.json({
      success: true,
      message: 'Evening reminder triggered successfully',
      ...result
    });
    
  } catch (err) {
    console.error('❌ Manual evening reminder trigger error:', err);
    await Log.create({ type: 'ERROR', message: `Manual evening reminder trigger error: ${err.message}` });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Testing Helper - Set lastNotificationDate for a user
 * POST /api/cron/set-notification-date
 * Body: { "phone": "919096994914" }
 */
router.post('/set-notification-date', async (req, res) => {
  try {
    const { phone } = req.body;
    
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Phone number required' });
    }
    
    const user = await User.findOneAndUpdate(
      { phone },
      { 
        $set: { 
          lastNotificationDate: new Date(),
          noonReminderSent: false,
          eveningReminderSent: false
        }
      },
      { new: true }
    );
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    console.log(`✅ Set lastNotificationDate for ${user.name} (${phone})`);
    
    res.json({
      success: true,
      message: 'lastNotificationDate updated',
      user: {
        name: user.name,
        phone: user.phone,
        lastNotificationDate: user.lastNotificationDate,
        noonReminderSent: user.noonReminderSent,
        eveningReminderSent: user.eveningReminderSent
      }
    });
    
  } catch (err) {
    console.error('❌ Set notification date error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Queue Monitoring - Get Queue Stats
 * GET /api/cron/queue/stats
 * Returns real-time statistics about the lesson generation queue
 */
router.get('/queue/stats', async (req, res) => {
  try {
    const [waitingCount, activeCount, completedCount, failedCount, delayedCount] = await Promise.all([
      lessonQueue.getWaitingCount(),
      lessonQueue.getActiveCount(),
      lessonQueue.getCompletedCount(),
      lessonQueue.getFailedCount(),
      lessonQueue.getDelayedCount()
    ]);

    res.json({
      success: true,
      queue: 'lessonQueue',
      stats: {
        waiting: waitingCount,
        active: activeCount,
        completed: completedCount,
        failed: failedCount,
        delayed: delayedCount,
        total: waitingCount + activeCount + delayedCount
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ Queue stats error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Queue Monitoring - Get Recent Jobs
 * GET /api/cron/queue/jobs?status=completed&limit=10
 * Returns recent jobs with their status
 * Query params:
 *   - status: completed, failed, waiting, active, delayed (default: all)
 *   - limit: number of jobs to return (default: 20, max: 100)
 */
router.get('/queue/jobs', async (req, res) => {
  try {
    const status = req.query.status || 'completed';
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    let jobs = [];
    
    switch (status) {
      case 'completed':
        jobs = await lessonQueue.getCompleted(0, limit - 1);
        break;
      case 'failed':
        jobs = await lessonQueue.getFailed(0, limit - 1);
        break;
      case 'waiting':
        jobs = await lessonQueue.getWaiting(0, limit - 1);
        break;
      case 'active':
        jobs = await lessonQueue.getActive(0, limit - 1);
        break;
      case 'delayed':
        jobs = await lessonQueue.getDelayed(0, limit - 1);
        break;
      default:
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid status. Use: completed, failed, waiting, active, or delayed' 
        });
    }

    const jobDetails = jobs.map(job => ({
      id: job.id,
      userId: job.data.userId,
      status: job.returnvalue ? 'completed' : (job.failedReason ? 'failed' : status),
      attemptsMade: job.attemptsMade,
      processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
      failedReason: job.failedReason || null,
      result: job.returnvalue || null
    }));

    res.json({
      success: true,
      queue: 'lessonQueue',
      status: status,
      count: jobDetails.length,
      jobs: jobDetails,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ Queue jobs error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Queue Monitoring - Clean Queue
 * POST /api/cron/queue/clean
 * Removes old completed and failed jobs from the queue
 * Body params:
 *   - grace: milliseconds to keep jobs (default: 3600000 = 1 hour)
 */
router.post('/queue/clean', async (req, res) => {
  try {
    const grace = parseInt(req.body.grace) || 3600000; // 1 hour default
    
    await lessonQueue.clean(grace, 'completed');
    await lessonQueue.clean(grace, 'failed');
    
    res.json({
      success: true,
      message: `Cleaned completed and failed jobs older than ${grace}ms`,
      gracePeriod: `${grace / 60000} minutes`,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ Queue clean error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
