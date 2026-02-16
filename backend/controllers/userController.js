const User = require('../models/User');
const Log = require('../models/Log');
const RegistrationLog = require('../models/RegistrationLog');

// Register user from Google Form
exports.register = async (req, res, next) => {
  console.log('Received registration request:', req.body);
  
  let { name, phone, email } = req.body;
  const ipAddress = req.ip || req.connection.remoteAddress;
  
  // Normalize phone number: Add 91 country code for Indian numbers
  if (phone) {
    // Remove any + sign
    phone = phone.replace(/\+/g, '');
    
    // Add 91 if not already present
    if (!phone.startsWith('91')) {
      phone = '91' + phone;
    }
  }
  
  try {
    // Validate input
    if (!name || !phone) {
      // Log validation error
      await RegistrationLog.create({
        name: name || '',
        phone: phone || '',
        email: email || '',
        status: 'ERROR',
        message: 'Validation failed: Name and phone are required',
        errorDetails: 'Missing required fields',
        ipAddress
      });
      
      return res.status(400).json({ error: 'Name and phone are required' });
    }
    
    // Check if user already exists
    let user = await User.findOne({ phone });
    
    if (!user) {
      // Create new user with proper defaults
      user = await User.create({ 
        name, 
        phone,
        email: email || '',
        isActive: true, // Hardcoded - user is active by default
        state: 'READY', // Ready for first cron job
        currentDay: 1, // Starts from Day 1
        lessonCompleted: false
      });
      
      // Log successful new registration
      await RegistrationLog.create({
        name,
        phone,
        email: email || '',
        status: 'SUCCESS',
        message: 'New user registered successfully',
        ipAddress
      });
      
      await Log.create({ 
        type: 'MESSAGE_RECEIVED', 
        phone, 
        message: 'New user registered' 
      });
    } else {
      // User exists, update state to READY
      user.state = 'READY';
      user.name = name; // Update name in case it changed
      if (email) user.email = email; // Update email if provided
      await user.save();
      
      // Log duplicate/re-registration
      await RegistrationLog.create({
        name,
        phone,
        email: email || '',
        status: 'DUPLICATE',
        message: 'User already exists - state updated to READY',
        ipAddress
      });
      
      await Log.create({ 
        type: 'MESSAGE_RECEIVED', 
        phone, 
        message: 'User re-registered, state set to READY' 
      });
    }
    
    res.status(201).json({ 
      success: true, 
      message: 'User registered successfully',
      user: { name: user.name, phone: user.phone, state: user.state }
    });
  } catch (err) {
    // Log error in registration logs
    await RegistrationLog.create({
      name: name || '',
      phone: phone || '',
      email: email || '',
      status: 'ERROR',
      message: 'Registration failed with error',
      errorDetails: err.message,
      ipAddress
    });
    
    await Log.create({ 
      type: 'ERROR', 
      message: `Registration error: ${err.message}` 
    });
    
    next(err);
  }
};

// Get all users (for admin UI)
exports.getUsers = async (req, res, next) => {
  try {
    const { state } = req.query;
    const filter = state ? { state } : {};
    const users = await User.find(filter).sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    next(err);
  }
};

// Update user state (for admin UI)
exports.updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { state } = req.body;
    const user = await User.findByIdAndUpdate(id, { state }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    next(err);
  }
};
