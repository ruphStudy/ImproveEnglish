const mongoose = require('mongoose');

const lessonSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  day: { 
    type: Number, 
    required: true 
  },
  level: {
    type: String,
    enum: ['beginner', 'intermediate', 'advanced'],
    required: true
  },
  topicTitle: String,
  grammarFocus: String,
  scenarioType: String,
  lessonJson: {
    title: String,
    scenarioType: String,
    conversation: String,
    explanation: String,
    guidedSpeakingPrompts: [String],
    newVocabulary: [{
      word: String,
      meaning: String,
      example: String
    }],
    microPractice: {
      q1: String,
      q2: String,
      q3: String, // legacy field, unused by v3 generator - kept for old lesson compatibility
      expectedStructure: String // legacy field, unused by v3 generator - kept for old lesson compatibility
    },
    confidenceLine: String
  }, // Full structured JSON from AI
  lessonText: {
    type: String,
    required: true
  }, // Formatted text for WhatsApp
  generationVersion: {
    type: String,
    default: 'v2'
  }, // Which generator produced this lesson (analytics/debugging)
  validationStatus: {
    type: String,
    enum: ['valid', 'retried', 'fallback'],
    default: 'valid'
  }, // Outcome of local deterministic validation
  status: {
    type: String,
    enum: ['generated', 'notified', 'sent', 'completed'],
    default: 'generated'
  },
  generatedAt: { type: Date, default: Date.now },
  notifiedAt: Date,
  sentAt: Date,
  completedAt: Date
});

// Index for fast lookups
lessonSchema.index({ userId: 1, day: 1 });
lessonSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('Lesson', lessonSchema);
