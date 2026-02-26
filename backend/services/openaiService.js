const openai = require('../config/openai');

/**
 * Generate English lesson with OpenAI
 * Using structured prompts and parameters from Make.com setup
 * 
 * @param {Number} currentDay - Day number for lesson progression
 * @param {String} name - Student name (used to personalize the lesson)
 * @returns {String} Generated lesson text
 */
async function generateLesson(currentDay, name) {
  
  // System prompt - Defines AI's role and behavior
  const systemPrompt = `You are an English speaking coach for beginners in India.

Your job is to create structured, practical, and attractive daily English lessons.

CRITICAL RULES:

- NEVER repeat a topic used in previous days.

- Always create a completely NEW topic.

- Topic must be unique for each day.

- Do not reuse similar themes like restaurant ordering if already used.

- If Day number increases, topic complexity must increase gradually.

- Avoid repeating situations (restaurant, hotel, shopping etc.) unless specifically told.



Formatting Rules:
- Always follow the exact format requested.
- Never skip any section.
- Keep total lesson under 350 words.
- If lesson becomes long, shorten dialogue but keep all 5 parts.
- Use simple vocabulary.
- Keep sentences short and clear.
- Plain text only.
- No extra empty lines.
- Maximum 1 emoji in entire lesson.
- Do not add explanations outside the required format.`;

  // User prompt - Specific instructions for this lesson
  const userPrompt = `Create an English speaking lesson for Day ${currentDay} for a student named ${name}.

Choose a practical daily-life topic suitable for beginners.

The topic difficulty should increase slowly as the day number increases.

Follow this exact structure:

Day ${currentDay}: [Topic Title]

PART 1: Read Aloud
Write a short 4–5 line conversation where one person is named ${name}.
Make ${name} an active participant in the conversation.

PART 2: Understand the Meaning
Explain each dialogue line in one short simple sentence.

PART 3: Speak in Your Own Words
Give one short speaking practice instruction directly addressing ${name}.

PART 4: 5 Simple Sentences
Write 5 short daily-use sentences related to the topic.
Use ${name} as the subject in at least 2-3 sentences to make it personal.
Number them 1 to 5.

PART 5: Confidence Line
Write one short motivating sentence directly encouraging ${name}.

Important:
- Use ${name}'s name naturally throughout the lesson to make it feel personal.
- Keep total length under 350 words.
- Keep formatting clean.
- Do not use extra blank lines.
- Keep it attractive and beginner-friendly.
If you cannot fit full lesson within 350 words, reduce dialogue length but do not remove any part.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 900,        // Maximum output length
      temperature: 0.3,       // Lower = more focused/consistent (0-2)
      top_p: 1               // Nucleus sampling (0-1)
    });
    
    return response.choices[0].message.content.trim();
    
  } catch (error) {
    console.error('OpenAI API Error:', error.message);
    throw new Error(`Failed to generate lesson: ${error.message}`);
  }
}

module.exports = { generateLesson };
