jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  actual.connection.readyState = 1;
  return actual;
});
jest.mock('../models/AiUsage', () => ({ create: jest.fn() }));
jest.mock('../models/Log', () => ({ create: jest.fn().mockResolvedValue({}) }));

const mongoose = require('mongoose');
const AiUsage = require('../models/AiUsage');
const Log = require('../models/Log');
const { trackOpenAI, getTrackingHealth } = require('../utils/aiUsageTracker');

const chatResponse = (id, usage) => ({ id, model: 'gpt-4o-mini-2024-07-18', usage, choices: [] });

beforeEach(() => {
  jest.clearAllMocks();
  mongoose.connection.readyState = 1;
  AiUsage.create.mockResolvedValue({});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('records tokens, cached tokens, cost, user and request id; returns the response unchanged', async () => {
  const response = chatResponse('chatcmpl-1', { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } });
  const result = await trackOpenAI({ operation: 'lesson_generation', model: 'gpt-4o-mini', userId: 'u1' }, async () => response);

  expect(result).toBe(response);
  const record = AiUsage.create.mock.calls[0][0];
  expect(record).toMatchObject({
    operation: 'lesson_generation',
    category: 'lesson',
    status: 'success',
    requestId: 'chatcmpl-1',
    userId: 'u1',
    inputTokens: 1000,
    cachedInputTokens: 400,
    outputTokens: 200,
    costKnown: true
  });
  expect(record.costUsd).toBeCloseTo((600 * 0.15 + 400 * 0.075 + 200 * 0.6) / 1e6, 15);
  expect(record.pricing).toMatchObject({ model: 'gpt-4o-mini', inputPer1M: 0.15, cachedInputPer1M: 0.075, outputPer1M: 0.6 });
});

test('a corrective retry is a separate billable request and gets its own record', async () => {
  await trackOpenAI({ operation: 'lesson_generation', model: 'gpt-4o-mini', userId: 'u1' },
    async () => chatResponse('chatcmpl-a', { prompt_tokens: 10, completion_tokens: 5 }));
  await trackOpenAI({ operation: 'lesson_generation_retry', model: 'gpt-4o-mini', userId: 'u1' },
    async () => chatResponse('chatcmpl-b', { prompt_tokens: 20, completion_tokens: 5 }));

  expect(AiUsage.create).toHaveBeenCalledTimes(2);
  expect(AiUsage.create.mock.calls.map(c => c[0].operation)).toEqual(['lesson_generation', 'lesson_generation_retry']);
});

test('a duplicate request id (already recorded) is ignored, not counted as a failure', async () => {
  const before = getTrackingHealth();
  AiUsage.create.mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
  await trackOpenAI({ operation: 'voice_evaluation', model: 'gpt-4o-mini' },
    async () => chatResponse('chatcmpl-dup', { prompt_tokens: 1, completion_tokens: 1 }));

  const after = getTrackingHealth();
  expect(after.duplicates).toBe(before.duplicates + 1);
  expect(after.failures).toBe(before.failures);
  expect(Log.create).not.toHaveBeenCalled();
});

test('a recording failure never breaks the caller, and is logged for tracking health', async () => {
  const before = getTrackingHealth();
  AiUsage.create.mockRejectedValue(new Error('write failed'));
  const response = chatResponse('chatcmpl-x', { prompt_tokens: 1, completion_tokens: 1 });

  await expect(trackOpenAI({ operation: 'lesson_generation', model: 'gpt-4o-mini' }, async () => response)).resolves.toBe(response);
  expect(getTrackingHealth().failures).toBe(before.failures + 1);
  expect(Log.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'AI_USAGE_TRACKING_ERROR' }));
});

test('when the database is not connected nothing is buffered and the caller is not blocked', async () => {
  mongoose.connection.readyState = 0;
  const response = chatResponse('chatcmpl-y', { prompt_tokens: 1, completion_tokens: 1 });
  await expect(trackOpenAI({ operation: 'lesson_generation', model: 'gpt-4o-mini' }, async () => response)).resolves.toBe(response);
  expect(AiUsage.create).not.toHaveBeenCalled();
});

test('missing token usage is recorded as unknown cost, not zero', async () => {
  await trackOpenAI({ operation: 'voice_evaluation', model: 'gpt-4o-mini' }, async () => ({ id: 'chatcmpl-z', choices: [] }));
  const record = AiUsage.create.mock.calls[0][0];
  expect(record.costKnown).toBe(false);
  expect(record.costUsd).toBeNull();
  expect(record.unknownReason).toBe('token_usage_missing');
});

test('whisper uses billed audio duration from the response; no token usage assumed', async () => {
  await trackOpenAI({ operation: 'voice_transcription', model: 'whisper-1', userId: 'u2', kind: 'transcription' },
    async () => Object.assign({ text: 'hello', usage: { type: 'duration', seconds: 30 } }, { _request_id: 'req_1' }));
  const record = AiUsage.create.mock.calls[0][0];
  expect(record).toMatchObject({ category: 'voice', audioSeconds: 30, costKnown: true, requestId: 'req_1' });
  expect(record.inputTokens).toBeUndefined();
  expect(record.costUsd).toBeCloseTo(0.003, 12);
});

test('whisper without a duration is unknown cost', async () => {
  await trackOpenAI({ operation: 'voice_transcription', model: 'whisper-1', kind: 'transcription' }, async () => ({ text: 'hi' }));
  const record = AiUsage.create.mock.calls[0][0];
  expect(record).toMatchObject({ costKnown: false, costUsd: null, unknownReason: 'audio_duration_missing' });
});

test('a failed request is recorded with unknown cost and the original error is rethrown', async () => {
  const err = Object.assign(new Error('timeout'), { status: 504 });
  await expect(trackOpenAI({ operation: 'lesson_generation', model: 'gpt-4o-mini', userId: 'u1' }, async () => { throw err; })).rejects.toBe(err);
  const record = AiUsage.create.mock.calls[0][0];
  expect(record).toMatchObject({ status: 'error', costKnown: false, costUsd: null, unknownReason: 'request_failed', errorStatus: 504 });
});

test('a record-building error never turns a successful OpenAI call into a failure', async () => {
  const before = getTrackingHealth();
  const response = { id: 'chatcmpl-bad' };
  Object.defineProperty(response, 'usage', { get() { throw new Error('boom'); } });
  await expect(trackOpenAI({ operation: 'lesson_generation', model: 'gpt-4o-mini' }, async () => response)).resolves.toBe(response);
  expect(getTrackingHealth().failures).toBe(before.failures + 1);
});

describe('whisper-1 response shapes', () => {
  const track = (response) => trackOpenAI(
    { operation: 'voice_transcription', model: 'whisper-1', userId: 'u3', kind: 'transcription' },
    async () => response
  );

  test('verbose_json: cost from the audio duration field', async () => {
    await track({ task: 'transcribe', language: 'english', duration: 45.5, text: 'hello there', segments: [] });
    const record = AiUsage.create.mock.calls[0][0];
    expect(record).toMatchObject({ audioSeconds: 45.5, costKnown: true, model: 'whisper-1' });
    expect(record.costUsd).toBeCloseTo((45.5 / 60) * 0.006, 15);
  });

  test('verbose_json with usage: billed usage.seconds takes precedence over duration', async () => {
    await track({ duration: 45.5, text: 'hi', usage: { type: 'duration', seconds: 46 } });
    expect(AiUsage.create.mock.calls[0][0].audioSeconds).toBe(46);
  });

  test('plain json with no duration or usage: unknown cost, never zero', async () => {
    await track({ text: 'hi' });
    expect(AiUsage.create.mock.calls[0][0]).toMatchObject({ costKnown: false, costUsd: null, unknownReason: 'audio_duration_missing' });
  });

  test('invalid duration values are treated as unknown', async () => {
    await track({ text: 'hi', duration: 'abc' });
    await track({ text: 'hi', duration: -3 });
    expect(AiUsage.create.mock.calls.map(c => c[0].costKnown)).toEqual([false, false]);
  });

  test('a zero-length clip is a known zero cost', async () => {
    await track({ text: '', duration: 0 });
    expect(AiUsage.create.mock.calls[0][0]).toMatchObject({ audioSeconds: 0, costUsd: 0, costKnown: true });
  });
});
