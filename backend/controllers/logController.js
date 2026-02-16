const Log = require('../models/Log');

// Get logs (for admin UI)
exports.getLogs = async (req, res, next) => {
  try {
    const { type, startDate, endDate } = req.query;
    const filter = {};
    if (type) filter.type = type;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }
    const logs = await Log.find(filter).sort({ createdAt: -1 }).limit(200);
    res.json(logs);
  } catch (err) {
    next(err);
  }
};
