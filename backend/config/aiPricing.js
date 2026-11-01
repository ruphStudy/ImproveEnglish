/**
 * Central OpenAI price table (USD). Every AiUsage record stores a copy of the
 * rates it was costed with, so changing a price here never rewrites history.
 * Rates verified 2026-11-01 - update PRICING_VERSION whenever they change.
 */
const PRICING_VERSION = '2026-11-01';

const MODEL_PRICING = {
  'gpt-4o-mini': { billing: 'tokens', inputPer1M: 0.15, cachedInputPer1M: 0.075, outputPer1M: 0.6 },
  'whisper-1': { billing: 'audio', perAudioMinute: 0.006 }
};

/**
 * Exact match first, then the longest key the model name starts with, so a
 * dated snapshot like "gpt-4o-mini-2024-07-18" still prices as gpt-4o-mini.
 */
function getModelPricing(model) {
  if (!model) return null;
  if (MODEL_PRICING[model]) return { model, ...MODEL_PRICING[model], version: PRICING_VERSION };
  const key = Object.keys(MODEL_PRICING)
    .filter(k => model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? { model: key, ...MODEL_PRICING[key], version: PRICING_VERSION } : null;
}

/**
 * Chat Completions cost. prompt_tokens already INCLUDES cached tokens, so
 * cached tokens are billed at the cached rate and only the remainder at the
 * full input rate - never both. Returns null when usage is missing.
 */
function computeTokenCost({ inputTokens, cachedInputTokens, outputTokens }, pricing) {
  if (!pricing || pricing.billing !== 'tokens') return null;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  const cached = Math.min(Math.max(cachedInputTokens || 0, 0), inputTokens);
  const uncached = inputTokens - cached;
  return (uncached * pricing.inputPer1M + cached * pricing.cachedInputPer1M + outputTokens * pricing.outputPer1M) / 1e6;
}

/** Whisper cost from billed audio seconds. Returns null when duration is unknown. */
function computeAudioCost(audioSeconds, pricing) {
  if (!pricing || pricing.billing !== 'audio') return null;
  if (!Number.isFinite(audioSeconds) || audioSeconds < 0) return null;
  return (audioSeconds / 60) * pricing.perAudioMinute;
}

/** Approximate display-only conversion rate; null when USD_TO_INR is unset/invalid. */
function getUsdToInr() {
  const rate = parseFloat(process.env.USD_TO_INR);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

module.exports = { PRICING_VERSION, MODEL_PRICING, getModelPricing, computeTokenCost, computeAudioCost, getUsdToInr };
