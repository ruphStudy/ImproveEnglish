const RegistrationLog = require('../models/RegistrationLog');

// Get registration logs (for admin UI)
exports.getRegistrationLogs = async (req, res, next) => {
  try {
    const { status, phone, startDate, endDate, limit = 200 } = req.query;
    
    const filter = {};
    if (status) filter.status = status;
    if (phone) filter.phone = { $regex: phone, $options: 'i' };
    
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }
    
    const logs = await RegistrationLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));
    
    res.json(logs);
  } catch (err) {
    next(err);
  }
};

// Get registration stats
exports.getRegistrationStats = async (req, res, next) => {
  try {
    const total = await RegistrationLog.countDocuments();
    const success = await RegistrationLog.countDocuments({ status: 'SUCCESS' });
    const duplicate = await RegistrationLog.countDocuments({ status: 'DUPLICATE' });
    const error = await RegistrationLog.countDocuments({ status: 'ERROR' });
    
    // Get today's registrations
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayTotal = await RegistrationLog.countDocuments({
      createdAt: { $gte: today }
    });
    
    res.json({
      total,
      success,
      duplicate,
      error,
      todayTotal
    });
  } catch (err) {
    next(err);
  }
};
