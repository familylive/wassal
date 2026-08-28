import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4000),
  jwtSecret: process.env.JWT_SECRET || 'wassal-dev-secret-change-me',
  dbPath: process.env.DB_PATH || new URL('./data/wassal.db', import.meta.url).pathname,
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`,
  // WhatsApp Cloud API (Meta) — fill .env to go live
  whatsapp: {
    provider: process.env.WHATSAPP_PROVIDER || 'simulator', // simulator | cloud | 360dialog
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'wassal-verify',
    apiUrl: process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v21.0'
  },
  // صوتيات: استقبال (STT) + رد (TTS)
  voice: {
    sttApiKey: process.env.STT_API_KEY || '',   // Groq مجاني: console.groq.com
    ttsApiKey: process.env.TTS_API_KEY || '',   // OpenAI بديل: platform.openai.com
    azureKey: process.env.AZURE_TTS_KEY || '',  // Azure (الأفضل): صوت امرأة سعودية ar-SA-ZariyahNeural
    azureRegion: process.env.AZURE_TTS_REGION || 'uae-north',
    ttsVoice: process.env.TTS_VOICE || 'ar-SA-ZariyahNeural',
    replies: process.env.VOICE_REPLIES === 'true' // إرسال رد صوتي بعد الرد الكتابي
  },
  // Moyasar — https://dashboard.moyasar.com (Apple Pay + Mada)
  moyasar: {
    secretKey: process.env.MOYASAR_SECRET_KEY || '',
    publishableKey: process.env.MOYASAR_PUBLISHABLE_KEY || '',
    sandbox: process.env.MOYASAR_SANDBOX !== 'false'
  },
  paymentMode: process.env.PAYMENT_MODE || 'mock' // mock | moyasar
};
export default config;
