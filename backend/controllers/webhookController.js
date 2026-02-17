const User = require('../models/User');
const Log = require('../models/Log');
const { sendWhatsAppMessage } = require('../services/whatsappService');

const dedupedMessages = new Set();

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
      
      if (dedupedMessages.has(msg.id)) {
        console.log(`⏭️ Duplicate message skipped: ${msg.id}`);
        continue;
      }
      dedupedMessages.add(msg.id);
      
      const phone = msg.from;
      const text = msg.text?.body?.trim().toUpperCase();
      const user = await User.findOne({ phone });
      
      if (!user) {
        console.log(`⚠️ User not found for phone: ${phone}`);
        continue;
      }
      
      console.log(`👤 User found: ${user.name} (${phone}) - State: ${user.state}`);
      await Log.create({ type: 'MESSAGE_RECEIVED', phone, message: text });
      
      // Handle "START" command - User wants to receive lesson
      if (text === 'START' && user.state === 'WAITING_START') {
        console.log(`🚀 Sending lesson to ${phone} for Day ${user.currentDay}`);
        await sendWhatsAppMessage(phone, user.lessonText);
        
        // Increment day and set READY for tomorrow (NO lessonCompleted update)
        user.currentDay += 1;
        user.state = 'READY';
        user.lastSeenAt = new Date();
        await user.save();
        
        await Log.create({ type: 'LESSON_STARTED', phone, message: `User received day ${user.currentDay - 1} lesson, now on day ${user.currentDay}` });
        console.log(`✅ Lesson sent! Day: ${user.currentDay - 1} → ${user.currentDay}, State: READY`);
      } 
      // Handle "DONE" command - User confirms completion (optional)
      else if (text === 'DONE' && user.state === 'READY') {
        console.log(`🎉 User ${phone} marked lesson as completed`);
        
        // Mark lesson as completed (day already incremented on START)
        user.lessonCompleted = true;
        user.lessonCompletedAt = new Date();
        await user.save();
        
        await sendWhatsAppMessage(phone, `Great job! Lesson marked as complete. See you tomorrow for Day ${user.currentDay}! 🎉`);
        await Log.create({ type: 'LESSON_COMPLETED', phone, message: `User confirmed completion for day ${user.currentDay - 1}` });
        console.log(`✅ Lesson completion confirmed by user`);
      }
      else {
        console.log(`ℹ️ Message "${text}" ignored - User state: ${user.state}`);
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook error:', err);
    await Log.create({ type: 'ERROR', message: err.message });
    next(err);
  }
};
