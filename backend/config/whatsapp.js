const axios = require('axios');

const whatsappApi = axios.create({
  baseURL: `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}`,
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

module.exports = whatsappApi;
