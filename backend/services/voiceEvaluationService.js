const axios = require('axios');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const Log = require('../models/Log');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Create temp directory if it doesn't exist
const tempDir = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

/**
 * Download audio file from WhatsApp API
 * @param {string} mediaId - WhatsApp media ID
 * @returns {Promise<string>} - Local file path
 */
async function downloadWhatsAppAudio(mediaId) {
  try {
    console.log(`📥 Downloading audio with media ID: ${mediaId}`);
    
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
    console.log(`🔗 Media URL retrieved: ${mediaUrl}`);
    
    // Step 2: Download the actual audio file
    const audioResponse = await axios({
      method: 'get',
      url: mediaUrl,
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
      }
    });
    
    // Step 3: Save to temporary file
    const fileName = `audio_${Date.now()}.ogg`;
    const filePath = path.join(tempDir, fileName);
    fs.writeFileSync(filePath, audioResponse.data);
    
    console.log(`✅ Audio downloaded to: ${filePath}`);
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
    console.log(`🎤 Transcribing audio file: ${audioFilePath}`);
    
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFilePath),
      model: 'whisper-1'
    });
    
    console.log(`✅ Transcription complete: "${transcription.text}"`);
    return transcription.text;
    
  } catch (error) {
    console.error('❌ Error transcribing audio:', error.message);
    throw new Error(`Failed to transcribe: ${error.message}`);
  }
}

/**
 * Evaluate English fluency using GPT-4
 * @param {string} transcript - Transcribed text
 * @returns {Promise<Object>} - Evaluation results
 */
async function evaluateFluency(transcript) {
  try {
    console.log(`🧠 Evaluating fluency for transcript: "${transcript}"`);
    
    const prompt = `You are an English language teacher evaluating a student's spoken English.

Here is the transcript of what the student said:
"${transcript}"

Please evaluate and provide:
1. Fluency Score (1-10): How smoothly and naturally they speak
2. Grammar Score (1-10): Grammatical correctness
3. Pronunciation Feedback: Brief feedback on pronunciation issues (if any)
4. Corrected Version: The properly corrected sentence(s)

Return ONLY a JSON object with this exact format:
{
  "fluencyScore": <number 1-10>,
  "grammarScore": <number 1-10>,
  "pronunciationFeedback": "<brief feedback>",
  "correctedVersion": "<corrected text>"
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an English language evaluation expert. Always respond with valid JSON only.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });
    
    const evaluation = JSON.parse(response.choices[0].message.content);
    console.log(`✅ Evaluation complete:`, evaluation);
    
    return {
      fluencyScore: evaluation.fluencyScore || 5,
      grammarScore: evaluation.grammarScore || 5,
      pronunciationFeedback: evaluation.pronunciationFeedback || 'Good effort!',
      correctedVersion: evaluation.correctedVersion || transcript
    };
    
  } catch (error) {
    console.error('❌ Error evaluating fluency:', error.message);
    throw new Error(`Failed to evaluate: ${error.message}`);
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
      console.log(`🗑️ Cleaned up temp file: ${filePath}`);
    }
  } catch (error) {
    console.error(`⚠️ Error cleaning up file ${filePath}:`, error.message);
  }
}

/**
 * Complete voice evaluation pipeline
 * @param {string} mediaId - WhatsApp media ID
 * @param {string} phone - User phone number
 * @returns {Promise<Object>} - Complete evaluation result
 */
async function processVoiceEvaluation(mediaId, phone) {
  let audioFilePath = null;
  
  try {
    console.log(`🎯 Starting voice evaluation for phone: ${phone}`);
    
    // Step 1: Download audio
    audioFilePath = await downloadWhatsAppAudio(mediaId);
    
    // Step 2: Transcribe with Whisper
    const transcript = await transcribeAudio(audioFilePath);
    
    // Step 3: Evaluate with GPT-4
    const evaluation = await evaluateFluency(transcript);
    
    // Log success
    await Log.create({
      type: 'VOICE_EVALUATION_SUCCESS',
      userPhone: phone,
      message: `Voice evaluated. Fluency: ${evaluation.fluencyScore}/10, Grammar: ${evaluation.grammarScore}/10`,
      status: 'SUCCESS',
      timestamp: new Date(),
      metadata: {
        transcript,
        ...evaluation
      }
    });
    
    return {
      success: true,
      transcript,
      ...evaluation
    };
    
  } catch (error) {
    console.error(`❌ Voice evaluation failed for ${phone}:`, error.message);
    
    // Log failure
    await Log.create({
      type: 'VOICE_EVALUATION_ERROR',
      userPhone: phone,
      message: `Voice evaluation failed: ${error.message}`,
      status: 'ERROR',
      timestamp: new Date()
    });
    
    throw error;
    
  } finally {
    // Cleanup temp file
    if (audioFilePath) {
      cleanupTempFile(audioFilePath);
    }
  }
}

module.exports = {
  processVoiceEvaluation,
  downloadWhatsAppAudio,
  transcribeAudio,
  evaluateFluency
};
