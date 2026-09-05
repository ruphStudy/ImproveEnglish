const User = require('../models/User');
const Log = require('../models/Log');
const Lesson = require('../models/Lesson');
const CurriculumTopic = require('../models/CurriculumTopic');
const TutorMemory = require('../models/TutorMemory');
const { sendWhatsAppMessage, sendTemplateMessage } = require('../services/whatsappService');
const { processVoiceEvaluation } = require('../services/voiceEvaluationService');
const { validatePromoCode } = require('../services/promoService');
const Razorpay = require('razorpay');
const PendingOrder = require('../models/PendingOrder');
const PlanMaster = require('../models/PlanMaster');
const { isDuplicateMessage } = require('../utils/whatsappDedupe');
const { needsOnboarding, handleOnboardingMessage } = require('../services/onboardingService');

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Map for database level names
const LEVEL_MAP = {
  'beginner': 'bigenner',
  'intermediate': 'intermidiate',
  'advanced': 'advance'
};

// Meta webhook verification
exports.verify = (req, res) => {
  console.log('🔍 Webhook Verification Request:', req.query);
  const verify_token = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  console.log("🔍 Webhook Verification Request:", {
    mode,
    token,
    challenge,
    verifyTokenFromEnv: verify_token,
  });
  if (mode && token && mode === 'subscribe' && token.trim() === verify_token) {
    console.log('✅ Webhook verified successfully!');
    return res.status(200).send(challenge);
  }
  console.log('❌ Webhook verification failed!');
  res.sendStatus(403);
};

// WhatsApp webhook handler
exports.handleWebhook = async (req, res, next) => {
  try {
    console.log('📩 Webhook received:', JSON.stringify(req.body, null, 2));
    
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!entry || !entry.messages) {
      console.log('⚠️ No messages in webhook payload');
      return res.sendStatus(200);
    }
    
    for (const msg of entry.messages) {
      console.log(`📱 Processing message: ID=${msg.id}, From=${msg.from}, Text=${msg.text?.body}`);
      
      if (await isDuplicateMessage(msg.id)) {
        console.log(`⏭️ Duplicate message skipped: ${msg.id}`);
        continue;
      }

      // Isolate each message: one message's failure (bad data, a transient
      // DB/API error) must not abort the rest of the batch or turn an
      // otherwise-fine webhook delivery into a 500 that Meta will retry.
      try {
      const phone = msg.from;
      const text = msg.text?.body?.trim().toUpperCase();
      const rawText = msg.text?.body?.trim(); // original case, for onboarding text answers - `text` above is uppercased for command matching only
      const user = await User.findOne({ phone });

      if (!user) {
        console.log(`⚠️ User not found for phone: ${phone}`);
        continue;
      }

      console.log(`👤 User found: ${user.name} (${phone}) - State: ${user.state}`);
      await Log.create({ type: 'MESSAGE_RECEIVED', phone, message: text || `[${msg.type || 'UNKNOWN'}]` });

      // Short WhatsApp onboarding (goal selection -> level assessment) for
      // brand-new users (state 'NEW'). UPGRADE must keep working regardless
      // of onboarding status, per product rule.
      if (text !== 'UPGRADE' && needsOnboarding(user)) {
        const onboardingResult = await handleOnboardingMessage(user, msg, rawText);
        await sendWhatsAppMessage(phone, onboardingResult.messageText);
        continue;
      }

      // Handle AUDIO messages - Voice Evaluation
      if (msg.type === 'audio') {
        console.log(`🎤 Audio message received from ${phone}`);
        
        try {
          // Send acknowledgment
          await sendWhatsAppMessage(
            phone,
            `🎤 Processing your voice message...\n\nPlease wait while I evaluate your English.`
          );

          // Process voice evaluation - links to the current lesson's speaking
          // prompt when available, evaluates only what a transcript can show
          // (grammar/sentence formation/naturalness/vocabulary/relevance),
          // and returns an already-formatted concise WhatsApp message.
          const mediaId = msg.audio.id;
          const result = await processVoiceEvaluation(mediaId, user);

          // Update user's last score (kept for dashboard/legacy compatibility,
          // now sourced from the truthful overall score rather than a
          // fabricated pronunciation/fluency claim)
          user.lastFluencyScore = result.overallScore;
          await user.save();

          // Plain text (not the old pronunciation-labeled template) - we're
          // inside the active conversation window and control the wording
          // directly, avoiding any pronunciation-accuracy overclaim.
          await sendWhatsAppMessage(phone, result.messageText);

          console.log(`✅ Voice evaluation sent to ${phone}. Overall: ${result.overallScore}/10`);

        } catch (error) {
          console.error(`❌ Error processing voice message:`, error);
          
          await sendWhatsAppMessage(
            phone,
            `Sorry ${user.name}, I couldn't process your voice message. Please try again or contact support.`
          );
        }
        
        // Skip further processing for audio messages
        continue;
      }
      
      // Handle "START" command when user is in READY state - Generate lesson on-demand
      if (text === 'START' && user.state === 'READY') {
        // Guard against an expired-but-not-yet-deactivated user (the midnight
        // subscriptionExpiry cron may not have run yet) triggering a paid
        // OpenAI generation call for a lapsed subscription.
        if (!user.isActive || (user.expiryDate && user.expiryDate < new Date())) {
          if (user.isActive) {
            user.isActive = false;
            await user.save();
          }
          await sendWhatsAppMessage(
            phone,
            `Hi ${user.name}, your FluencyLoop plan has expired. Reply UPGRADE to renew and continue your lessons.`
          );
          continue;
        }

        console.log(`🎯 User ${phone} sent START in READY state - Generating lesson on-demand`);

        try {
          // Fetch curriculum topic
          const topic = await CurriculumTopic.findOne({
            level: user.level,
            day: user.currentDay,
            isActive: true
          });

          if (!topic) {
            await sendWhatsAppMessage(
              phone,
              `Sorry ${user.name}, no curriculum topic is available for Level: ${user.level}, Day: ${user.currentDay}. Please contact support.`
            );
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
              recentScenarioTypes: [],
              weakAreas: [],
              difficultyScore: 0.5
            });
          }

          // Generate lesson with AI V2
          console.log(`🎓 Generating on-demand lesson for ${user.name} - Day ${user.currentDay}: ${topic.title}`);
          const { generateLesson } = require('../services/lessonGeneratorV2');
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
            generationVersion: lessonData.generationVersion,
            validationStatus: lessonData.validationStatus,
            status: 'sent',
            generatedAt: new Date(),
            sentAt: new Date()
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
          if (lessonData.scenarioType) {
            tutorMemory.recentScenarioTypes.push(lessonData.scenarioType);
            if (tutorMemory.recentScenarioTypes.length > 5) {
              tutorMemory.recentScenarioTypes = tutorMemory.recentScenarioTypes.slice(-5);
            }
          }
          await tutorMemory.save();

          // Send lesson to user
          await sendWhatsAppMessage(phone, lesson.lessonText);

          // Update user state
          user.currentDay += 1;
          user.state = 'READY';
          user.lastSeenAt = new Date();
          // Reset reminder flags (user started lesson)
          user.noonReminderSent = false;
          user.eveningReminderSent = false;
          await user.save();

          await Log.create({
            type: 'LESSON_STARTED',
            phone,
            message: `On-demand lesson generated and sent for day ${user.currentDay - 1}`
          });

          const { recordLearnerEvent } = require('../services/retentionService');
          await recordLearnerEvent(user._id, 'FIRST_START');
          await recordLearnerEvent(user._id, 'FIRST_LESSON_SENT');

          console.log(`✅ On-demand lesson sent to ${user.name} - Day ${user.currentDay - 1}`);
          
        } catch (error) {
          console.error(`❌ Error generating on-demand lesson:`, error);
          await sendWhatsAppMessage(
            phone,
            `Sorry ${user.name}, there was an error generating your lesson. Please try again in a few minutes or contact support.`
          );
        }
        
        continue; // Skip further processing
      }
      
      // Handle "START" command - User wants to receive lesson
      if (text === 'START' && user.state === 'WAITING_START') {
        console.log(`🚀 User ${phone} requested lesson for Day ${user.currentDay}`);
        console.log(`   Current state BEFORE: ${user.state}`);
        console.log(`   lastNotificationDate: ${user.lastNotificationDate}`);
        console.log(`   noonReminderSent: ${user.noonReminderSent}, eveningReminderSent: ${user.eveningReminderSent}`);
        
        // Fetch lesson from Lessons collection
        const lesson = await Lesson.findOne({
          userId: user._id,
          day: user.currentDay,
          status: { $in: ['generated', 'notified'] }
        }).sort({ generatedAt: -1 });

        if (!lesson) {
          console.error(`❌ No lesson found for ${user.name} - Day ${user.currentDay}`);
          
          // Reset state to READY so cron can regenerate the lesson
          user.state = 'READY';
          await user.save();
          console.log(`🔄 Reset ${user.name}'s state to READY for lesson regeneration`);
          
          await sendWhatsAppMessage(
            phone,
            `Sorry ${user.name}, your lesson for Day ${user.currentDay} is not ready yet. We'll generate it shortly. Please try again in a few minutes.`
          );
          
          await Log.create({
            type: 'ERROR',
            phone,
            message: `No lesson found for day ${user.currentDay}, state reset to READY`,
            status: 'ERROR'
          });
          
          continue; // Skip further processing
        }

        // Send lesson text from database
        await sendWhatsAppMessage(phone, lesson.lessonText);
        
        // Mark lesson as sent
        lesson.status = 'sent';
        lesson.sentAt = new Date();
        await lesson.save();
        
        // Increment day and set READY for tomorrow
        user.currentDay += 1;
        user.state = 'READY';
        user.lastSeenAt = new Date();
        // Reset reminder flags (user started lesson)
        user.noonReminderSent = false;
        user.eveningReminderSent = false;
        await user.save();
        
        console.log(`✅ Lesson sent to ${user.name}!`);
        console.log(`   State changed: WAITING_START → READY`);
        console.log(`   Day incremented: ${user.currentDay - 1} → ${user.currentDay}`);
        console.log(`   Reminder flags reset: noonReminderSent=false, eveningReminderSent=false`);
        
        await Log.create({
          type: 'LESSON_STARTED',
          phone,
          message: `User received day ${user.currentDay - 1} lesson, now on day ${user.currentDay}`,
          metadata: {
            lessonId: lesson._id.toString()
          }
        });

        const { recordLearnerEvent } = require('../services/retentionService');
        await recordLearnerEvent(user._id, 'FIRST_START');
        await recordLearnerEvent(user._id, 'FIRST_LESSON_SENT');

        console.log(`✅ Lesson sent! Day: ${user.currentDay - 1} → ${user.currentDay}, State: READY`);
      } 
      // Handle "DONE" command - User confirms completion
      else if (text === 'DONE' && user.state === 'READY') {
        console.log(`🎉 User ${phone} marked lesson as completed`);
        console.log(`   Current streak BEFORE: ${user.streak}`);
        console.log(`   Current day: ${user.currentDay}, checking for lesson on day ${user.currentDay - 1}`);
        
        // Mark the most recent sent lesson as completed
        const completedLesson = await Lesson.findOne({
          userId: user._id,
          day: user.currentDay - 1, // Previous day (since currentDay was already incremented)
          status: 'sent'
        }).sort({ sentAt: -1 });

        let streakIncremented = false; // Track if we should show milestone
        
        if (completedLesson) {
          completedLesson.status = 'completed';
          completedLesson.completedAt = new Date();
          await completedLesson.save();
          console.log(`✅ Lesson ${completedLesson._id} marked as completed`);
          
          // === LESSON-BASED STREAK TRACKING ===
          // Streak increments on each consecutive lesson completion
          // Independent of calendar days
          user.streak += 1;
          streakIncremented = true;
          console.log(`🔥 Lesson completed! Streak: ${user.streak - 1} → ${user.streak}`);

          // Real learner activity (not background cron delivery) - the basis
          // for both the FIRST_LESSON_COMPLETED milestone and D1/3/7/14/30 retention.
          const { recordLearnerEvent, recordDayActiveMilestones } = require('../services/retentionService');
          await recordLearnerEvent(user._id, 'FIRST_LESSON_COMPLETED');
          await recordDayActiveMilestones(user);

        } else {
          // No new lesson to complete (already completed or not found)
          console.log(`ℹ️ No pending lesson found to mark as completed. Streak unchanged: ${user.streak}`);
        }
        
        // Update completion tracking fields
        user.lastLessonCompletedDate = new Date();
        user.lessonCompleted = true;
        user.lessonCompletedAt = new Date();
        user.weeklyCompletedCount += 1; // Increment weekly counter
        await user.save();
        
        console.log(`📝 User completion tracking updated:`);
        
        // Log streak update
        await Log.create({
          type: 'STREAK_UPDATED',
          userPhone: user.phone,
          message: `Streak updated to ${user.streak}`,
          status: 'SUCCESS',
          timestamp: new Date(),
          metadata: {
            streak: user.streak,
            currentDay: user.currentDay
          }
        });
        
        // Send main streak confirmation message
        await sendWhatsAppMessage(
          phone,
          `🔥 Great job ${user.name}!\n\nYour current streak is ${user.streak} day${user.streak > 1 ? 's' : ''}.\n\nComplete tomorrow's lesson to keep it growing!`
        );
        
        // Check for milestone celebrations (only if streak was actually incremented)
        if (streakIncremented) {
          const milestoneDays = [3, 7, 14, 30];
          
          if (milestoneDays.includes(user.streak)) {
            await sendTemplateMessage(
              phone,
              'streak_reminder',
              [user.name, user.streak.toString()],
              'en'
            );
            
            await Log.create({
              type: 'STREAK_MILESTONE',
              userPhone: user.phone,
              message: `${user.streak}-day streak milestone reached.`,
              status: 'SUCCESS',
              timestamp: new Date(),
              metadata: {
                milestone: user.streak
              }
            });
            
            console.log(`🎊 Milestone reached! ${user.name} achieved ${user.streak}-day streak`);
          }
        }
        
        await Log.create({ type: 'LESSON_COMPLETED', phone, message: `User confirmed completion for day ${user.currentDay - 1}. Streak: ${user.streak}` });
        console.log(`✅ Lesson completion confirmed. Streak: ${user.streak}`);
      }
      // Handle "UPGRADE" command - User wants to extend subscription
      else if (text === 'UPGRADE') {
        console.log(`💰 User ${phone} requested upgrade`);
        
        // Fetch all plans from database
        const allPlans = await PlanMaster.find({}).sort({ level: 1, days: 1 });
        
        if (allPlans.length === 0) {
          await sendWhatsAppMessage(phone, 'Sorry, no plans are currently available. Please contact support.');
          return;
        }
        
        // Group plans by level
        const plansByLevel = {
          bigenner: [],
          intermidiate: [],
          advance: []
        };
        
        allPlans.forEach(plan => {
          if (plansByLevel[plan.level]) {
            plansByLevel[plan.level].push(plan);
          }
        });
        
        // Build message with all plans
        const today = new Date();
        const isExpiredOrInactive = !user.isActive || (user.expiryDate && user.expiryDate < today);
        
        let upgradeMessage = isExpiredOrInactive
          ? `Hi ${user.name},\n\nRenew your plan to continue learning:\n\n`
          : `Hi ${user.name},\n\nChoose your upgrade plan:\n\n`;
        
        // Add Beginner plans
        if (plansByLevel.bigenner.length > 0) {
          upgradeMessage += `🟢 *Beginner Level* (Code: *B*)\n`;
          plansByLevel.bigenner.forEach(plan => {
            upgradeMessage += `   ${plan.days} Days - ₹${plan.price}\n`;
          });
          upgradeMessage += '\n';
        }
        
        // Add Intermediate plans
        if (plansByLevel.intermidiate.length > 0) {
          upgradeMessage += `🟡 *Intermediate Level* (Code: *I*)\n`;
          plansByLevel.intermidiate.forEach(plan => {
            upgradeMessage += `   ${plan.days} Days - ₹${plan.price}\n`;
          });
          upgradeMessage += '\n';
        }
        
        // Add Advanced plans
        if (plansByLevel.advance.length > 0) {
          upgradeMessage += `🔴 *Advanced Level* (Code: *A*)\n`;
          plansByLevel.advance.forEach(plan => {
            upgradeMessage += `   ${plan.days} Days - ₹${plan.price}\n`;
          });
          upgradeMessage += '\n';
        }
        
        upgradeMessage += `📝 *How to reply:*\n`;
        upgradeMessage += `• Just days (e.g., *90*) - keeps ${user.level}\n`;
        upgradeMessage += `• Code + days (e.g., *B 90* or *I 30*)\n`;
        upgradeMessage += `• Full name + days (e.g., *beginner 90*)\n`;
        upgradeMessage += `• With promo: *90 PROMO50* or *B 90 SAVE20*\n\n`;
        upgradeMessage += `⚠️ *Note:* Changing level resets to Day 1\n`;
        upgradeMessage += `🔥 Your ${user.streak}-day streak will be preserved!`;
        
        await sendWhatsAppMessage(phone, upgradeMessage);
        
        await Log.create({
          type: 'UPGRADE_REQUESTED',
          userPhone: phone,
          message: 'User requested upgrade options',
          status: 'SUCCESS'
        });
        
        console.log(`✅ Upgrade options sent to ${user.name}`);
      }
      // Handle plan selection: Can be "30", "90", "365" OR "beginner 90", "B90", "I 30" OR "90 PROMO50", "B 90 SAVE20", etc.
      else if ((text && text.match(/^(beginner|intermediate|advanced|b|i|a)?\s*(30|90|365)(\s+[A-Za-z0-9]+)?$/i)) || ['30', '90', '365'].includes(text)) {
        console.log(`📅 User ${phone} selected plan: ${text}`);
        
        // Parse input
        let selectedLevel = user.level; // Default to current level
        let planDuration;
        let promoCode = null;
        
        // Check if level and/or promo code is specified
        const match = text.match(/^(beginner|intermediate|advanced|b|i|a)?\s*(30|90|365)(\s+([A-Za-z0-9]+))?$/i);
        if (match) {
          const levelInput = match[1] ? match[1].toLowerCase() : null;
          planDuration = parseInt(match[2]);
          promoCode = match[4] ? match[4].toUpperCase().trim() : null;
          
          // Map short codes and full names
          if (levelInput) {
            if (levelInput === 'b' || levelInput === 'beginner') selectedLevel = 'beginner';
            else if (levelInput === 'i' || levelInput === 'intermediate') selectedLevel = 'intermediate';
            else if (levelInput === 'a' || levelInput === 'advanced') selectedLevel = 'advanced';
          }
        } else {
          // Just duration, keep current level
          planDuration = parseInt(text);
        }
        
        const dbLevel = LEVEL_MAP[selectedLevel] || 'bigenner';
        
        console.log(`📊 Plan selection details:`);
        console.log(`   User current level: ${user.level}`);
        console.log(`   Selected level: ${selectedLevel}`);
        console.log(`   Selected duration: ${planDuration} days`);
        console.log(`   Database level: ${dbLevel}`);
        
        // Fetch plan from database
        const plan = await PlanMaster.findOne({ 
          level: dbLevel, 
          days: planDuration 
        });
        
        if (!plan) {
          await sendWhatsAppMessage(
            phone,
            `Sorry, the ${planDuration}-day ${selectedLevel} plan is not available. Please try another option or contact support.`
          );
          console.log(`❌ Plan not found: ${dbLevel} - ${planDuration} days`);
          return;
        }
        
        console.log(`✅ Plan found: ${selectedLevel} - ${planDuration} days - ₹${plan.price}`);
        
        let originalAmountPaise = plan.price * 100;
        let finalAmountPaise = originalAmountPaise;
        let discountAmountPaise = 0;
        let promoValidation = null;
        
        // Validate and apply promo code if provided
        if (promoCode) {
          console.log(`🎟️  Validating promo code: ${promoCode}`);
          
          promoValidation = await validatePromoCode(
            promoCode,
            user._id.toString(),
            plan.price,
            selectedLevel,
            planDuration,
            phone
          );
          
          if (promoValidation.valid) {
            discountAmountPaise = promoValidation.discountAmount * 100;
            finalAmountPaise = promoValidation.finalAmount * 100;
            
            console.log(`✅ Promo code valid:`);
            console.log(`   Original: ₹${plan.price}`);
            console.log(`   Discount: ₹${promoValidation.discountAmount}`);
            console.log(`   Final: ₹${promoValidation.finalAmount}`);
            
            // Send confirmation message about discount
            await sendWhatsAppMessage(
              phone,
              `🎉 Great! Promo code *${promoCode}* applied!\n\n` +
              `Original: ₹${plan.price}\n` +
              `Discount: -₹${promoValidation.discountAmount}\n` +
              `*Final Amount: ₹${promoValidation.finalAmount}*\n\n` +
              `Proceeding with payment link...`
            );
          } else {
            console.log(`❌ Invalid promo code: ${promoValidation.message}`);
           
            await sendWhatsAppMessage(
              phone,
              `❌ Promo code *${promoCode}* is invalid:\n${promoValidation.message}\n\n` +
              `Proceeding without discount at ₹${plan.price}`
            );
            
            // Reset promo code so we don't store invalid code
            promoCode = null;
          }
        }
        
        // Check if level will change (for messaging purposes)
        const levelWillChange = selectedLevel !== user.level;
        console.log(`📊 Level change: ${levelWillChange ? `Yes (${user.level} → ${selectedLevel})` : `No (keeping ${user.level})`}`);
        
        try {
          // Create Razorpay Payment Link (works for WhatsApp sharing)
          const description = promoCode 
            ? `English Course Upgrade - ${selectedLevel} - ${planDuration} Days (${promoCode} applied)`
            : `English Course Upgrade - ${selectedLevel} - ${planDuration} Days`;
          
          const paymentLinkResponse = await razorpay.paymentLink.create({
            amount: finalAmountPaise,
            currency: 'INR',
            description: description,
            customer: {
              name: user.name,
              contact: phone,
              email: user.email || ''
            },
            notify: {
              sms: false,
              email: false
            },
            reminder_enable: false,
            callback_url: `${process.env.SERVER_URL || 'http://localhost:3001'}/api/payments/verify-upgrade`,
            callback_method: 'get',
            notes: {
              type: 'upgrade',
              userId: user._id.toString(),
              name: user.name,
              phone: phone,
              email: user.email,
              level: selectedLevel,
              planDuration: planDuration.toString()
            }
          });
          
          // Create PendingOrder record with payment link ID
          // Note: order_id doesn't exist yet - it's created when user starts payment
          await PendingOrder.create({
            razorpayOrderId: paymentLinkResponse.id, // Store payment link ID temporarily
            paymentLinkId: paymentLinkResponse.id, // Payment link ID for matching
            name: user.name,
            phone: phone,
            email: user.email || '',
            level: selectedLevel,
            planDuration: planDuration,
            amountPaise: finalAmountPaise,
            originalAmountPaise: promoCode ? originalAmountPaise : null,
            discountAmountPaise: promoCode ? discountAmountPaise : 0,
            promoCode: promoCode || null,
            status: 'created',
            type: 'upgrade',
            userId: user._id
          });
          
          // Use the short_url from payment link response
          const paymentLink = paymentLinkResponse.short_url;
          
          // Create readable level name
          const levelDisplay = selectedLevel.charAt(0).toUpperCase() + selectedLevel.slice(1);
          const levelCode = selectedLevel === 'beginner' ? 'B' : selectedLevel === 'intermediate' ? 'I' : 'A';
          
          // Build amount display with promo if applied
          let amountDisplay = '';
          if (promoCode && promoValidation && promoValidation.valid) {
            const finalAmount = finalAmountPaise / 100;
            const originalAmount = originalAmountPaise / 100;
            const discount = discountAmountPaise / 100;
            amountDisplay = `💰 Amount:\n   Original: ₹${originalAmount}\n   Discount: -₹${discount}\n   *Final: ₹${finalAmount}*`;
          } else {
            amountDisplay = `💰 Amount: ₹${plan.price}`;
          }
          
          const confirmMessage = levelWillChange
            ? `💳 *Your upgrade order is ready!*\n\n📚 Level: ${levelDisplay} (${levelCode})\n📅 Duration: ${planDuration} Days\n${amountDisplay}\n\n🔗 Pay here: ${paymentLink}\n\n✨ After payment:\n• Subscription extended\n• Level updated to ${levelDisplay}\n• Progress resets to Day 1`
            : `💳 *Your upgrade order is ready!*\n\n📚 Level: ${levelDisplay} (${levelCode})\n📅 Duration: ${planDuration} Days\n${amountDisplay}\n\n🔗 Pay here: ${paymentLink}\n\n✨ Your subscription will be extended after payment.`;
          
          await sendWhatsAppMessage(phone, confirmMessage);
          
          await Log.create({
            type: 'UPGRADE_ORDER_CREATED',
            userPhone: phone,
            message: promoCode 
              ? `Upgrade payment link created for ${selectedLevel} - ${planDuration} days - ₹${finalAmountPaise/100} (Promo: ${promoCode})`
              : `Upgrade payment link created for ${selectedLevel} - ${planDuration} days - ₹${plan.price}`,
            status: 'SUCCESS',
            metadata: {
              paymentLinkId: paymentLinkResponse.id,
              amount: finalAmountPaise,
              originalAmount: promoCode ? originalAmountPaise : null,
              discountAmount: promoCode ? discountAmountPaise : 0,
              promoCode: promoCode || null,
              planDuration,
              level: selectedLevel,
              levelWillChange: levelWillChange,
              price: plan.price,
              shortUrl: paymentLink
            }
          });
          
          console.log(`✅ Upgrade payment link created: ${paymentLinkResponse.id} for ${user.name} (${selectedLevel} - ${planDuration} days - ₹${plan.price})`);
          
        } catch (error) {
          console.error(`❌ Error creating upgrade order:`, error);
          
          await sendWhatsAppMessage(
            phone,
            `Sorry, there was an error processing your upgrade request. Please try again or contact support.`
          );
          
          await Log.create({
            type: 'ERROR',
            userPhone: phone,
            message: `Upgrade order creation failed: ${error.message}`,
            status: 'ERROR'
          });
        }
      }
      else {
        console.log(`ℹ️ Message "${text}" ignored - User state: ${user.state}`);
      }
      } catch (msgErr) {
        console.error(`❌ Error processing message ${msg.id} from ${msg.from}:`, msgErr.message);
        await Log.create({
          type: 'WEBHOOK_MESSAGE_ERROR',
          phone: msg.from,
          message: `Failed to process message ${msg.id}: ${msgErr.message}`,
          status: 'ERROR'
        }).catch(() => {});
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook error:', err);
    await Log.create({ type: 'ERROR', message: err.message });
    next(err);
  }
};
