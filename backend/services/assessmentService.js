const openai = require('../config/openai');
const Log = require('../models/Log');
const LearnerAssessment = require('../models/LearnerAssessment');
const { ASSESSMENT_QUESTIONS } = LearnerAssessment;
const {
  downloadWhatsAppAudio,
  transcribeAudio,
  cleanupTempFile,
  normalizeWeakAreas
} = require('./voiceEvaluationService');

const ASSESSMENT_MODEL = 'gpt-4o-mini';
const SCORE_MIN = 1;
const SCORE_MAX = 10;
const VALID_LEVELS = ['beginner', 'intermediate', 'advanced'];

// ============================================================================
// Question progression - derived from persisted response counts, mirroring
// SpeakingAttempt's history-derived state (no extra mutable step counter).
// ============================================================================

function getNextAssessmentStep(assessment) {
  const answeredCount = assessment.textResponses.length + assessment.voiceResponses.length;
  if (answeredCount >= ASSESSMENT_QUESTIONS.length) return null;
  return ASSESSMENT_QUESTIONS[answeredCount];
}

function isAssessmentComplete(assessment) {
  return getNextAssessmentStep(assessment) === null;
}

async function recordTextAnswer(assessment, question, answerText) {
  assessment.textResponses.push({
    questionId: question.questionId,
    question: question.question,
    answer: (answerText || '').trim()
  });
  await assessment.save();
}

/**
 * Reuses Prompt 5's download/transcribe/cleanup utilities directly - no
 * duplicate voice pipeline. Deliberately does NOT create a SpeakingAttempt;
 * onboarding assessment attempts are kept separate from lesson-practice history.
 */
async function recordVoiceAnswer(assessment, question, mediaId) {
  let audioFilePath = null;
  try {
    audioFilePath = await downloadWhatsAppAudio(mediaId);
    const transcript = await transcribeAudio(audioFilePath);
    assessment.voiceResponses.push({
      questionId: question.questionId,
      question: question.question,
      transcript
    });
    await assessment.save();
    return transcript;
  } finally {
    if (audioFilePath) cleanupTempFile(audioFilePath);
  }
}

// ============================================================================
// Single final GPT assessment call (+ at most one corrective retry)
// ============================================================================

const SYSTEM_PROMPT = `You are assessing a new English learner's practical ability from 2 written answers and 2 transcribed spoken answers, to recommend a starting level.
Score ONLY what the text reveals: grammar, sentence formation, vocabulary, naturalness, and comprehension (did they understand/answer the question). Do NOT claim to judge pronunciation, accent, or intonation - transcripts cannot show those.
Return ONLY valid JSON in this exact shape:
{
  "grammarScore": 1-10,
  "sentenceFormationScore": 1-10,
  "vocabularyScore": 1-10,
  "naturalnessScore": 1-10,
  "comprehensionScore": 1-10,
  "overallScore": 1-10,
  "recommendedLevel": "beginner" | "intermediate" | "advanced",
  "strengths": ["short phrase", "..."],
  "weakAreas": ["short_snake_case_label", "..."],
  "summary": "one encouraging sentence"
}
weakAreas: pick at most 2 from exactly these labels (only if genuinely relevant): articles, prepositions, past_tense, question_formation, sentence_order, verb_agreement, vocabulary_range, natural_expression.
strengths: at most 2 short phrases.`;

function buildAssessmentUserPrompt(assessment) {
  const lines = [];
  assessment.textResponses.forEach((r, i) => lines.push(`Text Q${i + 1}: ${r.question}\nAnswer: ${r.answer}`));
  assessment.voiceResponses.forEach((r, i) => lines.push(`Voice Q${i + 1}: ${r.question}\nTranscript: ${r.transcript}`));
  return lines.join('\n\n');
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function validateAssessmentJson(result) {
  const errors = [];
  if (!result || typeof result !== 'object') {
    return { valid: false, errors: ['result is not an object'] };
  }

  const scoreFields = ['grammarScore', 'sentenceFormationScore', 'vocabularyScore', 'naturalnessScore', 'comprehensionScore', 'overallScore'];
  scoreFields.forEach(field => {
    const value = result[field];
    if (typeof value !== 'number' || Number.isNaN(value) || value < SCORE_MIN || value > SCORE_MAX) {
      errors.push(`${field} missing/out of range`);
    }
  });

  if (typeof result.summary !== 'string' || !result.summary.trim()) errors.push('summary missing');
  if (!Array.isArray(result.strengths)) errors.push('strengths must be an array');
  if (!Array.isArray(result.weakAreas)) errors.push('weakAreas must be an array');

  return { valid: errors.length === 0, errors };
}

/** AI recommendation is never trusted blindly - always coerced to a valid level. */
function validateRecommendedLevel(level) {
  return VALID_LEVELS.includes(level) ? level : null;
}

/** Deterministic sanity fallback when the AI level is missing/invalid. */
function deterministicLevelFromScore(overallScore) {
  if (typeof overallScore !== 'number' || Number.isNaN(overallScore)) return 'beginner';
  if (overallScore <= 4) return 'beginner';
  if (overallScore <= 7) return 'intermediate';
  return 'advanced';
}

/** Word-count heuristic used only if GPT is unreachable and there are no scores at all to threshold from. */
function heuristicFallback(assessment) {
  const totalWords = [
    ...assessment.textResponses.map(r => r.answer || ''),
    ...assessment.voiceResponses.map(r => r.transcript || '')
  ].join(' ').trim().split(/\s+/).filter(Boolean).length;

  const level = totalWords < 25 ? 'beginner' : totalWords < 60 ? 'intermediate' : 'advanced';

  return {
    grammarScore: 5, sentenceFormationScore: 5, vocabularyScore: 5, naturalnessScore: 5, comprehensionScore: 5, overallScore: 5,
    recommendedLevel: level,
    strengths: [],
    weakAreas: [],
    summary: "Thanks for completing your setup! We'll fine-tune your lessons as you go."
  };
}

/**
 * One GPT call to evaluate all 4 answers together, at most one corrective
 * retry on malformed/invalid JSON, then a deterministic fallback. Never
 * more than 1 GPT call for a normal successful run.
 */
async function runAssessmentEvaluation(assessment) {
  const userPrompt = buildAssessmentUserPrompt(assessment);
  const baseMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ];

  let response;
  try {
    response = await openai.chat.completions.create({
      model: ASSESSMENT_MODEL,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: baseMessages
    });
  } catch (apiError) {
    console.error('❌ Assessment API call failed:', apiError.message);
    return finalizeResult(heuristicFallback(assessment), 'fallback');
  }

  let result = safeParseJson(response.choices[0].message.content);
  let validation = validateAssessmentJson(result);

  if (validation.valid) {
    return finalizeResult(result, 'valid');
  }

  console.error('⚠️ Assessment JSON invalid, retrying once:', validation.errors.join('; '));

  try {
    const retryResponse = await openai.chat.completions.create({
      model: ASSESSMENT_MODEL,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        ...baseMessages,
        { role: 'assistant', content: response.choices[0].message.content },
        { role: 'user', content: `That was invalid: ${validation.errors.join('; ')}. Return corrected JSON only.` }
      ]
    });

    const retryResult = safeParseJson(retryResponse.choices[0].message.content);
    const retryValidation = validateAssessmentJson(retryResult);

    if (retryValidation.valid) {
      return finalizeResult(retryResult, 'retried');
    }
    console.error('❌ Assessment still invalid after retry:', retryValidation.errors.join('; '));
  } catch (retryApiError) {
    console.error('❌ Assessment retry API call failed:', retryApiError.message);
  }

  return finalizeResult(heuristicFallback(assessment), 'fallback');
}

function finalizeResult(result, validationStatus) {
  const recommendedLevel = validateRecommendedLevel(result.recommendedLevel) || deterministicLevelFromScore(result.overallScore);
  return {
    scores: {
      grammar: result.grammarScore,
      sentenceFormation: result.sentenceFormationScore,
      vocabulary: result.vocabularyScore,
      naturalness: result.naturalnessScore,
      comprehension: result.comprehensionScore,
      overall: result.overallScore
    },
    strengths: Array.isArray(result.strengths) ? result.strengths.slice(0, 2) : [],
    weakAreas: normalizeWeakAreas(result.weakAreas),
    summary: result.summary || '',
    recommendedLevel,
    validationStatus
  };
}

// ============================================================================
// Completion message (deterministic formatting - no AI-generated report)
// ============================================================================

const GOAL_LABELS = {
  daily_english: 'Daily English',
  workplace: 'Workplace English',
  interview: 'Interview English',
  college_placement: 'College / Placement',
  customer_service: 'Customer Service English',
  sales: 'Sales English',
  travel: 'Travel English'
};

const LEVEL_LABELS = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };

function buildOnboardingCompletionMessage({ learningGoal, level, recommendedLevel, strengths, weakAreas }) {
  const goalLabel = GOAL_LABELS[learningGoal] || GOAL_LABELS.daily_english;
  const levelLabel = LEVEL_LABELS[level] || LEVEL_LABELS.beginner;

  // Business rule: `level` (what was purchased, tied to PlanMaster pricing) is
  // never silently overridden by the assessment. If they differ, say so plainly
  // instead of hiding the recommendation.
  const levelNote = recommendedLevel && recommendedLevel !== level
    ? `\n(Your assessment suggested ${LEVEL_LABELS[recommendedLevel] || recommendedLevel} - lessons will run at your purchased ${levelLabel} level and adapt from there.)`
    : '';

  const strengthLines = strengths && strengths.length
    ? strengths.map(s => `• ${s}`).join('\n')
    : "• Keep going - you're just getting started!";

  const focusLines = weakAreas && weakAreas.length
    ? weakAreas.map(w => `• ${w.replace(/_/g, ' ')}`).join('\n')
    : '• General fluency';

  return `✅ Your FluencyLoop setup is ready!

Goal: ${goalLabel}
Level: ${levelLabel}${levelNote}

Strong:
${strengthLines}

Focus areas:
${focusLines}

Your lessons will now adapt to these areas.

Reply START to begin Day 1.`;
}

function getStepNumber(assessment) {
  return assessment.textResponses.length + assessment.voiceResponses.length + 1;
}

module.exports = {
  getNextAssessmentStep,
  isAssessmentComplete,
  getStepNumber,
  recordTextAnswer,
  recordVoiceAnswer,
  runAssessmentEvaluation,
  validateAssessmentJson,
  validateRecommendedLevel,
  deterministicLevelFromScore,
  buildOnboardingCompletionMessage,
  GOAL_LABELS
};
