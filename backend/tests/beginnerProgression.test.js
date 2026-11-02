jest.mock('../config/openai', () => ({
  chat: { completions: { create: jest.fn() } }
}));
jest.mock('../models/Log', () => ({ create: jest.fn().mockResolvedValue({}) }));

const os = require('os');
const fs = require('fs');
const path = require('path');
const openai = require('../config/openai');
const Log = require('../models/Log');
const {
  generateLesson,
  generateFallbackLesson,
  validateLessonJson,
  formatLessonForWhatsApp,
  getLessonRules,
  getScenarioType
} = require('../services/lessonGeneratorV2');
const {
  BEGINNER_FOUNDATION_TOPICS,
  getBeginnerStage,
  findBeginnerDifficultyIssues
} = require('../services/beginnerProgression');
const samples = require('./fixtures/beginnerSampleLessons');

const PREFIX = '🔊 Speak this conversation aloud slowly and clearly.';
const HARD_WORDS = /\b(might|could|would|should|must|if|than)\b/i;

const respond = json => ({ choices: [{ message: { content: JSON.stringify(json) } }] });
const memory = () => ({ recentTopicDays: [], recentGrammarKeys: [], vocabBank: [], recentScenarioTypes: [], weakAreas: [] });
const beginner = day => ({ name: 'Asha', level: 'beginner', currentDay: day, phone: '919000000002' });
const topicFor = day => BEGINNER_FOUNDATION_TOPICS[day - 1] || { title: 'Visiting a Doctor', grammarFocus: 'Simple past', difficultyTag: 'easy' };

beforeEach(() => openai.chat.completions.create.mockReset());

describe('beginner difficulty progression', () => {
  test.each([
    [1, 'absolute_beginner'], [7, 'absolute_beginner'], [8, 'very_easy'], [15, 'very_easy'],
    [16, 'easy'], [30, 'easy'], [31, 'easy_moderate'], [90, 'easy_moderate'],
    [91, 'gradual_progression'], [180, 'gradual_progression'], [181, 'confident_beginner'],
    [365, 'confident_beginner'], [400, 'confident_beginner']
  ])('day %i -> %s', (day, key) => {
    expect(getBeginnerStage(day).key).toBe(key);
  });

  test('Days 1-30 lessons are smaller than Day 31+, which still follow the existing 3+3 format', () => {
    for (const day of [1, 7, 15, 30]) {
      const rules = getLessonRules(beginner(day));
      expect(rules.speakingPrompts).toEqual([2, 2]);
      expect(rules.vocabCount).toEqual([2, 3]);
      expect(rules.conversationWordRange[1]).toBeLessThanOrEqual(110);
    }
    for (const day of [31, 90, 180, 365]) {
      const rules = getLessonRules(beginner(day));
      expect(rules.speakingPrompts).toEqual([3, 3]);
      expect(rules.vocabCount).toEqual([3, 3]);
    }
    // difficulty never decreases
    const maxWords = [1, 15, 30, 31, 90, 91, 180, 181, 365].map(d => getBeginnerStage(d).maxSentenceWords);
    expect([...maxWords].sort((a, b) => a - b)).toEqual(maxWords);
  });

  test('foundation plan covers Days 1-30 once each, starts with introductions and uses no hard grammar', () => {
    expect(BEGINNER_FOUNDATION_TOPICS.map(t => t.day)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(new Set(BEGINNER_FOUNDATION_TOPICS.map(t => t.title)).size).toBe(30);
    expect(BEGINNER_FOUNDATION_TOPICS[0].title).toBe('Introducing Yourself');
    for (const t of BEGINNER_FOUNDATION_TOPICS) {
      expect(`${t.title} ${t.grammarFocus}`).not.toMatch(HARD_WORDS);
      expect(t.difficultyTag).toBe(getBeginnerStage(t.day).key);
    }
  });

  test('beginner scenarios follow the stage through Day 90, then the goal family', () => {
    expect(getScenarioType(1, 'daily_english', 'beginner')).toBe('introductions');
    expect(getScenarioType(1, 'workplace', 'beginner')).toBe('introductions');
    expect(getScenarioType(16, undefined, 'beginner')).toBe('shopping');
    expect(getScenarioType(91, 'workplace', 'beginner')).toBe(getScenarioType(91, 'workplace'));
  });
});

describe('sample lessons (Days 1, 15, 30 - mocked AI output)', () => {
  test.each([1, 15, 30])('Day %i sample passes beginner validation with no difficulty issues', day => {
    const json = samples[day];
    expect(validateLessonJson(json, getLessonRules(beginner(day)))).toMatchObject({ valid: true, errors: [] });
    expect(findBeginnerDifficultyIssues(json, day, PREFIX)).toEqual([]);
    const text = formatLessonForWhatsApp(json, day);
    for (const heading of [`📘 Day ${day}:`, "🎯 Today's Focus:", '🗣 Conversation:', '🧩 Pattern:', '🎤 Speaking Practice:', '🧠 Vocabulary:', '✍ Quick Practice:', '💪']) {
      expect(text).toContain(heading);
    }
  });

  test('the old level-agnostic validator would have rejected a true beginner lesson as too short', () => {
    expect(validateLessonJson(samples[1]).valid).toBe(false);
  });
});

describe('beginner generation (one AI call, at most one retry, never extra)', () => {
  test('a simple Day 1 lesson uses the beginner prompt and exactly one AI call', async () => {
    openai.chat.completions.create.mockResolvedValueOnce(respond(samples[1]));
    const result = await generateLesson(beginner(1), topicFor(1), memory());

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(result.validationStatus).toBe('valid');
    expect(result.scenarioType).toBe('introductions');
    const { messages } = openai.chat.completions.create.mock.calls[0][0];
    expect(messages[0].content).toContain('beginner adult learner');
    const userMsg = messages[1].content;
    expect(userMsg).toContain('Absolute beginner');
    expect(userMsg).toContain('exactly 2 short sentences');
    expect(userMsg).toContain('Introducing Yourself');
  });

  test('hard grammar on Day 1 uses the single existing retry and accepts the simpler rewrite', async () => {
    const hard = { ...samples[1], conversation: `${PREFIX}\n\nA: Hello! Could you tell me your name?\nB: My name is Priya.\nA: Where might you live?\nB: I live in Pune.\nA: Nice to meet you!\nB: Nice to meet you too!` };
    openai.chat.completions.create
      .mockResolvedValueOnce(respond(hard))
      .mockResolvedValueOnce(respond(samples[1]));
    const result = await generateLesson(beginner(1), topicFor(1), memory());

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(result.validationStatus).toBe('retried');
    expect(result.lessonJson.conversation).not.toMatch(HARD_WORDS);
    const retryNote = openai.chat.completions.create.mock.calls[1][0].messages.at(-1).content;
    expect(retryNote).toContain('Too hard for this beginner stage');
  });

  test('if both AI attempts are too hard, the reviewed day lesson is used - never the hard one, no third call', async () => {
    const hard = { ...samples[1], microPractice: { q1: 'If you could, say your name.', q2: 'I ___ in Pune.' } };
    openai.chat.completions.create.mockResolvedValue(respond(hard));
    const result = await generateLesson(beginner(1), topicFor(1), memory());

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(result.validationStatus).toBe('fallback');
    expect(result.lessonJson.title).toBe('Introducing Yourself');
    expect(findBeginnerDifficultyIssues(result.lessonJson, 1, PREFIX)).toEqual([]);
    expect(Log.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'LESSON_GENERATION_FALLBACK' }));
  });

  test('a retry that is simpler but still too hard is not delivered either', async () => {
    const veryHard = { ...samples[1], conversation: `${PREFIX}\n\nA: Could you tell me your name?\nB: I might tell you.\nA: Where would you live?\nB: I should say Pune.\nA: Nice to meet you!\nB: Nice to meet you too!` };
    const lessHard = { ...samples[1], microPractice: { q1: 'If you like, say your name.', q2: 'I ___ in Pune.' } };
    openai.chat.completions.create
      .mockResolvedValueOnce(respond(veryHard))
      .mockResolvedValueOnce(respond(lessHard));
    const result = await generateLesson(beginner(1), topicFor(1), memory());
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(result.validationStatus).toBe('fallback');
  });

  test('two structurally invalid AI attempts on Day 12 give the Day 12 lesson after exactly 2 calls', async () => {
    openai.chat.completions.create.mockResolvedValue({ choices: [{ message: { content: 'not json' } }] });
    const result = await generateLesson(beginner(12), topicFor(12), memory());
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(result.validationStatus).toBe('fallback');
    expect(result.lessonJson.title).toBe('My Morning');
    expect(result.lessonText).toContain('I wake up at six.');
  });

  test('a very long sentence on Day 15 triggers the same single retry', () => {
    const long = { ...samples[15], conversation: `${PREFIX}\n\nA: What do you usually do at home in the evening after you finish all your work?\nB: I cook dinner.` };
    expect(findBeginnerDifficultyIssues(long, 15, PREFIX)[0]).toMatch(/words/);
  });

  test('from Day 31 modal verbs are allowed (no retry for "could")', async () => {
    const day31 = {
      ...samples[30],
      conversation: `${PREFIX}\n\nA: Could you help me, please?\nB: Yes, of course.\nA: I need to see a doctor today.\nB: The clinic is near the school.\nA: Thank you so much.\nB: You are welcome.`,
      guidedSpeakingPrompts: ['Could you help me?', 'I need to ___.', 'The clinic is ___.']
    };
    openai.chat.completions.create.mockResolvedValueOnce(respond(day31));
    const result = await generateLesson(beginner(31), topicFor(31), memory());
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(result.validationStatus).toBe('valid');
  });

  test('beginner fallback is simple and keeps the existing structure', () => {
    const fb = generateFallbackLesson(beginner(1), topicFor(1));
    expect(fb.lessonJson.guidedSpeakingPrompts).toHaveLength(2);
    expect(fb.lessonJson.explanation).toContain('My name is ___.\nI live in ___.');
    expect(findBeginnerDifficultyIssues(fb.lessonJson, 1, PREFIX)).toEqual([]);
    expect(JSON.stringify(fb.lessonJson)).not.toMatch(/opinion/i);
  });
});

describe('beginner Days 1-30 fallback lessons', () => {
  const lessons = Array.from({ length: 30 }, (_, i) => generateFallbackLesson(beginner(i + 1), topicFor(i + 1)));

  test.each(Array.from({ length: 30 }, (_, i) => i + 1))('Day %i fallback is valid, simple, on-topic and keeps all eight sections', day => {
    const { lessonJson, lessonText } = lessons[day - 1];
    expect(lessonJson.title).toBe(BEGINNER_FOUNDATION_TOPICS[day - 1].title);
    expect(validateLessonJson(lessonJson, getLessonRules(beginner(day)))).toMatchObject({ valid: true, errors: [] });
    expect(findBeginnerDifficultyIssues(lessonJson, day, PREFIX)).toEqual([]);
    expect(JSON.stringify(lessonJson)).not.toMatch(HARD_WORDS);
    for (const heading of [`📘 Day ${day}:`, "🎯 Today's Focus:", '🗣 Conversation:', '🧩 Pattern:', '🎤 Speaking Practice:', '🧠 Vocabulary:', '✍ Quick Practice:', '💪']) {
      expect(lessonText).toContain(heading);
    }
  });

  test('every day has its own conversation, vocabulary and practice', () => {
    for (const key of ['conversation', 'newVocabulary', 'microPractice']) {
      expect(new Set(lessons.map(l => JSON.stringify(l.lessonJson[key]))).size).toBe(30);
    }
  });

  test('Day 31+ beginners keep the generic simple fallback; other levels are untouched', () => {
    const day31 = generateFallbackLesson(beginner(31), topicFor(31));
    expect(day31.lessonJson.title).toBe('Visiting a Doctor');
    expect(day31.lessonJson.explanation).toContain('Simple past');
    const adv = generateFallbackLesson({ name: 'B', level: 'advanced', currentDay: 1 }, topicFor(1));
    expect(adv.lessonJson.guidedSpeakingPrompts).toHaveLength(3);
    expect(adv.lessonJson.conversation).toContain('Person A:');
  });
});

describe('intermediate and advanced are unchanged', () => {
  test.each(['intermediate', 'advanced'])('%s keeps the original system prompt, rules and goal scenarios', async level => {
    const user = { name: 'Ravi', level, currentDay: 1, phone: '919000000003', learningGoal: 'workplace' };
    expect(getLessonRules(user)).toEqual({
      conversationWordRange: [50, 220], explanationWordRange: [25, 160], speakingPrompts: [3, 3], vocabCount: [3, 3]
    });
    expect(getScenarioType(1, 'workplace', level)).toBe('email');

    openai.chat.completions.create.mockResolvedValueOnce(respond({ title: 'x' }));
    openai.chat.completions.create.mockResolvedValueOnce(respond({ title: 'x' }));
    await generateLesson(user, { title: 'Meetings', grammarFocus: 'Present perfect', difficultyTag: 'medium' }, memory());
    const { messages } = openai.chat.completions.create.mock.calls[0][0];
    expect(messages[0].content).toContain('~80-120 words');
    expect(messages[0].content).not.toContain('beginner');
    expect(messages[1].content).toContain(`LEVEL - ${level[0].toUpperCase()}${level.slice(1)}`);
    expect(messages[1].content).toContain('Avoid recent grammar patterns');
  });

  test('advanced lessons may use modal verbs without any retry', async () => {
    const json = {
      title: 'Negotiating', scenarioType: 'negotiation',
      conversation: `${PREFIX}\n\n${new Array(70).fill('could').join(' ')}`,
      explanation: new Array(30).fill('might').join(' '),
      guidedSpeakingPrompts: ['a', 'b', 'c'],
      newVocabulary: [1, 2, 3].map(i => ({ word: `w${i}`, meaning: 'm', example: 'e' })),
      microPractice: { q1: 'q', q2: 'q' }, confidenceLine: 'ok'
    };
    openai.chat.completions.create.mockResolvedValueOnce(respond(json));
    const result = await generateLesson({ name: 'B', level: 'advanced', currentDay: 2, phone: '1' }, { title: 'T', grammarFocus: 'G' }, memory());
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(result.validationStatus).toBe('valid');
  });
});

describe('migrateBeginnerCurriculum (mocked model, no database)', () => {
  const CurriculumTopic = require('../models/CurriculumTopic');
  const { migrateBeginnerCurriculum, restoreBeginnerCurriculum } = require('../scripts/migrateBeginnerCurriculum');
  let db;

  beforeEach(() => {
    db = [];
    for (let day = 1; day <= 365; day++) {
      db.push({ _id: `id${day}`, level: 'beginner', isActive: true, day, theme: 'Old', title: `Old topic ${day}`, grammarFocus: 'Present simple', difficultyTag: 'easy' });
    }
    db[0] = { ...db[0], title: 'Comparing Shopping Options', grammarFocus: 'Comparatives with might / could' };
    db[1] = { ...db[1], ...BEGINNER_FOUNDATION_TOPICS[1] }; // day 2 already correct
    db[39] = { ...db[39], grammarFocus: 'Second conditional (If I won...)' }; // day 40 flagged
    jest.spyOn(CurriculumTopic, 'find').mockImplementation(() => ({
      select: () => ({ sort: () => ({ lean: async () => db.map(d => ({ ...d })) }) })
    }));
    jest.spyOn(CurriculumTopic, 'updateOne').mockImplementation(async (filter, update) => {
      const doc = db.find(d => d._id === filter._id && Object.entries(filter).every(([k, v]) => d[k] === v));
      if (!doc) return { modifiedCount: 0 };
      Object.assign(doc, update.$set);
      return { modifiedCount: 1 };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  test('dry run changes nothing and reports Days 1-30 updates and hard later topics', async () => {
    const report = await migrateBeginnerCurriculum({ log: () => {} });
    expect(CurriculumTopic.updateOne).not.toHaveBeenCalled();
    expect(CurriculumTopic.find).toHaveBeenCalledWith({ level: 'beginner', isActive: true });
    expect(report).toMatchObject({ toUpdate: 29, unchanged: 1, executed: false, modified: 0 });
    expect(report.flagged).toContain(40);
  });

  test('the CLI runs a dry run unless --execute is passed', () => {
    const src = fs.readFileSync(path.join(__dirname, '../scripts/migrateBeginnerCurriculum.js'), 'utf8');
    expect(src).toContain("const execute = process.argv.includes('--execute');");
  });

  test('a backup is written before any update', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculum-'));
    let backupExistedAtFirstUpdate = null;
    CurriculumTopic.updateOne.mockImplementationOnce(async () => {
      backupExistedAtFirstUpdate = fs.readdirSync(dir).some(f => f.startsWith('beginner-curriculum-backup-'));
      return { modifiedCount: 1 };
    });
    await migrateBeginnerCurriculum({ execute: true, log: () => {}, backupDir: dir });
    expect(backupExistedAtFirstUpdate).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('execute updates only Days 1-30 content fields, writes a backup, and is idempotent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculum-'));
    const first = await migrateBeginnerCurriculum({ execute: true, log: () => {}, backupDir: dir });
    expect(first.modified).toBe(29);
    expect(db[0]).toMatchObject({ _id: 'id1', day: 1, isActive: true, title: 'Introducing Yourself' });
    expect(db[30].title).toBe('Old topic 31'); // day 31+ untouched
    expect(JSON.parse(fs.readFileSync(first.backupFile, 'utf8'))[0].before.title).toBe('Comparing Shopping Options');

    for (const [filter] of CurriculumTopic.updateOne.mock.calls) expect(filter.level).toBe('beginner');

    const second = await migrateBeginnerCurriculum({ execute: true, log: () => {}, backupDir: dir });
    expect(second).toMatchObject({ toUpdate: 0, unchanged: 30, modified: 0 });

    const { restored } = await restoreBeginnerCurriculum(first.backupFile, { log: () => {} });
    expect(restored).toBe(29);
    expect(db[0]).toMatchObject({ title: 'Comparing Shopping Options', grammarFocus: 'Comparatives with might / could' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
