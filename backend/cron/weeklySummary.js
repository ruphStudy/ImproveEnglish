const cron = require('node-cron');
const User = require('../models/User');
const { sendTemplateMessage } = require('../services/whatsappService');
const Log = require('../models/Log');

/**
 * Weekly Summary Cron - Runs every Sunday at 6:00 PM IST
 * 
 * Sends performance summary to active users and resets weekly counter
 */

async function runWeeklySummaryJob() {
  try {
    console.log('📊 Weekly summary cron started at 6:00 PM Sunday');
    
    // Find all active users
    const users = await User.find({ isActive: true });
    
    console.log(`📋 Sending weekly summary to ${users.length} active users`);
    
    let summariesSent = 0;
    let errors = 0;
    
    for (const user of users) {
      try {
        console.log(`📤 Sending weekly summary to ${user.name} (${user.phone})`);
        console.log(`   Lessons Completed: ${user.weeklyCompletedCount}`);
        console.log(`   Current Streak: ${user.streak}`);
        
        // Send WhatsApp template message
        // Parameters: {{1}}=name, {{2}}=lessonsCompleted, {{3}}=streak
        await sendTemplateMessage(
          user.phone,
          'weekly_summary_new',
          [
            user.name,
            user.weeklyCompletedCount.toString(),
            user.streak.toString()
          ],
          'en_US'
        );
        
        summariesSent++;
        
        // Log weekly summary sent
        await Log.create({
          type: 'WEEKLY_SUMMARY_SENT',
          userPhone: user.phone,
          message: `Weekly summary sent: ${user.weeklyCompletedCount} lessons, ${user.streak} streak`,
          status: 'SUCCESS',
          timestamp: new Date(),
          metadata: {
            weeklyCompleted: user.weeklyCompletedCount,
            streak: user.streak
          }
        });
        
        // Reset weekly counter
        user.weeklyCompletedCount = 0;
        await user.save();
        
        console.log(`✅ Weekly summary sent and counter reset for ${user.name}`);
        
      } catch (err) {
        console.error(`❌ Error sending weekly summary to ${user.phone}:`, err.message);
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
      message: `Weekly summary completed: ${summariesSent} sent, ${errors} errors`,
      status: 'SUCCESS',
      metadata: {
        totalUsers: users.length,
        summariesSent,
        errors
      }
    });
    
    console.log(`🎯 Weekly summary completed:`);
    console.log(`   - Summaries sent: ${summariesSent}`);
    console.log(`   - Errors: ${errors}`);
    
    return {
      totalUsers: users.length,
      summariesSent,
      errors
    };
    
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
