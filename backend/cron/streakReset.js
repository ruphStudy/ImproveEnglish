const cron = require('node-cron');
const User = require('../models/User');
const Log = require('../models/Log');

/**
 * Streak Reset Cron - DISABLED (Lesson-based streak tracking)
 * 
 * NOTE: This cron is disabled because streak tracking is now lesson-based,
 * not calendar-day based. Streak increments on each lesson completion
 * regardless of calendar gaps. Users can take breaks without losing streak.
 * 
 * Old behavior: Reset streak if user missed calendar days
 * New behavior: Streak = consecutive lessons completed (no time limit)
 */

async function runStreakResetJob() {
  console.log('ℹ️  Streak reset cron is disabled (lesson-based tracking active)');
  
  await Log.create({
    type: 'CRON_STREAK_RESET',
    message: 'Streak reset cron skipped - lesson-based tracking enabled',
    status: 'INFO'
  });
  
  return {
    totalChecked: 0,
    streaksReset: 0,
    disabled: true
  };
}

// Schedule cron job for 00:10 AM IST daily (10 minutes after midnight)
cron.schedule('10 0 * * *', runStreakResetJob, {
  timezone: 'Asia/Kolkata'
});

console.log('⏰ Streak reset cron initialized (00:10 AM IST)');

// Export the function for manual triggering
module.exports = { runStreakResetJob };
