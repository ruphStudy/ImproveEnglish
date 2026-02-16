const Log = require('../models/Log');

exports.errorHandler = async (err, req, res, next) => {
  await Log.create({ type: 'ERROR', message: err.message });
  res.status(500).json({ error: err.message });
};
