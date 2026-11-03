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
    required: false // web checkout requires it (controller); WhatsApp UPGRADE links for learners without email have none
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
  // Promo code fields (added for promo code feature)
  promoCode: {
    type: String,
    default: null,
    uppercase: true
  },
  originalAmountPaise: {
    type: Number,
    default: null // Original amount before discount
  },
  discountAmountPaise: {
    type: Number,
    default: 0 // Discount applied in paise
  },
  status: {
    type: String,
    enum: ['created', 'processing', 'paid', 'failed'],
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
  },
  timezone: { type: String, default: undefined } // validated IANA zone, copied to a NEW user only
}, {
  timestamps: true
});

module.exports = mongoose.model('PendingOrder', pendingOrderSchema);
