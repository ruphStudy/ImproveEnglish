// Beginner-only difficulty progression for lessonGeneratorV2 (no effect on
// intermediate/advanced). Everything here is deterministic - no AI calls.

// Stage rules feed both the prompt and local validation. Word ranges include
// the 8-word conversation prefix.
const BEGINNER_STAGES = [
  {
    key: 'absolute_beginner', from: 1, to: 7, label: 'Absolute beginner',
    focus: 'greetings, your name, family, basic introductions',
    scenarios: ['introductions', 'family', 'greetings'],
    maxSentenceWords: 8, turns: '4-6 short lines (3-5 turns)', speakingPrompts: 2, vocab: [2, 3],
    conversationWordRange: [15, 90], explanationWordRange: [4, 60],
    grammar: 'ONE pattern only, present simple with full forms (I am, it is, my name is). Pattern = 1-2 fill-in lines like "My name is ___." plus at most one short, plain sentence. No grammar terms.',
    avoid: 'might, could, would, should, must, if-sentences, comparisons (bigger/better/than), past or future tenses, contractions, idioms, phrasal verbs, formal or business words',
    strictWords: true
  },
  {
    key: 'very_easy', from: 8, to: 15, label: 'Very easy',
    focus: 'home, food, water, kitchen, daily activities',
    scenarios: ['home', 'food', 'daily_routine'],
    maxSentenceWords: 8, turns: '4-8 short lines (3-5 turns)', speakingPrompts: 2, vocab: [2, 3],
    conversationWordRange: [15, 100], explanationWordRange: [4, 60],
    grammar: 'ONE simple pattern (present simple, "I like / I don\'t like", "Can I have ___?", "Where is ___?"). Pattern = 1-2 fill-in lines plus at most one short, plain sentence. No grammar terms.',
    avoid: 'might, could, would, should, must, if-sentences, comparisons (bigger/better/than), perfect tenses, passive voice, idioms, phrasal verbs, formal or business words',
    strictWords: true
  },
  {
    key: 'easy', from: 16, to: 30, label: 'Easy',
    focus: 'shopping basics, prices, simple routine questions',
    scenarios: ['shopping', 'routine', 'everyday'],
    maxSentenceWords: 8, turns: '4-8 short lines (3-5 turns)', speakingPrompts: 2, vocab: [2, 3],
    conversationWordRange: [15, 110], explanationWordRange: [4, 70],
    grammar: 'ONE simple pattern (present simple questions, "How much is ___?", "Do you have ___?", "Can you ___?"; simple past only if today\'s topic asks for it). Common contractions like I\'m and it\'s are fine. Pattern = 1-2 fill-in lines plus at most one short, plain sentence.',
    avoid: 'might, could, would, should, must, if-sentences, comparisons (cheaper/better/than), perfect tenses, passive voice, idioms, formal or business words',
    strictWords: true
  },
  {
    key: 'easy_moderate', from: 31, to: 90, label: 'Easy to moderate',
    focus: 'school, neighbours, travel, appointments, daily conversations',
    scenarios: ['school', 'neighbours', 'travel', 'appointments', 'everyday'],
    maxSentenceWords: 10, turns: '6-8 short lines', speakingPrompts: 3, vocab: [3, 3],
    conversationWordRange: [25, 150], explanationWordRange: [8, 90],
    grammar: 'Simple present, present continuous, simple past, "going to" future and polite "Can/Could you ___?". One pattern per lesson with 1-2 short examples.',
    avoid: 'if-sentences, perfect tenses, passive voice, might/would/should for advice, idioms, formal or business words',
    strictWords: false
  },
  {
    key: 'gradual_progression', from: 91, to: 180, label: 'Gradual progression',
    focus: 'describing experiences, explaining needs',
    scenarios: null, // goal-based scenario families from here
    maxSentenceWords: 12, turns: '6-10 lines', speakingPrompts: 3, vocab: [3, 3],
    conversationWordRange: [30, 170], explanationWordRange: [10, 110],
    grammar: 'Build on earlier patterns. Simple "if" (first conditional) and basic present perfect only when today\'s grammar focus asks for them, with very clear examples.',
    avoid: 'complex clauses, passive voice, idioms, advanced or formal vocabulary',
    strictWords: false
  },
  {
    key: 'confident_beginner', from: 181, to: Infinity, label: 'Confident beginner',
    focus: 'everyday conversations, simple opinions, simple storytelling',
    scenarios: null,
    maxSentenceWords: 14, turns: '6-10 lines', speakingPrompts: 3, vocab: [3, 3],
    conversationWordRange: [30, 190], explanationWordRange: [10, 130],
    grammar: 'Everyday spoken English. Should/might for simple advice or possibility is fine when it fits the topic. Keep each sentence clear and short.',
    avoid: 'long complex sentences, rare idioms, academic or formal business vocabulary',
    strictWords: false
  }
];

// Reviewed Days 1-30 plan (the foundation every 30/90/365-day plan starts
// with). Applied to MongoDB only via scripts/migrateBeginnerCurriculum.js.
const BEGINNER_FOUNDATION_TOPICS = [
  [1, 'Introductions', 'Introducing Yourself', 'My name is ___. / I live in ___.'],
  [2, 'Greetings', 'Saying Hello and Goodbye', 'Hello / Good morning / See you tomorrow'],
  [3, 'Family', 'Talking About Your Family', 'This is my ___. / I have ___.'],
  [4, 'Introductions', 'Where Are You From?', 'Where are you from? / I am from ___.'],
  [5, 'Greetings', 'How Are You?', 'How are you? / I am fine.'],
  [6, 'Introductions', 'My Work or Studies', 'I am a ___. / I work at ___. / I study ___.'],
  [7, 'Polite Words', 'Please, Thank You and Sorry', 'Please ___. / Thank you. / Sorry.'],
  [8, 'Home', 'My Home', 'This is my ___. / My home has ___.'],
  [9, 'Food', 'Food I Like', 'I like ___. / I don\'t like ___.'],
  [10, 'Food', 'Asking for Water or Tea', 'Can I have ___, please?'],
  [11, 'Kitchen', 'In the Kitchen', 'Where is the ___? / It is on the ___.'],
  [12, 'Daily Activities', 'My Morning', 'I wake up at ___. / I eat ___.'],
  [13, 'Daily Activities', 'Telling the Time', 'What time is it? / It is ___.'],
  [14, 'Daily Activities', 'Days of the Week', 'Today is ___. / On Sunday, I ___.'],
  [15, 'Home', 'My Evening at Home', 'In the evening, I ___.'],
  [16, 'Shopping', 'At the Vegetable Shop', 'I want ___, please.'],
  [17, 'Shopping', 'Asking the Price', 'How much is this? / It is ___.'],
  [18, 'Shopping', 'Numbers and Money', 'It costs ___. / Here is ___.'],
  [19, 'Shopping', 'Asking for Size or Colour', 'Do you have ___? / Yes, we do.'],
  [20, 'Shopping', 'Paying at the Shop', 'Can I pay by ___?'],
  [21, 'Routine Questions', 'Asking Simple Questions', 'Do you ___? / Is it ___?'],
  [22, 'Routine Questions', 'What Do You Do Every Day?', 'What do you do ___? / I ___ every day.'],
  [23, 'Everyday Help', 'Asking for Help', 'Can you help me? / Where is ___?'],
  [24, 'Routine', 'Going to Work or School', 'I go by ___. / It takes ___.'],
  [25, 'Routine', 'My Weekend', 'On weekends, I ___.'],
  [26, 'Everyday Help', 'A Short Phone Call', 'Hello, this is ___. / Can I talk to ___?'],
  [27, 'Everyday', 'Today\'s Weather', 'It is hot today. / It is raining.'],
  [28, 'Everyday', 'Likes and Dislikes', 'Do you like ___? / Yes, I do. / No, I don\'t.'],
  [29, 'Routine', 'What I Did Yesterday', 'Yesterday, I ___. (went, ate, saw)'],
  [30, 'Review', 'Talking About Myself', 'I am ___. / I live in ___. / I like ___.']
].map(([day, theme, title, grammarFocus]) => ({
  level: 'beginner',
  day,
  theme,
  title,
  grammarFocus,
  difficultyTag: getBeginnerStage(day).key
}));

function getBeginnerStage(day) {
  const d = Number(day) > 0 ? Number(day) : 1;
  return BEGINNER_STAGES.find(s => d >= s.from && d <= s.to);
}

/** Validation targets for a beginner lesson on `day`. */
function getBeginnerLessonRules(day) {
  const s = getBeginnerStage(day);
  return {
    conversationWordRange: s.conversationWordRange,
    explanationWordRange: s.explanationWordRange,
    speakingPrompts: [s.speakingPrompts, s.speakingPrompts],
    vocabCount: s.vocab
  };
}

/** Stage block for the user prompt. */
function buildBeginnerGuidance(day) {
  const s = getBeginnerStage(day);
  const vocab = s.vocab[0] === s.vocab[1] ? `${s.vocab[0]}` : `${s.vocab[0]}-${s.vocab[1]}`;
  return [
    `LEVEL - Beginner, Day ${day} stage: ${s.label} (${s.focus}).`,
    `- Sentences: about ${s.maxSentenceWords} words or fewer, common everyday words, natural spoken English. Respectful of adult learners - never childish.`,
    `- Conversation: ${s.turns}, "A:" and "B:" speakers, meaningful and natural.`,
    `- Grammar: ${s.grammar}`,
    `- If today's grammar focus is harder than this stage, teach only its simplest, most common form.`,
    `- Avoid: ${s.avoid}.`,
    `- Speaking practice: exactly ${s.speakingPrompts} short sentences to say aloud (fill-in "___" is good).`,
    `- Vocabulary: ${vocab} common words; meaning in very simple words, example of ${s.maxSentenceWords} words or fewer.`,
    `- Quick practice: 2 easy fill-in-the-blank or short-answer questions.`,
    `- Today's Focus (scenarioType): a short plain phrase, e.g. "Talking about yourself".`
  ].join('\n');
}

// Days 1-30 only: words/structures the stage forbids. "would like" is allowed
// (a fixed polite phrase); comparisons are caught by "than".
const STRICT_WORD_PATTERNS = [
  /\bmight\b/i, /\bcould\b/i, /\bwould\b(?!\s+like)/i, /\bshould\b/i, /\bmust\b/i,
  /\bunless\b/i, /\balthough\b/i, /\bwhereas\b/i, /\bif\b/i, /\bthan\b/i
];
const SPEAKER_LABEL = /^\s*[^:\n]{1,20}:\s*/;

/**
 * Deterministic difficulty check (no AI call). Returns human-readable issues;
 * used to trigger generateLesson's single existing corrective retry.
 */
function findBeginnerDifficultyIssues(lessonJson, day, conversationPrefix = '') {
  const s = getBeginnerStage(day);
  const issues = [];
  if (!lessonJson || typeof lessonJson.conversation !== 'string') return issues;

  const dialogue = lessonJson.conversation.replace(conversationPrefix, '');
  const sentences = dialogue
    .split('\n')
    .map(line => line.replace(SPEAKER_LABEL, '').trim())
    .filter(Boolean)
    .flatMap(line => line.split(/(?<=[.!?])\s+/));
  const longest = Math.max(0, ...sentences.map(x => x.split(/\s+/).filter(Boolean).length));
  // Small allowance over the target before forcing a retry.
  if (longest > s.maxSentenceWords + 4) issues.push(`a conversation sentence has ${longest} words (keep to about ${s.maxSentenceWords})`);

  if (s.strictWords) {
    const mp = lessonJson.microPractice || {};
    const text = [dialogue, lessonJson.explanation, ...(lessonJson.guidedSpeakingPrompts || []), mp.q1, mp.q2]
      .filter(x => typeof x === 'string').join('\n');
    const found = STRICT_WORD_PATTERNS.map(re => (text.match(re) || [])[0]).filter(Boolean);
    if (found.length) issues.push(`uses grammar too hard for this stage: ${[...new Set(found.map(w => w.toLowerCase()))].join(', ')}`);
  }
  return issues;
}

/** Scenario for beginners on Days 1-90; null = use the goal-based family. */
function getBeginnerScenario(day) {
  const s = getBeginnerStage(day);
  return s.scenarios ? s.scenarios[((Number(day) || 1) - s.from) % s.scenarios.length] : null;
}

module.exports = {
  BEGINNER_STAGES,
  BEGINNER_FOUNDATION_TOPICS,
  getBeginnerStage,
  getBeginnerLessonRules,
  buildBeginnerGuidance,
  findBeginnerDifficultyIssues,
  getBeginnerScenario
};
