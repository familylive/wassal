import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4000),
  jwtSecret: process.env.JWT_SECRET || 'wassal-dev-secret-change-me',
  dbPath: process.env.DB_PATH || new URL('./data/wassal.db', import.meta.url).pathname,
  publicUrl: process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 4000}`,
  // WhatsApp Cloud API (Meta) — fill .env to go live
  whatsapp: {
    provider: process.env.WHATSAPP_PROVIDER || 'simulator', // simulator | cloud | 360dialog
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    apiUrl: process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v21.0'
  },
  voice: {
    sttApiKey: process.env.STT_API_KEY || '',   // Groq مجاني: console.groq.com
    ttsApiKey: process.env.TTS_API_KEY || '',   // OpenAI بديل: platform.openai.com
    azureKey: process.env.AZURE_TTS_KEY || '',  // Azure (الأفضل): صوت امرأة سعودية ar-SA-ZariyahNeural
    azureRegion: process.env.AZURE_TTS_REGION || 'uae-north',
    ttsVoice: process.env.TTS_VOICE || 'ar-SA-ZariyahNeural',
    elevenKey: process.env.ELEVENLABS_API_KEY || '',
    elevenVoiceId: process.env.ELEVENLABS_VOICE_ID || '',
    elevenModel: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
    replies: process.env.VOICE_REPLIES === 'true' // إرسال رد صوتي بعد الرد الكتابي
  },
  // Moyasar — https://dashboard.moyasar.com (Apple Pay + Mada)
  moyasar: {
    secretKey: process.env.MOYASAR_SECRET_KEY || '',
    publishableKey: process.env.MOYASAR_PUBLISHABLE_KEY || '',
    sandbox: process.env.MOYASAR_SANDBOX !== 'false'
  },
  paymentMode: process.env.PAYMENT_MODE || 'mock', // mock | moyasar
  quickOrder: process.env.QUICK_ORDER === 'true', // طلب مبسّط: المنيو ← الاختيار ← رابط الدفع ← الطلب ينتهي
  // رقم المشرف: تجيه إشعارات طلبات التسجيل للاعتماد
  adminPhone: process.env.ADMIN_PHONE || '',
  commissionBusinessPercent: Number(process.env.COMMISSION_BUSINESS_PERCENT || 15),
  commissionCaptainPercent: Number(process.env.COMMISSION_CAPTAIN_PERCENT || 15),
  businessSubscription: Number(process.env.BUSINESS_SUBSCRIPTION || 100000),
  captainDeposit: Number(process.env.CAPTAIN_DEPOSIT || 50000),
  supervisorName: process.env.SUPERVISOR_NAME || '',
  supervisorId: process.env.SUPERVISOR_ID || ''
};
export default config;
