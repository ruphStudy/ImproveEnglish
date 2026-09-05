jest.mock('../config/openai', () => ({
  chat: { completions: { create: jest.fn() } },
  audio: { transcriptions: { create: jest.fn() } }
}));
jest.mock('../models/Log', () => ({ create: jest.fn().mockResolvedValue({}) }));

const openai = require('../config/openai');
const {
  getNextAssessmentStep,
  isAssessmentComplete,
  getStepNumber,
  runAssessmentEvaluation,
  validateAssessmentJson,
  validateRecommendedLevel,
  deterministicLevelFromScore,
  buildOnboardingCompletionMessage
} = require('../services/assessmentService');

function openaiResponse(obj) {
  return { choices: [{ message: { content: JSON.stringify(obj) } }] };
}

function validAssessmentJson(overrides = {}) {
  return {
    grammarScore: 6,
    sentenceFormationScore: 6,
    vocabularyScore: 5,
    naturalnessScore: 6,
    comprehensionScore: 7,
    overallScore: 6,
    recommendedLevel: 'intermediate',
    strengths: ['Clear comprehension'],
    weakAreas: ['prepositions'],
    summary: 'Good start - keep practicing.',
    ...overrides
  };
}

function assessment(overrides = {}) {
  return {
    textResponses: [
      { questionId: 'text1', question: 'Q1', answer: 'My name is Raj and I work in sales.' },
      { questionId: 'text2', question: 'Q2', answer: 'I wake up, go to work, and study English at night.' }
    ],
    voiceResponses: [
      { questionId: 'voice1', question: 'Q3', transcript: 'Hi I am Raj, I work in sales and I like cricket.' },
      { questionId: 'voice2', question: 'Q4', transcript: 'Last week a client was unhappy and I solved it by listening carefully.' }
    ],
    ...overrides
  };
}

describe('getNextAssessmentStep / getStepNumber', () => {
  test('resumes from persisted partial state (2 text answers already recorded -> next is voice1)', () => {
    const partial = assessment({ voiceResponses: [] });
    const step = getNextAssessmentStep(partial);
    expect(step.questionId).toBe('voice1');
    expect(getStepNumber(partial)).toBe(3);
  });

  test('returns null once all 4 questions are answered', () => {
    expect(getNextAssessmentStep(assessment())).toBeNull();
    expect(isAssessmentComplete(assessment())).toBe(true);
  });
});

describe('validateAssessmentJson', () => {
  test('accepts a well-formed result', () => {
    expect(validateAssessmentJson(validAssessmentJson()).valid).toBe(true);
  });

  test('rejects out-of-range/missing fields', () => {
    const result = validateAssessmentJson({ overallScore: 999 });
    expect(result.valid).toBe(false);
  });
});

describe('validateRecommendedLevel / deterministicLevelFromScore', () => {
  test('rejects a level outside the fixed 3-level set', () => {
    expect(validateRecommendedLevel('expert')).toBeNull();
    expect(validateRecommendedLevel('beginner')).toBe('beginner');
  });

  test('deterministic thresholds map scores to sensible levels', () => {
    expect(deterministicLevelFromScore(3)).toBe('beginner');
    expect(deterministicLevelFromScore(6)).toBe('intermediate');
    expect(deterministicLevelFromScore(9)).toBe('advanced');
  });
});

describe('runAssessmentEvaluation - single call, one retry, deterministic fallback', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a valid response uses exactly one GPT call', async () => {
    openai.chat.completions.create.mockResolvedValueOnce(openaiResponse(validAssessmentJson()));

    const result = await runAssessmentEvaluation(assessment());

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(result.validationStatus).toBe('valid');
    expect(result.recommendedLevel).toBe('intermediate');
  });

  test('malformed JSON triggers exactly one corrective retry', async () => {
    openai.chat.completions.create
      .mockResolvedValueOnce(openaiResponse({ overallScore: 'not-a-number' }))
      .mockResolvedValueOnce(openaiResponse(validAssessmentJson()));

    const result = await runAssessmentEvaluation(assessment());

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(result.validationStatus).toBe('retried');
  });

  test('a second invalid response uses a deterministic fallback, never a third call', async () => {
    openai.chat.completions.create
      .mockResolvedValueOnce(openaiResponse({ bad: true }))
      .mockResolvedValueOnce(openaiResponse({ bad: true }));

    const result = await runAssessmentEvaluation(assessment());

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(result.validationStatus).toBe('fallback');
    expect(['beginner', 'intermediate', 'advanced']).toContain(result.recommendedLevel);
  });

  test('an invalid AI-provided level is coerced via the deterministic score threshold, not trusted blindly', async () => {
    openai.chat.completions.create.mockResolvedValueOnce(openaiResponse(validAssessmentJson({ recommendedLevel: 'expert', overallScore: 3 })));

    const result = await runAssessmentEvaluation(assessment());

    expect(result.recommendedLevel).toBe('beginner'); // from deterministicLevelFromScore(3), not the invalid "expert"
  });

  test('a hard API failure (not malformed JSON) still falls back safely with no crash', async () => {
    openai.chat.completions.create.mockRejectedValueOnce(new Error('network down'));

    const result = await runAssessmentEvaluation(assessment());

    expect(result.validationStatus).toBe('fallback');
    expect(['beginner', 'intermediate', 'advanced']).toContain(result.recommendedLevel);
  });

  test('never claims a pronunciation score anywhere in the result', async () => {
    openai.chat.completions.create.mockResolvedValueOnce(openaiResponse(validAssessmentJson()));

    const result = await runAssessmentEvaluation(assessment());

    expect(JSON.stringify(result).toLowerCase()).not.toContain('pronunciation');
  });
});

describe('buildOnboardingCompletionMessage', () => {
  test('discloses a mismatch between purchased level and assessment recommendation without changing entitlement', () => {
    const msg = buildOnboardingCompletionMessage({
      learningGoal: 'interview',
      level: 'intermediate',
      recommendedLevel: 'beginner',
      strengths: ['Vocabulary'],
      weakAreas: ['sentence_order', 'prepositions']
    });
    expect(msg).toContain('Level: Intermediate'); // purchased level is what's operative
    expect(msg).toContain('suggested Beginner'); // recommendation disclosed, not hidden
    expect(msg).toContain('Interview English');
    expect(msg).toContain('Reply START to begin Day 1.');
  });

  test('no mismatch note when recommendation matches the purchased level', () => {
    const msg = buildOnboardingCompletionMessage({
      learningGoal: 'daily_english',
      level: 'beginner',
      recommendedLevel: 'beginner',
      strengths: [],
      weakAreas: []
    });
    expect(msg).not.toContain('suggested');
  });
});
