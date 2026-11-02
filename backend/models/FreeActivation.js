const mongoose = require('mongoose');

/**
 * One free-beta (100% promo) activation. Kept separate from PaymentHistory so
 * free activations never carry Razorpay ids or appear in revenue reports.
 *
 * The unique {promoCode, phone} index is the idempotency/concurrency key:
 * retries and parallel requests for the same phone + code always resolve to
 * this one document. status flow: reserved -> activated | rejected.
 */
const freeActivationSchema = new mongoose.Schema({
  source: { type: String, default: 'FREE_PROMO', immutable: true },
  promoCode: { type: String, required: true },
  phone: { type: String, required: true },
  name: { type: String },
  email: { type: String },
  level: { type: String, enum: ['beginner', 'intermediate', 'advanced'], required: true },
  planDuration: { type: Number, required: true },
  listPriceInr: { type: Number, required: true }, // PlanMaster price waived - informational, NOT revenue
  status: { type: String, enum: ['reserved', 'activated', 'rejected'], default: 'reserved' },
  rejectReason: { type: String, default: null },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  expiryDate: { type: Date, default: null },
  activatedAt: { type: Date, default: null },
  // 'sent' = accepted by the WhatsApp Cloud API (not a delivery receipt).
  welcomeStatus: { type: String, enum: ['pending', 'sent', 'failed', 'skipped_no_template'], default: 'pending' },
  welcomeError: { type: String, default: null },
  welcomeMessageId: { type: String, default: null }, // wamid returned on acceptance, for later delivery checks
  timezone: { type: String, default: undefined } // validated IANA zone, copied to the user it creates
}, { timestamps: true });

freeActivationSchema.index({ promoCode: 1, phone: 1 }, { unique: true });
freeActivationSchema.index({ status: 1, updatedAt: 1 });

module.exports = mongoose.model('FreeActivation', freeActivationSchema);
