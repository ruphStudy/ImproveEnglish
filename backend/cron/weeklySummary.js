const cron = require('node-cron');
const User = require('../models/User');
const { sendTemplateMessage } = require('../services/whatsappService');
const Log = require('../models/Log');
const { runWithCronLock } = require('../utils/cronLock');
const { getWeeklyActivityStats, hadWeeklyActivity } = require('../services/retentionService');

/**
 * Weekly Summary Cron - Runs every Sunday at 6:00 PM IST
 *
 * Sends a progress summary ONLY to users with real activity this week
 * (lesson completion or speaking practice) - never a fake "great progress"
 * report for an inactive week. Resets the weekly counter for all active users
 * regardless of whether a message was sent.
 *
 * NOTE: still uses the existing approved 'weekly_summary_new' template
 * (name/lessonsCompleted/streak) because WhatsApp requires an approved
 * template outside the 24h customer-service window, which a once-a-week
 * broadcast to possibly-inactive users always is. A richer message (speaking
 * score, weak-area focus) is ready in
 * retentionService.buildWeeklyProgressMessage() but requires a NEW approved
 * Meta template with more placeholders before it can be sent - see the
 * sprint report for this external action.
 */

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function runWeeklySummaryJob() {
  return runWithCronLock('weekly-summary', 1800, runWeeklySummaryJobInner);
}

async function runWeeklySummaryJobInner() {
  try {
    console.log('📊 Weekly summary cron started at 6:00 PM Sunday');

    const users = await User.find({ isActive: true });
    console.log(`📋 Checking ${users.length} active users for weekly activity`);

    const sinceDate = new Date(Date.now() - ONE_WEEK_MS);
    let summariesSent = 0;
    let skippedInactive = 0;
    let errors = 0;

    for (const user of users) {
      try {
        const stats = await getWeeklyActivityStats(user._id, sinceDate);

        if (!hadWeeklyActivity(stats)) {
          skippedInactive++;
          console.log(`⏭️  Skipped ${user.name} - no activity this week (comeback logic handles re-engagement)`);
        } else {
          await sendTemplateMessage(
            user.phone,
            'weekly_summary_new',
            [user.name, stats.lessonsCompleted.toString(), user.streak.toString()],
            'en_US'
          );

          summariesSent++;

          await Log.create({
            type: 'WEEKLY_SUMMARY_SENT',
            userPhone: user.phone,
            message: `Weekly summary sent: ${stats.lessonsCompleted} lessons, ${stats.speakingAttemptsCount} speaking practices, ${user.streak} streak`,
            status: 'SUCCESS',
            timestamp: new Date(),
            metadata: stats
          });

          console.log(`✅ Weekly summary sent to ${user.name}`);
        }

        // Reset weekly counter regardless of whether a message was sent
        user.weeklyCompletedCount = 0;
        await user.save();

      } catch (err) {
        console.error(`❌ Error processing weekly summary for ${user.phone}:`, err.message);
        errors++;

        await Log.create({
          type: 'WEEKLY_SUMMARY_ERROR',
          userPhone: user.phone,
          message: `Failed to send weekly summary: ${err.message}`,
          status: 'ERROR'
        });
      }
    }

    await Log.create({
      type: 'CRON_WEEKLY_SUMMARY',
      message: `Weekly summary completed: ${summariesSent} sent, ${skippedInactive} skipped (inactive), ${errors} errors`,
      status: 'SUCCESS',
      metadata: { totalUsers: users.length, summariesSent, skippedInactive, errors }
    });

    console.log(`🎯 Weekly summary completed: ${summariesSent} sent, ${skippedInactive} skipped, ${errors} errors`);

    return { totalUsers: users.length, summariesSent, skippedInactive, errors };

  } catch (err) {
    console.error('❌ Weekly summary cron error:', err);
    await Log.create({
      type: 'ERROR',
      message: `Weekly summary cron error: ${err.message}`,
      status: 'ERROR'
    });
    throw err;
  }
}

// Schedule cron job for Sunday 6:00 PM IST (every week)
cron.schedule('0 18 * * 0', runWeeklySummaryJob, {
  timezone: 'Asia/Kolkata'
});

console.log('⏰ Weekly summary cron initialized (Sunday 6:00 PM IST)');

// Export the function for manual triggering
module.exports = { runWeeklySummaryJob };
