const cron = require('node-cron');
const User = require('../models/User');
const { generateLesson } = require('../services/openaiService');
const { sendTemplateMessage } = require('../services/whatsappService');
const Log = require('../models/Log');

/**
 * Daily Lesson Cron - Runs every day at 7:00 AM IST
 * 
 * Flow:
 * 1. Find users with isActive=true AND state=READY
 * 2. Generate lesson with OpenAI based on currentDay
 * 3. Store lessonText in user record
 * 4. Send WhatsApp template message
 * 5. Set state to WAITING_START
 * 6. When user replies START → Send lesson → Increment day → Set READY
 * 7. Next day, cron finds user again (now with incremented currentDay)
 */
cron.schedule('0 7 * * *', async () => {
  try {
    console.log('☀️ Daily lesson cron started at 7:00 AM');
    
    // Find active users who are READY for new lesson
    const users = await User.find({ 
      isActive: true,
      state: 'READY'
    });
    
    console.log(`📋 Found ${users.length} active users ready for lessons`);
    
    for (const user of users) {
      try {
        // Generate personalized lesson based on current day
        const lesson = await generateLesson(user.currentDay, user.name);
        
        // Update user record with generated lesson
        user.lessonText = lesson;
        user.lessonDate = new Date();
        user.state = 'WAITING_START';
        user.lessonCompleted = false; // Reset for new lesson
        await user.save();
        
        // Send WhatsApp TEMPLATE message (Meta policy requirement)
        // Parameters: {{1}}=name, {{2}}=day, {{3}}=instruction text
        await sendTemplateMessage(
          user.phone, 
          'daily_lesson_notification', 
          [
            user.name, 
            user.currentDay.toString(),
            'Reply START to receive today\'s lesson.'
          ]
        );
        
        await Log.create({ 
          type: 'LESSON_GENERATED', 
          phone: user.phone, 
          message: `Template sent for day ${user.currentDay}` 
        });
        
        console.log(`✅ Lesson sent to ${user.name} (${user.phone}) - Day ${user.currentDay}`);
      } catch (err) {
        console.error(`❌ Error for ${user.name}:`, err.message);
        await Log.create({ 
          type: 'ERROR', 
          phone: user.phone, 
          message: `Daily lesson error: ${err.message}` 
        });
      }
    }
    
    await Log.create({
      type: 'CRON_LESSON',
      message: `Daily lesson cron: ${users.length} template messages sent`
    });
    
    console.log(`🎉 Daily lesson cron completed - ${users.length} users processed`);
  } catch (err) {
    console.error('❌ Daily lesson cron error:', err);
    await Log.create({ type: 'ERROR', message: `Lesson cron error: ${err.message}` });
  }
}, {
  timezone: 'Asia/Kolkata'
});
