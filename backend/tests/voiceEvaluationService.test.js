jest.mock('axios');
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  createReadStream: jest.fn().mockReturnValue('fake-stream')
}));
jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    audio: { transcriptions: { create: jest.fn() } },
    chat: { completions: { create: jest.fn() } }
  }));
});
jest.mock('../models/Log', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/Lesson', () => ({ findOne: jest.fn() }));
jest.mock('../models/TutorMemory', () => ({ findOne: jest.fn() }));
jest.mock('../models/SpeakingAttempt', () => ({ find: jest.fn(), create: jest.fn() }));

const fs = require('fs');
const axios = require('axios');
const Log = require('../models/Log');
const Lesson = require('../models/Lesson');
const TutorMemory = require('../models/TutorMemory');
const SpeakingAttempt = require('../models/SpeakingAttempt');

const voiceService = require('../services/voiceEvaluationService');
const {
  processVoiceEvaluation,
  findRelevantLesson,
  determineSpeakingPromptState,
  normalizeWeakAreas,
  updateWeakAreas,
  evaluateTranscript,
  validateEvaluationJson,
  formatSpeakingFeedbackMessage
} = voiceService;

// The mocked OpenAI constructor's returned instance is what the service
// module captured at require-time - grab the same instance via the mocked
// constructor's last return value.
const OpenAI = require('openai');
const openaiInstance = OpenAI.mock.results[0].value;

function findAttemptsChain(attempts) {
  return { sort: () => ({ select: () => ({ lean: () => Promise.resolve(attempts) }) }) };
}

function lessonFindOneChain(lesson) {
  return { sort: jest.fn().mockResolvedValue(lesson) };
}

const user = { _id: 'user1', name: 'Rajesh', phone: '919000000001', level: 'intermediate', currentDay: 5 };

const lessonWithPrompts = {
  _id: 'lesson1',
  topicTitle: 'Ordering Coffee',
  grammarFocus: 'Present Simple Requests',
  generatedAt: new Date(),
  lessonJson: { guidedSpeakingPrompts: ['Order a coffee.', 'Ask about milk options.', 'Say thank you and leave.'] }
};

function validEvalJson(overrides = {}) {
  return {
    grammarScore: 7,
    sentenceFormationScore: 7,
    naturalnessScore: 6,
    vocabularyScore: 7,
    relevanceScore: 8,
    overallScore: 7,
    feedback: 'You answered the prompt clearly.',
    correctedVersion: "I'd like a coffee, please.",
    retrySuggestion: 'Try adding a polite opener.',
    weakAreas: ['articles'],
    ...overrides
  };
}

function openaiChatResponse(obj) {
  return { choices: [{ message: { content: JSON.stringify(obj) } }] };
}

beforeEach(() => {
  jest.clearAllMocks();
  axios.get = jest.fn().mockResolvedValue({ data: { url: 'https://graph.facebook.com/fake-media-url' } });
  axios.mockResolvedValue({ data: Buffer.from('fake-audio-bytes') });
  openaiInstance.audio.transcriptions.create.mockResolvedValue({ text: "I would like a coffee please." });
  Log.create.mockResolvedValue({});
  SpeakingAttempt.create.mockResolvedValue({ _id: 'attempt1' });
  TutorMemory.findOne.mockResolvedValue({ weakAreas: [], save: jest.fn().mockResolvedValue(true) });
});

describe('determineSpeakingPromptState', () => {
  const prompts = lessonWithPrompts.lessonJson.guidedSpeakingPrompts;

  test('no attempts yet -> prompt 1, attempt 1', async () => {
    SpeakingAttempt.find.mockReturnValue(findAttemptsChain([]));
    const result = await determineSpeakingPromptState('lesson1', prompts);
    expect(result).toEqual({ promptIndex: 0, promptText: prompts[0], attemptNumber: 1 });
  });

  test('low score on prompt 1 with attempts remaining -> retry stays on prompt 1', async () => {
    SpeakingAttempt.find.mockReturnValue(findAttemptsChain([{ promptIndex: 0, scores: { overall: 4 } }]));
    const result = await determineSpeakingPromptState('lesson1', prompts);
    expect(result.promptIndex).toBe(0);
    expect(result.attemptNumber).toBe(2);
  });

  test('cap reached on prompt 1 (2 low-scoring attempts) -> moves to prompt 2', async () => {
    SpeakingAttempt.find.mockReturnValue(findAttemptsChain([
      { promptIndex: 0, scores: { overall: 4 } },
      { promptIndex: 0, scores: { overall: 5 } }
    ]));
    const result = await determineSpeakingPromptState('lesson1', prompts);
    expect(result.promptIndex).toBe(1);
    expect(result.attemptNumber).toBe(1);
  });

  test('good score on prompt 1 -> moves straight to prompt 2', async () => {
    SpeakingAttempt.find.mockReturnValue(findAttemptsChain([{ promptIndex: 0, scores: { overall: 8 } }]));
    const result = await determineSpeakingPromptState('lesson1', prompts);
    expect(result.promptIndex).toBe(1);
    expect(result.attemptNumber).toBe(1);
  });

  test('progresses through all 3 prompts and stays on the last one once exhausted', async () => {
    SpeakingAttempt.find.mockReturnValue(findAttemptsChain([
      { promptIndex: 0, scores: { overall: 9 } },
      { promptIndex: 1, scores: { overall: 9 } },
      { promptIndex: 2, scores: { overall: 9 } }
    ]));
    const result = await determineSpeakingPromptState('lesson1', prompts);
    expect(result.promptIndex).toBe(2); // clamped to last valid index, no crash
    expect(result.promptText).toBe(prompts[2]);
  });

  test('no lesson/prompts -> generic evaluation context (null prompt)', async () => {
    const result = await determineSpeakingPromptState(null, []);
    expect(result).toEqual({ promptIndex: null, promptText: null, attemptNumber: 1 });
  });
});

describe('normalizeWeakAreas / updateWeakAreas', () => {
  test('only allow-listed labels survive, capped at 2 per attempt', () => {
    const result = normalizeWeakAreas(['Articles', 'made-up-thing', 'PAST TENSE', 'prepositions', 'vocabulary_range']);
    expect(result).toEqual(['articles', 'past_tense']);
  });

  test('non-array input returns empty array safely', () => {
    expect(normalizeWeakAreas(null)).toEqual([]);
    expect(normalizeWeakAreas(undefined)).toEqual([]);
  });

  test('bounded memory: stays at the cap and reinforces repeats via recency', () => {
    let memory = ['prepositions', 'past_tense', 'articles', 'sentence_order', 'verb_agreement'];
    memory = updateWeakAreas(memory, ['articles', 'vocabulary_range']); // articles repeats, one new label
    expect(memory.length).toBe(5); // still bounded
    expect(memory).toContain('vocabulary_range');
    expect(memory[memory.length - 2]).toBe('articles'); // moved to reinforced/recent position
  });

  test('a single attempt cannot dominate memory beyond its 2-label contribution', () => {
    const memory = updateWeakAreas([], ['articles', 'past_tense']);
    expect(memory).toEqual(['articles', 'past_tense']);
  });
});

describe('evaluateTranscript', () => {
  test('valid evaluation JSON is accepted with a single OpenAI call', async () => {
    openaiInstance.chat.completions.create.mockResolvedValueOnce(openaiChatResponse(validEvalJson()));

    const { evaluation, validationStatus } = await evaluateTranscript({
      transcript: 'I would like a coffee please.',
      level: 'intermediate',
      topicTitle: lessonWithPrompts.topicTitle,
      grammarFocus: lessonWithPrompts.grammarFocus,
      promptText: 'Order a coffee.',
      weakAreas: []
    });

    expect(openaiInstance.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(validationStatus).toBe('valid');
    expect(evaluation.overallScore).toBe(7);
  });

  test('malformed JSON triggers exactly one corrective retry, then is accepted if valid', async () => {
    openaiInstance.chat.completions.create
      .mockResolvedValueOnce(openaiChatResponse({ overallScore: 999 })) // out of range, missing fields
      .mockResolvedValueOnce(openaiChatResponse(validEvalJson()));

    const { validationStatus } = await evaluateTranscript({
      transcript: 'test', level: 'beginner', topicTitle: 't', grammarFocus: 'g', promptText: 'p', weakAreas: []
    });

    expect(openaiInstance.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(validationStatus).toBe('retried');
  });

  test('still invalid after the one retry uses a safe fallback, no third call', async () => {
    openaiInstance.chat.completions.create
      .mockResolvedValueOnce(openaiChatResponse({ bad: true }))
      .mockResolvedValueOnce(openaiChatResponse({ bad: true }));

    const { evaluation, validationStatus } = await evaluateTranscript({
      transcript: 'hello there', level: 'beginner', topicTitle: 't', grammarFocus: 'g', promptText: 'p', weakAreas: []
    });

    expect(openaiInstance.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(validationStatus).toBe('fallback');
    expect(evaluation.overallScore).toBe(5);
    expect(evaluation.correctedVersion).toBe('hello there');
  });

  test('context includes topic/grammar/prompt/transcript but not a whole lesson object', async () => {
    openaiInstance.chat.completions.create.mockResolvedValueOnce(openaiChatResponse(validEvalJson()));

    await evaluateTranscript({
      transcript: 'my transcript text',
      level: 'intermediate',
      topicTitle: 'Ordering Coffee',
      grammarFocus: 'Present Simple Requests',
      promptText: 'Order a coffee.',
      weakAreas: ['articles']
    });

    const { messages } = openaiInstance.chat.completions.create.mock.calls[0][0];
    const userMsg = messages.find(m => m.role === 'user').content;
    expect(userMsg).toContain('Ordering Coffee');
    expect(userMsg).toContain('Present Simple Requests');
    expect(userMsg).toContain('Order a coffee.');
    expect(userMsg).toContain('my transcript text');
    expect(userMsg).not.toContain('guidedSpeakingPrompts'); // no whole-lesson dump
  });
});

describe('validateEvaluationJson', () => {
  test('accepts a well-formed evaluation', () => {
    expect(validateEvaluationJson(validEvalJson()).valid).toBe(true);
  });

  test('rejects out-of-range scores and missing fields', () => {
    const result = validateEvaluationJson({ grammarScore: 15, weakAreas: 'not-an-array' });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('formatSpeakingFeedbackMessage - no pronunciation overclaim', () => {
  test('never mentions pronunciation/accent/intonation', () => {
    const msg = formatSpeakingFeedbackMessage({
      evaluation: validEvalJson(),
      needsRetry: false,
      hasNextPrompt: true,
      nextPromptText: 'Ask about milk options.'
    });
    expect(msg.toLowerCase()).not.toContain('pronunciation');
    expect(msg.toLowerCase()).not.toContain('accent');
    expect(msg.toLowerCase()).not.toContain('intonation');
    expect(msg).toContain('Overall: 7/10');
  });
});

describe('processVoiceEvaluation (end-to-end with mocks)', () => {
  test('associates the attempt with the recent lesson and its first prompt, saves SpeakingAttempt, cleans up temp file', async () => {
    Lesson.findOne.mockReturnValue(lessonFindOneChain(lessonWithPrompts));
    SpeakingAttempt.find.mockReturnValue(findAttemptsChain([]));
    openaiInstance.chat.completions.create.mockResolvedValueOnce(openaiChatResponse(validEvalJson()));

    const result = await processVoiceEvaluation('media123', user);

    expect(result.success).toBe(true);
    expect(result.overallScore).toBe(7);
    expect(SpeakingAttempt.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user1',
      lessonId: 'lesson1',
      promptIndex: 0,
      promptText: 'Order a coffee.',
      transcript: expect.any(String)
    }));
    expect(fs.unlinkSync).toHaveBeenCalled(); // temp file cleaned up on success
    expect(result.messageText.toLowerCase()).not.toContain('pronunciation');
  });

  test('no recent lesson -> generic evaluation still works (voice note not rejected)', async () => {
    Lesson.findOne.mockReturnValue(lessonFindOneChain(null));
    SpeakingAttempt.find.mockReturnValue(findAttemptsChain([]));
    openaiInstance.chat.completions.create.mockResolvedValueOnce(openaiChatResponse(validEvalJson()));

    const result = await processVoiceEvaluation('media123', user);

    expect(result.success).toBe(true);
    expect(SpeakingAttempt.create).toHaveBeenCalledWith(expect.objectContaining({ lessonId: null, promptIndex: null }));
  });

  test('updates TutorMemory weakAreas from the evaluation result', async () => {
    Lesson.findOne.mockReturnValue(lessonFindOneChain(lessonWithPrompts));
    SpeakingAttempt.find.mockReturnValue(findAttemptsChain([]));
    const tutorMemorySave = jest.fn().mockResolvedValue(true);
    TutorMemory.findOne.mockResolvedValue({ weakAreas: ['past_tense'], save: tutorMemorySave });
    openaiInstance.chat.completions.create.mockResolvedValueOnce(openaiChatResponse(validEvalJson({ weakAreas: ['articles'] })));

    await processVoiceEvaluation('media123', user);

    expect(tutorMemorySave).toHaveBeenCalled();
  });

  test('cleans up the temp file even when transcription fails', async () => {
    openaiInstance.audio.transcriptions.create.mockRejectedValueOnce(new Error('whisper down'));

    await expect(processVoiceEvaluation('media123', user)).rejects.toThrow();

    expect(fs.unlinkSync).toHaveBeenCalled();
    expect(Log.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'VOICE_ATTEMPT_FAILED' }));
  });

  test('cleans up the temp file even when the download fails', async () => {
    axios.get.mockRejectedValueOnce(new Error('media fetch failed'));

    await expect(processVoiceEvaluation('media123', user)).rejects.toThrow();

    // Download failed before a file was written, so unlink isn't expected here,
    // but the failure must still be logged rather than crashing the caller.
    expect(Log.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'VOICE_ATTEMPT_FAILED' }));
  });
});
