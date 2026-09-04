jest.mock('../config/openai', () => ({
  chat: { completions: { create: jest.fn() } }
}));
jest.mock('../models/Log', () => ({ create: jest.fn().mockResolvedValue({}) }));

const openai = require('../config/openai');
const Log = require('../models/Log');
const {
  generateLesson,
  generateFallbackLesson,
  validateLessonJson,
  computeVocabOverlapRatio,
  getScenarioType
} = require('../services/lessonGeneratorV2');

const REQUIRED_PREFIX = '🔊 Speak this conversation aloud slowly and clearly.';

function words(n, filler = 'word') {
  return new Array(n).fill(filler).join(' ');
}

function validLessonJson(overrides = {}) {
  return {
    title: 'Ordering Coffee',
    scenarioType: 'dining',
    conversation: `${REQUIRED_PREFIX}\n\n${words(60)}`,
    explanation: words(30),
    guidedSpeakingPrompts: ['Prompt one', 'Prompt two', 'Prompt three'],
    newVocabulary: [
      { word: 'brew', meaning: 'to make coffee/tea', example: 'They brew fresh coffee every morning.' },
      { word: 'refill', meaning: 'to fill again', example: 'Can I get a refill?' },
      { word: 'aroma', meaning: 'a pleasant smell', example: 'The aroma of coffee filled the room.' }
    ],
    microPractice: { q1: 'Ask for a refill.', q2: 'Describe the aroma.' },
    confidenceLine: 'You are doing great!',
    ...overrides
  };
}

function openaiResponse(jsonObj) {
  return { choices: [{ message: { content: JSON.stringify(jsonObj) } }] };
}

const user = { name: 'Rajesh', level: 'intermediate', currentDay: 12, phone: '919000000001' };
const topic = { title: 'Coffee Shop Conversation', grammarFocus: 'Present Simple Requests', difficultyTag: 'medium' };

function tutorMemory(overrides = {}) {
  return {
    recentTopicDays: [10, 11],
    recentGrammarKeys: ['Past Simple'],
    vocabBank: [{ word: 'order' }, { word: 'menu' }],
    recentScenarioTypes: ['workplace', 'social'],
    weakAreas: ['pronunciation'],
    ...overrides
  };
}

describe('validateLessonJson', () => {
  test('a well-formed lesson passes validation', () => {
    const result = validateLessonJson(validLessonJson());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.vocabWords).toEqual(['brew', 'refill', 'aroma']);
  });

  test('a missing required field fails validation', () => {
    const broken = validLessonJson();
    delete broken.explanation;
    const result = validateLessonJson(broken);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('explanation')]));
  });

  test('wrong vocabulary/speaking-prompt counts are flagged', () => {
    const wrongCounts = validLessonJson({
      guidedSpeakingPrompts: ['only one'],
      newVocabulary: [{ word: 'a', meaning: 'm', example: 'e' }]
    });
    const result = validateLessonJson(wrongCounts);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('guidedSpeakingPrompts'))).toBe(true);
    expect(result.errors.some(e => e.includes('newVocabulary'))).toBe(true);
  });
});

describe('computeVocabOverlapRatio', () => {
  test('returns 0 with no overlap', () => {
    expect(computeVocabOverlapRatio(['brew', 'refill'], ['order', 'menu'])).toBe(0);
  });

  test('returns the correct ratio when words repeat recent vocab', () => {
    expect(computeVocabOverlapRatio(['order', 'menu', 'brew'], ['order', 'menu'])).toBeCloseTo(2 / 3);
  });
});

describe('generateLesson', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a valid first response is accepted with a single OpenAI call', async () => {
    openai.chat.completions.create.mockResolvedValueOnce(openaiResponse(validLessonJson()));

    const result = await generateLesson(user, topic, tutorMemory());

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(result.validationStatus).toBe('valid');
    expect(result.lessonJson.title).toBe('Ordering Coffee');
    expect(result.generationVersion).toBe('v3');
    // Existing lesson-flow shape preserved for callers (webhookController/lessonWorker)
    expect(result).toEqual(expect.objectContaining({
      lessonJson: expect.any(Object),
      lessonText: expect.any(String),
      vocabList: expect.any(Array),
      scenarioType: expect.any(String)
    }));
  });

  test('excessive recent-vocab overlap triggers exactly one corrective retry and is accepted after', async () => {
    const overlapping = validLessonJson({
      newVocabulary: [
        { word: 'order', meaning: 'to request', example: 'I order coffee.' },
        { word: 'menu', meaning: 'list of items', example: 'Check the menu.' },
        { word: 'brew', meaning: 'to make coffee', example: 'They brew coffee.' }
      ]
    });
    openai.chat.completions.create
      .mockResolvedValueOnce(openaiResponse(overlapping))
      .mockResolvedValueOnce(openaiResponse(validLessonJson()));

    const result = await generateLesson(user, topic, tutorMemory({ vocabBank: [{ word: 'order' }, { word: 'menu' }] }));

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(result.validationStatus).toBe('retried');
    expect(result.lessonJson.title).toBe('Ordering Coffee');
  });

  test('only one AI retry is ever allowed - persistently invalid output falls back after exactly 2 calls', async () => {
    const invalid = { title: '' }; // missing everything else
    openai.chat.completions.create
      .mockResolvedValueOnce(openaiResponse(invalid))
      .mockResolvedValueOnce(openaiResponse(invalid));

    const result = await generateLesson(user, topic, tutorMemory());

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(result.validationStatus).toBe('fallback');
    expect(Log.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'LESSON_GENERATION_FALLBACK' }));
  });

  test('vocab overlap that persists after the one retry is still accepted (structurally valid), never sent to fallback', async () => {
    const overlapping = validLessonJson({
      newVocabulary: [
        { word: 'order', meaning: 'to request', example: 'I order coffee.' },
        { word: 'menu', meaning: 'list of items', example: 'Check the menu.' },
        { word: 'brew', meaning: 'to make coffee', example: 'They brew coffee.' }
      ]
    });
    openai.chat.completions.create
      .mockResolvedValueOnce(openaiResponse(overlapping))
      .mockResolvedValueOnce(openaiResponse(overlapping)); // still overlapping on retry

    const result = await generateLesson(user, topic, tutorMemory({ vocabBank: [{ word: 'order' }, { word: 'menu' }] }));

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(result.validationStatus).not.toBe('fallback'); // repetition alone never burns the fallback path
    expect(result.lessonJson.newVocabulary[0].word).toBe('order');
  });

  test('generator uses the current CurriculumTopic and recent scenario/grammar/vocab context in the prompt', async () => {
    openai.chat.completions.create.mockResolvedValueOnce(openaiResponse(validLessonJson()));

    await generateLesson(user, topic, tutorMemory());

    const [{ messages }] = openai.chat.completions.create.mock.calls[0];
    const userMessage = messages.find(m => m.role === 'user').content;

    expect(userMessage).toContain(topic.title);
    expect(userMessage).toContain(topic.grammarFocus);
    expect(userMessage).toContain('workplace, social'); // recentScenarioTypes context
  });

  test('OpenAI API failure on first call falls back immediately without a retry', async () => {
    openai.chat.completions.create.mockRejectedValueOnce(new Error('network error'));

    const result = await generateLesson(user, topic, tutorMemory());

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(result.validationStatus).toBe('fallback');
  });
});

describe('generateFallbackLesson', () => {
  test('fallback content is level-aware and references the current topic', () => {
    const beginner = generateFallbackLesson({ name: 'A', level: 'beginner', currentDay: 3 }, topic);
    const advanced = generateFallbackLesson({ name: 'B', level: 'advanced', currentDay: 3 }, topic);

    expect(beginner.lessonJson.newVocabulary).not.toEqual(advanced.lessonJson.newVocabulary);
    expect(beginner.lessonJson.title).toBe(topic.title);
    expect(beginner.lessonJson.explanation).toContain(topic.grammarFocus);
    expect(beginner.validationStatus).toBe('fallback');
    expect(beginner.generationVersion).toBe('v3');
  });
});

describe('getScenarioType', () => {
  test('is deterministic and varies across consecutive days', () => {
    const day10 = getScenarioType(10);
    const day11 = getScenarioType(11);
    expect(day10).not.toBe(day11);
    expect(getScenarioType(10)).toBe(day10); // deterministic given same input
  });
});
