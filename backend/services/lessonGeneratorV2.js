const openai = require('../config/openai');
const Log = require('../models/Log');
const { trackOpenAI } = require('../utils/aiUsageTracker');
const { getScenarioFamily, getGoalContextLabel } = require('./onboardingService');
const {
  getBeginnerStage,
  getBeginnerLessonRules,
  buildBeginnerGuidance,
  findBeginnerDifficultyIssues,
  getBeginnerScenario
} = require('./beginnerProgression');
const { buildBeginnerFallbackJson } = require('./beginnerFallbackLessons');

const GENERATION_VERSION = 'v3';

// Target sizes - keeps a daily lesson to roughly 10-15 minutes on WhatsApp
const TARGET_SPEAKING_PROMPTS = 3;
const TARGET_VOCAB_COUNT = 3;
const CONVERSATION_WORD_RANGE = [50, 220]; // generous - advanced lessons can run a bit longer
const EXPLANATION_WORD_RANGE = [25, 160];
const REQUIRED_CONVERSATION_PREFIX = '🔊 Speak this conversation aloud slowly and clearly.';
const RECENT_VOCAB_CONTEXT_LIMIT = 12; // only recent-enough words are useful anti-repetition context
const RECENT_SCENARIO_CONTEXT_LIMIT = 5;
const VOCAB_OVERLAP_RETRY_THRESHOLD = 0.5; // >=50% of today's "new" words already recently taught

const DEFAULT_LESSON_RULES = {
  conversationWordRange: CONVERSATION_WORD_RANGE,
  explanationWordRange: EXPLANATION_WORD_RANGE,
  speakingPrompts: [TARGET_SPEAKING_PROMPTS, TARGET_SPEAKING_PROMPTS],
  vocabCount: [TARGET_VOCAB_COUNT, TARGET_VOCAB_COUNT]
};

function isBeginner(user) {
  return user.level === 'beginner';
}

function getLessonRules(user) {
  return isBeginner(user) ? getBeginnerLessonRules(user.currentDay) : DEFAULT_LESSON_RULES;
}

// ============================================================================
// PART 1: SYSTEM PROMPT (constant, level-agnostic - level detail lives in the
// per-request user prompt so it isn't duplicated here)
// ============================================================================

const SYSTEM_PROMPT = `
You are a professional English tutor writing ONE short, natural WhatsApp lesson.

RULES:
1. Natural dialogue only - no textbook greetings, use contractions, be scenario-specific from line one.
2. Conversation field MUST start with exactly: "${REQUIRED_CONVERSATION_PREFIX}" then a realistic dialogue (~80-120 words, a bit more is fine for advanced level).
3. Explanation must show the grammar PATTERN with 1-2 example sentences (~50-80 words), not a summary.
4. Follow the given topic, grammar focus and scenario exactly - never invent a different topic.
5. Avoid the recent topics/grammar/vocabulary/scenarios listed in the user message - keep it fresh.
6. Vocabulary: exactly ${TARGET_VOCAB_COUNT} useful words that fit the scenario naturally.
7. Use the student's name at most once. Be encouraging but concise.
8. Return ONLY valid JSON, no commentary, matching exactly this shape:

{
  "title": "...",
  "scenarioType": "...",
  "conversation": "${REQUIRED_CONVERSATION_PREFIX}\\n\\n[dialogue]",
  "explanation": "[pattern explanation]",
  "guidedSpeakingPrompts": ["prompt1", "prompt2", "prompt3"],
  "newVocabulary": [
    {"word":"...", "meaning":"...", "example":"..."},
    {"word":"...", "meaning":"...", "example":"..."},
    {"word":"...", "meaning":"...", "example":"..."}
  ],
  "microPractice": {"q1": "...", "q2": "..."},
  "confidenceLine": "..."
}
`.trim();

// Beginner-only system prompt: sizes and difficulty come from the day's stage
// in the user prompt (see beginnerProgression.js), so nothing here conflicts.
const BEGINNER_SYSTEM_PROMPT = `
You are a friendly English tutor writing ONE short WhatsApp lesson for a beginner adult learner.

RULES:
1. Simple, natural, everyday spoken English. Short sentences. Respectful of adults - never childish.
2. Conversation field MUST start with exactly: "${REQUIRED_CONVERSATION_PREFIX}" then a short "A:"/"B:" dialogue, one line per turn.
3. Explanation = today's ONE pattern as short fill-in lines (e.g. "My name is ___.") with at most one plain sentence. No grammar terms.
4. Follow the given topic and the stage rules in the user message exactly - never invent a different or harder topic.
5. Vocabulary: common, useful words. Meanings in very simple words; short examples.
6. Use the student's name at most once. Be warm and brief.
7. Return ONLY valid JSON, no commentary, matching exactly this shape (array lengths as the user message says):

{
  "title": "...",
  "scenarioType": "...",
  "conversation": "${REQUIRED_CONVERSATION_PREFIX}\\n\\nA: ...\\nB: ...",
  "explanation": "...",
  "guidedSpeakingPrompts": ["..."],
  "newVocabulary": [{"word":"...", "meaning":"...", "example":"..."}],
  "microPractice": {"q1": "...", "q2": "..."},
  "confidenceLine": "..."
}
`.trim();

function getSystemPrompt(user) {
  return isBeginner(user) ? BEGINNER_SYSTEM_PROMPT : SYSTEM_PROMPT;
}

// ============================================================================
// PART 2: LEVEL-SPECIFIC GUIDANCE (injected once, into the user prompt only)
// ============================================================================

const LEVEL_GUIDANCE = {
  beginner: 'LEVEL - Beginner: simple sentence structures, everyday useful vocabulary, short responses, minimal jargon, slow steady progression.',
  intermediate: 'LEVEL - Intermediate: natural real-world conversation (workplace/social scenarios), common phrasal verbs and expressions, encourage more spontaneous speaking.',
  advanced: 'LEVEL - Advanced: nuanced conversation, professional/contextual vocabulary, opinions/negotiation/persuasion/explanation, more complex sentence structures. Slightly richer content is fine.'
};

function getLevelGuidance(level) {
  return LEVEL_GUIDANCE[level] || LEVEL_GUIDANCE.beginner;
}

// ============================================================================
// PART 3: USER PROMPT BUILDER (dynamic per user - only the memory that's
// actually useful is included, to keep prompt tokens down)
// ============================================================================

function buildUserPrompt(user, topic, tutorMemory, scenarioType) {
  const recentTopics = tutorMemory.recentTopicDays?.length
    ? tutorMemory.recentTopicDays.join(', ')
    : 'None';

  const recentGrammar = tutorMemory.recentGrammarKeys?.length
    ? tutorMemory.recentGrammarKeys.join(', ')
    : 'None';

  const recentVocab = tutorMemory.vocabBank?.length
    ? tutorMemory.vocabBank.slice(-RECENT_VOCAB_CONTEXT_LIMIT).map(v => v.word).join(', ')
    : 'None';

  const recentScenarios = tutorMemory.recentScenarioTypes?.length
    ? tutorMemory.recentScenarioTypes.slice(-RECENT_SCENARIO_CONTEXT_LIMIT).join(', ')
    : 'None';

  const weakAreas = tutorMemory.weakAreas?.length
    ? tutorMemory.weakAreas.join(', ')
    : 'None identified yet';

  if (isBeginner(user)) {
    // Anti-repetition is softened for beginners: pushing away from recent
    // simple patterns/words otherwise drives the AI toward harder ones.
    const foundation = getBeginnerStage(user.currentDay).strictWords;
    return `
Student: ${user.name} | Level: beginner | Day: ${user.currentDay}
Topic: ${topic.title} | Grammar focus: ${topic.grammarFocus} | Difficulty: ${topic.difficultyTag} | Scenario: ${scenarioType}

${buildBeginnerGuidance(user.currentDay)}

Learner's goal context${foundation ? ' - use only if it fits naturally in simple words' : ' - bias the situation toward this, but KEEP today\'s topic and grammar focus'}: ${getGoalContextLabel(user.learningGoal)}

Recent topics (days): ${recentTopics}
Recent patterns (simple ones may be reused - never switch to harder grammar to avoid repeating): ${recentGrammar}
Recent words (prefer other common everyday words - never rare ones): ${recentVocab}
Recently used scenario types (vary the specific situation): ${recentScenarios}
Gently reinforce, in simple words: ${weakAreas}

Generate the lesson JSON now.
    `.trim();
  }

  return `
Student: ${user.name} | Level: ${user.level} | Day: ${user.currentDay}
Topic: ${topic.title} | Grammar focus: ${topic.grammarFocus} | Difficulty: ${topic.difficultyTag} | Scenario: ${scenarioType}

${getLevelGuidance(user.level)}

Learner's goal context - bias the situation/vocabulary toward this, but KEEP today's topic and grammar focus exactly: ${getGoalContextLabel(user.learningGoal)}

Avoid recent topics (days): ${recentTopics}
Avoid recent grammar patterns: ${recentGrammar}
Avoid recent vocabulary: ${recentVocab}
Recently used scenario types (vary the specific situation even if the category repeats): ${recentScenarios}
Gently reinforce these weak areas WITHOUT changing today's topic/grammar focus: ${weakAreas}

Generate the lesson JSON now.
  `.trim();
}

// ============================================================================
// PART 4: SCENARIO TYPE ROTATION - deterministic, no memory needed. Biased by
// the learner's goal (falls back to the daily_english family when no goal is
// set, which is also every existing user's default).
// ============================================================================

function getScenarioType(day, learningGoal, level) {
  // Beginners follow the stage's everyday situations through Day 90 (the
  // goal family's day-1 slot was "shopping", which made Day 1 a shopping lesson).
  const beginnerScenario = level === 'beginner' ? getBeginnerScenario(day) : null;
  if (beginnerScenario) return beginnerScenario;
  const family = getScenarioFamily(learningGoal);
  return family[day % family.length];
}

// ============================================================================
// PART 5: WHATSAPP FORMATTER
// ============================================================================

function formatLessonForWhatsApp(lessonJson, dayNumber) {
  const vocabText = lessonJson.newVocabulary
    .map(v => `• ${v.word} – ${v.meaning}\n  Example: ${v.example}`)
    .join('\n\n');

  const speakingText = lessonJson.guidedSpeakingPrompts
    .map((p, i) => `${i + 1}. ${p}`)
    .join('\n');

  const mp = lessonJson.microPractice || {};

  return `
📘 Day ${dayNumber}: ${lessonJson.title}

🎯 Today's Focus: ${lessonJson.scenarioType}

🗣 Conversation:
${lessonJson.conversation}

🧩 Pattern:
${lessonJson.explanation}

🎤 Speaking Practice:
${speakingText}

🧠 Vocabulary:
${vocabText}

✍ Quick Practice:
1) ${mp.q1 || ''}
2) ${mp.q2 || ''}

💪 ${lessonJson.confidenceLine}
  `.trim();
}

// ============================================================================
// PART 6: LOCAL DETERMINISTIC VALIDATION (no extra AI call)
// ============================================================================

function countLabel([min, max]) {
  return min === max ? `exactly ${min}` : `${min}-${max}`;
}

function validateLessonJson(lessonJson, rules = DEFAULT_LESSON_RULES) {
  const errors = [];
  const { conversationWordRange, explanationWordRange, speakingPrompts, vocabCount } = rules;

  if (!lessonJson || typeof lessonJson !== 'object') {
    return { valid: false, errors: ['lessonJson is not an object'], vocabWords: [] };
  }

  if (typeof lessonJson.title !== 'string' || !lessonJson.title.trim()) errors.push('title missing/empty');
  if (typeof lessonJson.scenarioType !== 'string' || !lessonJson.scenarioType.trim()) errors.push('scenarioType missing/empty');
  if (typeof lessonJson.confidenceLine !== 'string' || !lessonJson.confidenceLine.trim()) errors.push('confidenceLine missing/empty');

  if (typeof lessonJson.conversation !== 'string' || !lessonJson.conversation.trim()) {
    errors.push('conversation missing/empty');
  } else {
    if (!lessonJson.conversation.startsWith(REQUIRED_CONVERSATION_PREFIX)) {
      errors.push('conversation missing required instruction prefix');
    }
    const wordCount = lessonJson.conversation.trim().split(/\s+/).length;
    if (wordCount < conversationWordRange[0] || wordCount > conversationWordRange[1]) {
      errors.push(`conversation word count out of range (${wordCount})`);
    }
  }

  if (typeof lessonJson.explanation !== 'string' || !lessonJson.explanation.trim()) {
    errors.push('explanation missing/empty');
  } else {
    const wordCount = lessonJson.explanation.trim().split(/\s+/).length;
    if (wordCount < explanationWordRange[0] || wordCount > explanationWordRange[1]) {
      errors.push(`explanation word count out of range (${wordCount})`);
    }
  }

  const prompts = lessonJson.guidedSpeakingPrompts;
  if (!Array.isArray(prompts) || prompts.length < speakingPrompts[0] || prompts.length > speakingPrompts[1]) {
    errors.push(`guidedSpeakingPrompts must contain ${countLabel(speakingPrompts)} prompts`);
  } else if (lessonJson.guidedSpeakingPrompts.some(p => typeof p !== 'string' || !p.trim())) {
    errors.push('guidedSpeakingPrompts contains an empty/invalid entry');
  }

  let vocabWords = [];
  const vocab = lessonJson.newVocabulary;
  if (!Array.isArray(vocab) || vocab.length < vocabCount[0] || vocab.length > vocabCount[1]) {
    errors.push(`newVocabulary must contain ${countLabel(vocabCount)} words`);
  } else {
    const hasIncompleteEntry = lessonJson.newVocabulary.some(v =>
      !v || typeof v.word !== 'string' || !v.word.trim() ||
      typeof v.meaning !== 'string' || !v.meaning.trim() ||
      typeof v.example !== 'string' || !v.example.trim()
    );
    if (hasIncompleteEntry) errors.push('newVocabulary contains an incomplete entry');
    vocabWords = lessonJson.newVocabulary.filter(v => v && v.word).map(v => v.word.toLowerCase().trim());
  }

  const mp = lessonJson.microPractice;
  if (!mp || typeof mp !== 'object' ||
      typeof mp.q1 !== 'string' || !mp.q1.trim() ||
      typeof mp.q2 !== 'string' || !mp.q2.trim()) {
    errors.push('microPractice must include non-empty q1 and q2');
  }

  return { valid: errors.length === 0, errors, vocabWords };
}

function computeVocabOverlapRatio(newVocabWords, recentVocabWords) {
  if (!newVocabWords || !newVocabWords.length) return 0;
  const recentSet = new Set((recentVocabWords || []).map(w => w.toLowerCase().trim()));
  const overlapCount = newVocabWords.filter(w => recentSet.has(w)).length;
  return overlapCount / newVocabWords.length;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// ============================================================================
// PART 7: FALLBACK LESSON GENERATOR (deterministic, no OpenAI call, level-aware)
// ============================================================================

const FALLBACK_VOCAB_BY_LEVEL = {
  beginner: [
    { word: 'practice', meaning: 'to do something repeatedly to improve', example: 'I practice English every day.' },
    { word: 'simple', meaning: 'easy to understand', example: 'Try to use simple words when you speak.' },
    { word: 'everyday', meaning: 'happening or used daily', example: 'This is part of my everyday routine.' }
  ],
  intermediate: [
    { word: 'get by', meaning: 'to manage or cope with something', example: 'I can get by in most conversations now.' },
    { word: 'bring up', meaning: 'to mention a topic', example: 'She brought up the schedule change in the meeting.' },
    { word: 'figure out', meaning: 'to understand something after thinking', example: 'Let me figure out the best way to say this.' }
  ],
  advanced: [
    { word: 'nuanced', meaning: 'showing subtle, careful distinctions', example: 'His argument was nuanced and persuasive.' },
    { word: 'negotiate', meaning: 'to discuss something to reach an agreement', example: 'We negotiated a better deadline.' },
    { word: 'articulate', meaning: 'to express an idea clearly', example: 'She articulated her opinion with confidence.' }
  ]
};

function generateFallbackLesson(user, topic) {
  console.log(`🛡️ Generating fallback lesson for ${user.name} - Day ${user.currentDay}`);

  const level = FALLBACK_VOCAB_BY_LEVEL[user.level] ? user.level : 'beginner';
  const topicTitle = topic.title || `Day ${user.currentDay} topic`;
  const grammarFocus = topic.grammarFocus || "today's pattern";

  // Beginner Days 1-30: the reviewed, day-specific lesson for the foundation plan.
  const foundationJson = level === 'beginner'
    ? buildBeginnerFallbackJson(user.currentDay, REQUIRED_CONVERSATION_PREFIX)
    : null;

  const fallbackJson = foundationJson || (level === 'beginner' ? {
    title: topic.title || `Day ${user.currentDay} Lesson`,
    scenarioType: 'Simple everyday English',
    conversation: `${REQUIRED_CONVERSATION_PREFIX}\n\nA: Hello! How are you?\nB: I am fine, thank you.\nA: Let's practice English.\nB: Yes, let's practice!\nA: Speak slowly and clearly.\nB: Okay. Thank you!`,
    explanation: `Today's pattern: ${grammarFocus}\nSay it in short, simple sentences.`,
    guidedSpeakingPrompts: [
      'Hello! My name is ___.',
      `Say one short sentence about ${topicTitle}.`
    ],
    newVocabulary: FALLBACK_VOCAB_BY_LEVEL.beginner,
    microPractice: {
      q1: 'My name ___ ___.',
      q2: `Write one short sentence about ${topicTitle}.`
    },
    confidenceLine: 'Great job! Keep speaking every day! 💪'
  } : {
    title: topic.title || `Day ${user.currentDay} Lesson`,
    scenarioType: 'general',
    conversation: `${REQUIRED_CONVERSATION_PREFIX}\n\nPerson A: Can you help me practice ${topicTitle}?\nPerson B: Sure, let's go through it together.\nPerson A: I want to get comfortable using ${grammarFocus}.\nPerson B: Good idea - let's try a few real examples.`,
    explanation: `Today's focus is ${grammarFocus}. Practice this pattern in your own sentences until it feels natural - repetition is what builds fluency.`,
    guidedSpeakingPrompts: [
      `Use ${grammarFocus} in a sentence about your day.`,
      `Ask a question related to ${topicTitle}.`,
      'Share your opinion in one or two sentences.'
    ],
    newVocabulary: FALLBACK_VOCAB_BY_LEVEL[level],
    microPractice: {
      q1: `Write one sentence using ${grammarFocus}.`,
      q2: `Ask a question about ${topicTitle}.`
    },
    confidenceLine: 'Keep practicing - every lesson makes you stronger! 💪'
  });

  return {
    lessonJson: fallbackJson,
    lessonText: formatLessonForWhatsApp(fallbackJson, user.currentDay),
    vocabList: fallbackJson.newVocabulary,
    scenarioType: 'general',
    generationVersion: GENERATION_VERSION,
    validationStatus: 'fallback'
  };
}

// ============================================================================
// PART 8: MAIN LESSON GENERATOR - one call, at most one corrective retry
// ============================================================================

async function callOpenAI(messages, temperature, operation, user) {
  return trackOpenAI({ operation, model: 'gpt-4o-mini', userId: user && user._id }, () => openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature,
    response_format: { type: 'json_object' },
    messages
  }));
}

async function generateLesson(user, topic, tutorMemory) {
  const scenarioType = getScenarioType(user.currentDay, user.learningGoal, user.level);
  const rules = getLessonRules(user);
  const checkDifficulty = json => (isBeginner(user)
    ? findBeginnerDifficultyIssues(json, user.currentDay, REQUIRED_CONVERSATION_PREFIX)
    : []);
  const recentVocabWords = (tutorMemory.vocabBank || [])
    .slice(-RECENT_VOCAB_CONTEXT_LIMIT)
    .map(v => v.word);

  try {
    const userPrompt = buildUserPrompt(user, topic, tutorMemory, scenarioType);
    const baseMessages = [
      { role: 'system', content: getSystemPrompt(user) },
      { role: 'user', content: userPrompt }
    ];

    console.log(`🎓 Generating structured lesson for ${user.name} - Day ${user.currentDay} (${topic.title})`);

    let response;
    try {
      response = await callOpenAI(baseMessages, 0.7, 'lesson_generation', user);
    } catch (apiError) {
      console.error('❌ OpenAI API call failed:', apiError.message);
      await Log.create({
        type: 'LESSON_GENERATION_ERROR',
        userPhone: user.phone,
        message: `OpenAI API error: ${apiError.message}`,
        status: 'ERROR',
        metadata: { day: user.currentDay, topic: topic.title }
      });
      return generateFallbackLesson(user, topic);
    }

    let lessonJson = safeParseJson(response.choices[0].message.content);
    let validation = lessonJson
      ? validateLessonJson(lessonJson, rules)
      : { valid: false, errors: ['response was not valid JSON'], vocabWords: [] };

    const needsStructuralRetry = !validation.valid;
    const vocabOverlapRatio = validation.valid
      ? computeVocabOverlapRatio(validation.vocabWords, recentVocabWords)
      : 0;
    const needsRepetitionRetry = validation.valid && vocabOverlapRatio >= VOCAB_OVERLAP_RETRY_THRESHOLD;
    // Beginner only: too-hard wording shares the same single retry - never a fallback.
    const difficultyIssues = validation.valid ? checkDifficulty(lessonJson) : [];
    const needsDifficultyRetry = difficultyIssues.length > 0;

    let validationStatus = 'valid';

    if (needsStructuralRetry || needsRepetitionRetry || needsDifficultyRetry) {
      const notes = [];
      if (needsStructuralRetry) {
        notes.push(`Your last response was invalid: ${validation.errors.join('; ')}. Return corrected JSON matching the exact required structure.`);
      }
      if (needsDifficultyRetry) {
        notes.push(`Too hard for this beginner stage: ${difficultyIssues.join('; ')}. Rewrite with shorter, simpler sentences and the same JSON structure.`);
      }
      if (needsRepetitionRetry) {
        notes.push(isBeginner(user)
          ? `Your vocabulary overlapped too much with recently taught words (${recentVocabWords.join(', ')}). Choose different common, everyday words that fit the scenario.`
          : `Your vocabulary overlapped too much with recently taught words (${recentVocabWords.join(', ')}). Choose ${TARGET_VOCAB_COUNT} different, fresh words that still fit the scenario.`);
      }
      const correctionNote = notes.join(' ');
      const retryKind = needsStructuralRetry ? 'structural' : needsDifficultyRetry ? 'difficulty' : 'repetition';

      console.log(`🔄 Corrective retry (${retryKind}): ${correctionNote}`);

      let retryHandled = false;
      try {
        const retryResponse = await callOpenAI([
          ...baseMessages,
          { role: 'assistant', content: response.choices[0].message.content },
          { role: 'user', content: correctionNote }
        ], 0.5, 'lesson_generation_retry', user);

        const retryJson = safeParseJson(retryResponse.choices[0].message.content);
        const retryValidation = retryJson
          ? validateLessonJson(retryJson, rules)
          : { valid: false, errors: ['retry response was not valid JSON'], vocabWords: [] };

        // A beginner retry must not be harder than the original it replaces.
        const retryIssueCount = checkDifficulty(retryJson).length;
        const retryNotHarder = needsDifficultyRetry
          ? retryIssueCount < difficultyIssues.length
          : retryIssueCount === 0;

        if (retryValidation.valid && (needsStructuralRetry || retryNotHarder)) {
          lessonJson = retryJson;
          validationStatus = 'retried';
          retryHandled = true;
        } else {
          console.error('⚠️ Retry still invalid:', retryValidation.errors.join('; '));
        }
      } catch (retryApiError) {
        console.error('❌ Corrective retry API call failed:', retryApiError.message);
      }

      if (!retryHandled) {
        if (needsStructuralRetry) {
          // Original was unusable and the one allowed retry didn't fix it - fallback.
          await Log.create({
            type: 'LESSON_GENERATION_FALLBACK',
            userPhone: user.phone,
            message: 'Used fallback lesson after JSON validation failures',
            status: 'WARNING',
            metadata: { day: user.currentDay, topic: topic.title, errors: validation.errors }
          });
          return generateFallbackLesson(user, topic);
        }
        // Original was structurally valid (only a vocab-overlap or beginner
        // difficulty concern) and the retry didn't improve it - accept the original rather than burn the
        // curriculum-aligned content on a cosmetic repetition issue.
        validationStatus = 'valid';
      }
    }

    // Beginner Days 1-30: never deliver a lesson known to fail the difficulty
    // check (e.g. both AI attempts too hard) - use the reviewed day lesson.
    const remainingIssues = isBeginner(user) && getBeginnerStage(user.currentDay).strictWords
      ? checkDifficulty(lessonJson)
      : [];
    if (remainingIssues.length) {
      await Log.create({
        type: 'LESSON_GENERATION_FALLBACK',
        userPhone: user.phone,
        message: 'Used beginner fallback lesson after difficulty check failures',
        status: 'WARNING',
        metadata: { day: user.currentDay, topic: topic.title, errors: remainingIssues }
      });
      return generateFallbackLesson(user, topic);
    }

    const lessonText = formatLessonForWhatsApp(lessonJson, user.currentDay);

    await Log.create({
      type: 'LESSON_GENERATED',
      userPhone: user.phone,
      message: `Structured lesson generated for Day ${user.currentDay}`,
      status: 'SUCCESS',
      metadata: {
        day: user.currentDay,
        topic: topic.title,
        vocabCount: lessonJson.newVocabulary.length,
        validationStatus
      }
    });

    return {
      lessonJson,
      lessonText,
      vocabList: lessonJson.newVocabulary,
      scenarioType,
      generationVersion: GENERATION_VERSION,
      validationStatus
    };

  } catch (error) {
    console.error('❌ Unexpected error in generateLesson:', error);
    await Log.create({
      type: 'LESSON_GENERATION_ERROR',
      userPhone: user.phone,
      message: `Unexpected error: ${error.message}`,
      status: 'ERROR',
      metadata: { day: user.currentDay, error: error.stack }
    });
    return generateFallbackLesson(user, topic);
  }
}

module.exports = {
  generateLesson,
  getLessonRules,
  generateFallbackLesson,
  formatLessonForWhatsApp,
  validateLessonJson,
  computeVocabOverlapRatio,
  getScenarioType,
  GENERATION_VERSION
};
