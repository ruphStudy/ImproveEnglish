const mongoose = require('mongoose');

// Milestone/funnel tracking only - NOT raw clickstream. One row per meaningful
// lifecycle event, not per WhatsApp message.
const EVENT_TYPES = [
  'SUBSCRIPTION_ACTIVATED',
  'ONBOARDING_COMPLETED',
  'FIRST_START',
  'FIRST_LESSON_SENT',
  'FIRST_LESSON_COMPLETED',
  'FIRST_VOICE_ATTEMPT',
  'DAY_1_ACTIVE',
  'DAY_3_ACTIVE',
  'DAY_7_ACTIVE',
  'DAY_14_ACTIVE',
  'DAY_30_ACTIVE',
  'SUBSCRIPTION_RENEWED',
  'SUBSCRIPTION_UPGRADED',
  'DAY30_REPORT_SENT',
  'COMEBACK_REMINDER_SENT',
  'UPGRADE_NUDGE_SENT'
];

const learnerEventSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: EVENT_TYPES,
    required: true
  },
  // Distinguishes repeatable event types (a renewal payment, a specific day
  // milestone, a specific comeback segment) so the SAME underlying trigger
  // can never be recorded twice, while genuinely distinct triggers of the
  // same type (e.g. a later renewal) still get their own row. 'default' is
  // used for true once-ever-per-user singletons (e.g. FIRST_START).
  dedupeKey: {
    type: String,
    default: 'default'
  },
  metadata: { type: mongoose.Schema.Types.Mixed },
  occurredAt: { type: Date, default: Date.now }
});

// The core idempotency guarantee: DB-level uniqueness, immune to duplicate
// WhatsApp delivery, retries, worker retries, or app restarts.
learnerEventSchema.index({ userId: 1, type: 1, dedupeKey: 1 }, { unique: true });
learnerEventSchema.index({ type: 1, occurredAt: 1 });
learnerEventSchema.index({ userId: 1, occurredAt: 1 });

const LearnerEvent = mongoose.model('LearnerEvent', learnerEventSchema);
module.exports = LearnerEvent;
module.exports.EVENT_TYPES = EVENT_TYPES;
