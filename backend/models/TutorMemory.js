const mongoose = require('mongoose');

const tutorMemorySchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true, 
    unique: true 
  },
  recentTopicDays: {
    type: [Number],
    default: []
  }, // Last 7 topic days completed (for anti-repetition)
  recentGrammarKeys: {
    type: [String],
    default: []
  }, // Last 7 grammar focus areas (for variety)
  vocabBank: [{
    word: String,
    day: Number,
    addedAt: { type: Date, default: Date.now }
  }], // All vocabulary words introduced (for anti-repetition)
  weakAreas: {
    type: [String],
    default: []
  }, // Areas needing reinforcement (e.g., "pronunciation", "verb_tenses")
  difficultyScore: {
    type: Number,
    default: 0.5,
    min: 0,
    max: 1
  }, // 0-1 scale indicating user's progress within level
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

tutorMemorySchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  
  // Cap recentTopicDays at 7
  if (this.recentTopicDays.length > 7) {
    this.recentTopicDays = this.recentTopicDays.slice(-7);
  }
  
  // Cap recentGrammarKeys at 7
  if (this.recentGrammarKeys.length > 7) {
    this.recentGrammarKeys = this.recentGrammarKeys.slice(-7);
  }
  
  next();
});

module.exports = mongoose.model('TutorMemory', tutorMemorySchema);
