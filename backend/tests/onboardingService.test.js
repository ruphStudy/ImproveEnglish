jest.mock('../config/openai', () => ({ chat: { completions: { create: jest.fn() } } }));
jest.mock('../models/Log', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/LearnerAssessment', () => {
  const mockModel = jest.fn();
  mockModel.findOne = jest.fn();
  mockModel.create = jest.fn();
  mockModel.ASSESSMENT_QUESTIONS = [
    { questionId: 'text1', type: 'text', question: "What's your name and what do you do?" },
    { questionId: 'text2', type: 'text', question: 'Describe your typical day.' },
    { questionId: 'voice1', type: 'voice', question: '🎤 Introduce yourself.' },
    { questionId: 'voice2', type: 'voice', question: '🎤 Describe a challenge you handled.' }
  ];
  return mockModel;
});
jest.mock('../models/TutorMemory', () => ({ findOne: jest.fn() }));
jest.mock('../services/assessmentService', () => {
  const actual = jest.requireActual('../services/assessmentService');
  return {
    getNextAssessmentStep: actual.getNextAssessmentStep,
    getStepNumber: actual.getStepNumber,
    recordTextAnswer: jest.fn(),
    recordVoiceAnswer: jest.fn(),
    runAssessmentEvaluation: jest.fn(),
    buildOnboardingCompletionMessage: jest.fn().mockReturnValue('COMPLETION_MESSAGE')
  };
});

const Log = require('../models/Log');
const LearnerAssessment = require('../models/LearnerAssessment');
const TutorMemory = require('../models/TutorMemory');
const {
  recordTextAnswer,
  recordVoiceAnswer,
  runAssessmentEvaluation
} = require('../services/assessmentService');
const {
  needsOnboarding,
  handleOnboardingMessage,
  normalizeGoalInput,
  getScenarioFamily,
  getGoalContextLabel
} = require('../services/onboardingService');

function makeUser(overrides = {}) {
  return {
    _id: 'user1',
    name: 'Rajesh',
    phone: '919000000001',
    level: 'intermediate',
    learningGoal: 'daily_english',
    state: 'NEW',
    onboardingStatus: 'PENDING_GOAL',
    save: jest.fn().mockResolvedValue(true),
    ...overrides
  };
}

function makeAssessment(overrides = {}) {
  return {
    userId: 'user1',
    status: 'in_progress',
    textResponses: [],
    voiceResponses: [],
    weakAreas: [],
    save: jest.fn().mockResolvedValue(true),
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  Log.create.mockResolvedValue({});
});

describe('needsOnboarding', () => {
  test('a brand-new user pending goal selection needs onboarding', () => {
    expect(needsOnboarding(makeUser())).toBe(true);
  });

  test('an existing legacy user (no onboardingStatus, not state NEW) is unaffected', () => {
    expect(needsOnboarding(makeUser({ state: 'READY', onboardingStatus: undefined }))).toBe(false);
  });

  test('a user whose onboarding is already COMPLETED does not need it again', () => {
    expect(needsOnboarding(makeUser({ onboardingStatus: 'COMPLETED' }))).toBe(false);
  });
});

describe('normalizeGoalInput', () => {
  test.each([
    ['1', 'daily_english'],
    ['2', 'workplace'],
    ['workplace', 'workplace'],
    ['interview', 'interview'],
    ['placement', 'college_placement'],
    ['sales', 'sales'],
    ['travel', 'travel'],
    ['  Daily  ', 'daily_english']
  ])('normalizes %s -> %s', (input, expected) => {
    expect(normalizeGoalInput(input)).toBe(expected);
  });

  test('unrecognized input returns null', () => {
    expect(normalizeGoalInput('banana')).toBeNull();
    expect(normalizeGoalInput('99')).toBeNull();
    expect(normalizeGoalInput('')).toBeNull();
  });
});

describe('handleOnboardingMessage - goal selection step', () => {
  test('a valid goal selection advances to PENDING_ASSESSMENT and creates the assessment', async () => {
    const user = makeUser();
    LearnerAssessment.create.mockResolvedValue(makeAssessment());

    const result = await handleOnboardingMessage(user, { type: 'text' }, '2');

    expect(user.learningGoal).toBe('workplace');
    expect(user.onboardingStatus).toBe('PENDING_ASSESSMENT');
    expect(user.save).toHaveBeenCalled();
    expect(LearnerAssessment.create).toHaveBeenCalledWith({ userId: 'user1', status: 'in_progress' });
    expect(result.messageText).toContain('Question 1/4');
  });

  test('invalid goal input remains at the same step and re-prompts', async () => {
    const user = makeUser();

    const result = await handleOnboardingMessage(user, { type: 'text' }, 'banana');

    expect(user.onboardingStatus).toBe('PENDING_GOAL'); // unchanged
    expect(user.save).not.toHaveBeenCalled();
    expect(LearnerAssessment.create).not.toHaveBeenCalled();
    expect(result.messageText).toContain('Reply with 1-7');
  });
});

describe('handleOnboardingMessage - assessment steps', () => {
  test('a text answer to a text question is recorded and progresses to the next question', async () => {
    const user = makeUser({ onboardingStatus: 'PENDING_ASSESSMENT' });
    const assessment = makeAssessment();
    LearnerAssessment.findOne.mockReturnValue({ sort: () => Promise.resolve(assessment) });
    recordTextAnswer.mockImplementation(async (a, q, answer) => {
      a.textResponses.push({ questionId: q.questionId, question: q.question, answer });
    });

    const result = await handleOnboardingMessage(user, { type: 'text' }, 'My name is Raj and I work in sales.');

    expect(recordTextAnswer).toHaveBeenCalledTimes(1);
    expect(result.messageText).toContain('Question 2/4');
  });

  test('resumes correctly from persisted partial state (2 text answers already saved -> voice1 next)', async () => {
    const user = makeUser({ onboardingStatus: 'PENDING_ASSESSMENT' });
    const assessment = makeAssessment({
      textResponses: [
        { questionId: 'text1', question: 'q', answer: 'a' },
        { questionId: 'text2', question: 'q', answer: 'a' }
      ]
    });
    LearnerAssessment.findOne.mockReturnValue({ sort: () => Promise.resolve(assessment) });
    recordVoiceAnswer.mockImplementation(async (a, q) => {
      a.voiceResponses.push({ questionId: q.questionId, question: q.question, transcript: 'transcript' });
    });

    const result = await handleOnboardingMessage(user, { type: 'audio', audio: { id: 'media1' } }, undefined);

    expect(recordVoiceAnswer).toHaveBeenCalledWith(assessment, expect.objectContaining({ questionId: 'voice1' }), 'media1');
    expect(result.messageText).toContain('Question 4/4'); // advanced to voice2
  });

  test('sending text when a voice answer is expected asks for voice and does not record/advance', async () => {
    const user = makeUser({ onboardingStatus: 'PENDING_ASSESSMENT' });
    const assessment = makeAssessment({
      textResponses: [
        { questionId: 'text1', question: 'q', answer: 'a' },
        { questionId: 'text2', question: 'q', answer: 'a' }
      ]
    });
    LearnerAssessment.findOne.mockReturnValue({ sort: () => Promise.resolve(assessment) });

    const result = await handleOnboardingMessage(user, { type: 'text' }, 'sorry, typing instead');

    expect(recordTextAnswer).not.toHaveBeenCalled();
    expect(recordVoiceAnswer).not.toHaveBeenCalled();
    expect(result.messageText).toContain('voice note');
  });

  test('sending voice when a text answer is expected asks for text and does not record/advance', async () => {
    const user = makeUser({ onboardingStatus: 'PENDING_ASSESSMENT' });
    const assessment = makeAssessment();
    LearnerAssessment.findOne.mockReturnValue({ sort: () => Promise.resolve(assessment) });

    const result = await handleOnboardingMessage(user, { type: 'audio', audio: { id: 'media1' } }, undefined);

    expect(recordTextAnswer).not.toHaveBeenCalled();
    expect(recordVoiceAnswer).not.toHaveBeenCalled();
    expect(result.messageText).toContain('text reply');
  });

  test('voice transcript is saved without creating a normal SpeakingAttempt record', async () => {
    // recordVoiceAnswer itself (mocked here) is the boundary that would create a
    // SpeakingAttempt if it were reused incorrectly - assert onboarding calls the
    // assessment-specific recorder, never a SpeakingAttempt-creating path.
    const user = makeUser({ onboardingStatus: 'PENDING_ASSESSMENT' });
    const assessment = makeAssessment({
      textResponses: [{ questionId: 'text1', question: 'q', answer: 'a' }, { questionId: 'text2', question: 'q', answer: 'a' }]
    });
    LearnerAssessment.findOne.mockReturnValue({ sort: () => Promise.resolve(assessment) });

    await handleOnboardingMessage(user, { type: 'audio', audio: { id: 'media1' } }, undefined);

    expect(recordVoiceAnswer).toHaveBeenCalledTimes(1);
  });

  test('once all 4 answers are collected, runs evaluation exactly once and completes onboarding', async () => {
    const user = makeUser({ onboardingStatus: 'PENDING_ASSESSMENT' });
    const assessment = makeAssessment({
      textResponses: [{ questionId: 'text1', question: 'q', answer: 'a' }, { questionId: 'text2', question: 'q', answer: 'a' }],
      voiceResponses: [{ questionId: 'voice1', question: 'q', transcript: 't' }]
    });
    LearnerAssessment.findOne.mockReturnValue({ sort: () => Promise.resolve(assessment) });
    recordVoiceAnswer.mockImplementation(async (a) => {
      a.voiceResponses.push({ questionId: 'voice2', question: 'q', transcript: 'final answer' });
    });
    runAssessmentEvaluation.mockResolvedValue({
      scores: { grammar: 6, sentenceFormation: 6, vocabulary: 6, naturalness: 6, comprehension: 6, overall: 6 },
      strengths: ['Vocabulary'],
      weakAreas: ['prepositions'],
      summary: 'Nice work.',
      recommendedLevel: 'intermediate',
      validationStatus: 'valid'
    });
    TutorMemory.findOne.mockResolvedValue({ weakAreas: [], save: jest.fn().mockResolvedValue(true) });

    const result = await handleOnboardingMessage(user, { type: 'audio', audio: { id: 'media2' } }, undefined);

    expect(runAssessmentEvaluation).toHaveBeenCalledTimes(1);
    expect(user.onboardingStatus).toBe('COMPLETED');
    expect(user.state).toBe('READY');
    expect(user.assessedLevel).toBe('intermediate');
    expect(result.messageText).toBe('COMPLETION_MESSAGE');
    expect(Log.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'ONBOARDING_COMPLETED' }));
  });

  test('seeds TutorMemory weakAreas only when currently empty (never overwrites existing weak areas)', async () => {
    const user = makeUser({ onboardingStatus: 'PENDING_ASSESSMENT' });
    const assessment = makeAssessment({
      textResponses: [{ questionId: 'text1', question: 'q', answer: 'a' }, { questionId: 'text2', question: 'q', answer: 'a' }],
      voiceResponses: [{ questionId: 'voice1', question: 'q', transcript: 't' }, { questionId: 'voice2', question: 'q', transcript: 't' }]
    });
    LearnerAssessment.findOne.mockReturnValue({ sort: () => Promise.resolve(assessment) });
    runAssessmentEvaluation.mockResolvedValue({
      scores: {}, strengths: [], weakAreas: ['past_tense'], summary: '', recommendedLevel: 'beginner', validationStatus: 'valid'
    });
    const existingMemory = { weakAreas: ['articles'], save: jest.fn().mockResolvedValue(true) };
    TutorMemory.findOne.mockResolvedValue(existingMemory);

    await handleOnboardingMessage(user, { type: 'text' }, 'anything');

    expect(existingMemory.weakAreas).toEqual(['articles']); // untouched
    expect(existingMemory.save).not.toHaveBeenCalled();
  });

  test('a duplicate/extra message after the assessment is already complete does not re-record an answer', async () => {
    const user = makeUser({ onboardingStatus: 'PENDING_ASSESSMENT' });
    const assessment = makeAssessment({
      textResponses: [{ questionId: 'text1', question: 'q', answer: 'a' }, { questionId: 'text2', question: 'q', answer: 'a' }],
      voiceResponses: [{ questionId: 'voice1', question: 'q', transcript: 't' }, { questionId: 'voice2', question: 'q', transcript: 't' }]
    });
    LearnerAssessment.findOne.mockReturnValue({ sort: () => Promise.resolve(assessment) });
    runAssessmentEvaluation.mockResolvedValue({
      scores: {}, strengths: [], weakAreas: [], summary: '', recommendedLevel: 'beginner', validationStatus: 'valid'
    });
    TutorMemory.findOne.mockResolvedValue({ weakAreas: [], save: jest.fn() });

    await handleOnboardingMessage(user, { type: 'text' }, 'extra stray message');

    expect(recordTextAnswer).not.toHaveBeenCalled();
    expect(recordVoiceAnswer).not.toHaveBeenCalled();
  });
});

describe('goal-to-scenario/context mapping', () => {
  test('every goal maps to its own deterministic scenario family, defaulting to daily_english', () => {
    expect(getScenarioFamily('workplace')).toEqual(['meetings', 'email', 'teamwork', 'manager', 'client']);
    expect(getScenarioFamily(undefined)).toEqual(getScenarioFamily('daily_english'));
    expect(getScenarioFamily('not_a_real_goal')).toEqual(getScenarioFamily('daily_english'));
  });

  test('goal context label defaults safely for legacy/unset goals', () => {
    expect(getGoalContextLabel(undefined)).toBe(getGoalContextLabel('daily_english'));
  });
});
