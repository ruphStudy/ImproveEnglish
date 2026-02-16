const mongoose = require('mongoose');

const registrationLogSchema = new mongoose.Schema({
  name: { type: String },
  phone: { type: String },
  email: { type: String },
  status: { 
    type: String, 
    enum: ['SUCCESS', 'ERROR', 'DUPLICATE'],
    required: true 
  },
  message: { type: String },
  errorDetails: { type: String },
  ipAddress: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('RegistrationLog', registrationLogSchema);
