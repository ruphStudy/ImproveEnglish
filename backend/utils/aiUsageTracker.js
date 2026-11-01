const mongoose = require('mongoose');
const AiUsage = require('../models/AiUsage');
const Log = require('../models/Log');
const { getModelPricing, computeTokenCost, computeAudioCost } = require('../config/aiPricing');

const OPERATION_CATEGORIES = {
  lesson_generation: 'lesson',
  lesson_generation_retry: 'lesson',
  voice_transcription: 'voice',
  voice_evaluation: 'voice',
  voice_evaluation_retry: 'voice',
  assessment_transcription: 'onboarding',
  assessment_evaluation: 'onboarding',
  assessment_evaluation_retry: 'onboarding'
};

// In-process tracking health (resets on restart; failures are also written
// to Log as AI_USAGE_TRACKING_ERROR when the database is reachable).
const health = { since: new Date(), recorded: 0, duplicates: 0, failures: 0, lastFailureAt: null, lastError: null };

function toCount(n) {
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function buildSuccessRecord(base, response, kind) {
  const record = { ...base, status: 'success', model: response?.model || base.model };
  const requestId = response?.id || response?._request_id;
  if (typeof requestId === 'string' && requestId) record.requestId = requestId;

  const pricing = getModelPricing(base.model) || getModelPricing(record.model);
  record.pricing = pricing;
  if (!pricing) {
    return { ...record, costUsd: null, costKnown: false, unknownReason: 'no_pricing_for_model' };
  }

  if (kind === 'transcription') {
    // Prefer the billed usage.seconds when present; otherwise verbose_json's
    // audio `duration`. Neither -> unknown cost.
    const usage = response?.usage;
    const billedSeconds = usage && usage.type === 'duration' ? toCount(usage.seconds) : null;
    const seconds = billedSeconds ?? toCount(response?.duration);
    record.audioSeconds = seconds;
    const cost = computeAudioCost(seconds, pricing);
    return cost === null
      ? { ...record, costUsd: null, costKnown: false, unknownReason: 'audio_duration_missing' }
      : { ...record, costUsd: cost, costKnown: true };
  }

  const usage = response?.usage;
  record.inputTokens = toCount(usage?.prompt_tokens);
  record.outputTokens = toCount(usage?.completion_tokens);
  record.cachedInputTokens = toCount(usage?.prompt_tokens_details?.cached_tokens) ?? (record.inputTokens === null ? null : 0);
  const cost = computeTokenCost(record, pricing);
  return cost === null
    ? { ...record, costUsd: null, costKnown: false, unknownReason: 'token_usage_missing' }
    : { ...record, costUsd: cost, costKnown: true };
}

function buildErrorRecord(base, err) {
  // A failed request is usually not billed, but a timeout/connection drop
  // after OpenAI received it may be - so its cost is unknown, never 0.
  const record = {
    ...base,
    status: 'error',
    costUsd: null,
    costKnown: false,
    unknownReason: 'request_failed',
    errorStatus: Number.isFinite(err?.status) ? err.status : null,
    pricing: getModelPricing(base.model)
  };
  const requestId = err?.request_id || err?.requestID;
  if (typeof requestId === 'string' && requestId) record.requestId = requestId;
  return record;
}

async function noteFailure(message, record) {
  health.failures += 1;
  health.lastFailureAt = new Date();
  health.lastError = message;
  console.error(`⚠️ AI usage tracking failed (${record.operation}): ${message}`);
  if (mongoose.connection.readyState === 1) {
    await Log.create({
      type: 'AI_USAGE_TRACKING_ERROR',
      message: `AI usage not recorded for ${record.operation}: ${message}`,
      status: 'ERROR',
      metadata: { operation: record.operation, model: record.model, costUsd: record.costUsd }
    }).catch(() => {});
  }
}

/** Persists one usage record. Never throws - tracking must not break the caller. */
async function saveRecord(record) {
  try {
    // Without a connection mongoose would buffer the insert and stall the caller.
    if (mongoose.connection.readyState !== 1) {
      await noteFailure('database not connected', record);
      return;
    }
    await AiUsage.create(record);
    health.recorded += 1;
  } catch (err) {
    if (err && err.code === 11000) {
      health.duplicates += 1; // same OpenAI request already recorded
      return;
    }
    await noteFailure(err?.message || String(err), record);
  }
}

/**
 * Runs one OpenAI request and records its usage/cost. Returns the response
 * (or rethrows the error) exactly as the un-tracked call would.
 *
 * @param {object} meta - { operation, model, userId?, kind?: 'chat' | 'transcription' }
 * @param {Function} call - () => openai.<...>.create(...)
 */
async function trackOpenAI(meta, call) {
  const base = {
    operation: meta.operation,
    category: OPERATION_CATEGORIES[meta.operation] || 'other',
    model: meta.model,
    userId: meta.userId || null
  };

  let response;
  try {
    response = await call();
  } catch (err) {
    await safeRecord(() => buildErrorRecord(base, err), base);
    throw err;
  }
  await safeRecord(() => buildSuccessRecord(base, response, meta.kind || 'chat'), base);
  return response;
}

// Building a record must never turn a successful (already billed) OpenAI call
// into an error, or mask the original API error.
async function safeRecord(build, base) {
  let record;
  try {
    record = build();
  } catch (err) {
    await noteFailure(`could not build usage record: ${err.message}`, base);
    return;
  }
  await saveRecord(record);
}

function getTrackingHealth() {
  return { ...health };
}

module.exports = { trackOpenAI, getTrackingHealth, buildSuccessRecord, buildErrorRecord, OPERATION_CATEGORIES };
