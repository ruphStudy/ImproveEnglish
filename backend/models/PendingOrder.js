const mongoose = require('mongoose');

const pendingOrderSchema = new mongoose.Schema({
  razorpayOrderId: {
    type: String,
    required: true,
    index: true
  },
  paymentLinkId: {
    type: String,
    default: null,
    index: true
  },
  razorpayPaymentId: {
    type: String,
    default: null
  },
  name: {
    type: String,
    required: true
  },
  phone: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true
  },
  level: {
    type: String,
    required: true,
    enum: ['beginner', 'intermediate', 'advanced']
  },
  planDuration: {
    type: Number,
    required: true
  },
  amountPaise: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['created', 'paid', 'failed'],
    default: 'created'
  },
  type: {
    type: String,
    enum: ['new', 'upgrade'],
    default: 'new'
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  utmSource: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('PendingOrder', pendingOrderSchema);
