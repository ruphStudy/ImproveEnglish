const cron = require('node-cron');
const User = require('../models/User');
const { sendTemplateMessage } = require('../services/whatsappService');
const Log = require('../models/Log');

/**
 * Expiry Reminder Cron - Runs daily at 9:00 AM IST
 * 
 * Sends WhatsApp reminders:
 * - 7 days before expiry (once)
 * - 3 days before expiry (once)
 */

async function runExpiryReminderJob() {
  try {
    console.log('🔔 Expiry reminder check started at 9:00 AM');
    
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Start of today
    
    // Find active users whose subscription hasn't expired yet
    const activeUsers = await User.find({
      isActive: true,
      expiryDate: { $gte: today }
    });
    
    console.log(`📋 Found ${activeUsers.length} active users to check for expiry reminders`);
    
    let sevenDayReminders = 0;
    let threeDayReminders = 0;
    
    for (const user of activeUsers) {
      try {
        const timeDiff = user.expiryDate - today;
        const daysRemaining = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));
        
        console.log(`📅 ${user.name} (${user.phone}): ${daysRemaining} days remaining`);
        
        // 7-day reminder
        if (daysRemaining <= 7 && daysRemaining > 3 && !user.sevenDayReminderSent) {
          console.log(`📤 Sending 7-day reminder to ${user.name} (${user.phone})`);
          
          try {
            await sendTemplateMessage(
              user.phone,
              'expiry_reminder_7_days_new',
              [user.name],
              'en_US'
            );
            
            user.sevenDayReminderSent = true;
            await user.save();
            
            sevenDayReminders++;
            
            await Log.create({
              type: 'EXPIRY_REMINDER_7_DAYS',
              userPhone: user.phone,
              message: `7-day expiry reminder sent. Expires on ${user.expiryDate.toLocaleDateString('en-IN')}`,
              status: 'SUCCESS',
              metadata: {
                daysRemaining,
                expiryDate: user.expiryDate
              }
            });
            
            console.log(`✅ 7-day reminder sent to ${user.name}`);
          } catch (err) {
            console.error(`❌ Failed to send 7-day reminder to ${user.phone}:`, err.message);
            await Log.create({
              type: 'EXPIRY_REMINDER_ERROR',
              userPhone: user.phone,
              message: `Failed to send 7-day reminder: ${err.message}`,
              status: 'ERROR'
            });
          }
        }
        
        // 3-day reminder
        if (daysRemaining <= 3 && daysRemaining > 0 && !user.threeDayReminderSent) {
          console.log(`📤 Sending 3-day reminder to ${user.name} (${user.phone})`);
          
          try {
            await sendTemplateMessage(
              user.phone,
              'expiry_reminder_3_days_new',
              [user.name],
              'en_US'
            );
            
            user.threeDayReminderSent = true;
            await user.save();
            
            threeDayReminders++;
            
            await Log.create({
              type: 'EXPIRY_REMINDER_3_DAYS',
              userPhone: user.phone,
              message: `3-day expiry reminder sent. Expires on ${user.expiryDate.toLocaleDateString('en-IN')}`,
              status: 'SUCCESS',
              metadata: {
                daysRemaining,
                expiryDate: user.expiryDate
              }
            });
            
            console.log(`✅ 3-day reminder sent to ${user.name}`);
          } catch (err) {
            console.error(`❌ Failed to send 3-day reminder to ${user.phone}:`, err.message);
            await Log.create({
              type: 'EXPIRY_REMINDER_ERROR',
              userPhone: user.phone,
              message: `Failed to send 3-day reminder: ${err.message}`,
              status: 'ERROR'
            });
          }
        }
      } catch (err) {
        console.error(`❌ Error processing user ${user.phone}:`, err.message);
      }
    }
    
    const summary = {
      totalChecked: activeUsers.length,
      sevenDayReminders,
      threeDayReminders
    };
    
    await Log.create({
      type: 'CRON_EXPIRY_REMINDER',
      message: `Expiry reminder check completed: ${sevenDayReminders} seven-day reminders, ${threeDayReminders} three-day reminders sent`,
      status: 'SUCCESS',
      metadata: summary
    });
    
    console.log(`🎯 Expiry reminder check completed:`);
    console.log(`   - 7-day reminders sent: ${sevenDayReminders}`);
    console.log(`   - 3-day reminders sent: ${threeDayReminders}`);
    
    return summary;
    
  } catch (err) {
    console.error('❌ Expiry reminder cron error:', err);
    await Log.create({ 
      type: 'ERROR', 
      message: `Expiry reminder cron error: ${err.message}`,
      status: 'ERROR'
    });
    throw err;
  }
}

// Schedule cron job for 9:00 AM IST daily
cron.schedule('0 9 * * *', runExpiryReminderJob, {
  timezone: 'Asia/Kolkata'
});

console.log('⏰ Expiry reminder cron initialized (9:00 AM IST)');

// Export the function for manual triggering
module.exports = { runExpiryReminderJob };
