const mongoose = require('mongoose');

const logSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: [
      'LESSON_GENERATED', 
      'LESSON_STARTED',
      'LESSON_COMPLETED',
      'MESSAGE_SENT', 
      'MESSAGE_RECEIVED', 
      'CRON_LESSON',
      'CRON_RESET',
      'ERROR'
    ],
    required: true
  },
  phone: { type: String },
  message: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Log', logSchema);
