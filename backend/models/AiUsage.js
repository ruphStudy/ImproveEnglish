const mongoose = require('mongoose');

/**
 * One document per OpenAI API request (including corrective retries and
 * failed attempts). costUsd is an ESTIMATE from recorded usage x the pricing
 * snapshot - not OpenAI's billed amount. costKnown=false means usage was
 * missing/uncertain (or the request failed) and costUsd is null, never 0.
 */
const aiUsageSchema = new mongoose.Schema({
  operation: { type: String, required: true },
  category: { type: String, enum: ['lesson', 'voice', 'onboarding', 'other'], required: true },
  model: { type: String, required: true },
  requestId: { type: String }, // OpenAI response id / x-request-id - idempotency key when present
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // null = not attributable
  status: { type: String, enum: ['success', 'error'], required: true },
  inputTokens: { type: Number, default: null },
  cachedInputTokens: { type: Number, default: null },
  outputTokens: { type: Number, default: null },
  audioSeconds: { type: Number, default: null },
  costUsd: { type: Number, default: null },
  costKnown: { type: Boolean, required: true },
  unknownReason: { type: String, default: null },
  errorStatus: { type: Number, default: null }, // HTTP status of a failed request, if any
  pricing: { type: mongoose.Schema.Types.Mixed, default: null }, // rates applied to this record
  createdAt: { type: Date, default: Date.now }
});

aiUsageSchema.index({ createdAt: 1 });
aiUsageSchema.index({ userId: 1, createdAt: 1 });
aiUsageSchema.index(
  { requestId: 1 },
  { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } }
);

module.exports = mongoose.model('AiUsage', aiUsageSchema);
