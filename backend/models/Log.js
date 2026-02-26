const mongoose = require('mongoose');

const logSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: [
      'LESSON_GENERATED', 
      'LESSON_STARTED',
      'LESSON_COMPLETED',
      'LESSON_GENERATION_ERROR',
      'LESSON_GENERATION_FALLBACK',
      'MESSAGE_SENT', 
      'MESSAGE_RECEIVED', 
      'CRON_LESSON',
      'CRON_RESET',
      'CRON_EXPIRY',
      'CRON_EXPIRY_REMINDER',
      'CRON_STREAK_RESET',
      'CRON_WEEKLY_SUMMARY',
      'CRON_LESSON_REMINDER',
      'LESSON_REMINDER_NOON',
      'LESSON_REMINDER_EVENING',
      'LESSON_REMINDER_ERROR',
      'STREAK_RESET',
      'STREAK_UPDATED',
      'STREAK_MILESTONE',
      'CURRICULUM_TOPIC_NOT_FOUND',
      'EXPIRY_REMINDER_7_DAYS',
      'EXPIRY_REMINDER_3_DAYS',
      'EXPIRY_REMINDER_ERROR',
      'WEEKLY_SUMMARY_SENT',
      'WEEKLY_SUMMARY_ERROR',
      'VOICE_EVALUATION_SUCCESS',
      'VOICE_EVALUATION_ERROR',
      'ORDER_CREATED',
      'PAYMENT_SUCCESS',
      'PAYMENT_ERROR',
      'UPGRADE_SUCCESS',
      'UPGRADE_REQUESTED',
      'UPGRADE_ORDER_CREATED',
      'DUPLICATE_PAYMENT',
      'SUBSCRIPTION_EXPIRED',
      'ERROR'
    ],
    required: true
  },
  phone: { type: String },
  userPhone: { type: String }, // Alternative field name used by payment controller
  message: { type: String },
  status: { type: String }, // SUCCESS, ERROR, WARNING, INFO
  metadata: { type: mongoose.Schema.Types.Mixed }, // Additional data (orderId, paymentId, etc.)
  createdAt: { type: Date, default: Date.now },
  timestamp: { type: Date, default: Date.now } // Alternative field name
});

module.exports = mongoose.model('Log', logSchema);
