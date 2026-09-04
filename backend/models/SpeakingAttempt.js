const mongoose = require('mongoose');

const speakingAttemptSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  lessonId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Lesson',
    default: null
  }, // null when no recent/relevant lesson was found (generic evaluation)
  day: { type: Number },
  level: {
    type: String,
    enum: ['beginner', 'intermediate', 'advanced']
  },

  promptIndex: { type: Number, default: null }, // index into lessonJson.guidedSpeakingPrompts, null for generic evaluation
  promptText: { type: String },
  expectedGrammar: { type: String },

  transcript: { type: String, required: true },

  scores: {
    grammar: Number,
    sentenceFormation: Number,
    naturalness: Number,
    vocabulary: Number,
    relevance: Number,
    overall: Number
  }, // 1-10 scale, matching User.lastFluencyScore's existing convention

  feedback: String,
  correctedVersion: String,
  suggestedRetry: String,
  weakAreas: { type: [String], default: [] }, // normalized labels only

  attemptNumber: { type: Number, default: 1 },
  validationStatus: {
    type: String,
    enum: ['valid', 'retried', 'fallback'],
    default: 'valid'
  },

  createdAt: { type: Date, default: Date.now }
});

speakingAttemptSchema.index({ userId: 1, createdAt: -1 });
speakingAttemptSchema.index({ lessonId: 1, promptIndex: 1, createdAt: 1 });

module.exports = mongoose.model('SpeakingAttempt', speakingAttemptSchema);
