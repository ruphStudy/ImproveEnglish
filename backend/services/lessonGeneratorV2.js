const openai = require('../config/openai');
const Log = require('../models/Log');

// ============================================================================
// PART 1: SYSTEM PROMPT (AI Tutor Brain) - CONSTANT
// ============================================================================

const SYSTEM_PROMPT = `
You are a professional English language tutor creating natural, realistic, progressive lessons for WhatsApp delivery.

CRITICAL RULES:

1. NATURAL DIALOGUE ONLY:
   - Write conversations as real people actually speak
   - NO textbook-style exchanges like "Hi! How are you? I am fine."
   - NO generic greetings unless scenario requires them
   - Use contractions, natural pauses, realistic flow
   - Make dialogue situation-specific from the first line

2. SCENARIO SPECIFICITY:
   - Every scenario must have concrete details (names of places, specific items, real situations)
   - NO vague contexts like "at a place" or "talking about something"
   - Make it feel like a real conversation between real people

3. CONVERSATION FORMAT:
   - MUST start with exactly: "🔊 Speak this conversation aloud slowly and clearly."
   - Then provide the dialogue (120-170 words total including instruction)
   - Use realistic speaker labels (e.g., "Customer:", "Barista:", "Manager:", "Friend:")

4. GRAMMAR EXPLANATION:
   - Focus on PATTERNS, not summaries
   - Show the grammar structure being used
   - Explain WHY it works in this context
   - Give 2-3 short example sentences demonstrating the pattern
   - Keep it 80-120 words

5. ANTI-REPETITION:
   - Follow provided topic and grammar focus exactly
   - NEVER repeat previous topics or grammar patterns
   - Avoid recently used vocabulary
   - Each lesson must feel completely fresh

6. VOCABULARY:
   - Choose useful, slightly challenging words (not basic everyday words)
   - Each word must fit the scenario naturally
   - Examples must be relevant to the lesson context

7. TONE:
   - Match difficulty level (beginner = simpler, advanced = sophisticated)
   - Use student's name sparingly (max 2 times in entire lesson)
   - Keep it encouraging but professional

8. OUTPUT:
   - Return ONLY valid JSON
   - No commentary outside the JSON structure

MANDATORY JSON FORMAT:

{
  "title": "...",
  "scenarioType": "...",
  "conversation": "🔊 Speak this conversation aloud slowly and clearly.\n\n[realistic dialogue 120-170 words]",
  "explanation": "[pattern-focused grammar explanation 80-120 words]",
  "guidedSpeakingPrompts": ["prompt1", "prompt2", "prompt3", "prompt4", "prompt5"],
  "newVocabulary": [
    {"word":"...", "meaning":"...", "example":"..."},
    {"word":"...", "meaning":"...", "example":"..."},
    {"word":"...", "meaning":"...", "example":"..."},
    {"word":"...", "meaning":"...", "example":"..."},
    {"word":"...", "meaning":"...", "example":"..."}
  ],
  "microPractice": {
    "q1": "...",
    "q2": "...",
    "q3": "...",
    "expectedStructure": "..."
  },
  "confidenceLine": "..."
}

Return ONLY the JSON. No other text.
`;

// ============================================================================
// PART 2: USER PROMPT BUILDER (Dynamic Per User)
// ============================================================================

function buildUserPrompt(user, topic, tutorMemory, scenarioType) {
  const recentTopics = tutorMemory.recentTopicDays.length > 0
    ? tutorMemory.recentTopicDays.join(', ')
    : 'None';
  
  const recentGrammar = tutorMemory.recentGrammarKeys.length > 0
    ? tutorMemory.recentGrammarKeys.join(', ')
    : 'None';
  
  const recentVocab = tutorMemory.vocabBank.length > 0
    ? tutorMemory.vocabBank.slice(-30).map(v => v.word).join(', ')
    : 'None';
  
  const weakAreas = tutorMemory.weakAreas.length > 0
    ? tutorMemory.weakAreas.join(', ')
    : 'None identified yet';

  return `
CREATE A NATURAL, REALISTIC ENGLISH LESSON:

Student: ${user.name}
Level: ${user.level}
Day: ${user.currentDay}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TODAY'S LESSON FOCUS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Topic: ${topic.title}
Grammar: ${topic.grammarFocus}
Difficulty: ${topic.difficultyTag}
Scenario Type: ${scenarioType}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANTI-REPETITION CONSTRAINTS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⛔ DO NOT reuse these recent topics:
${recentTopics}

⛔ DO NOT repeat these grammar patterns:
${recentGrammar}

⛔ AVOID these recently taught vocabulary words:
${recentVocab}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STUDENT WEAK AREAS (gentle reinforcement):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${weakAreas}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL REQUIREMENTS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. START conversation field with: "🔊 Speak this conversation aloud slowly and clearly."

2. Create a SPECIFIC realistic scenario with concrete details:
   - Use real place names or realistic business names
   - Include specific items, times, or situations
   - Make speakers feel like real people with natural speech patterns

3. Write dialogue as people ACTUALLY speak:
   - Use contractions (I'm, don't, can't, we'll)
   - Include natural hesitations or responses ("Hmm", "Let me see", "Sure thing")
   - NO robotic textbook exchanges
   - Jump into the situation immediately (no generic "hello how are you")

4. Grammar explanation must show PATTERNS:
   - Identify the structure being used
   - Explain the pattern clearly
   - Give 2-3 example sentences showing the pattern

5. Make this lesson completely UNIQUE and FRESH:
   - Different from all previous ${user.currentDay - 1} days
   - New vocabulary not in recent lessons
   - Unique practical situation

6. Keep it practical and immediately useful for real-world English.

Generate the complete lesson in valid JSON format now.
  `.trim();
}

// ============================================================================
// PART 3: SCENARIO TYPE ROTATION
// ============================================================================

const SCENARIO_TYPES = [
  'workplace',
  'social',
  'shopping',
  'travel',
  'dining',
  'healthcare',
  'education',
  'technology'
];

function getScenarioType(day) {
  return SCENARIO_TYPES[day % SCENARIO_TYPES.length];
}

// ============================================================================
// PART 4: WHATSAPP FORMATTER
// ============================================================================

function formatLessonForWhatsApp(lessonJson, dayNumber) {
  const vocabText = lessonJson.newVocabulary
    .map(v => `• ${v.word} – ${v.meaning}\n  Example: ${v.example}`)
    .join('\n\n');

  const speakingText = lessonJson.guidedSpeakingPrompts
    .map((p, i) => `${i + 1}. ${p}`)
    .join('\n');

  return `
📘 Day ${dayNumber}: ${lessonJson.title}

🎭 Scenario: ${lessonJson.scenarioType}

🗣 Conversation:
${lessonJson.conversation}

📖 Explanation:
${lessonJson.explanation}

🎯 Speaking Practice:
${speakingText}

🧠 New Vocabulary:
${vocabText}

✍ Micro Practice:
1) ${lessonJson.microPractice.q1}
2) ${lessonJson.microPractice.q2}
3) ${lessonJson.microPractice.q3}

Expected Structure:
${lessonJson.microPractice.expectedStructure}

💪 ${lessonJson.confidenceLine}
  `.trim();
}

// ============================================================================
// PART 5: FALLBACK LESSON GENERATOR
// ============================================================================

function generateFallbackLesson(user, topic) {
  console.log(`🛡️ Generating fallback lesson for ${user.name} - Day ${user.currentDay}`);
  
  const fallbackJson = {
    title: topic.title || `Day ${user.currentDay} Lesson`,
    scenarioType: 'general',
    conversation: `Example conversation about ${topic.title}.\n\nPerson A: Hello! Can you help me?\nPerson B: Of course! What do you need?\nPerson A: I'd like to learn more about this topic.\nPerson B: Great! Let me explain it to you.`,
    explanation: `This lesson focuses on ${topic.grammarFocus}. Practice using these structures in your daily conversations to improve your fluency.`,
    guidedSpeakingPrompts: [
      'Introduce yourself',
      'Ask a simple question',
      'Describe your daily routine',
      'Talk about your hobbies',
      'Share your opinion on something'
    ],
    newVocabulary: [
      { word: 'practice', meaning: 'to do something repeatedly to improve', example: 'I practice English every day.' },
      { word: 'improve', meaning: 'to become better', example: 'My speaking skills improve daily.' },
      { word: 'learn', meaning: 'to gain knowledge', example: 'I learn new words each lesson.' },
      { word: 'conversation', meaning: 'a talk between people', example: 'We had a conversation about travel.' },
      { word: 'fluent', meaning: 'able to speak smoothly', example: 'She is fluent in three languages.' }
    ],
    microPractice: {
      q1: 'Write a sentence using present tense',
      q2: 'Describe what you did yesterday',
      q3: 'Ask a question about the future',
      expectedStructure: 'Use complete sentences with proper grammar'
    },
    confidenceLine: 'Keep practicing! Every lesson makes you stronger! 💪'
  };

  return {
    lessonJson: fallbackJson,
    lessonText: formatLessonForWhatsApp(fallbackJson, user.currentDay),
    vocabList: fallbackJson.newVocabulary,
    scenarioType: 'general'
  };
}

// ============================================================================
// PART 6: MAIN LESSON GENERATOR WITH RETRY LOGIC
// ============================================================================

async function generateLesson(user, topic, tutorMemory) {
  try {
    const scenarioType = getScenarioType(user.currentDay);
    const userPrompt = buildUserPrompt(user, topic, tutorMemory, scenarioType);

    console.log(`🎓 Generating structured lesson for ${user.name} - Day ${user.currentDay}`);
    console.log(`   Topic: ${topic.title}`);
    console.log(`   Grammar: ${topic.grammarFocus}`);
    console.log(`   Scenario: ${scenarioType}`);

    // First attempt
    let response;
    try {
      response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.7,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ]
      });
    } catch (apiError) {
      console.error('❌ OpenAI API call failed:', apiError.message);
      
      await Log.create({
        type: 'LESSON_GENERATION_ERROR',
        userPhone: user.phone,
        message: `OpenAI API error: ${apiError.message}`,
        status: 'ERROR',
        metadata: {
          day: user.currentDay,
          topic: topic.title,
          error: apiError.message
        }
      });

      // Return fallback
      return generateFallbackLesson(user, topic);
    }

    let lessonJson;
    try {
      lessonJson = JSON.parse(response.choices[0].message.content);
      
      // Validate required fields
      if (!lessonJson.title || !lessonJson.conversation || !lessonJson.newVocabulary) {
        throw new Error('Missing required fields in JSON');
      }
      
      console.log('✅ Valid JSON lesson generated');
      
    } catch (parseError) {
      console.error('⚠️ JSON parse error on first attempt:', parseError.message);
      
      // RETRY ONCE with explicit fix request
      console.log('🔄 Retrying with JSON fix request...');
      
      try {
        const retryResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0.5,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: response.choices[0].message.content },
            { role: 'user', content: 'The JSON you provided is invalid. Please fix it and return ONLY valid JSON matching the exact structure required.' }
          ]
        });
        
        lessonJson = JSON.parse(retryResponse.choices[0].message.content);
        
        if (!lessonJson.title || !lessonJson.conversation || !lessonJson.newVocabulary) {
          throw new Error('Missing required fields after retry');
        }
        
        console.log('✅ Valid JSON after retry');
        
      } catch (retryError) {
        console.error('❌ JSON still invalid after retry:', retryError.message);
        
        await Log.create({
          type: 'LESSON_GENERATION_FALLBACK',
          userPhone: user.phone,
          message: 'Used fallback lesson after JSON validation failures',
          status: 'WARNING',
          metadata: {
            day: user.currentDay,
            topic: topic.title,
            error: retryError.message
          }
        });
        
        // Return fallback
        return generateFallbackLesson(user, topic);
      }
    }

    // Format for WhatsApp
    const lessonText = formatLessonForWhatsApp(lessonJson, user.currentDay);

    await Log.create({
      type: 'LESSON_GENERATED',
      userPhone: user.phone,
      message: `Structured lesson generated for Day ${user.currentDay}`,
      status: 'SUCCESS',
      metadata: {
        day: user.currentDay,
        topic: topic.title,
        vocabCount: lessonJson.newVocabulary.length
      }
    });

    return {
      lessonJson,
      lessonText,
      vocabList: lessonJson.newVocabulary,
      scenarioType
    };

  } catch (error) {
    console.error('❌ Unexpected error in generateLesson:', error);
    
    await Log.create({
      type: 'LESSON_GENERATION_ERROR',
      userPhone: user.phone,
      message: `Unexpected error: ${error.message}`,
      status: 'ERROR',
      metadata: {
        day: user.currentDay,
        error: error.stack
      }
    });
    
    // Final fallback
    return generateFallbackLesson(user, topic);
  }
}

module.exports = {
  generateLesson,
  formatLessonForWhatsApp,
  generateFallbackLesson
};
