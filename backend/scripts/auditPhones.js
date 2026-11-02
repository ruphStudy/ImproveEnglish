/**
 * READ-ONLY phone audit. Never modifies data.
 *
 * Reports users whose stored phone is not already in the canonical WhatsApp
 * format (E.164 digits, no "+") produced by utils/phone.js, e.g. legacy
 * Indian numbers saved without the 91 prefix. Fix any listed record manually
 * after checking it - a wrong guess would break WhatsApp delivery.
 *
 * Usage (from backend/): node scripts/auditPhones.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');
const { normalizePhone } = require('../utils/phone');

function mask(phone) {
  const s = String(phone || '');
  return s.length > 4 ? `${'*'.repeat(s.length - 4)}${s.slice(-4)}` : '****';
}

/** Classifies a stored phone; exported for tests. */
function classifyStoredPhone(stored) {
  const asStored = normalizePhone(`+${stored}`);
  if (asStored === stored) return { status: 'ok' };
  const suggested = normalizePhone(stored); // default India, any valid country accepted
  return suggested && suggested !== stored
    ? { status: 'non_canonical', suggested }
    : { status: 'invalid' };
}

async function auditPhones({ log = console.log } = {}) {
  const users = await User.find({}).select('_id phone isActive expiryDate').lean();
  const phonesTaken = new Set(users.map(u => u.phone));
  const findings = [];

  for (const u of users) {
    const result = classifyStoredPhone(u.phone);
    if (result.status === 'ok') continue;
    findings.push({
      userId: String(u._id),
      phone: mask(u.phone),
      status: result.status,
      suggested: result.suggested ? mask(result.suggested) : null,
      suggestedConflictsWithExistingUser: !!(result.suggested && phonesTaken.has(result.suggested)),
      isActive: u.isActive
    });
  }

  log(`Checked ${users.length} user(s); ${findings.length} need review.`);
  for (const f of findings) {
    log(`  ${f.userId} phone=${f.phone} ${f.status}${f.suggested ? ` suggested=${f.suggested}` : ''}` +
      `${f.suggestedConflictsWithExistingUser ? ' (suggested number already belongs to another user!)' : ''} active=${f.isActive}`);
  }
  log('READ-ONLY - no changes were made.');
  return { checked: users.length, findings };
}

if (require.main === module) {
  (async () => {
    try {
      await mongoose.connect(process.env.MONGO_URI);
      await auditPhones();
      await mongoose.connection.close();
      process.exit(0);
    } catch (err) {
      console.error('Audit failed:', err.message);
      await mongoose.connection.close().catch(() => {});
      process.exit(1);
    }
  })();
}

module.exports = { auditPhones, classifyStoredPhone };
