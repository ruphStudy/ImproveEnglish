const PromoCode = require('../models/PromoCode');
const User = require('../models/User');

/**
 * Validate promo code and calculate discount
 * @param {String} code - Promo code entered by user
 * @param {String} userId - User ID (can be null for new users)
 * @param {Number} amount - Original amount in rupees
 * @param {String} level - Level: beginner/intermediate/advanced
 * @param {Number} duration - Plan duration in days
 * @param {String} userPhone - User phone for tracking
 * @returns {Object} validation result with discount details
 */
async function validatePromoCode(code, userId, amount, level, duration, userPhone) {
  try {
    // Find promo code (case insensitive)
    const promo = await PromoCode.findOne({ 
      code: code.toUpperCase().trim(),
      isActive: true
    });
    
    if (!promo) {
      return { 
        valid: false, 
        message: 'Invalid promo code' 
      };
    }
    
    // Check validity dates
    const now = new Date();
    if (now < promo.validFrom) {
      return { 
        valid: false, 
        message: `Promo code valid from ${promo.validFrom.toLocaleDateString()}` 
      };
    }
    
    if (promo.validUntil && now > promo.validUntil) {
      return { 
        valid: false, 
        message: 'Promo code has expired' 
      };
    }
    
    // Check global usage limit
    if (promo.maxUses && promo.currentUses >= promo.maxUses) {
      return { 
        valid: false, 
        message: 'Promo code usage limit reached' 
      };
    }
    
    // Check per-user limit (if userId provided)
    if (userId) {
      const userUsageCount = promo.usedBy.filter(
        u => u.userId && u.userId.toString() === userId
      ).length;
      
      if (userUsageCount >= promo.perUserLimit) {
        return { 
          valid: false, 
          message: 'You have already used this promo code' 
        };
      }
    } else if (userPhone) {
      // For new users without userId, check by phone
      const phoneUsageCount = promo.usedBy.filter(
        u => u.userPhone === userPhone
      ).length;
      
      if (phoneUsageCount >= promo.perUserLimit) {
        return { 
          valid: false, 
          message: 'This phone number has already used this promo code' 
        };
      }
    }
    
    // Check minimum amount
    if (amount < promo.minAmount) {
      return { 
        valid: false, 
        message: `Minimum purchase amount ₹${promo.minAmount} required` 
      };
    }
    
    // Check level restriction
    if (promo.applicableLevels && promo.applicableLevels.length > 0) {
      if (!promo.applicableLevels.includes(level.toLowerCase())) {
        return { 
          valid: false, 
          message: `Promo code not valid for ${level} level` 
        };
      }
    }
    
    // Check duration restriction
    if (promo.applicableDurations && promo.applicableDurations.length > 0) {
      if (!promo.applicableDurations.includes(duration)) {
        return { 
          valid: false, 
          message: `Promo code not valid for ${duration}-day plan` 
        };
      }
    }
    
    // Check first-time user restriction
    if (promo.firstTimeOnly && userId) {
      const user = await User.findById(userId);
      if (user && user.expiryDate && new Date(user.expiryDate) > now) {
        return { 
          valid: false, 
          message: 'Promo code only valid for first-time users' 
        };
      }
    }
    
    // Calculate discount
    let discountAmount;
    if (promo.discountType === 'percentage') {
      discountAmount = Math.round((amount * promo.discountValue) / 100);
      
      // Apply max discount cap if set
      if (promo.maxDiscount && discountAmount > promo.maxDiscount) {
        discountAmount = promo.maxDiscount;
      }
    } else {
      // Fixed discount
      discountAmount = promo.discountValue;
    }
    
    // Ensure discount doesn't exceed amount
    if (discountAmount > amount) {
      discountAmount = amount;
    }
    
    const finalAmount = Math.max(0, amount - discountAmount);
    
    return {
      valid: true,
      code: promo.code,
      description: promo.description,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      discountAmount: discountAmount,
      originalAmount: amount,
      finalAmount: finalAmount,
      savings: discountAmount,
      promoId: promo._id
    };
    
  } catch (err) {
    console.error('❌ Promo validation error:', err);
    return { 
      valid: false, 
      message: 'Error validating promo code',
      error: err.message
    };
  }
}

/**
 * Mark promo code as used after successful payment
 * @param {String} code - Promo code
 * @param {String} userId - User ID
 * @param {String} userName - User name
 * @param {String} userPhone - User phone
 * @param {Number} originalAmount - Original amount
 * @param {Number} discountAmount - Discount applied
 * @param {Number} finalAmount - Final amount paid
 * @param {String} orderId - Order/Payment ID for reference
 */
async function markPromoAsUsed(code, userId, userName, userPhone, originalAmount, discountAmount, finalAmount, orderId) {
  try {
    // Idempotency guard: only apply if no usedBy entry for this exact order already
    // exists. A retried/duplicate call for the same order therefore matches nothing
    // and safely no-ops instead of incrementing currentUses / pushing a second entry.
    const result = await PromoCode.findOneAndUpdate(
      {
        code: code.toUpperCase().trim(),
        ...(orderId ? { 'usedBy.orderId': { $ne: orderId } } : {})
      },
      {
        $inc: { currentUses: 1 },
        $push: {
          usedBy: {
            userId: userId || null,
            userName,
            userPhone,
            usedAt: new Date(),
            orderAmount: originalAmount,
            discountAmount,
            finalAmount,
            orderId: orderId || null
          }
        }
      },
      { new: true }
    );

    if (!result) {
      console.log(`ℹ️ Promo code ${code} already recorded as used for order ${orderId} - skipping duplicate`);
      return { success: true, alreadyUsed: true };
    }

    console.log(`✅ Promo code ${code} marked as used by ${userName}`);
    return { success: true };

  } catch (err) {
    console.error('❌ Error marking promo as used:', err);
    return { success: false, error: err.message };
  }
}

module.exports = {
  validatePromoCode,
  markPromoAsUsed
};
