const mongoose = require('mongoose');

const promoCodeSchema = new mongoose.Schema({
  code: { 
    type: String, 
    required: true, 
    unique: true,
    uppercase: true,
    trim: true
  },
  
  // Discount configuration
  discountType: { 
    type: String, 
    enum: ['percentage', 'fixed'], 
    required: true 
  },
  discountValue: { 
    type: Number, 
    required: true,
    min: 0
  }, // e.g., 50 for 50% or 500 for ₹500 fixed
  
  // Usage limits
  maxUses: { 
    type: Number, 
    default: null 
  }, // null = unlimited
  currentUses: { 
    type: Number, 
    default: 0 
  },
  perUserLimit: { 
    type: Number, 
    default: 1 
  }, // How many times one user can use
  
  // Validity period
  validFrom: { 
    type: Date, 
    default: Date.now 
  },
  validUntil: { 
    type: Date, 
    default: null 
  }, // null = no expiry
  
  // Restrictions
  minAmount: { 
    type: Number, 
    default: 0 
  }, // Minimum purchase amount in ₹
  maxDiscount: {
    type: Number,
    default: null
  }, // Maximum discount amount for percentage discounts (e.g., 50% off max ₹500)
  applicableLevels: [{ 
    type: String, 
    enum: ['beginner', 'intermediate', 'advanced'] 
  }], // Empty array = all levels
  applicableDurations: [{ 
    type: Number 
  }], // [30, 90, 180] = only these durations. Empty = all
  firstTimeOnly: { 
    type: Boolean, 
    default: false 
  }, // Only for users who have never subscribed
  
  // Status
  isActive: { 
    type: Boolean, 
    default: true 
  },
  
  // Metadata
  createdBy: { 
    type: String, 
    default: 'admin' 
  },
  description: {
    type: String,
    default: ''
  },
  internalNotes: {
    type: String,
    default: ''
  }, // Admin notes - not shown to users
  
  // Usage tracking
  usedBy: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    userName: String,
    userPhone: String,
    usedAt: {
      type: Date,
      default: Date.now
    },
    orderAmount: Number, // Original amount
    discountAmount: Number, // Discount applied
    finalAmount: Number, // Amount after discount
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order'
    }
  }]
}, {
  timestamps: true
});

// Indexes for faster queries
promoCodeSchema.index({ code: 1 });
promoCodeSchema.index({ isActive: 1, validUntil: 1 });
promoCodeSchema.index({ 'usedBy.userId': 1 });

// Virtual for checking if code is expired
promoCodeSchema.virtual('isExpired').get(function() {
  if (!this.validUntil) return false;
  return new Date() > this.validUntil;
});

// Virtual for checking if usage limit reached
promoCodeSchema.virtual('isLimitReached').get(function() {
  if (!this.maxUses) return false;
  return this.currentUses >= this.maxUses;
});

module.exports = mongoose.model('PromoCode', promoCodeSchema);
