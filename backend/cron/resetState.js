const cron = require('node-cron');
const User = require('../models/User');
const Log = require('../models/Log');

/**
 * Midnight Reset - DISABLED
 * 
 * Not needed in current flow because:
 * - Users in READY state → Processed by 7am cron next day
 * - Users in WAITING_START → Skipped by 7am cron (stay on same day until they reply START)
 * - No state needs to be reset at midnight
 * 
 * Keeping file for reference but cron is commented out
 */

/*
cron.schedule('0 0 * * *', async () => {
  try {
    console.log('🌙 Midnight reset - DISABLED (not needed)');
  } catch (err) {
    console.error('❌ Midnight reset error:', err);
  }
}, {
  timezone: 'Asia/Kolkata'
});
*/

console.log('ℹ️ Midnight reset cron is DISABLED (not needed in current flow)');
