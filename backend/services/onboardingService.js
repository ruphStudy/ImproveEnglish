const Log = require('../models/Log');
const LearnerAssessment = require('../models/LearnerAssessment');
const { ASSESSMENT_QUESTIONS } = LearnerAssessment;
const TutorMemory = require('../models/TutorMemory');
const {
  getNextAssessmentStep,
  getStepNumber,
  recordTextAnswer,
  recordVoiceAnswer,
  runAssessmentEvaluation,
  buildOnboardingCompletionMessage
} = require('./assessmentService');

// ============================================================================
// GOAL SELECTION - deterministic, no AI call for onboarding navigation
// ============================================================================

const GOAL_OPTIONS = [
  { key: 'daily_english', number: 1, aliases: ['daily', 'daily english', 'general', 'general english'] },
  { key: 'workplace', number: 2, aliases: ['workplace', 'work', 'office', 'workplace english'] },
  { key: 'interview', number: 3, aliases: ['interview', 'interview english'] },
  { key: 'college_placement', number: 4, aliases: ['placement', 'college', 'college placement', 'college/placement'] },
  { key: 'customer_service', number: 5, aliases: ['customer service', 'customer', 'support'] },
  { key: 'sales', number: 6, aliases: ['sales', 'sales english'] },
  { key: 'travel', number: 7, aliases: ['travel', 'travel english'] }
];

function normalizeGoalInput(rawText) {
  if (!rawText) return null;
  const cleaned = String(rawText).trim().toLowerCase();

  const asNumber = parseInt(cleaned, 10);
  if (!Number.isNaN(asNumber) && String(asNumber) === cleaned) {
    const byNumber = GOAL_OPTIONS.find(g => g.number === asNumber);
    if (byNumber) return byNumber.key;
  }

  const byAlias = GOAL_OPTIONS.find(g => g.key === cleaned || g.aliases.includes(cleaned));
  return byAlias ? byAlias.key : null;
}

function buildGoalSelectionMessage() {
  return `Welcome to FluencyLoop 👋

What do you mainly want to improve?

1. Daily English
2. Workplace English
3. Interview English
4. College / Placement
5. Customer Service
6. Sales English
7. Travel English

Reply with 1-7.`;
}

// ============================================================================
// GOAL-BIASED SCENARIO FAMILIES (deterministic - reused by lessonGeneratorV2)
// ============================================================================

const GOAL_SCENARIO_BIAS = {
  daily_english: ['social', 'shopping', 'dining', 'healthcare', 'everyday'],
  workplace: ['meetings', 'email', 'teamwork', 'manager', 'client'],
  interview: ['introduction', 'projects', 'strengths', 'problem_solving', 'experience'],
  college_placement: ['introduction', 'group_discussion', 'campus', 'placement_interview', 'presentation'],
  customer_service: ['greeting', 'complaint', 'explanation', 'resolution', 'follow_up'],
  sales: ['discovery', 'pitch', 'objection', 'negotiation', 'follow_up'],
  travel: ['airport', 'hotel', 'transport', 'restaurant', 'directions']
};

const GOAL_CONTEXT_LABELS = {
  daily_english: 'general everyday life',
  workplace: 'workplace / professional context',
  interview: 'job interview preparation',
  college_placement: 'college placement / campus interview preparation',
  customer_service: 'customer service interactions',
  sales: 'sales conversations',
  travel: 'travel situations'
};

function getScenarioFamily(learningGoal) {
  return GOAL_SCENARIO_BIAS[learningGoal] || GOAL_SCENARIO_BIAS.daily_english;
}

function getGoalContextLabel(learningGoal) {
  return GOAL_CONTEXT_LABELS[learningGoal] || GOAL_CONTEXT_LABELS.daily_english;
}

// ============================================================================
// ONBOARDING DISPATCH - called from webhookController when user.state === 'NEW'
// ============================================================================

function needsOnboarding(user) {
  return user.state === 'NEW' && user.onboardingStatus !== 'COMPLETED';
}

function formatQuestionPrompt(question, stepNumber) {
  return `Question ${stepNumber}/${ASSESSMENT_QUESTIONS.length}:\n${question.question}`;
}

async function handleGoalSelection(user, rawText) {
  const goal = normalizeGoalInput(rawText);

  if (!goal) {
    return { messageText: `Sorry, I didn't quite get that.\n\n${buildGoalSelectionMessage()}` };
  }

  user.learningGoal = goal;
  user.onboardingStatus = 'PENDING_ASSESSMENT';
  await user.save();

  await Log.create({
    type: 'ONBOARDING_GOAL_SELECTED',
    userPhone: user.phone,
    message: `Goal selected: ${goal}`,
    status: 'SUCCESS'
  });

  await LearnerAssessment.create({ userId: user._id, status: 'in_progress' });

  return {
    messageText: `Great! Let's do a quick 5-7 minute check so we can personalize your lessons.\n\n${formatQuestionPrompt(ASSESSMENT_QUESTIONS[0], 1)}`
  };
}

async function finalizeAssessment(user, assessment) {
  let evaluation;
  try {
    evaluation = await runAssessmentEvaluation(assessment);
  } catch (err) {
    console.error('❌ Assessment evaluation crashed, using safe default:', err.message);
    evaluation = {
      scores: { grammar: 5, sentenceFormation: 5, vocabulary: 5, naturalness: 5, comprehension: 5, overall: 5 },
      strengths: [],
      weakAreas: [],
      summary: '',
      recommendedLevel: 'beginner',
      validationStatus: 'fallback'
    };
  }

  assessment.scores = evaluation.scores;
  assessment.strengths = evaluation.strengths;
  assessment.weakAreas = evaluation.weakAreas;
  assessment.summary = evaluation.summary;
  assessment.recommendedLevel = evaluation.recommendedLevel;
  assessment.validationStatus = evaluation.validationStatus;
  assessment.status = 'completed';
  assessment.completedAt = new Date();
  await assessment.save();

  // Business rule: `level` is tied to what was purchased (PlanMaster prices
  // differ per level) - never silently switched. Store the recommendation
  // separately; the completion message discloses any mismatch honestly.
  user.assessedLevel = evaluation.recommendedLevel;
  user.onboardingStatus = 'COMPLETED';
  user.state = 'READY';
  await user.save();

  if (evaluation.weakAreas.length > 0) {
    const tutorMemory = await TutorMemory.findOne({ userId: user._id });
    // Only seed a genuinely empty memory - never overwrite existing weak areas.
    if (tutorMemory && tutorMemory.weakAreas.length === 0) {
      tutorMemory.weakAreas = evaluation.weakAreas;
      await tutorMemory.save();
    }
  }

  await Log.create({
    type: 'ONBOARDING_COMPLETED',
    userPhone: user.phone,
    message: `Onboarding completed - recommended level ${evaluation.recommendedLevel}`,
    status: 'SUCCESS',
    metadata: {
      goal: user.learningGoal,
      purchasedLevel: user.level,
      recommendedLevel: evaluation.recommendedLevel,
      validationStatus: evaluation.validationStatus
    }
  });

  const { recordLearnerEvent } = require('./retentionService');
  await recordLearnerEvent(user._id, 'ONBOARDING_COMPLETED', {
    metadata: { goal: user.learningGoal, recommendedLevel: evaluation.recommendedLevel }
  });

  return {
    messageText: buildOnboardingCompletionMessage({
      learningGoal: user.learningGoal,
      level: user.level,
      recommendedLevel: evaluation.recommendedLevel,
      strengths: evaluation.strengths,
      weakAreas: evaluation.weakAreas
    })
  };
}

async function handleAssessmentStep(user, msg, rawText) {
  let assessment = await LearnerAssessment.findOne({ userId: user._id, status: 'in_progress' }).sort({ startedAt: -1 });

  if (!assessment) {
    // Resume safety net - shouldn't normally happen, but recreate rather than strand the user.
    assessment = await LearnerAssessment.create({ userId: user._id, status: 'in_progress' });
  }

  const currentStep = getNextAssessmentStep(assessment);

  if (!currentStep) {
    // All 4 already answered (e.g. a stray extra message slipped through) - finalize defensively.
    return finalizeAssessment(user, assessment);
  }

  const isVoiceMessage = msg.type === 'audio';
  const isTextMessage = !isVoiceMessage && !!(rawText && rawText.trim());

  if (currentStep.type === 'voice' && !isVoiceMessage) {
    return { messageText: `This step needs a short voice note 🎤\n\n${formatQuestionPrompt(currentStep, getStepNumber(assessment))}` };
  }
  if (currentStep.type === 'text' && !isTextMessage) {
    return { messageText: `This step needs a text reply ✍️\n\n${formatQuestionPrompt(currentStep, getStepNumber(assessment))}` };
  }

  try {
    if (currentStep.type === 'text') {
      await recordTextAnswer(assessment, currentStep, rawText);
    } else {
      await recordVoiceAnswer(assessment, currentStep, msg.audio.id);
    }
  } catch (err) {
    console.error('❌ Onboarding assessment answer failed:', err.message);
    await Log.create({
      type: 'ONBOARDING_ASSESSMENT_FAILED',
      userPhone: user.phone,
      message: `Failed to record ${currentStep.questionId}: ${err.message}`,
      status: 'ERROR'
    });
    return { messageText: `Sorry, I couldn't process that. Please try sending it again.\n\n${formatQuestionPrompt(currentStep, getStepNumber(assessment))}` };
  }

  await Log.create({
    type: 'ONBOARDING_ASSESSMENT_STEP',
    userPhone: user.phone,
    message: `Answered ${currentStep.questionId}`,
    status: 'SUCCESS'
  });

  const nextStep = getNextAssessmentStep(assessment);
  if (nextStep) {
    return { messageText: formatQuestionPrompt(nextStep, getStepNumber(assessment)) };
  }

  return finalizeAssessment(user, assessment);
}

/**
 * Main entry point. Called from webhookController when the user is mid-onboarding
 * (user.state === 'NEW'), for any message type EXCEPT commands that must always
 * work regardless of onboarding (UPGRADE is handled by the caller before this).
 */
async function handleOnboardingMessage(user, msg, rawText) {
  if (user.onboardingStatus === 'PENDING_GOAL' || !user.onboardingStatus) {
    return handleGoalSelection(user, rawText);
  }
  if (user.onboardingStatus === 'PENDING_ASSESSMENT') {
    return handleAssessmentStep(user, msg, rawText);
  }
  // Defensive: state is NEW but onboarding already reads as COMPLETED - unblock the user.
  user.state = 'READY';
  await user.save();
  return { messageText: 'Setup already complete! Reply START to begin your first lesson.' };
}

module.exports = {
  needsOnboarding,
  handleOnboardingMessage,
  normalizeGoalInput,
  buildGoalSelectionMessage,
  getScenarioFamily,
  getGoalContextLabel,
  GOAL_OPTIONS,
  GOAL_SCENARIO_BIAS
};
