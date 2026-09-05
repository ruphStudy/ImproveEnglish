const cron = require('node-cron');
const User = require('../models/User');
const Lesson = require('../models/Lesson');
const SpeakingAttempt = require('../models/SpeakingAttempt');
const LearnerEvent = require('../models/LearnerEvent');
const Log = require('../models/Log');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const { runWithCronLock } = require('../utils/cronLock');
const {
  recordLearnerEvent,
  getLatestPaymentInfoMap,
  getComebackSegment,
  buildComebackMessage,
  canSendComebackReminder,
  isWithinUpgradeWindow,
  isEngagedEnoughForUpgrade,
  getUpgradeSegment,
  buildUpgradeNudgeMessage,
  buildDisengagedNudgeMessage,
  canSendUpgradeNudge,
  buildDay30ProgressReport
} = require('../services/retentionService');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DAY30_REPORT_WINDOW = [25, 32];

/**
 * Sends a proactive plain-text nudge and, on failure, logs a clearly labeled
 * "needs an approved template" condition (rather than a generic error) so an
 * operator can tell this apart from a real bug. Re-throws so the caller's
 * per-user catch still counts it as an error and - critically - so the
 * associated milestone is never recorded for a message that was never
 * actually delivered.
 */
async function sendProactiveMessage(phone, message, label) {
  try {
    await sendWhatsAppMessage(phone, message);
  } catch (sendErr) {
    await Log.create({
      type: 'ERROR',
      phone,
      message: `${label} send failed (likely outside WhatsApp's 24h window - needs an approved template): ${sendErr.message}`
    });
    throw sendErr;
  }
}

/**
 * Runs once daily. For each active, onboarded, non-expired user, applies (in
 * priority order, at most one message per user per run to avoid stacking):
 *   1. Day-30 progress report (once per subscription cycle)
 *   2. 30->90 upgrade nudge / soft disengaged nudge (cooldown-gated)
 *   3. Missed-day comeback reminder (cooldown-gated)
 *
 * NOTE ON DELIVERY: all three messages below are sent as plain WhatsApp text.
 * WhatsApp only delivers plain text within an open 24h customer-service
 * window; these are proactive nudges to users who may not have messaged
 * recently, so reliable production delivery requires approved Meta templates
 * for each. That template creation is an external action - see the sprint
 * report. The logic here is fully functional once templates exist.
 */
async function runRetentionEngineJob() {
  return runWithCronLock('retention-engine', 1800, runRetentionEngineJobInner);
}

async function runRetentionEngineJobInner() {
  try {
    console.log('🔁 Retention engine started');
    const now = new Date();

    const candidates = await User.find({
      isActive: true,
      state: { $ne: 'PAUSED' },
      $or: [{ onboardingStatus: { $exists: false } }, { onboardingStatus: 'COMPLETED' }],
      $and: [{ $or: [{ expiryDate: null }, { expiryDate: { $gte: now } }] }]
    });

    console.log(`📋 Evaluating ${candidates.length} active candidates`);

    const paymentInfoMap = await getLatestPaymentInfoMap(candidates.map(u => u._id));

    let day30Sent = 0, upgradeSent = 0, disengagedSent = 0, comebackSent = 0, errors = 0;

    for (const user of candidates) {
      try {
        const paymentInfo = paymentInfoMap.get(String(user._id));
        let handled = false;

        if (paymentInfo) {
          const daysSincePayment = Math.floor((now - new Date(paymentInfo.createdAt)) / ONE_DAY_MS);

          // 1. Day-30 progress report (once per subscription cycle - dedupe by paymentId).
          // Send BEFORE recording: if the send fails (e.g. rejected outside WhatsApp's
          // 24h window - see file-level note), the milestone must stay unclaimed so
          // tomorrow's run retries instead of permanently losing the report.
          if (!handled && paymentInfo.planDuration === 30
              && daysSincePayment >= DAY30_REPORT_WINDOW[0] && daysSincePayment <= DAY30_REPORT_WINDOW[1]) {
            const alreadySent = await LearnerEvent.exists({ userId: user._id, type: 'DAY30_REPORT_SENT', dedupeKey: paymentInfo.razorpayPaymentId });
            if (!alreadySent) {
              const report = await buildDay30ProgressReport(user);
              await sendProactiveMessage(user.phone, report, 'Day-30 report');
              await recordLearnerEvent(user._id, 'DAY30_REPORT_SENT', { dedupeKey: paymentInfo.razorpayPaymentId });
              day30Sent++;
              handled = true;
            }
          }

          // 2. 30->90 upgrade / disengaged nudge
          if (!handled && isWithinUpgradeWindow(paymentInfo.planDuration, daysSincePayment) && await canSendUpgradeNudge(user._id)) {
            const [lessonsCompleted, speakingAttempts] = await Promise.all([
              Lesson.countDocuments({ userId: user._id, status: 'completed' }),
              SpeakingAttempt.countDocuments({ userId: user._id })
            ]);
            const segment = getUpgradeSegment(user, { planDuration: paymentInfo.planDuration, daysSincePayment, lessonsCompleted, speakingAttempts });

            if (segment) {
              const message = segment === 'engaged'
                ? buildUpgradeNudgeMessage(user, { lessonsCompleted, speakingAttempts })
                : buildDisengagedNudgeMessage();

              await sendProactiveMessage(user.phone, message, `Upgrade nudge (${segment})`);
              await recordLearnerEvent(user._id, 'UPGRADE_NUDGE_SENT', {
                dedupeKey: `${paymentInfo.razorpayPaymentId}-${now.toISOString().slice(0, 10)}`,
                metadata: { segment, lessonsCompleted, speakingAttempts }
              });
              segment === 'engaged' ? upgradeSent++ : disengagedSent++;
              handled = true;
            }
          }
        }

        // 3. Missed-day comeback reminder
        if (!handled) {
          const segment = getComebackSegment(user, now);
          if (segment && await canSendComebackReminder(user._id)) {
            const message = buildComebackMessage(segment, user);
            await sendProactiveMessage(user.phone, message, `Comeback reminder (${segment})`);
            await recordLearnerEvent(user._id, 'COMEBACK_REMINDER_SENT', {
              dedupeKey: `${segment}-${now.toISOString().slice(0, 10)}`,
              metadata: { segment }
            });
            comebackSent++;
          }
        }

      } catch (err) {
        console.error(`❌ Retention engine error for ${user.phone}:`, err.message);
        errors++;
        await Log.create({ type: 'ERROR', phone: user.phone, message: `Retention engine error: ${err.message}` });
      }
    }

    const summary = { totalCandidates: candidates.length, day30Sent, upgradeSent, disengagedSent, comebackSent, errors };
    await Log.create({ type: 'CRON_RETENTION_ENGINE', message: `Retention engine completed: ${JSON.stringify(summary)}`, status: 'SUCCESS', metadata: summary });
    console.log('🎯 Retention engine completed:', summary);

    return summary;

  } catch (err) {
    console.error('❌ Retention engine cron error:', err);
    await Log.create({ type: 'ERROR', message: `Retention engine cron error: ${err.message}` });
    throw err;
  }
}

// Once daily at 10:00 AM IST - after the 7am lesson cron and noon reminder, so
// a user who's about to get a normal lesson nudge isn't also hit by this run.
cron.schedule('0 10 * * *', runRetentionEngineJob, { timezone: 'Asia/Kolkata' });

console.log('⏰ Retention engine cron initialized (10:00 AM IST)');

module.exports = { runRetentionEngineJob };
