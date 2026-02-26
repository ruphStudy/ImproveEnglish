const cron = require('node-cron');
const User = require('../models/User');
const Log = require('../models/Log');

/**
 * Subscription Expiry Cron - Runs daily at midnight IST
 * 
 * Deactivates users whose subscription has expired
 */
cron.schedule('0 0 * * *', async () => {
  try {
    console.log('🕛 Subscription expiry check started at midnight');
    
    const now = new Date();
    
    // Find users whose subscription has expired
    const expiredUsers = await User.find({
      isActive: true,
      expiryDate: { $lt: now }
    });
    
    if (expiredUsers.length === 0) {
      console.log('✅ No expired subscriptions found');
      return;
    }
    
    console.log(`⚠️ Found ${expiredUsers.length} expired subscriptions`);
    
    for (const user of expiredUsers) {
      try {
        user.isActive = false;
        await user.save();
        
        await Log.create({
          type: 'SUBSCRIPTION_EXPIRED',
          userPhone: user.phone,
          message: `Subscription expired on ${user.expiryDate.toLocaleDateString('en-IN')}`,
          status: 'INFO',
          metadata: {
            expiryDate: user.expiryDate,
            lastDay: user.currentDay
          }
        });
        
        console.log(`⏹️  Deactivated ${user.name} (${user.phone}) - expired on ${user.expiryDate.toLocaleDateString('en-IN')}`);
      } catch (err) {
        console.error(`❌ Error deactivating ${user.phone}:`, err.message);
      }
    }
    
    await Log.create({
      type: 'CRON_EXPIRY',
      message: `Expiry check: ${expiredUsers.length} users deactivated`,
      status: 'SUCCESS'
    });
    
    console.log(`🎯 Expiry check completed - ${expiredUsers.length} users deactivated`);
    
  } catch (err) {
    console.error('❌ Expiry cron error:', err);
    await Log.create({ 
      type: 'ERROR', 
      message: `Expiry cron error: ${err.message}`,
      status: 'ERROR'
    });
  }
}, {
  timezone: 'Asia/Kolkata'
});

console.log('⏰ Subscription expiry cron initialized (midnight IST)');
