const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String },
  phone: { type: String, unique: true, required: true },
  email: { type: String },
  isActive: { type: Boolean, default: true }, // Active users receive daily lessons
  state: {
    type: String,
    enum: ['NEW', 'READY', 'WAITING_START', 'IN_LESSON', 'COMPLETED_TODAY', 'PAUSED'],
    default: 'READY' // Start as READY for first cron job
  },
  currentDay: { type: Number, default: 1 }, // Starts from Day 1
  lessonText: { type: String },
  lessonDate: { type: Date },
  lessonCompleted: { type: Boolean, default: false }, // Tracks if today's lesson is completed
  lessonCompletedAt: { type: Date }, // When user replied DONE
  lastSeenAt: { type: Date },
  expiryDate: { type: Date }, // Subscription expiry date
  level: { 
    type: String, 
    enum: ['beginner', 'intermediate', 'advanced'],
    default: 'beginner'
  }, // User's English level
  sevenDayReminderSent: {
    type: Boolean,
    default: false
  }, // Expiry reminder sent 7 days before
  threeDayReminderSent: {
    type: Boolean,
    default: false
  }, // Expiry reminder sent 3 days before
  streak: {
    type: Number,
    default: 0
  }, // Consecutive lessons completed (lesson-based, not calendar-day based)
  lastLessonCompletedDate: {
    type: Date,
    default: null
  }, // Timestamp when user last completed a lesson
  weeklyCompletedCount: {
    type: Number,
    default: 0
  }, // Count of lessons completed this week (resets every Sunday)
  lastFluencyScore: {
    type: Number,
    default: null
  }, // Last voice evaluation overall score (1-10) - see SpeakingAttempt for full per-dimension history
  noonReminderSent: {
    type: Boolean,
    default: false
  }, // 12 PM lesson reminder sent today
  eveningReminderSent: {
    type: Boolean,
    default: false
  }, // 6 PM lesson reminder sent today
  lastNotificationDate: {
    type: Date,
    default: null
  }, // Date when lesson notification was sent (for 24-hour tracking)
  lastAppliedPaymentId: {
    type: String,
    default: null
  }, // Razorpay payment ID last applied to this user's subscription - guards a crashed/retried payment from double-extending expiry or resetting progress twice
  learningGoal: {
    type: String,
    enum: ['daily_english', 'workplace', 'interview', 'college_placement', 'customer_service', 'sales', 'travel'],
    default: 'daily_english'
  }, // Biases lesson scenario/context - never overrides curriculum topic/grammar/day
  onboardingStatus: {
    type: String,
    enum: ['PENDING_GOAL', 'PENDING_ASSESSMENT', 'COMPLETED']
    // Intentionally no default: existing users read this as undefined, which
    // every onboarding check treats as "already onboarded" for backward compatibility.
  },
  assessedLevel: {
    type: String,
    enum: ['beginner', 'intermediate', 'advanced'],
    default: null
  }, // Level recommended by the onboarding assessment - informational only.
     // Never silently overwrites `level`, since PlanMaster prices are level-specific.
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

userSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Database indexes for performance optimization
// Compound index for daily lesson cron query (most important)
userSchema.index({ isActive: 1, state: 1, expiryDate: 1 });

// Index for reminder cron queries
userSchema.index({ isActive: 1, state: 1, lastNotificationDate: 1 });

// Index for expiry reminder queries
userSchema.index({ isActive: 1, expiryDate: 1 });

// Index for phone (already unique, but explicit for lookups)
userSchema.index({ phone: 1 });

module.exports = mongoose.model('User', userSchema);
