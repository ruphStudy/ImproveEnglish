const mongoose = require('mongoose');

const curriculumTopicSchema = new mongoose.Schema({
  level: {
    type: String,
    enum: ['beginner', 'intermediate', 'advanced'],
    required: true
  },
  day: {
    type: Number,
    required: true
  },
  month: {
    type: Number,
    required: true
  },
  theme: {
    type: String,
    required: true
  },
  title: {
    type: String,
    required: true
  },
  grammarFocus: {
    type: String,
    required: true
  },
  difficultyTag: {
    type: String,
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Index for fast topic lookup
curriculumTopicSchema.index({ level: 1, day: 1, isActive: 1 });

curriculumTopicSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('CurriculumTopic', curriculumTopicSchema, 'curriculum_topics');
