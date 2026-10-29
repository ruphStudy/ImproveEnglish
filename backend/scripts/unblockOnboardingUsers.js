/**
 * One-time migration: unblock paid users stuck in mandatory onboarding.
 *
 * Before onboarding became optional, new paid users were created with
 * state 'NEW' + onboardingStatus PENDING_GOAL/PENDING_ASSESSMENT and were
 * invisible to the daily lesson cron (which only picks state 'READY') until
 * they finished the WhatsApp assessment.
 *
 * This sets matching users to state 'READY' and unsets onboardingStatus,
 * the same shape new paid users now get. Nothing else is touched: expiryDate,
 * level, currentDay, streak, learningGoal, assessedLevel and payment history
 * are preserved. Safe to re-run - already-unblocked users no longer match.
 *
 * Usage (from backend/):
 *   node scripts/unblockOnboardingUsers.js            # dry run (default) - lists matches, changes nothing
 *   node scripts/unblockOnboardingUsers.js --execute  # applies the update
 */
const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');

function buildFilter(now = new Date()) {
  return {
    state: 'NEW',
    isActive: true,
    expiryDate: { $gte: now },
    onboardingStatus: { $in: ['PENDING_GOAL', 'PENDING_ASSESSMENT'] }
  };
}

function maskPhone(phone) {
  const s = String(phone || '');
  return s.length > 4 ? `${'*'.repeat(s.length - 4)}${s.slice(-4)}` : '****';
}

async function unblockOnboardingUsers({ execute = false, now = new Date(), log = console.log } = {}) {
  const filter = buildFilter(now);
  const users = await User.find(filter)
    .select('_id phone level currentDay expiryDate onboardingStatus')
    .lean();

  log(`Found ${users.length} active, unexpired user(s) stuck in onboarding.`);
  for (const u of users) {
    log(`  ${u._id}  phone=${maskPhone(u.phone)}  level=${u.level}  day=${u.currentDay}  ` +
      `expiry=${u.expiryDate ? u.expiryDate.toISOString().split('T')[0] : '-'}  onboarding=${u.onboardingStatus}`);
  }

  if (!execute) {
    log('DRY RUN - no changes made. Re-run with --execute to apply.');
    return { matched: users.length, modified: 0, executed: false };
  }

  if (users.length === 0) {
    return { matched: 0, modified: 0, executed: true };
  }

  // Re-apply the full filter (not just the listed ids) so a user who changed
  // state since the listing is never overwritten.
  const result = await User.updateMany(
    { ...filter, _id: { $in: users.map(u => u._id) } },
    { $set: { state: 'READY' }, $unset: { onboardingStatus: '' } }
  );

  log(`Updated ${result.modifiedCount} user(s) to READY.`);
  return { matched: users.length, modified: result.modifiedCount, executed: true };
}

if (require.main === module) {
  const execute = process.argv.includes('--execute');
  (async () => {
    try {
      await mongoose.connect(process.env.MONGO_URI);
      console.log(execute ? 'Mode: EXECUTE' : 'Mode: DRY RUN');
      await unblockOnboardingUsers({ execute });
      await mongoose.connection.close();
      process.exit(0);
    } catch (err) {
      console.error('Migration failed:', err.message);
      await mongoose.connection.close().catch(() => {});
      process.exit(1);
    }
  })();
}

module.exports = { unblockOnboardingUsers, buildFilter };
