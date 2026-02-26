const express = require('express');
const router = express.Router();
const PlanMaster = require('../models/PlanMaster');

// Get all plans
router.get('/plans', async (req, res) => {
  try {
    const plans = await PlanMaster.find({}).sort({ level: 1, days: 1 });
    
    // Group plans by level for easier frontend consumption
    const groupedPlans = {
      bigenner: [],
      intermidiate: [],
      advance: []
    };
    
    plans.forEach(plan => {
      if (groupedPlans[plan.level]) {
        groupedPlans[plan.level].push({
          planName: plan.planName,
          days: plan.days,
          price: plan.price,
          _id: plan._id
        });
      }
    });
    
    res.json({
      success: true,
      plans: groupedPlans,
      allPlans: plans
    });
  } catch (error) {
    console.error('Error fetching plans:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch plans'
    });
  }
});

// Get plans for specific level
router.get('/plans/:level', async (req, res) => {
  try {
    const { level } = req.params;
    
    const plans = await PlanMaster.find({ level }).sort({ days: 1 });
    
    res.json({
      success: true,
      level,
      plans
    });
  } catch (error) {
    console.error('Error fetching plans:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch plans'
    });
  }
});

// Get specific plan by level and days
router.get('/plan/:level/:days', async (req, res) => {
  try {
    const { level, days } = req.params;
    
    const plan = await PlanMaster.findOne({ 
      level, 
      days: parseInt(days) 
    });
    
    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Plan not found'
      });
    }
    
    res.json({
      success: true,
      plan
    });
  } catch (error) {
    console.error('Error fetching plan:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch plan'
    });
  }
});

module.exports = router;
