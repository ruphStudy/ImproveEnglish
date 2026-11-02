const whatsappApi = require('../config/whatsapp');
const Log = require('../models/Log');

async function sendWhatsAppMessage(phone, message) {
  try {
    const data = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body: message }
    };
    await whatsappApi.post('/messages', data);
    await Log.create({ type: 'MESSAGE_SENT', phone, message });
  } catch (err) {
    await Log.create({ type: 'ERROR', phone, message: err.message });
    throw err;
  }
}

/**
 * Template messages are business-initiated, so learners who replied STOP /
 * STOP ALL / UNSUBSCRIBE (User.whatsappOptOut) never receive one - this guard is
 * the backstop behind the schedulers' own query filters. Only a direct response
 * to the learner's own action may pass { allowOptedOut: true } (e.g. confirming a
 * payment they just made, or the streak milestone right after their DONE).
 * Throws an error with code WHATSAPP_OPTED_OUT so callers record it as not sent.
 */
async function assertNotOptedOut(phone, template) {
  const User = require('../models/User'); // lazy: avoids a model <-> service load cycle
  if (await User.exists({ phone, whatsappOptOut: true })) {
    const err = new Error(`Learner opted out of proactive WhatsApp messages - ${template} not sent`);
    err.code = 'WHATSAPP_OPTED_OUT';
    throw err;
  }
}

async function sendTemplateMessage(phone, template, params = [], languageCode = 'en_US', { allowOptedOut = false } = {}) {
  if (!allowOptedOut) await assertNotOptedOut(phone, template);
  try {
    console.log('📤 === WHATSAPP TEMPLATE MESSAGE ===');
    console.log('   Phone:', phone);
    console.log('   Template:', template);
    console.log('   Params:', params);
    console.log('   Language Code:', languageCode);
    
    const data = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: template,
        language: { code: languageCode }
      }
    };
    
    // Only add components if there are parameters
    if (params && params.length > 0) {
      data.template.components = [
        {
          type: 'body',
          parameters: params.map(text => ({ type: 'text', text }))
        }
      ];
    }
    
    console.log('📤 WhatsApp API Request:', JSON.stringify(data, null, 2));
    console.log('📤 API Endpoint:', `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`);
    
    const response = await whatsappApi.post('/messages', data);
    
    console.log('✅ WhatsApp API Response:', JSON.stringify(response.data, null, 2));
    
    await Log.create({ type: 'MESSAGE_SENT', phone, message: `[TEMPLATE] ${template}` });
    
    return response.data;
  } catch (err) {
    // Log detailed error from WhatsApp API
    console.error('❌ === WHATSAPP ERROR ===');
    console.error('   Error Message:', err.message);
    console.error('   Error Code:', err.code);
    console.error('   Response Status:', err.response?.status);
    console.error('   Response Data:', JSON.stringify(err.response?.data, null, 2));
    
    const errorDetails = err.response?.data || err.message;
    
    await Log.create({ 
      type: 'ERROR', 
      phone, 
      message: `Template Error: ${JSON.stringify(errorDetails)}` 
    });
    throw err;
  }
}

module.exports = { sendWhatsAppMessage, sendTemplateMessage };
