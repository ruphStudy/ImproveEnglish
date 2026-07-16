const mongoose = require('mongoose');

const paymentHistorySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
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
  planName: {
    type: String,
    required: true
  },
  amountPaid: {
    type: Number,
    required: true
  },
  // Promo code fields (added for promo code feature)
  promoCode: {
    type: String,
    default: null,
    uppercase: true
  },
  originalAmount: {
    type: Number,
    default: null // Original amount before discount
  },
  discountAmount: {
    type: Number,
    default: 0 // Discount applied
  },
  currency: {
    type: String,
    default: 'INR'
  },
  razorpayOrderId: {
    type: String,
    required: true
  },
  razorpayPaymentId: {
    type: String,
    required: true
  },
  paymentMethod: {
    type: String // card, upi, netbanking, wallet
  },
  paymentStatus: {
    type: String,
    enum: ['success', 'failed', 'pending'],
    default: 'success'
  },
  expiryDate: {
    type: Date,
    required: true
  },
  utmSource: {
    type: String
  }
}, {
  timestamps: true
});

// Index for efficient queries
paymentHistorySchema.index({ phone: 1, createdAt: -1 });
paymentHistorySchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('PaymentHistory', paymentHistorySchema);
