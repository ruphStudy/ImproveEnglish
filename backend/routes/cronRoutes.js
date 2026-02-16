const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { generateLesson } = require('../services/openaiService');
const { sendTemplateMessage } = require('../services/whatsappService');
const Log = require('../models/Log');

/**
 * Manual Cron Trigger - For Testing
 * GET/POST /api/cron/trigger-daily-lesson
 * Manually runs the daily lesson logic (same as 7am cron)
 * Supports both GET and POST for easy browser testing
 */
const triggerDailyLesson = async (req, res) => {
  try {
    console.log('🔧 Manual cron trigger started...');
    
    // Find active users who are READY
    const users = await User.find({ 
      isActive: true,
      state: 'READY'
    });
    
    console.log(`📋 Found ${users.length} active users to send lessons to`);
    
    const results = [];
    
    for (const user of users) {
      try {
        // Generate personalized lesson with OpenAI
        const lesson = await generateLesson(user.currentDay, user.name);
        
        // Update same record with new lesson
        user.lessonText = lesson;
        user.lessonDate = new Date();
        user.state = 'WAITING_START';
        user.lessonCompleted = false;
        await user.save();
        
        // Send WhatsApp TEMPLATE message
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
          message: `[MANUAL] Template sent for day ${user.currentDay}` 
        });
        
        console.log(`✅ Lesson sent to ${user.name} (${user.phone}) - Day ${user.currentDay}`);
        
        results.push({
          success: true,
          user: user.name,
          phone: user.phone,
          day: user.currentDay
        });
      } catch (err) {
        console.error(`❌ Error for ${user.name}:`, err.message);
        results.push({
          success: false,
          user: user.name,
          phone: user.phone,
          error: err.message
        });
      }
    }
    
    await Log.create({
      type: 'CRON_LESSON',
      message: `[MANUAL] Daily lesson trigger: ${users.length} users processed`
    });
    
    console.log('🎉 Manual cron trigger completed!');
    
    res.json({
      success: true,
      message: 'Daily lesson cron triggered successfully',
      totalUsers: users.length,
      results: results
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

module.exports = router;
