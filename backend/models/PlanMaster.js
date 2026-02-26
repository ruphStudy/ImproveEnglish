const mongoose = require('mongoose');

const planMasterSchema = new mongoose.Schema({
  planName: {
    type: String,
    required: true,
    enum: ['plan30', 'plan60', 'plan180', 'plan365']
  },
  days: {
    type: Number,
    required: true
  },
  level: {
    type: String,
    required: true,
    enum: ['bigenner', 'intermidiate', 'advance']
  },
  price: {
    type: Number,
    required: true
  }
}, {
  timestamps: true
});

// Create compound index for efficient queries
planMasterSchema.index({ level: 1, days: 1 });

module.exports = mongoose.model('PlanMaster', planMasterSchema, 'plan_master');
