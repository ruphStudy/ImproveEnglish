const express = require('express');
const router = express.Router();
const PromoCode = require('../models/PromoCode');
const rateLimit = require('express-rate-limit');
const { quotePromo } = require('../services/freePromoService');
const { normalizePhone } = require('../utils/phone');
const adminAuth = require('../middleware/adminAuth');

const promoValidateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again later.' }
});

/**
 * Validate promo code (display only - nothing is reserved or charged here)
 * POST /api/promo/validate
 * Body: { code, phone (or userPhone), country, level, planDuration (or duration) }
 * The price always comes from PlanMaster; any client-sent amount is ignored.
 */
router.post('/validate', promoValidateLimiter, async (req, res) => {
  try {
    const { code, level, country } = req.body || {};
    const rawPhone = req.body?.phone ?? req.body?.userPhone;
    const planDuration = req.body?.planDuration ?? req.body?.duration;

    if (!code || !rawPhone || !level || !planDuration) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: code, phone, level, planDuration'
      });
    }

    const phone = normalizePhone(rawPhone, country);
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Please enter a valid WhatsApp number for the selected country' });
    }

    const quote = await quotePromo({ code, phone, level, planDuration });
    if (!quote.ok) {
      return res.json({ success: true, valid: false, message: quote.message });
    }

    return res.json({
      success: true,
      valid: true,
      isFree: quote.isFree,
      applicableDurations: quote.applicableDurations,
      promo: {
        code: quote.code,
        description: quote.description,
        originalAmount: quote.originalAmount,
        discountAmount: quote.discountAmount,
        finalAmount: quote.finalAmount
      }
    });
  } catch (err) {
    console.error('❌ Promo validation error:', err.message);
    res.status(500).json({ success: false, message: 'Error validating promo code' });
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
