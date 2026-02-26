const cron = require('node-cron');
const User = require('../models/User');
const CurriculumTopic = require('../models/CurriculumTopic');
const TutorMemory = require('../models/TutorMemory');
const Lesson = require('../models/Lesson');
const { generateLesson } = require('../services/lessonGeneratorV2');
const { sendTemplateMessage } = require('../services/whatsappService');
const Log = require('../models/Log');

/**
 * Daily Lesson Cron V2 - Runs every day at 7:00 AM IST
 * 
 * Flow:
 * 1. Find active users with state=READY
 * 2. Fetch CurriculumTopic for user's level + currentDay
 * 3. Fetch or create TutorMemory
 * 4. Generate structured JSON lesson with AI
 * 5. Save to Lessons collection
 * 6. Update TutorMemory (topics, grammar, vocab)
 * 7. Send WhatsApp template notification
 * 8. Set user state to WAITING_START
 * 9. User replies START → Lesson sent from Lessons collection
 */
cron.schedule('0 7 * * *', async () => {
  try {
    console.log('☀️ Daily lesson cron V2 started at 7:00 AM');
    
    // Find active users who are READY for new lesson AND not expired
    const users = await User.find({ 
      isActive: true,
      state: 'READY',
      $or: [
        { expiryDate: { $gte: new Date() } },
        { expiryDate: null }
      ]
    });
    
    console.log(`📋 Found ${users.length} active users ready for lessons`);
    
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;
    
    for (const user of users) {
      try {
        console.log(`\n🔍 Processing user: ${user.name} (${user.phone})`);
        console.log(`   Current state: ${user.state}, Day: ${user.currentDay}, Level: ${user.level}`);
        console.log(`   lastNotificationDate BEFORE: ${user.lastNotificationDate}`);
        
        // Safety check: Ensure user is not expired
        if (user.expiryDate && user.expiryDate < new Date()) {
          user.isActive = false;
          await user.save();

          await Log.create({
            type: "SUBSCRIPTION_EXPIRED",
            userPhone: user.phone,
            message: "Subscription expired, lessons stopped automatically.",
            status: "INFO"
          });

          console.log(`⏹️  Skipped expired user: ${user.name} (${user.phone})`);
          skipCount++;
          continue;
        }

        // Step 1: Fetch curriculum topic
        const topic = await CurriculumTopic.findOne({
          level: user.level,
          day: user.currentDay,
          isActive: true
        });

        if (!topic) {
          console.error(`❌ No curriculum topic found for ${user.name} - Level: ${user.level}, Day: ${user.currentDay}`);
          
          await Log.create({
            type: 'CURRICULUM_TOPIC_NOT_FOUND',
            userPhone: user.phone,
            message: `No curriculum topic for level=${user.level}, day=${user.currentDay}`,
            status: 'ERROR',
            metadata: {
              level: user.level,
              day: user.currentDay
            }
          });
          
          skipCount++;
          continue; // Skip this user
        }

        // Step 2: Fetch or create TutorMemory
        let tutorMemory = await TutorMemory.findOne({ userId: user._id });
        
        if (!tutorMemory) {
          console.log(`🆕 Creating new TutorMemory for ${user.name}`);
          tutorMemory = await TutorMemory.create({
            userId: user._id,
            recentTopicDays: [],
            recentGrammarKeys: [],
            vocabBank: [],
            weakAreas: [],
            difficultyScore: 0.5
          });
        }

        // Step 3: Generate structured lesson with AI
        console.log(`🎓 Generating lesson for ${user.name} - Day ${user.currentDay}: ${topic.title}`);
        
        const lessonData = await generateLesson(user, topic, tutorMemory);

        // Step 4: Save lesson to Lessons collection
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

        console.log(`💾 Lesson saved to database - ID: ${lesson._id}`);

        // Step 5: Update TutorMemory
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

        // Add new vocabulary to vocab bank
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
        console.log(`🧠 TutorMemory updated for ${user.name}`);

        // Step 6: Update user state
        console.log(`📝 Updating user state for ${user.name}...`);
        user.state = 'WAITING_START';
        user.lessonDate = new Date();
        user.lessonCompleted = false;
        // Reset reminder flags for new lesson notification
        user.noonReminderSent = false;
        user.eveningReminderSent = false;
        const notificationDate = new Date();
        user.lastNotificationDate = notificationDate; // Track for 24-hour reminder window
        console.log(`   Setting lastNotificationDate = ${notificationDate.toISOString()}`);
        console.log(`   Setting state = WAITING_START`);
        console.log(`   Resetting reminder flags: noonReminderSent=false, eveningReminderSent=false`);
        await user.save();
        console.log(`✅ User saved! lastNotificationDate AFTER save: ${user.lastNotificationDate}`);

        // Step 7: Send WhatsApp notification
        const streakMessage =
          user.streak > 0
            ? `🔥 Current Streak: ${user.streak} day${user.streak > 1 ? 's' : ''}\nReply START to receive today's lesson.`
            : `Reply START to receive today's lesson and begin your streak!`;
        
        await sendTemplateMessage(
          user.phone, 
          'daily_lesson_notification', 
          [
            user.name, 
            user.currentDay.toString(),
            streakMessage
          ],
          'en'
        );

        // Mark lesson as notified
        lesson.status = 'notified';
        lesson.notifiedAt = new Date();
        await lesson.save();
        
        console.log(`✅ Lesson sent to ${user.name} (${user.phone}) - Day ${user.currentDay}`);
        console.log(`📊 Final user state after save:`);
        console.log(`   - state: ${user.state}`);
        console.log(`   - lastNotificationDate: ${user.lastNotificationDate}`);
        console.log(`   - noonReminderSent: ${user.noonReminderSent}`);
        console.log(`   - eveningReminderSent: ${user.eveningReminderSent}`);
        
        await Log.create({ 
          type: 'LESSON_GENERATED', 
          phone: user.phone, 
          message: `Structured lesson generated and notified for day ${user.currentDay}, lastNotificationDate=${user.lastNotificationDate}`,
          metadata: {
            lessonId: lesson._id.toString(),
            topic: topic.title,
            lastNotificationDate: user.lastNotificationDate
          }
        });
        
        successCount++;
        
      } catch (err) {
        console.error(`❌ Error for ${user.name}:`, err.message);
        await Log.create({ 
          type: 'ERROR', 
          phone: user.phone, 
          message: `Daily lesson error: ${err.message}` 
        });
        errorCount++;
      }
    }
    
    await Log.create({
      type: 'CRON_LESSON',
      message: `Daily lesson cron V2: ${successCount} success, ${skipCount} skipped, ${errorCount} errors`
    });
    
    console.log(`🎉 Daily lesson cron completed - Success: ${successCount}, Skipped: ${skipCount}, Errors: ${errorCount}`);
    
  } catch (err) {
    console.error('❌ Daily lesson cron error:', err);
    await Log.create({ type: 'ERROR', message: `Lesson cron error: ${err.message}` });
  }
}, {
  timezone: 'Asia/Kolkata'
});
