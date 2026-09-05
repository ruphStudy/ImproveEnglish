const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const openai = require('../config/openai');
const Log = require('../models/Log');
const Lesson = require('../models/Lesson');
const TutorMemory = require('../models/TutorMemory');
const SpeakingAttempt = require('../models/SpeakingAttempt');

const VOICE_MODEL = 'gpt-4o-mini';
const SCORE_MIN = 1;
const SCORE_MAX = 10; // matches User.lastFluencyScore's existing 1-10 convention

const RELEVANT_LESSON_MAX_AGE_HOURS = 48; // "recently sent, not too old"
const MAX_ATTEMPTS_PER_PROMPT = 2;
const RETRY_SCORE_THRESHOLD = 6; // below this (of 10), offer a retry on the same prompt
const WEAK_AREA_MEMORY_CAP = 5;
const WEAK_AREA_CONTEXT_LIMIT = 5; // how many recent weak areas to feed back into the prompt

const ALLOWED_WEAK_AREAS = [
  'articles',
  'prepositions',
  'past_tense',
  'question_formation',
  'sentence_order',
  'verb_agreement',
  'vocabulary_range',
  'natural_expression'
];
const ALLOWED_WEAK_AREA_SET = new Set(ALLOWED_WEAK_AREAS);

// Create temp directory if it doesn't exist
const tempDir = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// ============================================================================
// PART 1: AUDIO DOWNLOAD + TRANSCRIPTION
// ============================================================================

/**
 * Download audio file from WhatsApp API
 * @param {string} mediaId - WhatsApp media ID
 * @returns {Promise<string>} - Local file path
 */
async function downloadWhatsAppAudio(mediaId) {
  try {
    console.log(`📥 Downloading audio for media ID: ${mediaId}`);

    // Step 1: Get media URL from WhatsApp API
    const mediaUrlResponse = await axios.get(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
        }
      }
    );

    const mediaUrl = mediaUrlResponse.data.url;
    // Media URLs are short-lived but still sensitive (bearer-token-adjacent) - never log them in full.

    // Step 2: Download the actual audio file
    const audioResponse = await axios({
      method: 'get',
      url: mediaUrl,
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
      }
    });

    // Step 3: Save to a unique temporary file
    const fileName = `audio_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.ogg`;
    const filePath = path.join(tempDir, fileName);
    fs.writeFileSync(filePath, audioResponse.data);

    console.log(`✅ Audio downloaded: ${fileName}`);
    return filePath;

  } catch (error) {
    console.error('❌ Error downloading WhatsApp audio:', error.message);
    throw new Error(`Failed to download audio: ${error.message}`);
  }
}

/**
 * Transcribe audio using OpenAI Whisper
 * @param {string} audioFilePath - Local path to audio file
 * @returns {Promise<string>} - Transcribed text
 */
async function transcribeAudio(audioFilePath) {
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFilePath),
      model: 'whisper-1'
    });

    console.log(`✅ Transcription complete (${transcription.text.length} chars)`);
    return transcription.text;

  } catch (error) {
    console.error('❌ Error transcribing audio:', error.message);
    throw new Error(`Failed to transcribe: ${error.message}`);
  }
}

/**
 * Clean up temporary audio file
 * @param {string} filePath - Path to file to delete
 */
function cleanupTempFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`🗑️ Cleaned up temp audio file`);
    }
  } catch (error) {
    console.error(`⚠️ Error cleaning up temp file:`, error.message);
  }
}

// ============================================================================
// PART 2: RELEVANT LESSON + SPEAKING PROMPT SELECTION
// (derived entirely from Lesson + SpeakingAttempt history - no new mutable
// user/lesson state field needed)
// ============================================================================

async function findRelevantLesson(user) {
  const cutoff = new Date(Date.now() - RELEVANT_LESSON_MAX_AGE_HOURS * 60 * 60 * 1000);
  return Lesson.findOne({
    userId: user._id,
    generatedAt: { $gte: cutoff }
  }).sort({ generatedAt: -1 });
}

/**
 * Determine which speaking prompt this voice attempt should be evaluated
 * against, and what attempt number it is, purely from prior SpeakingAttempt
 * history for this lesson:
 *   - No attempts yet -> prompt 1, attempt 1
 *   - Last attempt scored below the retry threshold and hasn't hit the cap
 *     -> same prompt, attemptNumber + 1
 *   - Otherwise -> next prompt, attempt 1 (or stay on the last prompt once
 *     all prompts are exhausted, so voice notes keep working indefinitely
 *     without needing new state)
 */
async function determineSpeakingPromptState(lessonId, prompts) {
  if (!lessonId || !prompts || !prompts.length) {
    return { promptIndex: null, promptText: null, attemptNumber: 1 };
  }

  const attempts = await SpeakingAttempt.find({ lessonId })
    .sort({ createdAt: 1 })
    .select('promptIndex scores.overall')
    .lean();

  if (attempts.length === 0) {
    return { promptIndex: 0, promptText: prompts[0], attemptNumber: 1 };
  }

  const lastAttempt = attempts[attempts.length - 1];
  const lastPromptIndex = lastAttempt.promptIndex ?? 0;
  const lastScore = lastAttempt.scores?.overall ?? 0;
  const attemptsOnLastPrompt = attempts.filter(a => a.promptIndex === lastPromptIndex).length;

  const shouldRetrySamePrompt = lastScore < RETRY_SCORE_THRESHOLD && attemptsOnLastPrompt < MAX_ATTEMPTS_PER_PROMPT;

  let promptIndex;
  let attemptNumber;

  if (shouldRetrySamePrompt) {
    promptIndex = lastPromptIndex;
    attemptNumber = attemptsOnLastPrompt + 1;
  } else {
    promptIndex = Math.min(lastPromptIndex + 1, prompts.length - 1);
    attemptNumber = promptIndex === lastPromptIndex ? attemptsOnLastPrompt + 1 : 1;
  }

  return { promptIndex, promptText: prompts[promptIndex], attemptNumber };
}

// ============================================================================
// PART 3: WEAK-AREA NORMALIZATION + BOUNDED MEMORY UPDATE
// ============================================================================

function normalizeWeakAreas(rawList) {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set();
  const normalized = [];
  for (const raw of rawList) {
    if (typeof raw !== 'string') continue;
    const key = raw.toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (ALLOWED_WEAK_AREA_SET.has(key) && !seen.has(key)) {
      seen.add(key);
      normalized.push(key);
    }
  }
  return normalized.slice(0, 2); // one attempt can contribute at most 2 labels
}

/**
 * Recency-based bounded update: a repeated weak area moves to the end
 * (reinforced/most-recent) rather than duplicating; the array is capped so
 * a single bad attempt (max 2 new labels) can never dominate the whole
 * bounded memory, and old, no-longer-relevant labels age out naturally.
 */
function updateWeakAreas(currentWeakAreas, newWeakAreas, maxLength = WEAK_AREA_MEMORY_CAP) {
  const updated = Array.isArray(currentWeakAreas) ? [...currentWeakAreas] : [];
  newWeakAreas.forEach(area => {
    const idx = updated.indexOf(area);
    if (idx !== -1) updated.splice(idx, 1);
    updated.push(area);
  });
  return updated.length > maxLength ? updated.slice(-maxLength) : updated;
}

// ============================================================================
// PART 4: CONTEXT-AWARE, TRUTHFUL EVALUATION (Whisper transcript -> GPT text
// evaluation only - never claims to judge pronunciation/accent/intonation,
// which cannot be assessed from a transcript)
// ============================================================================

const EVAL_SYSTEM_PROMPT = `You are an English speaking coach evaluating a transcribed spoken response.
Score ONLY what a text transcript can reveal: grammar accuracy, sentence formation, naturalness of phrasing, vocabulary use, and relevance to the prompt.
NEVER claim to evaluate pronunciation, accent, stress, or intonation - a transcript cannot show those.
Return ONLY valid JSON in this exact shape:
{
  "grammarScore": 1-10,
  "sentenceFormationScore": 1-10,
  "naturalnessScore": 1-10,
  "vocabularyScore": 1-10,
  "relevanceScore": 1-10,
  "overallScore": 1-10,
  "feedback": "one short, specific, constructive sentence",
  "correctedVersion": "a corrected, more natural version of their response",
  "retrySuggestion": "one concrete thing to try on a retry",
  "weakAreas": ["short_snake_case_label", "..."]
}
weakAreas: pick at most 2 from exactly these labels (only if genuinely relevant): ${ALLOWED_WEAK_AREAS.join(', ')}.`;

function buildEvaluationUserPrompt({ level, topicTitle, grammarFocus, promptText, transcript, weakAreas }) {
  return `Level: ${level || 'beginner'}
Topic: ${topicTitle || 'General speaking practice'}
Grammar focus: ${grammarFocus || 'General fluency'}
Speaking prompt given to student: ${promptText || 'Speak freely about anything in English.'}
Known weak areas to watch for (do not force if not relevant): ${weakAreas && weakAreas.length ? weakAreas.join(', ') : 'None yet'}

Student's transcribed spoken response: "${transcript}"`;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function validateEvaluationJson(evaluation) {
  const errors = [];
  if (!evaluation || typeof evaluation !== 'object') {
    return { valid: false, errors: ['evaluation is not an object'] };
  }

  const scoreFields = ['grammarScore', 'sentenceFormationScore', 'naturalnessScore', 'vocabularyScore', 'relevanceScore', 'overallScore'];
  scoreFields.forEach(field => {
    const value = evaluation[field];
    if (typeof value !== 'number' || Number.isNaN(value) || value < SCORE_MIN || value > SCORE_MAX) {
      errors.push(`${field} missing/out of range`);
    }
  });

  if (typeof evaluation.feedback !== 'string' || !evaluation.feedback.trim()) errors.push('feedback missing');
  if (typeof evaluation.correctedVersion !== 'string' || !evaluation.correctedVersion.trim()) errors.push('correctedVersion missing');
  if (typeof evaluation.retrySuggestion !== 'string' || !evaluation.retrySuggestion.trim()) errors.push('retrySuggestion missing');
  if (!Array.isArray(evaluation.weakAreas)) errors.push('weakAreas must be an array');

  return { valid: errors.length === 0, errors };
}

function buildFallbackEvaluation(transcript) {
  return {
    grammarScore: 5,
    sentenceFormationScore: 5,
    naturalnessScore: 5,
    vocabularyScore: 5,
    relevanceScore: 5,
    overallScore: 5,
    feedback: 'Thanks for practicing! Try answering in a few complete sentences.',
    correctedVersion: transcript || '',
    retrySuggestion: 'Speak a little slower and use complete sentences.',
    weakAreas: []
  };
}

/**
 * One Whisper transcription + one GPT evaluation call, with at most one
 * corrective retry if the evaluation JSON is malformed/invalid. No AI QA,
 * weak-area-extraction, or retry-decision calls are ever added.
 */
async function evaluateTranscript(context) {
  const userPrompt = buildEvaluationUserPrompt(context);
  const baseMessages = [
    { role: 'system', content: EVAL_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ];

  let response;
  try {
    response = await openai.chat.completions.create({
      model: VOICE_MODEL,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: baseMessages
    });
  } catch (apiError) {
    console.error('❌ Evaluation API call failed:', apiError.message);
    return { evaluation: buildFallbackEvaluation(context.transcript), validationStatus: 'fallback' };
  }

  let evaluation = safeParseJson(response.choices[0].message.content);
  let validation = validateEvaluationJson(evaluation);

  if (validation.valid) {
    return { evaluation, validationStatus: 'valid' };
  }

  console.error('⚠️ Evaluation JSON invalid, retrying once:', validation.errors.join('; '));

  try {
    const retryResponse = await openai.chat.completions.create({
      model: VOICE_MODEL,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        ...baseMessages,
        { role: 'assistant', content: response.choices[0].message.content },
        { role: 'user', content: `That was invalid: ${validation.errors.join('; ')}. Return corrected JSON only, matching the exact required structure.` }
      ]
    });

    const retryEvaluation = safeParseJson(retryResponse.choices[0].message.content);
    const retryValidation = validateEvaluationJson(retryEvaluation);

    if (retryValidation.valid) {
      return { evaluation: retryEvaluation, validationStatus: 'retried' };
    }
    console.error('❌ Evaluation still invalid after retry:', retryValidation.errors.join('; '));
  } catch (retryApiError) {
    console.error('❌ Evaluation retry API call failed:', retryApiError.message);
  }

  return { evaluation: buildFallbackEvaluation(context.transcript), validationStatus: 'fallback' };
}

// ============================================================================
// PART 5: CONCISE WHATSAPP FEEDBACK MESSAGE
// ============================================================================

function formatSpeakingFeedbackMessage({ evaluation, needsRetry, hasNextPrompt, nextPromptText }) {
  let nextStep;
  if (needsRetry) {
    nextStep = `🔁 Try again:\n${evaluation.retrySuggestion}`;
  } else if (hasNextPrompt) {
    nextStep = `➡️ Next prompt:\n${nextPromptText}`;
  } else {
    nextStep = `🔁 Keep practicing:\n${evaluation.retrySuggestion}`;
  }

  return `🎤 Speaking Feedback

Overall: ${evaluation.overallScore}/10

📝 Feedback:
${evaluation.feedback}

💬 More natural:
"${evaluation.correctedVersion}"

${nextStep}`;
}

// ============================================================================
// PART 6: MAIN PIPELINE
// ============================================================================

/**
 * Complete voice evaluation pipeline: download -> transcribe -> link to the
 * relevant lesson/prompt -> evaluate -> persist SpeakingAttempt -> update
 * TutorMemory weak areas -> build a concise WhatsApp reply.
 * @param {string} mediaId - WhatsApp media ID
 * @param {object} user - the User document (already loaded by the caller)
 */
async function processVoiceEvaluation(mediaId, user) {
  let audioFilePath = null;

  try {
    audioFilePath = await downloadWhatsAppAudio(mediaId);
    const transcript = await transcribeAudio(audioFilePath);

    await Log.create({
      type: 'VOICE_ATTEMPT_CREATED',
      userPhone: user.phone,
      message: 'Voice note received and transcribed',
      status: 'INFO'
    });

    const lesson = await findRelevantLesson(user);
    const prompts = (lesson && lesson.lessonJson && lesson.lessonJson.guidedSpeakingPrompts) || [];
    const { promptIndex, promptText, attemptNumber } = await determineSpeakingPromptState(
      lesson ? lesson._id : null,
      prompts
    );

    const tutorMemory = await TutorMemory.findOne({ userId: user._id });
    const weakAreaContext = (tutorMemory?.weakAreas || []).slice(-WEAK_AREA_CONTEXT_LIMIT);

    const { evaluation, validationStatus } = await evaluateTranscript({
      transcript,
      level: user.level,
      topicTitle: lesson ? lesson.topicTitle : null,
      grammarFocus: lesson ? lesson.grammarFocus : null,
      promptText,
      weakAreas: weakAreaContext
    });

    const normalizedWeakAreas = normalizeWeakAreas(evaluation.weakAreas);

    const attempt = await SpeakingAttempt.create({
      userId: user._id,
      lessonId: lesson ? lesson._id : null,
      day: user.currentDay,
      level: user.level,
      promptIndex,
      promptText,
      expectedGrammar: lesson ? lesson.grammarFocus : null,
      transcript,
      scores: {
        grammar: evaluation.grammarScore,
        sentenceFormation: evaluation.sentenceFormationScore,
        naturalness: evaluation.naturalnessScore,
        vocabulary: evaluation.vocabularyScore,
        relevance: evaluation.relevanceScore,
        overall: evaluation.overallScore
      },
      feedback: evaluation.feedback,
      correctedVersion: evaluation.correctedVersion,
      suggestedRetry: evaluation.retrySuggestion,
      weakAreas: normalizedWeakAreas,
      attemptNumber,
      validationStatus
    });

    if (tutorMemory && normalizedWeakAreas.length > 0) {
      tutorMemory.weakAreas = updateWeakAreas(tutorMemory.weakAreas, normalizedWeakAreas);
      await tutorMemory.save();
    }

    // Lazy require: retentionService -> assessmentService -> this module, so a
    // top-level require here would create a circular dependency at load time.
    const { recordLearnerEvent, recordDayActiveMilestones } = require('./retentionService');
    await recordLearnerEvent(user._id, 'FIRST_VOICE_ATTEMPT');
    await recordDayActiveMilestones(user);

    await Log.create({
      type: 'VOICE_ATTEMPT_EVALUATED',
      userPhone: user.phone,
      message: `Voice attempt evaluated - overall ${evaluation.overallScore}/10`,
      status: 'SUCCESS',
      metadata: {
        attemptId: attempt._id.toString(),
        lessonId: lesson ? lesson._id.toString() : null,
        promptIndex,
        attemptNumber,
        validationStatus
      }
    });

    const totalPrompts = prompts.length;
    const needsRetry = promptIndex !== null
      && evaluation.overallScore < RETRY_SCORE_THRESHOLD
      && attemptNumber < MAX_ATTEMPTS_PER_PROMPT;
    const hasNextPrompt = promptIndex !== null && !needsRetry && promptIndex < totalPrompts - 1;

    const messageText = formatSpeakingFeedbackMessage({
      evaluation,
      needsRetry,
      hasNextPrompt,
      nextPromptText: hasNextPrompt ? prompts[promptIndex + 1] : null
    });

    return {
      success: true,
      transcript,
      evaluation,
      overallScore: evaluation.overallScore,
      messageText,
      attemptId: attempt._id
    };

  } catch (error) {
    console.error(`❌ Voice evaluation failed for ${user.phone}:`, error.message);

    await Log.create({
      type: 'VOICE_ATTEMPT_FAILED',
      userPhone: user.phone,
      message: `Voice evaluation failed: ${error.message}`,
      status: 'ERROR'
    });

    throw error;

  } finally {
    if (audioFilePath) {
      cleanupTempFile(audioFilePath);
    }
  }
}

module.exports = {
  processVoiceEvaluation,
  downloadWhatsAppAudio,
  transcribeAudio,
  cleanupTempFile,
  findRelevantLesson,
  determineSpeakingPromptState,
  normalizeWeakAreas,
  updateWeakAreas,
  evaluateTranscript,
  validateEvaluationJson,
  formatSpeakingFeedbackMessage,
  ALLOWED_WEAK_AREAS
};
