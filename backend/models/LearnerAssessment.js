const mongoose = require('mongoose');

// Fixed, high-quality questions (no AI-generated questions) - keeps the
// assessment short (~5-7 min) and its cost fully predictable.
const ASSESSMENT_QUESTIONS = [
  { questionId: 'text1', type: 'text', question: "What's your name, and what do you do (work/study)? Reply in 1-2 sentences." },
  { questionId: 'text2', type: 'text', question: 'Describe your typical day in a few sentences.' },
  { questionId: 'voice1', type: 'voice', question: '🎤 Send a voice note: Introduce yourself - your name, work/study, and one hobby.' },
  { questionId: 'voice2', type: 'voice', question: '🎤 Send a voice note: Describe a challenge you handled recently and how you solved it.' }
];

const learnerAssessmentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    enum: ['in_progress', 'completed', 'failed'],
    default: 'in_progress'
  },

  textResponses: [{
    questionId: String,
    question: String,
    answer: String
  }],
  voiceResponses: [{
    questionId: String,
    question: String,
    transcript: String
  }],

  scores: {
    grammar: Number,
    sentenceFormation: Number,
    vocabulary: Number,
    naturalness: Number,
    comprehension: Number,
    overall: Number
  }, // 1-10 scale, matching SpeakingAttempt/User.lastFluencyScore convention

  strengths: { type: [String], default: [] },
  weakAreas: { type: [String], default: [] }, // normalized labels, same allow-list as SpeakingAttempt
  summary: String,

  recommendedLevel: {
    type: String,
    enum: ['beginner', 'intermediate', 'advanced']
  },
  validationStatus: {
    type: String,
    enum: ['valid', 'retried', 'fallback']
  },

  startedAt: { type: Date, default: Date.now },
  completedAt: { type: Date }
});

learnerAssessmentSchema.index({ userId: 1, startedAt: -1 });

const LearnerAssessment = mongoose.model('LearnerAssessment', learnerAssessmentSchema);
module.exports = LearnerAssessment;
module.exports.ASSESSMENT_QUESTIONS = ASSESSMENT_QUESTIONS;
