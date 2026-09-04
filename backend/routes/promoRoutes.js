const express = require('express');
const router = express.Router();
const PromoCode = require('../models/PromoCode');
const { validatePromoCode } = require('../services/promoService');
const adminAuth = require('../middleware/adminAuth');

/**
 * Validate promo code
 * POST /api/promo/validate
 * Body: { code, userId (optional), userPhone, amount, level, duration }
 */
router.post('/validate', async (req, res) => {
  try {
    const { code, userId, userPhone, amount, level, duration } = req.body;
    
    // Validate required fields
    if (!code || !amount || !level || !duration) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: code, amount, level, duration' 
      });
    }
    
    if (!userPhone && !userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Either userId or userPhone is required' 
      });
    }
    
    // Validate promo code
    const result = await validatePromoCode(
      code,
      userId,
      amount,
      level,
      duration,
      userPhone
    );
    
    if (result.valid) {
      return res.json({
        success: true,
        valid: true,
        promo: {
          code: result.code,
          description: result.description,
          discountType: result.discountType,
          discountValue: result.discountValue,
          originalAmount: result.originalAmount,
          discountAmount: result.discountAmount,
          finalAmount: result.finalAmount,
          savings: result.savings
        }
      });
    } else {
      return res.json({
        success: true,
        valid: false,
        message: result.message
      });
    }
    
  } catch (err) {
    console.error('❌ Promo validation error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * Get active promo codes (admin only - for testing)
 * GET /api/promo/active
 */
router.get('/active', adminAuth, async (req, res) => {
  try {
    const promos = await PromoCode.find({ 
      isActive: true,
      $or: [
        { validUntil: { $gte: new Date() } },
        { validUntil: null }
      ]
    }).select('code description discountType discountValue validUntil maxUses currentUses');
    
    res.json({
      success: true,
      count: promos.length,
      promos
    });
    
  } catch (err) {
    console.error('❌ Error fetching promos:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * Create promo code (admin only - for testing)
 * POST /api/promo/create
 */
router.post('/create', adminAuth, async (req, res) => {
  try {
    const promoData = req.body;
    
    // Validate required fields
    if (!promoData.code || !promoData.discountType || !promoData.discountValue) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: code, discountType, discountValue' 
      });
    }
    
    // Check if code already exists
    const existing = await PromoCode.findOne({ code: promoData.code.toUpperCase() });
    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'Promo code already exists' 
      });
    }
    
    const promo = await PromoCode.create(promoData);
    
    res.json({
      success: true,
      message: 'Promo code created successfully',
      promo: {
        code: promo.code,
        description: promo.description,
        discountType: promo.discountType,
        discountValue: promo.discountValue,
        validFrom: promo.validFrom,
        validUntil: promo.validUntil
      }
    });
    
  } catch (err) {
    console.error('❌ Error creating promo:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

module.exports = router;
