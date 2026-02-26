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
  }, // Last voice evaluation fluency score (1-10)
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
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

userSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('User', userSchema);
