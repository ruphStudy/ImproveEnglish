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

async function sendTemplateMessage(phone, template, params = []) {
  try {
    const data = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: template,
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: params.map(text => ({ type: 'text', text }))
          }
        ]
      }
    };
    
    console.log('📤 Sending template message:', JSON.stringify(data, null, 2));
    
    await whatsappApi.post('/messages', data);
    await Log.create({ type: 'MESSAGE_SENT', phone, message: `[TEMPLATE] ${template}` });
  } catch (err) {
    // Log detailed error from WhatsApp API
    const errorDetails = err.response?.data || err.message;
    console.error('❌ WhatsApp API Error:', JSON.stringify(errorDetails, null, 2));
    
    await Log.create({ 
      type: 'ERROR', 
      phone, 
      message: `Template Error: ${JSON.stringify(errorDetails)}` 
    });
    throw err;
  }
}

module.exports = { sendWhatsAppMessage, sendTemplateMessage };
