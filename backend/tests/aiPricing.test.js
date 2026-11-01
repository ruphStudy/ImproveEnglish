const { getModelPricing, computeTokenCost, computeAudioCost, getUsdToInr } = require('../config/aiPricing');

describe('aiPricing', () => {
  const mini = getModelPricing('gpt-4o-mini');

  test('prices gpt-4o-mini input/output per 1M tokens', () => {
    const cost = computeTokenCost({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }, mini);
    expect(cost).toBeCloseTo(0.75, 12);
  });

  test('cached tokens are billed at the cached rate and not double-counted', () => {
    // 1000 prompt tokens of which 400 cached: 600 x 0.15 + 400 x 0.075 + 200 x 0.60 (per 1M)
    const cost = computeTokenCost({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 }, mini);
    expect(cost).toBeCloseTo((600 * 0.15 + 400 * 0.075 + 200 * 0.6) / 1e6, 15);
  });

  test('cached tokens larger than prompt tokens are capped', () => {
    const cost = computeTokenCost({ inputTokens: 100, cachedInputTokens: 500, outputTokens: 0 }, mini);
    expect(cost).toBeCloseTo((100 * 0.075) / 1e6, 15);
  });

  test('missing usage gives null (unknown), never 0', () => {
    expect(computeTokenCost({ inputTokens: null, cachedInputTokens: null, outputTokens: null }, mini)).toBeNull();
    expect(computeAudioCost(null, getModelPricing('whisper-1'))).toBeNull();
  });

  test('whisper-1 is priced per audio minute', () => {
    expect(computeAudioCost(90, getModelPricing('whisper-1'))).toBeCloseTo(0.009, 12);
  });

  test('dated model snapshots map to the base model; unknown models have no pricing', () => {
    expect(getModelPricing('gpt-4o-mini-2024-07-18').model).toBe('gpt-4o-mini');
    expect(getModelPricing('gpt-4o')).toBeNull();
    expect(getModelPricing('gpt-4o-mini').version).toBeDefined();
  });

  test('USD_TO_INR is optional', () => {
    const original = process.env.USD_TO_INR;
    delete process.env.USD_TO_INR;
    expect(getUsdToInr()).toBeNull();
    process.env.USD_TO_INR = '83.5';
    expect(getUsdToInr()).toBe(83.5);
    process.env.USD_TO_INR = 'abc';
    expect(getUsdToInr()).toBeNull();
    if (original === undefined) delete process.env.USD_TO_INR; else process.env.USD_TO_INR = original;
  });
});
