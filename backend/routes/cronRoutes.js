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

/**
 * Manual Cron Trigger - For Testing
 * GET/POST /api/cron/trigger-daily-lesson
 * Manually runs the daily lesson logic (same as 7am cron)
 * Supports both GET and POST for easy browser testing
 */
const triggerDailyLesson = async (req, res) => {
  try {
    console.log('🔧 Manual cron trigger V2 started...');
    
    // Find active users who are READY
    const users = await User.find({ 
      isActive: true,
      state: 'READY',
      $or: [
        { expiryDate: { $gte: new Date() } },
        { expiryDate: null }
      ]
    });
    
    console.log(`📋 Found ${users.length} active users to send lessons to`);
    
    const results = [];
    
    for (const user of users) {
      try {
        // Fetch curriculum topic
        const topic = await CurriculumTopic.findOne({
          level: user.level,
          day: user.currentDay,
          isActive: true
        });

        if (!topic) {
          console.error(`❌ No curriculum topic for ${user.name} - Level: ${user.level}, Day: ${user.currentDay}`);
          results.push({
            success: false,
            user: user.name,
            phone: user.phone,
            day: user.currentDay,
            error: 'No curriculum topic found'
          });
          continue;
        }

        // Fetch or create TutorMemory
        let tutorMemory = await TutorMemory.findOne({ userId: user._id });
        if (!tutorMemory) {
          tutorMemory = await TutorMemory.create({
            userId: user._id,
            recentTopicDays: [],
            recentGrammarKeys: [],
            vocabBank: [],
            weakAreas: [],
            difficultyScore: 0.5
          });
        }

        // Generate structured lesson with AI V2
        console.log(`🎓 Generating lesson for ${user.name} - Day ${user.currentDay}: ${topic.title}`);
        const lessonData = await generateLesson(user, topic, tutorMemory);

        // Save lesson to Lessons collection
        const lesson = await Lesson.create({
          userId: user._id,
          day: user.currentDay,
          level: user.level,
          topicTitle: topic.title,
          grammarFocus: topic.grammarFocus,
          scenarioType: lessonData.scenarioType,
          lessonJson: lessonData.lessonJson,
          lessonText: lessonData.lessonText,
          status: 'generated',
          generatedAt: new Date()
        });

        // Update TutorMemory
        tutorMemory.recentTopicDays.push(user.currentDay);
        if (tutorMemory.recentTopicDays.length > 7) {
          tutorMemory.recentTopicDays = tutorMemory.recentTopicDays.slice(-7);
        }
        if (topic.grammarFocus && !tutorMemory.recentGrammarKeys.includes(topic.grammarFocus)) {
          tutorMemory.recentGrammarKeys.push(topic.grammarFocus);
          if (tutorMemory.recentGrammarKeys.length > 7) {
            tutorMemory.recentGrammarKeys = tutorMemory.recentGrammarKeys.slice(-7);
          }
        }
        if (lessonData.vocabList && lessonData.vocabList.length > 0) {
          lessonData.vocabList.forEach(vocab => {
            tutorMemory.vocabBank.push({
              word: vocab.word,
              day: user.currentDay,
              addedAt: new Date()
            });
          });
        }
        await tutorMemory.save();

        // Update user state
        user.state = 'WAITING_START';
        user.lessonDate = new Date();
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
          ],
          'en' // Use 'en' if template was created with English language, or 'en_US' for English (US)
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

module.exports = router;
