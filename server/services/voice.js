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

// 2) تحويل صوت مباشر (ملف) → نص عبر Groq Whisper
export async function groqTranscribe(audioBuffer, mimeType = 'audio/mpeg') {
  if (!sttApiKey || !audioBuffer) return null;
  const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('ogg') ? 'ogg' : 'mpeg';
  const fd = new FormData();
  fd.append('file', new Blob([audioBuffer], { type: mimeType }), `voice.${ext}`);
  fd.append('model', 'whisper-large-v3-turbo');
  fd.append('language', 'ar');
  const r = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', fd, {
    headers: { Authorization: `Bearer ${sttApiKey}` },
    timeout: 60000,
  });
  return (r.data?.text || '').trim() || null;
}

// 2ب) تحويل صوت قادم من Meta (media_id) → نص
export async function transcribeVoice(mediaId) {
  if (!sttApiKey) return null;
  const url = await getMediaUrl(mediaId);
  if (!url) return null;
  const audio = await axios.get(`${url}?access_token=${token}`, { responseType: 'arraybuffer' });
  return groqTranscribe(audio.data, 'audio/mpeg');
}

// 2) تحويل النص إلى صوت عبر Azure (صوت امرأة سعودية — زريّة)
export async function azureTTS(text, voiceOverride = null) {
  const { azureKey, azureRegion, ttsVoice } = config.voice;
  if (!azureKey || !azureRegion) return null;
  const vname = voiceOverride || ttsVoice || 'ar-SA-ZariyahNeural';
  const vlang = vname.split('-').slice(0, 2).join('-');
  const ssml = `<speak version='1.0' xml:lang='${vlang}'><voice name='${vname}'>${text.slice(0, 900).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</voice></speak>`;
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


// ---------- تجهيز النص للنطق (إزالة الرموز والإيموجي) ----------
export function cleanForSpeech(text) {
  if (!text) return '';
  return String(text)
    .replace(/[*_~`]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, ' ')
    .replace(/[⬜✅❌🔊📍🛒🧾🔥🎉🚫⭐💰⏱👇🍽️🛵📦]/gu, ' ')
    .replace(/https?:\/\/\S+/g, 'رابط الدفع')
    .replace(/[━─=_]{2,}/g, '. ')
    .replace(/\s*\n\s*/g, '. ')
    .replace(/\.{2,}/g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// تقسيم النص الطويل إلى مقاطع صوتية
function splitForSpeech(t, max = 450) {
  const parts = [];
  let cur = '';
  for (const seg of t.split(/(?<=[.!؟?،])\s+/)) {
    if (!seg) continue;
    if ((cur + ' ' + seg).trim().length > max && cur) { parts.push(cur.trim()); cur = seg; }
    else cur = (cur ? cur + ' ' : '') + seg;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean).slice(0, 3);
}

// إرسال صوتية واحدة (رفع + إرسال)
async function sendOneChunk(phone, text) {
  let audio = await azureTTS(text);
  if (!audio) {
    const { ttsApiKey, ttsVoice } = config.voice;
    if (!ttsApiKey) return false;
    const r = await axios.post('https://api.openai.com/v1/audio/speech',
      { model: 'gpt-4o-mini-tts', voice: ttsVoice || 'alloy', input: text },
      { headers: { Authorization: `Bearer ${ttsApiKey}`, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 30000 });
    audio = r.data;
  }
  if (!audio) return false;
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', 'audio/mpeg');
  fd.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'voice.mp3');
  const up = await axios.post(`${apiUrl}/${phoneNumberId}/media`, fd, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
  const mediaId = up.data?.id;
  if (!mediaId) return false;
  await axios.post(`${apiUrl}/${phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', to: phone, type: 'audio', audio: { id: mediaId } },
    { headers: { Authorization: `Bearer ${token}` } });
  return true;
}

// 3) نص → صوت (Azure ar-SA زريّة — صوت امرأة سعودية، أو OpenAI كبديل) ثم إرسال صوتية عبر Meta
export async function sendVoiceNote(phone, text) {
  const clean = cleanForSpeech(text);
  if (!clean) return false;
  const chunks = splitForSpeech(clean);
  let ok = false;
  for (const ch of chunks) {
    try { ok = (await sendOneChunk(phone, ch)) || ok; } catch (e) { console.error('VOICE_TTS_FAIL', e.message); }
  }
  return ok;
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
