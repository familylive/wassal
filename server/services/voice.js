// ---------- معالجة الصوتيات: استقبال (STT) + رد (TTS) ----------
// STT: Groq (whisper) مجاني · TTS: OpenAI (رخيص)
import axios from 'axios';
import config from '../config.js';
import { waSend } from './whatsapp.js';

const { token, phoneNumberId, apiUrl } = config.whatsapp;
const { sttApiKey, ttsApiKey, ttsVoice, replies } = config.voice;

// 1) الحصول على رابط الملف الصوتي من Meta
async function getMediaUrl(mediaId) {
  const r = await axios.get(`${apiUrl}/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } });
  return r.data?.url || null;
}

// 2) تحميل الصوت + تحويله نصاً (Groq Whisper)
export async function transcribeVoice(mediaId) {
  if (!sttApiKey) return null;
  const url = await getMediaUrl(mediaId);
  if (!url) return null;
  const audio = await axios.get(`${url}?access_token=${token}`, { responseType: 'arraybuffer' });
  const fd = new FormData();
  fd.append('file', new Blob([audio.data]), 'voice.mpeg');
  fd.append('model', 'whisper-large-v3-turbo');
  fd.append('language', 'ar');
  const r = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', fd, {
    headers: { Authorization: `Bearer ${sttApiKey}` },
    timeout: 60000,
  });
  return (r.data?.text || '').trim() || null;
}

// 2) تحويل النص إلى صوت عبر Azure (صوت امرأة سعودية — زريّة)
export async function azureTTS(text) {
  const { azureKey, azureRegion, ttsVoice } = config.voice;
  if (!azureKey || !azureRegion) return null;
  const ssml = `<speak version='1.0' xml:lang='ar-SA'><voice name='${ttsVoice || 'ar-SA-ZariyahNeural'}'>${text.slice(0, 400).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</voice></speak>`;
  const r = await axios.post(`https://${azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, ssml, {
    headers: {
      'Ocp-Apim-Subscription-Key': azureKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
    },
    responseType: 'arraybuffer', timeout: 30000,
  });
  return r.data;
}

// 3) نص → صوت (Azure ar-SA زريّة — صوت امرأة سعودية، أو OpenAI كبديل) ثم إرسال صوتية عبر Meta
export async function sendVoiceNote(phone, text) {
  if (!text) return false;
  // لا نرسل صوتياً للأطوال الكبيرة (القوائم) — فقط جمل قصيرة
  if (text.length > 250) return false;
  let audio = null;
  try {
    audio = await azureTTS(text);
    if (!audio) {
      const { ttsApiKey, ttsVoice } = config.voice;
      if (!ttsApiKey) return false;
      // OpenAI (بديل — فصحى محايدة)
      const r = await axios.post('https://api.openai.com/v1/audio/speech',
        { model: 'gpt-4o-mini-tts', voice: ttsVoice || 'alloy', input: text.slice(0, 400) },
        { headers: { Authorization: `Bearer ${ttsApiKey}`, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 30000 });
      audio = r.data;
    }
    if (!audio) return false;
    // رفع الصوت إلى Meta
    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp');
    fd.append('type', 'audio/mpeg');
    fd.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'voice.mp3');
    const up = await axios.post(`${apiUrl}/${phoneNumberId}/media`, fd, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000,
    });
    const mediaId = up.data?.id;
    if (!mediaId) return false;
    // إرسال الصوتية
    await axios.post(`${apiUrl}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to: phone, type: 'audio', audio: { id: mediaId } },
      { headers: { Authorization: `Bearer ${token}` } });
    return true;
  } catch (e) {
    console.error('VOICE_TTS_FAIL', e.response?.status, e.message);
    return false;
  }
}

// 4) إرسال رد كتابي + صوتي (اختياري حسب الإعدادات)
export async function waSendWithVoice({ phone, type = 'text', body = null, buttons = null, list = null, image = null, restaurantId = null, orderId = null, participant = 'customer', channel = null }) {
  const result = await waSend({ phone, restaurantId, orderId, type, body, buttons, list, image, participant, channel });
  if (replies && type === 'text' && body) {
    // أرسل الصوتية بدون انتظار (لا تعطّل الرد الكتابي)
    sendVoiceNote(phone, body).catch(() => {});
  }
  return result;
}
