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
  }], // Recent vocabulary words introduced (for anti-repetition) - bounded, see pre('save')
  recentScenarioTypes: {
    type: [String],
    default: []
  }, // Last 5 scenario types used (for variety within the deterministic rotation)
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

const BOUNDS = {
  recentTopicDays: 7,
  recentGrammarKeys: 7,
  recentScenarioTypes: 5,
  // vocabBank previously had no bound and grew indefinitely. 50 is comfortably
  // more than the ~12 most-recent words the generator reads for anti-repetition.
  vocabBank: 50
};

// Pure, DB-independent so it's directly unit-testable without a live Mongo connection.
function capBoundedArrays(doc) {
  Object.entries(BOUNDS).forEach(([field, max]) => {
    if (doc[field] && doc[field].length > max) {
      doc[field] = doc[field].slice(-max);
    }
  });
  return doc;
}

tutorMemorySchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  capBoundedArrays(this);
  next();
});

const TutorMemory = mongoose.model('TutorMemory', tutorMemorySchema);
module.exports = TutorMemory;
module.exports.capBoundedArrays = capBoundedArrays;
module.exports.BOUNDS = BOUNDS;
