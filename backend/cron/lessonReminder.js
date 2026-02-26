const cron = require('node-cron');
const User = require('../models/User');
const Log = require('../models/Log');
const { sendWhatsAppMessage, sendTemplateMessage } = require('../services/whatsappService');

/**
 * Lesson Reminder System - Nudge users who haven't replied START yet
 * 
 * Schedule:
 * - 12:00 PM (Noon): First reminder
 * - 6:00 PM (Evening): Second reminder
 * 
 * Logic:
 * - Only remind users in WAITING_START state
 * - Only if notification was sent today (within 24-hour window)
 * - Only if specific reminder hasn't been sent yet
 * - Stop after 24 hours (WhatsApp limitation + respect user's pace)
 */

/**
 * Helper function to check if date is today
 */
function isToday(date) {
  if (!date) return false;
  const today = new Date();
  const checkDate = new Date(date);
  return (
    today.getDate() === checkDate.getDate() &&
    today.getMonth() === checkDate.getMonth() &&
    today.getFullYear() === checkDate.getFullYear()
  );
}

/**
 * Run Noon Reminder Job - Can be called by cron or manually
 */
async function runNoonReminderJob() {
  try {
    console.log('🔔 Noon lesson reminder check started');
    const today = new Date();
    console.log(`📅 Current time: ${today.toISOString()}`);
    
    // Find users who:
    // 1. Are in WAITING_START state (got notification but didn't reply START)
    // 2. Got notification today (within 24-hour window)
    // 3. Haven't received noon reminder yet
    // 4. Are active and not expired
    const users = await User.find({
      state: 'WAITING_START',
      isActive: true,
      noonReminderSent: false,
      lastNotificationDate: { $ne: null },
      $or: [
        { expiryDate: { $gte: new Date() } },
        { expiryDate: null }
      ]
    });
    
    console.log(`📋 Found ${users.length} users for noon reminder check`);
    
    if (users.length > 0) {
      console.log('👥 Users details:');
      users.forEach(u => {
        console.log(`   - ${u.name} (${u.phone}):`);
        console.log(`     lastNotificationDate: ${u.lastNotificationDate}`);
        console.log(`     isToday: ${isToday(u.lastNotificationDate)}`);
        console.log(`     state: ${u.state}, noonReminderSent: ${u.noonReminderSent}`);
      });
    }
    
    let remindersSent = 0;
    let skipped = 0;
    
    for (const user of users) {
      try {
        console.log(`\n🔍 Processing ${user.name}...`);
        
        // Check if notification was sent today (within 24 hours)
        if (!isToday(user.lastNotificationDate)) {
          console.log(`⏭️  Skipping ${user.name} - lastNotificationDate not today`);
          console.log(`   lastNotificationDate was: ${user.lastNotificationDate}`);
          skipped++;
          continue;
        }
        
        // Send reminder using TEMPLATE (works without 24-hour window)
        // TODO: Create 'lesson_reminder_noon' template in Meta Business Manager first
        await sendTemplateMessage(
          user.phone,
          'lesson_reminder_noon',
          [user.name, user.currentDay.toString()],
          'en'
        );
        
        // Mark reminder as sent
        user.noonReminderSent = true;
        await user.save();
        
        remindersSent++;
        
        await Log.create({
          type: 'LESSON_REMINDER_NOON',
          userPhone: user.phone,
          message: `Noon reminder sent for Day ${user.currentDay}`,
          status: 'SUCCESS',
          metadata: {
            day: user.currentDay,
            notificationDate: user.lastNotificationDate
          }
        });
        
        console.log(`✅ Noon reminder sent to ${user.name} (${user.phone})`);
        
      } catch (err) {
        console.error(`❌ Failed to send noon reminder to ${user.phone}:`, err.message);
        
        await Log.create({
          type: 'LESSON_REMINDER_ERROR',
          userPhone: user.phone,
          message: `Noon reminder failed: ${err.message}`,
          status: 'ERROR'
        });
      }
    }
    
    await Log.create({
      type: 'CRON_LESSON_REMINDER',
      message: `Noon reminder check completed: ${remindersSent} sent, ${skipped} skipped`,
      status: 'SUCCESS',
      metadata: {
        type: 'noon',
        totalChecked: users.length,
        remindersSent,
        skipped
      }
    });
    
    console.log(`🎯 Noon reminder check completed - ${remindersSent} reminders sent, ${skipped} skipped`);
    
    return {
      totalChecked: users.length,
      remindersSent,
      skipped
    };
    
  } catch (err) {
    console.error('❌ Noon reminder error:', err);
    await Log.create({ 
      type: 'ERROR', 
      message: `Noon reminder error: ${err.message}`,
      status: 'ERROR'
    });
    throw err;
  }
}

/**
 * Run Evening Reminder Job - Can be called by cron or manually
 */
async function runEveningReminderJob() {
  try {
    console.log('🔔 Evening lesson reminder check started');
    const now = new Date();
    console.log(`📅 Current time: ${now.toISOString()}`);
    
    // Find users who:
    // 1. Are in WAITING_START state
    // 2. Got notification today
    // 3. Haven't received evening reminder yet
    // 4. Are active and not expired
    const users = await User.find({
      state: 'WAITING_START',
      isActive: true,
      eveningReminderSent: false,
      lastNotificationDate: { $ne: null },
      $or: [
        { expiryDate: { $gte: new Date() } },
        { expiryDate: null }
      ]
    });
    
    console.log(`📋 Found ${users.length} users for evening reminder check`);
    
    if (users.length > 0) {
      console.log('👥 Users details:');
      users.forEach(u => {
        console.log(`   - ${u.name} (${u.phone}):`);
        console.log(`     lastNotificationDate: ${u.lastNotificationDate}`);
        console.log(`     isToday: ${isToday(u.lastNotificationDate)}`);
        console.log(`     state: ${u.state}, eveningReminderSent: ${u.eveningReminderSent}`);
      });
    }
    
    let remindersSent = 0;
    let skipped = 0;
    
    for (const user of users) {
      try {
        console.log(`\n🔍 Processing ${user.name}...`);
        
        // Check if notification was sent today
        if (!isToday(user.lastNotificationDate)) {
          console.log(`⏭️  Skipping ${user.name} - lastNotificationDate not today`);
          console.log(`   lastNotificationDate was: ${user.lastNotificationDate}`);
          skipped++;
          continue;
        }
        
        // Send evening reminder using TEMPLATE (works without 24-hour window)
        // TODO: Create 'lesson_reminder_evening' template in Meta Business Manager first
        await sendTemplateMessage(
          user.phone,
          'lesson_reminder_evening',
          [user.name, user.currentDay.toString()],
          'en'
        );
        
        // Mark reminder as sent
        user.eveningReminderSent = true;
        await user.save();
        
        remindersSent++;
        
        await Log.create({
          type: 'LESSON_REMINDER_EVENING',
          userPhone: user.phone,
          message: `Evening reminder sent for Day ${user.currentDay}`,
          status: 'SUCCESS',
          metadata: {
            day: user.currentDay,
            notificationDate: user.lastNotificationDate
          }
        });
        
        console.log(`✅ Evening reminder sent to ${user.name} (${user.phone})`);
        
      } catch (err) {
        console.error(`❌ Failed to send evening reminder to ${user.phone}:`, err.message);
        
        await Log.create({
          type: 'LESSON_REMINDER_ERROR',
          userPhone: user.phone,
          message: `Evening reminder failed: ${err.message}`,
          status: 'ERROR'
        });
      }
    }
    
    await Log.create({
      type: 'CRON_LESSON_REMINDER',
      message: `Evening reminder check completed: ${remindersSent} sent, ${skipped} skipped`,
      status: 'SUCCESS',
      metadata: {
        type: 'evening',
        totalChecked: users.length,
        remindersSent,
        skipped
      }
    });
    
    console.log(`🎯 Evening reminder check completed - ${remindersSent} reminders sent, ${skipped} skipped`);
    
    return {
      totalChecked: users.length,
      remindersSent,
      skipped
    };
    
  } catch (err) {
    console.error('❌ Evening reminder error:', err);
    await Log.create({ 
      type: 'ERROR', 
      message: `Evening reminder error: ${err.message}`,
      status: 'ERROR'
    });
    throw err;
  }
}

/**
 * Noon Reminder (12:00 PM) - First gentle nudge
 */
cron.schedule('0 12 * * *', async () => {
  await runNoonReminderJob();
}, {
  timezone: 'Asia/Kolkata'
});

/**
 * Evening Reminder (6:00 PM) - Final nudge before day ends
 */
cron.schedule('0 18 * * *', async () => {
  await runEveningReminderJob();
}, {
  timezone: 'Asia/Kolkata'
});

console.log('✅ Lesson reminder crons initialized:');
console.log('   🕛 12:00 PM - Noon reminder');
console.log('   🕕 6:00 PM - Evening reminder');

module.exports = { isToday, runNoonReminderJob, runEveningReminderJob };

