const { lessonQueue } = require('../config/queueConfig');
const User = require('../models/User');
const CurriculumTopic = require('../models/CurriculumTopic');
const TutorMemory = require('../models/TutorMemory');
const Lesson = require('../models/Lesson');
const { generateLesson } = require('../services/lessonGeneratorV2');
const { sendTemplateMessage } = require('../services/whatsappService');
const Log = require('../models/Log');

/**
 * Process a single user's lesson generation job
 * This function will be executed by Bull workers in parallel
 */
async function processLessonJob(userId) {
  const startTime = Date.now();
  
  try {
    // Fetch user with lean() for better performance (read-only)
    const user = await User.findById(userId);
    
    if (!user) {
      console.error(`❌ User not found: ${userId}`);
      throw new Error(`User not found: ${userId}`);
    }

    console.log(`\n🔍 Processing user: ${user.name} (${user.phone})`);
    console.log(`   Current state: ${user.state}, Day: ${user.currentDay}, Level: ${user.level}`);

    // Safety check: Ensure user is still active and not expired
    if (!user.isActive || (user.expiryDate && user.expiryDate < new Date())) {
      user.isActive = false;
      await user.save();

      await Log.create({
        type: "SUBSCRIPTION_EXPIRED",
        userPhone: user.phone,
        message: "Subscription expired, lessons stopped automatically.",
        status: "INFO"
      });

      console.log(`⏹️  Skipped expired user: ${user.name} (${user.phone})`);
      return { status: 'skipped', reason: 'expired', userId };
    }

    // Safety check: User should be in READY state
    if (user.state !== 'READY') {
      console.log(`⏭️  Skipped user in ${user.state} state: ${user.name}`);
      return { status: 'skipped', reason: 'not_ready', userId };
    }

    // Idempotency guard: a lesson may already exist for this user+day from a
    // previous attempt that generated it but then failed before the
    // WhatsApp notification/state update completed (e.g. a transient
    // WhatsApp API error). Reuse it instead of calling the AI generator
    // again - avoids duplicate Lesson records and duplicate OpenAI cost,
    // and lets a Bull retry actually succeed instead of being silently
    // defeated by the not_ready guard above.
    let lesson = await Lesson.findOne({ userId: user._id, day: user.currentDay }).sort({ generatedAt: -1 });
    let topicTitle;

    if (lesson && lesson.status === 'notified') {
      console.log(`⏭️  Lesson already generated and notified for ${user.name} - Day ${user.currentDay}`);
      return { status: 'skipped', reason: 'already_notified', userId };
    }

    if (!lesson) {
      // Step 1: Fetch curriculum topic
      const topic = await CurriculumTopic.findOne({
        level: user.level,
        day: user.currentDay,
        isActive: true
      }).lean(); // Use lean() for better performance

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

        return { status: 'skipped', reason: 'no_topic', userId };
      }
      topicTitle = topic.title;

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

      // Step 3: Generate structured lesson with AI (this is the slow part - 21 seconds)
      console.log(`🎓 Generating lesson for ${user.name} - Day ${user.currentDay}: ${topic.title}`);

      const lessonData = await generateLesson(user, topic, tutorMemory);

      // Step 4: Save lesson to Lessons collection
      lesson = await Lesson.create({
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
    } else {
      topicTitle = lesson.topicTitle;
      console.log(`♻️  Reusing previously generated lesson for ${user.name} - Day ${user.currentDay} (retry after earlier failure)`);
    }

    // Send WhatsApp notification BEFORE flipping user state. If this throws,
    // user.state stays 'READY' and the lesson stays 'generated', so a Bull
    // retry will legitimately re-enter this function, hit the reuse branch
    // above, and just retry the send - instead of being skipped forever by
    // the not_ready guard.
    const streakMessage =
      user.streak > 0
        ? `🔥 Current Streak: ${user.streak} day${user.streak > 1 ? 's' : ''}. Reply START to receive today's lesson.`
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

    // Update user state now that the notification actually went out
    console.log(`📝 Updating user state for ${user.name}...`);
    user.state = 'WAITING_START';
    user.lessonDate = new Date();
    user.lessonCompleted = false;
    // Reset reminder flags for new lesson notification
    user.noonReminderSent = false;
    user.eveningReminderSent = false;
    user.lastNotificationDate = new Date(); // Track for 24-hour reminder window
    await user.save();

    const duration = Date.now() - startTime;
    console.log(`✅ Lesson sent to ${user.name} (${user.phone}) - Day ${user.currentDay} (${duration}ms)`);

    await Log.create({
      type: 'LESSON_GENERATED',
      phone: user.phone,
      message: `Structured lesson generated and notified for day ${user.currentDay}`,
      metadata: {
        lessonId: lesson._id.toString(),
        topic: topicTitle,
        duration: `${duration}ms`,
        lastNotificationDate: user.lastNotificationDate
      }
    });

    return {
      status: 'success',
      userId,
      userName: user.name,
      day: user.currentDay,
      duration
    };
    
  } catch (error) {
    console.error(`❌ Error processing user ${userId}:`, error.message);
    
    // Try to log error
    try {
      const user = await User.findById(userId).select('phone').lean();
      if (user) {
        await Log.create({ 
          type: 'ERROR', 
          phone: user.phone, 
          message: `Lesson job error: ${error.message}` 
        });
      }
    } catch (logError) {
      console.error('Failed to log error:', logError.message);
    }
    
    throw error; // Re-throw to let Bull handle retry logic
  }
}

/**
 * Start the lesson worker with configurable concurrency
 * @param {number} concurrency - Number of parallel jobs (default: 15)
 */
function startLessonWorker(concurrency = 15) {
  console.log(`🚀 Starting lesson worker with concurrency: ${concurrency}`);
  
  // Process jobs from the queue
  lessonQueue.process(concurrency, async (job) => {
    return await processLessonJob(job.data.userId);
  });
  
  // Log worker activity
  lessonQueue.on('completed', (job, result) => {
    if (result.status === 'success') {
      console.log(`✅ [Worker] Job ${job.id} completed: ${result.userName} - Day ${result.day} (${result.duration}ms)`);
    } else {
      console.log(`⏭️  [Worker] Job ${job.id} skipped: ${result.reason}`);
    }
  });
  
  lessonQueue.on('failed', (job, err) => {
    console.error(`❌ [Worker] Job ${job.id} failed: ${err.message}`);
  });
  
  console.log('✅ Lesson worker started and listening for jobs');
}

module.exports = {
  startLessonWorker,
  processLessonJob
};
