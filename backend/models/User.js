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
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

userSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('User', userSchema);
