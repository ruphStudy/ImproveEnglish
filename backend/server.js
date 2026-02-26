require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { errorHandler } = require('./middleware/errorHandler');
const userRoutes = require('./routes/userRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const logRoutes = require('./routes/logRoutes');
const registrationLogRoutes = require('./routes/registrationLogRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const planRoutes = require('./routes/planRoutes');

const app = express();

// Trust proxy - required for ngrok and other reverse proxies
app.set('trust proxy', 1);

// Middleware
app.use(helmet());
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174', 'https://www.fluencyloop.in'],
  credentials: true
}));
app.use(morgan('dev'));

// IMPORTANT: Razorpay webhook needs raw body, apply before express.json()
app.use('/api/payments/razorpay-webhook', express.raw({ type: 'application/json' }));

app.use(express.json());

// Rate limit for registration endpoint
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: 'Too many registration attempts, please try again later.'
});
app.use('/api/register', registerLimiter);

// Routes
app.use('/api', userRoutes);
app.use('/api', webhookRoutes);
app.use('/api', logRoutes);
app.use('/api', registrationLogRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api', planRoutes);
app.use('/api/cron', require('./routes/cronRoutes'));
app.use('/api/analytics', require('./routes/analyticsRoutes'));

// Error handler
app.use(errorHandler);

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('MongoDB connected');
  // Start server only after DB connection
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('MongoDB connection error:', err);
});

// Cron jobs
require('./cron/dailyLesson');
require('./cron/resetState');
require('./cron/subscriptionExpiry');
require('./cron/expiryReminder');
require('./cron/streakReset');
require('./cron/weeklySummary');
require('./cron/lessonReminder');
