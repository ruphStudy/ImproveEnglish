const Razorpay = require('razorpay');
const crypto = require('crypto');
const PendingOrder = require('../models/PendingOrder');
const User = require('../models/User');
const Log = require('../models/Log');
const whatsappService = require('../services/whatsappService');
const PlanMaster = require('../models/PlanMaster');
const { processSuccessfulPayment, reconcileStuckPendingOrders } = require('../services/paymentProcessingService');

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

      // Persist order ID correction if this order was matched via payment link ID
      if (pendingOrder.razorpayOrderId !== orderId) {
        console.log(`📝 Updating order ID from ${pendingOrder.razorpayOrderId} to ${orderId}`);
        pendingOrder.razorpayOrderId = orderId;
        await pendingOrder.save();
      }

      console.log('📝 Order Details:');
      console.log(`   Name: ${pendingOrder.name}`);
      console.log(`   Phone: ${pendingOrder.phone}`);
      console.log(`   Email: ${pendingOrder.email}`);
      console.log(`   Level: ${pendingOrder.level}`);
      console.log(`   Plan: ${pendingOrder.planDuration} days`);
      console.log(`   Status: ${pendingOrder.status}`);

      // Delegate to the single payment processor so webhook and Payment Link callback
      // can never both apply the success side effects for the same order.
      let result;
      try {
        result = await processSuccessfulPayment({
          pendingOrder,
          razorpayPaymentId: paymentId,
          paymentMethod: payment.method,
          amountPaidPaise: amountPaid
        });
      } catch (procErr) {
        console.error('❌ Payment processing failed:', procErr);
        await Log.create({
          type: 'PAYMENT_ERROR',
          userPhone: pendingOrder.phone,
          message: `Webhook processing failed: ${procErr.message}`,
          status: 'ERROR'
        });
        console.log('🔔 ========== WEBHOOK END (PROCESSING ERROR - WILL RETRY) ==========\n');
        // Non-200 so Razorpay retries; the claim was released internally, so retry is safe
        return res.status(500).json({ success: false, message: 'Processing failed' });
      }

      if (!result.success) {
        console.log(`⚠️ Amount mismatch for ${orderId}`);
        console.log('🔔 ========== WEBHOOK END (AMOUNT MISMATCH) ==========\n');
        return res.status(200).json({ success: true, message: 'Amount mismatch' });
      }

      if (result.alreadyProcessed) {
        console.log(`⚠️ Order ${orderId} already processed (status: ${result.status})`);
        console.log('🔔 ========== WEBHOOK END (ALREADY PROCESSED) ==========\n');
        return res.status(200).json({ success: true, message: 'Already processed' });
      }

      const { user, newExpiryDate, isNewUser, levelChanged } = result;
      console.log(`✅ Payment processed. New user: ${isNewUser}, Level changed: ${levelChanged}`);
      console.log(`   New Expiry: ${newExpiryDate.toISOString().split('T')[0]}`);
      console.log(`   Streak Preserved: ${user.streak}`);

      // Send WhatsApp confirmation (best-effort; user is already activated regardless)
      try {
        if (isNewUser) {
          const formattedExpiryDate = newExpiryDate.toISOString().split('T')[0];
          await whatsappService.sendTemplateMessage(
            pendingOrder.phone,
            'payment_welcome_new',
            [user.name, pendingOrder.planDuration.toString(), pendingOrder.level, formattedExpiryDate],
            'en_US'
          );

          // Kick off the short WhatsApp onboarding (goal selection -> level
          // assessment) for brand-new users only - existing users are untouched.
          if (user.onboardingStatus === 'PENDING_GOAL') {
            const { buildGoalSelectionMessage } = require('../services/onboardingService');
            await whatsappService.sendWhatsAppMessage(pendingOrder.phone, buildGoalSelectionMessage());
          }
        } else {
          const formattedDate = newExpiryDate.toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
          });
          await whatsappService.sendWhatsAppMessage(
            pendingOrder.phone,
            `🎉 Payment successful!\n\nYour plan is now active until ${formattedDate}.${levelChanged ? `\n\nLevel updated to ${pendingOrder.level}. Starting fresh at Day 1!` : ''}\n\nKeep up your streak of ${user.streak} day${user.streak !== 1 ? 's' : ''}! 🔥`
          );
        }
      } catch (whatsappError) {
        console.error('❌ WhatsApp confirmation failed (non-fatal):', whatsappError.message);
      }

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

// Manual reconciliation trigger - releases stuck 'processing' orders for retry
exports.reconcileStuckOrders = async (req, res) => {
  try {
    const maxAgeMinutes = parseInt(req.body?.maxAgeMinutes) || 15;
    const result = await reconcileStuckPendingOrders(maxAgeMinutes);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('❌ Reconciliation error:', error);
    res.status(500).json({ success: false, message: 'Reconciliation failed', error: error.message });
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

    // Find pending order by payment link ID (status not filtered here - the
    // processor's atomic claim is the actual idempotency gate, so a webhook
    // that already completed this order is detected below, not silently missed)
    const pendingOrder = await PendingOrder.findOne({
      paymentLinkId: razorpay_payment_link_id
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

    // Try to fetch authoritative payment details (amount + method) from Razorpay.
    // Best-effort: if unavailable, fall back to trusting the verified callback/signature.
    let paymentMethod = 'payment_link';
    let amountPaidPaise = pendingOrder.amountPaise;
    try {
      const payment = await razorpay.payments.fetch(razorpay_payment_id);
      paymentMethod = payment.method || 'payment_link';
      if (typeof payment.amount === 'number') {
        amountPaidPaise = payment.amount;
      }
      console.log('💳 Payment method:', paymentMethod, '| Amount:', amountPaidPaise);
    } catch (fetchError) {
      console.log('⚠️ Could not fetch payment details, trusting callback signature for amount');
    }

    let result;
    try {
      result = await processSuccessfulPayment({
        pendingOrder,
        razorpayPaymentId: razorpay_payment_id,
        paymentMethod,
        amountPaidPaise
      });
    } catch (procErr) {
      console.error('❌ Upgrade processing error:', procErr);
      await Log.create({
        type: 'PAYMENT_ERROR',
        userPhone: pendingOrder.phone,
        message: `Upgrade callback processing failed: ${procErr.message}`,
        status: 'ERROR'
      });
      return res.send(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><title>Error</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: #dc3545;">❌ Error Processing Payment</h1>
          <p>An error occurred. Please contact support if amount was deducted.</p>
        </body></html>
      `);
    }

    if (!result.success) {
      console.error('❌ Amount mismatch on upgrade callback');
      return res.send(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><title>Verification Failed</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: #dc3545;">❌ Verification Failed</h1>
          <p>Payment amount could not be verified. Please contact support with payment ID: ${razorpay_payment_id}</p>
        </body></html>
      `);
    }

    if (result.alreadyProcessed) {
      console.log(`⚠️ Order already processed (status: ${result.status}) - likely completed via webhook`);
      return res.send(`
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"><title>Payment Confirmed</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: #28a745;">✅ Payment Already Confirmed</h1>
          <p>Your subscription has already been activated. A confirmation was sent to your WhatsApp.</p>
        </body></html>
      `);
    }

    const { user, newExpiryDate, levelChanged } = result;

    if (levelChanged) {
      console.log(`✅ User level updated to ${user.level} - Progress reset to Day 1`);
    } else {
      console.log(`✅ User level unchanged: ${user.level} - Progress preserved at Day ${user.currentDay}`);
    }

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
