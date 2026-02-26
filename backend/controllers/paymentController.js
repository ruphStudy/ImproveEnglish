const Razorpay = require('razorpay');
const crypto = require('crypto');
const PendingOrder = require('../models/PendingOrder');
const User = require('../models/User');
const Log = require('../models/Log');
const whatsappService = require('../services/whatsappService');
const PlanMaster = require('../models/PlanMaster');
const PaymentHistory = require('../models/PaymentHistory');

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Map frontend level names to database level names
const LEVEL_MAP = {
  'beginner': 'bigenner',
  'intermediate': 'intermidiate',
  'advanced': 'advance'
};

// Phone normalization utility (reused from existing userController)
function normalizePhone(phone) {
  if (!phone) return null;
  // Remove any spaces, dashes, or other characters
  let normalized = phone.replace(/[\s\-\(\)]/g, '');
  // Remove leading + if present
  normalized = normalized.replace(/^\+/, '');
  // Add 91 if not present
  if (!normalized.startsWith('91')) {
    normalized = '91' + normalized;
  }
  return normalized;
}

// Create Razorpay Order
exports.createOrder = async (req, res) => {
  try {
    const { name, phone, email, level, planDuration, utmSource } = req.body;

    // Validation
    if (!name || !phone || !email || !level || !planDuration) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: name, phone, email, level, planDuration'
      });
    }

    // Validate level
    if (!['beginner', 'intermediate', 'advanced'].includes(level)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid level. Must be beginner, intermediate, or advanced'
      });
    }

    // Normalize phone
    const normalizedPhone = normalizePhone(phone);

    // Map level to database format
    const dbLevel = LEVEL_MAP[level];

    // Fetch plan from database
    const plan = await PlanMaster.findOne({ 
      level: dbLevel, 
      days: parseInt(planDuration) 
    });

    if (!plan) {
      return res.status(400).json({
        success: false,
        message: `No plan found for level ${level} with ${planDuration} days`
      });
    }

    // Get amount in paise (multiply by 100)
    const amountPaise = plan.price * 100;

    // Create Razorpay order
    const razorpayOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `order_${Date.now()}_${normalizedPhone}`,
      notes: {
        name,
        phone: normalizedPhone,
        email,
        level,
        planDuration: planDuration.toString()
      }
    });

    // Create PendingOrder record
    const pendingOrder = new PendingOrder({
      razorpayOrderId: razorpayOrder.id,
      name,
      phone: normalizedPhone,
      email,
      level,
      planDuration,
      amountPaise,
      status: 'created',
      utmSource: utmSource || null
    });

    await pendingOrder.save();

    console.log(`📦 Order created: ${razorpayOrder.id} for ${name} (${normalizedPhone})`);

    // Log to database
    await Log.create({
      type: 'ORDER_CREATED',
      userPhone: normalizedPhone,
      message: `Order created for ${planDuration} days plan`,
      status: 'SUCCESS',
      metadata: {
        orderId: razorpayOrder.id,
        amount: amountPaise,
        level
      }
    });

    // Return details for frontend
    res.json({
      success: true,
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: razorpayOrder.id,
      amountPaise,
      currency: 'INR'
    });

  } catch (error) {
    console.error('❌ Error creating order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create order',
      error: error.message
    });
  }
};

// Razorpay Webhook Handler
exports.handleWebhook = async (req, res) => {
  console.log('\n🔔 ========== WEBHOOK RECEIVED ==========');
  console.log('📍 Endpoint hit: POST /api/payments/razorpay-webhook');
  console.log('⏰ Time:', new Date().toISOString());
  
  try {
    // Get signature from headers
    const signature = req.headers['x-razorpay-signature'];
    console.log('🔑 Signature received:', signature ? 'YES ✅' : 'NO ❌');
    
    if (!signature) {
      console.log('❌ No signature found in webhook');
      console.log('🔔 ========== WEBHOOK END (NO SIGNATURE) ==========\n');
      return res.status(400).json({ success: false, message: 'No signature' });
    }

    // Get raw body (must use express.raw middleware)
    const body = req.body.toString('utf8');
    console.log('📦 Body length:', body.length, 'bytes');
    console.log('📄 Body preview:', body.substring(0, 200) + '...');

    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(body)
      .digest('hex');

    console.log('🔐 Signature verification:');
    console.log('   Received:', signature);
    console.log('   Expected:', expectedSignature);
    console.log('   Match:', signature === expectedSignature ? '✅ YES' : '❌ NO');

    if (signature !== expectedSignature) {
      console.log('❌ Invalid webhook signature');
      console.log('🔔 ========== WEBHOOK END (INVALID SIGNATURE) ==========\n');
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    // Parse event
    const event = JSON.parse(body);
    console.log(`📥 Event Type: ${event.event}`);
    console.log('📋 Full event data:', JSON.stringify(event, null, 2));

    // Handle payment.captured event
    if (event.event === 'payment.captured') {
      console.log('✅ Event is payment.captured - Processing...');
      
      const payment = event.payload.payment.entity;
      const orderId = payment.order_id;
      const paymentId = payment.id;
      const amountPaid = payment.amount;

      console.log(`💰 Payment Details:`);
      console.log(`   Payment ID: ${paymentId}`);
      console.log(`   Order ID: ${orderId}`);
      console.log(`   Amount Paid: ₹${amountPaid / 100}`);

      // Find pending order - try order_id first, then check description for payment link ID
      console.log(`🔍 Searching for pending order: ${orderId}`);
      let pendingOrder = await PendingOrder.findOne({ razorpayOrderId: orderId });
      console.log('📋 Pending order found by order_id:', pendingOrder ? 'YES ✅' : 'NO ❌');
      
      // If not found, try payment link ID from description (format: #plink_xxx)
      if (!pendingOrder && payment.description) {
        const paymentLinkId = payment.description.replace('#', '');
        console.log(`🔍 Trying payment link ID from description: ${paymentLinkId}`);
        pendingOrder = await PendingOrder.findOne({ paymentLinkId: paymentLinkId });
        console.log('📋 Pending order found by payment link ID:', pendingOrder ? 'YES ✅' : 'NO ❌');
      }
      
      if (!pendingOrder) {
        console.log(`⚠️ No pending order found for ${orderId} or description ${payment.description}`);
        console.log('🔔 ========== WEBHOOK END (ORDER NOT FOUND) ==========\n');
        return res.status(200).json({ success: true, message: 'Order not found, ignored' });
      }

      // Update order ID if found by payment link ID (for future reference)
      if (pendingOrder.razorpayOrderId !== orderId) {
        console.log(`📝 Updating order ID from ${pendingOrder.razorpayOrderId} to ${orderId}`);
        pendingOrder.razorpayOrderId = orderId;
      }

      console.log('📝 Order Details:');
      console.log(`   Name: ${pendingOrder.name}`);
      console.log(`   Phone: ${pendingOrder.phone}`);
      console.log(`   Email: ${pendingOrder.email}`);
      console.log(`   Level: ${pendingOrder.level}`);
      console.log(`   Plan: ${pendingOrder.planDuration} days`);
      console.log(`   Status: ${pendingOrder.status}`);

      // Check if already processed
      if (pendingOrder.status === 'paid') {
        console.log(`⚠️ Order ${orderId} already processed`);
        console.log('🔔 ========== WEBHOOK END (ALREADY PROCESSED) ==========\n');
        return res.status(200).json({ success: true, message: 'Already processed' });
      }

      // Verify amount
      console.log(`💵 Amount Verification:`);
      console.log(`   Expected: ₹${pendingOrder.amountPaise / 100}`);
      console.log(`   Received: ₹${amountPaid / 100}`);
      console.log(`   Match: ${amountPaid === pendingOrder.amountPaise ? '✅ YES' : '❌ NO'}`);
      
      if (amountPaid !== pendingOrder.amountPaise) {
        console.log(`⚠️ Amount mismatch for ${orderId}: expected ${pendingOrder.amountPaise}, got ${amountPaid}`);
        await Log.create({
          type: 'PAYMENT_ERROR',
          userPhone: pendingOrder.phone,
          message: 'Amount mismatch in payment',
          status: 'ERROR',
          metadata: { orderId, expected: pendingOrder.amountPaise, received: amountPaid }
        });
        console.log('🔔 ========== WEBHOOK END (AMOUNT MISMATCH) ==========\n');
        return res.status(200).json({ success: true, message: 'Amount mismatch' });
      }

      // Check if user already exists
      console.log(`🔍 Checking if user exists: ${pendingOrder.phone}`);
      const existingUser = await User.findOne({ phone: pendingOrder.phone });
      console.log('👤 Existing user found:', existingUser ? 'YES' : 'NO');
      if (existingUser) {
        console.log(`   User ID: ${existingUser._id}`);
        console.log(`   Is Active: ${existingUser.isActive}`);
        console.log(`   State: ${existingUser.state}`);
      }

      // === HANDLE UPGRADE TYPE ===
      if (pendingOrder.type === 'upgrade') {
        console.log('🔄 Processing UPGRADE payment...');
        
        if (!existingUser) {
          console.log(`❌ Upgrade payment but user not found: ${pendingOrder.phone}`);
          return res.status(200).json({ success: true, message: 'User not found for upgrade' });
        }
        
        // Calculate new expiry date
        const today = new Date();
        const extensionDays = pendingOrder.planDuration;
        let newExpiryDate;
        
        if (existingUser.expiryDate && existingUser.expiryDate > today) {
          // Extend from current expiry date
          newExpiryDate = new Date(existingUser.expiryDate);
          newExpiryDate.setDate(newExpiryDate.getDate() + extensionDays);
          console.log(`📅 Extending from existing expiry: ${existingUser.expiryDate.toISOString().split('T')[0]} + ${extensionDays} days`);
        } else {
          // Start from today if expired or no expiry date
          newExpiryDate = new Date();
          newExpiryDate.setDate(newExpiryDate.getDate() + extensionDays);
          console.log(`📅 Starting from today + ${extensionDays} days`);
        }
        
        console.log(`📅 New Expiry Date: ${newExpiryDate.toISOString().split('T')[0]}`);
        
        // Update user - extend subscription without resetting progress
        existingUser.expiryDate = newExpiryDate;
        existingUser.isActive = true;
        // Reset reminder flags for new subscription period
        existingUser.sevenDayReminderSent = false;
        existingUser.threeDayReminderSent = false;
        // DO NOT reset: currentDay, streak, lastLessonCompletedDate, state
        
        const user = await existingUser.save();
        console.log(`✅ Subscription extended successfully`);
        console.log(`   User: ${user.name}`);
        console.log(`   New Expiry: ${user.expiryDate.toISOString().split('T')[0]}`);
        console.log(`   Streak Preserved: ${user.streak}`);
        console.log(`   Current Day Preserved: ${user.currentDay}`);
        
        // Update pending order status
        pendingOrder.status = 'paid';
        await pendingOrder.save();
        
        // Save payment history
        console.log('💳 Saving payment history...');
        await PaymentHistory.create({
          userId: user._id,
          name: pendingOrder.name,
          phone: pendingOrder.phone,
          email: pendingOrder.email,
          level: pendingOrder.level,
          planDuration: pendingOrder.planDuration,
          planName: `plan${pendingOrder.planDuration}`,
          amountPaid: amountPaid / 100,
          currency: 'INR',
          razorpayOrderId: orderId,
          razorpayPaymentId: paymentId,
          paymentMethod: payment.method || 'unknown',
          paymentStatus: 'success',
          expiryDate: newExpiryDate,
          utmSource: pendingOrder.utmSource
        });
        console.log('✅ Payment history saved');
        
        // Send WhatsApp confirmation
        const formattedDate = newExpiryDate.toLocaleDateString('en-IN', {
          day: 'numeric',
          month: 'long',
          year: 'numeric'
        });
        
        await whatsappService.sendWhatsAppMessage(
          pendingOrder.phone,
          `🎉 Upgrade successful!\n\nYour plan is now active until ${formattedDate}.\n\nKeep up your streak of ${user.streak} day${user.streak !== 1 ? 's' : ''}! 🔥`
        );
        
        await Log.create({
          type: 'UPGRADE_SUCCESS',
          userPhone: pendingOrder.phone,
          message: `Subscription extended by ${extensionDays} days`,
          status: 'SUCCESS',
          metadata: {
            orderId,
            paymentId,
            newExpiryDate,
            extensionDays,
            streakPreserved: user.streak
          }
        });
        
        console.log('🔔 ========== WEBHOOK END (UPGRADE SUCCESS) ==========\n');
        return res.status(200).json({ success: true, message: 'Upgrade successful' });
      }

      // === HANDLE NEW USER TYPE (DEFAULT) ===
      if (existingUser && existingUser.isActive) {
        console.log(`⚠️ User ${pendingOrder.phone} already active, duplicate payment`);
        
        // Update pending order status
        pendingOrder.status = 'paid';
        await pendingOrder.save();

        // Log duplicate payment
        await Log.create({
          type: 'DUPLICATE_PAYMENT',
          userPhone: pendingOrder.phone,
          message: 'Payment received for already active user',
          status: 'WARNING',
          metadata: { orderId, paymentId }
        });
        
        console.log('🔔 ========== WEBHOOK END (DUPLICATE PAYMENT) ==========\n');
        return res.status(200).json({ success: true, message: 'User already active' });
      }

      // Calculate expiry date
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + pendingOrder.planDuration);
      console.log(`📅 Expiry Date: ${expiryDate.toISOString().split('T')[0]}`);

      // Create or update user
      console.log('👤 Creating/Updating user...');
      let user;
      if (existingUser) {
        console.log('♻️ Reactivating existing user...');
        // Reactivate existing user
        existingUser.isActive = true;
        existingUser.expiryDate = expiryDate;
        existingUser.level = pendingOrder.level;
        existingUser.name = pendingOrder.name;
        existingUser.email = pendingOrder.email;
        existingUser.state = 'READY';
        existingUser.currentDay = 1;
        existingUser.lessonCompleted = false;
        // Reset expiry reminder flags for new subscription period
        existingUser.sevenDayReminderSent = false;
        existingUser.threeDayReminderSent = false;
        user = await existingUser.save();
        console.log(`✅ User reactivated successfully: ${pendingOrder.phone}`);
      } else {
        console.log('🆕 Creating new user...');
        // Create new user
        user = new User({
          name: pendingOrder.name,
          phone: pendingOrder.phone,
          email: pendingOrder.email,
          level: pendingOrder.level,
          isActive: true,
          state: 'READY',
          currentDay: 1,
          lessonText: '',
          lessonCompleted: false,
          expiryDate: expiryDate,
        });
        user = await user.save();
        console.log(`✅ New user created successfully: ${pendingOrder.phone}`);
      }

      console.log('💾 User saved to database:');
      console.log(`   User ID: ${user._id}`);
      console.log(`   Phone: ${user.phone}`);
      console.log(`   Active: ${user.isActive}`);
      console.log(`   Expiry: ${user.expiryDate.toISOString().split('T')[0]}`);

      // Save payment history
      console.log('💳 Saving payment history...');
      await PaymentHistory.create({
        userId: user._id,
        name: pendingOrder.name,
        phone: pendingOrder.phone,
        email: pendingOrder.email,
        level: pendingOrder.level,
        planDuration: pendingOrder.planDuration,
        planName: `plan${pendingOrder.planDuration}`,
        amountPaid: amountPaid / 100, // Convert paise to rupees
        currency: 'INR',
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        paymentMethod: payment.method || 'unknown',
        paymentStatus: 'success',
        expiryDate: expiryDate,
        utmSource: pendingOrder.utmSource
      });
      console.log('✅ Payment history saved');

      // Send WhatsApp welcome message using approved template
      console.log('📱 === SENDING WELCOME MESSAGE ===');
      console.log('   Phone:', pendingOrder.phone);
      console.log('   Template: payment_welcome_new');
      const formattedExpiryDate = expiryDate.toISOString().split('T')[0];
      try {
        const whatsappResult = await whatsappService.sendTemplateMessage(
          pendingOrder.phone,
          'payment_welcome_new',
          [
            user.name,                            // {{1}} = User Name (e.g., "Rajesh")
            pendingOrder.planDuration.toString(), // {{2}} = Plan Duration (e.g., "30")
            pendingOrder.level,                   // {{3}} = Level (e.g., "beginner")
            formattedExpiryDate                   // {{4}} = Expiry Date (e.g., "2026-03-24")
          ],
          'en_US'
        );
        console.log('✅ WhatsApp welcome message sent successfully');
        console.log('   WhatsApp Message ID:', whatsappResult?.messages?.[0]?.id);
      } catch (whatsappError) {
        console.error('❌ === WHATSAPP SEND FAILED ===');
        console.error('   Error Message:', whatsappError.message);
        console.error('   Error Stack:', whatsappError.stack);
        console.error('   Response Data:', whatsappError.response?.data);
        // Don't fail webhook if WhatsApp fails - user still activated
      }
      console.log('📱 === WELCOME MESSAGE COMPLETE ===');

      // Update pending order
      console.log('📝 Updating pending order status to "paid"...');
      pendingOrder.status = 'paid';
      await pendingOrder.save();
      console.log('✅ Pending order updated');

      // Log success
      console.log('📊 Creating payment success log...');
      await Log.create({
        type: 'PAYMENT_SUCCESS',
        userPhone: pendingOrder.phone,
        message: `User activated with ${pendingOrder.planDuration}-day plan`,
        status: 'SUCCESS',
        metadata: {
          orderId,
          paymentId,
          planDuration: pendingOrder.planDuration,
          expiryDate: expiryDate,
        },
      });
      console.log('✅ Log entry created');

      console.log('🎉 Payment processed successfully!');
      console.log('🔔 ========== WEBHOOK END (SUCCESS) ==========\n');
      return res.status(200).json({ success: true, message: 'Payment processed' });
    }

    // If not payment.captured event
    console.log(`ℹ️ Event ${event.event} - Not processing`);
    console.log('🔔 ========== WEBHOOK END (OTHER EVENT) ==========\n');
    return res.status(200).json({ success: true, message: 'Event received' });

  } catch (error) {
    console.error('❌ ========== WEBHOOK ERROR ==========');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('🔔 ========== WEBHOOK END (ERROR) ==========\n');
    // Always return 200 to prevent Razorpay retries
    return res.status(200).json({ success: false, message: error.message });
  }
};

// Get order status (optional, for frontend polling)
exports.getOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;

    const pendingOrder = await PendingOrder.findOne({ razorpayOrderId: orderId });

    if (!pendingOrder) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    let userActivated = false;
    if (pendingOrder.status === 'paid') {
      const user = await User.findOne({ phone: pendingOrder.phone });
      userActivated = user && user.isActive;
    }

    res.json({
      success: true,
      status: pendingOrder.status,
      userActivated,
      planDuration: pendingOrder.planDuration,
      level: pendingOrder.level
    });

  } catch (error) {
    console.error('❌ Error checking order status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check order status'
    });
  }
};

// Verify Upgrade Payment (Callback from Razorpay Payment Link)
exports.verifyUpgradePayment = async (req, res) => {
  console.log('\n💳 ========== UPGRADE PAYMENT VERIFICATION ==========');
  console.log('📍 Endpoint hit: GET /api/payment/verify-upgrade');
  console.log('⏰ Time:', new Date().toISOString());
  
  try {
    const {
      razorpay_payment_id,
      razorpay_payment_link_id,
      razorpay_payment_link_reference_id,
      razorpay_payment_link_status,
      razorpay_signature
    } = req.query;
    
    console.log('📦 Payment Details:', {
      payment_id: razorpay_payment_id,
      link_id: razorpay_payment_link_id,
      status: razorpay_payment_link_status
    });
    
    // Check if payment was successful
    if (razorpay_payment_link_status !== 'paid') {
      console.log('❌ Payment not successful:', razorpay_payment_link_status);
      return res.send(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><title>Payment Failed</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: #dc3545;">❌ Payment Failed</h1>
          <p>Status: ${razorpay_payment_link_status}</p>
          <p>Please try again or contact support.</p>
        </body></html>
      `);
    }
    
    // Verify signature - Payment Link signature format:
    // HMAC_SHA256(payment_link_id + "|" + payment_link_reference_id + "|" + payment_link_status + "|" + payment_id)
    const signatureString = `${razorpay_payment_link_id}|${razorpay_payment_link_reference_id || ''}|${razorpay_payment_link_status}|${razorpay_payment_id}`;
    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(signatureString)
      .digest('hex');
    
    console.log('🔐 Signature Verification:');
    console.log('   String:', signatureString);
    console.log('   Generated:', generatedSignature);
    console.log('   Received:', razorpay_signature);
    
    if (generatedSignature !== razorpay_signature) {
      console.error('❌ Invalid signature');
      return res.send(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><title>Verification Failed</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: #dc3545;">❌ Verification Failed</h1>
          <p>Invalid payment signature. Please contact support.</p>
        </body></html>
      `);
    }
    
    console.log('✅ Signature verified');
    
    // Find pending order by payment link ID
    const pendingOrder = await PendingOrder.findOne({
      paymentLinkId: razorpay_payment_link_id,
      status: 'created'
    });
    
    if (!pendingOrder) {
      console.error('❌ No pending order found');
      return res.send(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><title>Order Not Found</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: #dc3545;">❌ Order Not Found</h1>
          <p>This order may have already been processed.</p>
        </body></html>
      `);
    }
    
    console.log('📦 Found pending order:', pendingOrder._id);
    
    // Find user
    const user = await User.findOne({ phone: pendingOrder.phone });
    
    if (!user) {
      console.error('❌ User not found:', pendingOrder.phone);
      return res.send(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><title>User Not Found</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: #dc3545;">❌ User Not Found</h1>
          <p>Please contact support with payment ID: ${razorpay_payment_id}</p>
        </body></html>
      `);
    }
    
    // Calculate new expiry date
    const currentExpiry = user.expiryDate && user.expiryDate > new Date() 
      ? new Date(user.expiryDate) 
      : new Date();
    
    const newExpiryDate = new Date(currentExpiry);
    newExpiryDate.setDate(newExpiryDate.getDate() + pendingOrder.planDuration);
    
    console.log('📅 Subscription update:');
    console.log('   Current expiry:', currentExpiry.toISOString().split('T')[0]);
    console.log('   New expiry:', newExpiryDate.toISOString().split('T')[0]);
    console.log('   Days added:', pendingOrder.planDuration);
    console.log('   Current level:', user.level);
    console.log('   New level:', pendingOrder.level);
    
    // Check if level is changing (before we update it)
    const levelChanged = user.level !== pendingOrder.level;
    const oldLevel = user.level;
    
    // Update user subscription
    user.expiryDate = newExpiryDate;
    user.isActive = true;
    user.level = pendingOrder.level; // Update level from pending order
    
    // If level changed, reset progress to start fresh at new level
    if (levelChanged) {
      const oldDay = user.currentDay;
      const oldState = user.state;
      user.currentDay = 1;
      user.state = 'READY';
      user.lessonText = '';
      user.lessonCompleted = false;
      console.log(`🔄 Level changed: Resetting progress`);
      console.log(`   Old: Day ${oldDay}, State ${oldState}`);
      console.log(`   New: Day 1, State READY`);
      console.log(`   Streak preserved: ${user.streak} days`);
    }
    
    // Reset reminder flags
    user.sevenDayReminderSent = false;
    user.threeDayReminderSent = false;
    await user.save();
    
    if (levelChanged) {
      console.log(`✅ User level updated from ${oldLevel} to ${pendingOrder.level} - Progress reset to Day 1`);
    } else {
      console.log(`✅ User level unchanged: ${user.level} - Progress preserved at Day ${user.currentDay}`);
    }
    
    // Update pending order status
    pendingOrder.status = 'paid';
    pendingOrder.razorpayPaymentId = razorpay_payment_id;
    await pendingOrder.save();
    
    // Try to fetch payment details for more information
    let paymentMethod = 'payment_link';
    try {
      const razorpay = require('../config/razorpay');
      const payment = await razorpay.payments.fetch(razorpay_payment_id);
      paymentMethod = payment.method || 'payment_link';
      console.log('💳 Payment method:', paymentMethod);
    } catch (fetchError) {
      console.log('⚠️ Could not fetch payment details, using default');
    }
    
    console.log('📝 Creating payment history with:', {
      userId: user._id.toString(),
      name: pendingOrder.name,
      phone: pendingOrder.phone,
      email: pendingOrder.email,
      level: pendingOrder.level,
      planDuration: pendingOrder.planDuration,
      amountPaid: pendingOrder.amountPaise / 100,
      expiryDate: newExpiryDate
    });
    
    // Create payment history record
    await PaymentHistory.create({
      userId: user._id,
      name: pendingOrder.name,
      phone: pendingOrder.phone,
      email: pendingOrder.email,
      level: pendingOrder.level,
      planDuration: pendingOrder.planDuration,
      planName: `plan${pendingOrder.planDuration}`,
      amountPaid: pendingOrder.amountPaise / 100,
      currency: 'INR',
      razorpayOrderId: razorpay_payment_link_id,
      razorpayPaymentId: razorpay_payment_id,
      paymentMethod: paymentMethod,
      paymentStatus: 'success',
      expiryDate: newExpiryDate
    });
    console.log('✅ Payment history record created');
    
    // Create readable level display
    const levelDisplay = pendingOrder.level.charAt(0).toUpperCase() + pendingOrder.level.slice(1);
    const levelCode = pendingOrder.level === 'beginner' ? 'B' : pendingOrder.level === 'intermediate' ? 'I' : 'A';
    
    // Send WhatsApp confirmation
    const confirmationMessage = levelChanged
      ? `🎉 *Payment Successful!*\n\n✅ Your subscription has been extended\n\n🔄 *Level Updated:* ${levelDisplay} (${levelCode})\n📅 Duration: ${pendingOrder.planDuration} days\n💰 Amount: ₹${pendingOrder.amountPaise / 100}\n📆 New expiry: ${newExpiryDate.toLocaleDateString('en-IN')}\n\n🆕 Starting fresh at Day 1 of ${levelDisplay} level!\n🔥 Your ${user.streak}-day streak is preserved!\n💪 Your next lesson will be ready soon.\n\nThank you for choosing English Improvement!`
      : `🎉 *Payment Successful!*\n\n✅ Your subscription has been extended\n\n📚 Level: ${levelDisplay} (${levelCode})\n📅 Duration: ${pendingOrder.planDuration} days\n💰 Amount: ₹${pendingOrder.amountPaise / 100}\n📆 New expiry: ${newExpiryDate.toLocaleDateString('en-IN')}\n\n🔥 Continue from where you left off at Day ${user.currentDay}!\n🔥 Keep your ${user.streak}-day streak alive!\n\nThank you for choosing English Improvement! 🚀`;
    
    await whatsappService.sendWhatsAppMessage(user.phone, confirmationMessage);
    
    // Log success
    const logMessage = levelChanged 
      ? `Upgrade payment successful - ${pendingOrder.planDuration} days added, level changed to ${pendingOrder.level}, progress reset to Day 1`
      : `Upgrade payment successful - ${pendingOrder.planDuration} days added`;
    
    await Log.create({
      type: 'UPGRADE_SUCCESS',
      userPhone: user.phone,
      message: logMessage,
      status: 'SUCCESS',
      metadata: {
        payment_id: razorpay_payment_id,
        link_id: razorpay_payment_link_id,
        amount: pendingOrder.amountPaise / 100,
        level: pendingOrder.level,
        levelChanged: levelChanged,
        oldLevel: oldLevel,
        progressReset: levelChanged,
        currentDay: user.currentDay,
        newExpiryDate
      }
    });
    
    console.log(`✅ Upgrade successful for: ${user.name} (${levelChanged ? `Level changed, reset to Day 1` : `Level unchanged, continuing Day ${user.currentDay}`})`);
    console.log('💳 ========== VERIFICATION COMPLETE ==========\n');
    
    // Return success page
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Payment Successful</title>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            margin: 0;
            padding: 20px;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .container {
            background: white;
            border-radius: 20px;
            padding: 40px;
            max-width: 500px;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          }
          .success-icon {
            font-size: 80px;
            animation: bounce 0.6s;
          }
          @keyframes bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-20px); }
          }
          h1 { color: #28a745; margin: 20px 0; }
          .details {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 20px;
            margin: 20px 0;
            text-align: left;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            margin: 10px 0;
            padding: 5px 0;
            border-bottom: 1px solid #dee2e6;
          }
          .detail-label { font-weight: 600; color: #6c757d; }
          .detail-value { color: #212529; }
          .message {
            color: #6c757d;
            line-height: 1.6;
            margin: 20px 0;
          }
          .close-btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 15px 40px;
            border-radius: 25px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            margin-top: 20px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success-icon">✅</div>
          <h1>Payment Successful!</h1>
          
          <div class="details">
            <div class="detail-row">
              <span class="detail-label">Level:</span>
              <span class="detail-value">${levelDisplay} (${levelCode})</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Plan Extended:</span>
              <span class="detail-value">${pendingOrder.planDuration} Days</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Amount Paid:</span>
              <span class="detail-value">₹${pendingOrder.amountPaise / 100}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">New Expiry:</span>
              <span class="detail-value">${newExpiryDate.toLocaleDateString('en-IN', {day: 'numeric', month: 'short', year: 'numeric'})}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Payment ID:</span>
              <span class="detail-value" style="font-size: 12px;">${razorpay_payment_id}</span>
            </div>
          </div>
          
          <p class="message">
            🎉 Your subscription has been successfully extended!<br>
            ${levelChanged ? `<strong>🔄 Your level has been updated to ${levelDisplay}!</strong><br>✨ You'll start fresh at Day 1 of the new level.<br>🔥 Your ${user.streak}-day streak is preserved!<br>` : `<strong>🔥 Continue from Day ${user.currentDay}!</strong><br>💪 Keep your ${user.streak}-day streak alive!<br>`}
            <strong>A confirmation has been sent to your WhatsApp.</strong><br><br>
            Keep learning and maintain your streak! 🔥
          </p>
          
          <button class="close-btn" onclick="window.close()">Close</button>
        </div>
      </body>
      </html>
    `);
    
  } catch (error) {
    console.error('❌ Upgrade verification error:', error);
    
    await Log.create({
      type: 'PAYMENT_ERROR',
      message: `Upgrade verification error: ${error.message}`,
      status: 'ERROR'
    });
    
    res.send(`
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><title>Error</title></head>
      <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h1 style="color: #dc3545;">❌ Error Processing Payment</h1>
        <p>An error occurred. Please contact support if amount was deducted.</p>
        <p style="color: #6c757d; font-size: 12px;">Error: ${error.message}</p>
      </body></html>
    `);
  }
};
