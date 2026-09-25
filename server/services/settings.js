// ---------- إعدادات المنصة القابلة للتعديل من اللوحة ----------
// تُخزَّن في جدول app_settings وتُطبَّق فوق متغيرات البيئة عند الإقلاع وعند أي تعديل.
// الهدف: تغيير توكن واتساب ومفاتيح الصوت من الجوال مباشرة — بدون الحاجة للوحة الاستضافة.
import config from '../config.js';
import { q } from '../db.js';

const SECRET_KEYS = new Set([
  'WHATSAPP_TOKEN', 'STT_API_KEY', 'TTS_API_KEY', 'AZURE_TTS_KEY', 'ELEVENLABS_API_KEY'
]);

const ALLOWED = new Set([
  'WHATSAPP_PROVIDER', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_API_URL',
  'STT_API_KEY', 'TTS_API_KEY', 'AZURE_TTS_KEY', 'AZURE_TTS_REGION', 'TTS_VOICE',
  'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'VOICE_REPLIES', 'QUICK_ORDER', 'ADMIN_PHONE', 'SUPERVISOR_NAME', 'SUPERVISOR_ID', 'PAYMENT_MODE', 'MOYASAR_SECRET_KEY', 'COMMISSION_BUSINESS_PERCENT', 'COMMISSION_CAPTAIN_PERCENT', 'BUSINESS_SUBSCRIPTION', 'CAPTAIN_DEPOSIT'
]);

function storedRows() {
  try { return q.all('SELECT key, value FROM app_settings'); } catch (e) { return []; }
}

function mask(v) {
  const s = String(v || '');
  return s ? '••••' + s.slice(-4) : '';
}

// تطبيق ما في القاعدة فوق config (لا يحذف قيم متغيرات البيئة إن كان المفتاح فارغاً)
export function applySettings() {
  const map = {};
  for (const r of storedRows()) {
    if (r.value !== null && r.value !== undefined && String(r.value) !== '') map[r.key] = String(r.value);
  }
  if (map.WHATSAPP_PROVIDER) config.whatsapp.provider = map.WHATSAPP_PROVIDER;
  if (map.WHATSAPP_TOKEN) config.whatsapp.token = map.WHATSAPP_TOKEN;
  if (map.WHATSAPP_PHONE_NUMBER_ID) config.whatsapp.phoneNumberId = map.WHATSAPP_PHONE_NUMBER_ID;
  if (map.WHATSAPP_VERIFY_TOKEN) config.whatsapp.verifyToken = map.WHATSAPP_VERIFY_TOKEN;
  if (map.WHATSAPP_API_URL) config.whatsapp.apiUrl = map.WHATSAPP_API_URL;
  if (map.STT_API_KEY) config.voice.sttApiKey = map.STT_API_KEY;
  if (map.TTS_API_KEY) config.voice.ttsApiKey = map.TTS_API_KEY;
  if (map.AZURE_TTS_KEY) config.voice.azureKey = map.AZURE_TTS_KEY;
  if (map.AZURE_TTS_REGION) config.voice.azureRegion = map.AZURE_TTS_REGION;
  if (map.TTS_VOICE) config.voice.ttsVoice = map.TTS_VOICE;
  if (map.ELEVENLABS_API_KEY) config.voice.elevenKey = map.ELEVENLABS_API_KEY;
  if (map.ELEVENLABS_VOICE_ID) config.voice.elevenVoiceId = map.ELEVENLABS_VOICE_ID;
  if (map.VOICE_REPLIES !== undefined) config.voice.replies = map.VOICE_REPLIES === 'true';
  if (map.QUICK_ORDER !== undefined) config.quickOrder = map.QUICK_ORDER === 'true';
  if (map.ADMIN_PHONE !== undefined) config.adminPhone = map.ADMIN_PHONE;
  if (map.SUPERVISOR_NAME !== undefined) config.supervisorName = map.SUPERVISOR_NAME;
  if (map.SUPERVISOR_ID !== undefined) config.supervisorId = map.SUPERVISOR_ID;
  if (map.PAYMENT_MODE !== undefined) config.paymentMode = map.PAYMENT_MODE;
  if (map.MOYASAR_SECRET_KEY !== undefined) config.moyasar.secretKey = map.MOYASAR_SECRET_KEY;
  if (map.COMMISSION_BUSINESS_PERCENT !== undefined) config.commissionBusinessPercent = Number(map.COMMISSION_BUSINESS_PERCENT) || 0;
  if (map.COMMISSION_CAPTAIN_PERCENT !== undefined) config.commissionCaptainPercent = Number(map.COMMISSION_CAPTAIN_PERCENT) || 0;
  if (map.BUSINESS_SUBSCRIPTION !== undefined) config.businessSubscription = Number(map.BUSINESS_SUBSCRIPTION) || 0;
  if (map.CAPTAIN_DEPOSIT !== undefined) config.captainDeposit = Number(map.CAPTAIN_DEPOSIT) || 0;
  return map;
}

// قراءة نص على شكل KEY=VALUE (يُسمح بلصق ملف .env كامل) وتحويله إلى تعديلات
export function parseEnvText(text = '') {
  const patch = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const v = m[2].replace(/^["']|["']$/g, '');
    if (ALLOWED.has(m[1]) && v) patch[m[1]] = v;
  }
  return patch;
}

export function saveSettings(patch = {}) {
  for (const [k, v] of Object.entries(patch)) {
    if (!ALLOWED.has(k)) continue;
    const val = v === null || v === undefined ? '' : String(v).trim();
    q.run("INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')", k, val);
  }
  applySettings();
  return publicSettings();
}

export function publicSettings() {
  const stored = {};
  for (const r of storedRows()) stored[r.key] = SECRET_KEYS.has(r.key) ? mask(r.value) : r.value;
  return {
    provider: config.whatsapp.provider,
    phoneNumberId: config.whatsapp.phoneNumberId,
    verifyToken: config.whatsapp.verifyToken,
    apiUrl: config.whatsapp.apiUrl,
    tokenSet: Boolean(config.whatsapp.token),
    tokenMask: mask(config.whatsapp.token),
    sttSet: Boolean(config.voice.sttApiKey),
    ttsSet: Boolean(config.voice.ttsApiKey || config.voice.azureKey || config.voice.elevenKey),
    voiceReplies: Boolean(config.voice.replies),
    quickOrder: Boolean(config.quickOrder),
    adminPhone: config.adminPhone || '',
    supervisorName: config.supervisorName || '',
    supervisorId: config.supervisorId || '',
    paymentMode: config.paymentMode,
    commissionBusinessPercent: config.commissionBusinessPercent,
    commissionCaptainPercent: config.commissionCaptainPercent,
    businessSubscription: config.businessSubscription,
    captainDeposit: config.captainDeposit,
    env: {
      provider: process.env.WHATSAPP_PROVIDER || null,
      token: Boolean(process.env.WHATSAPP_TOKEN),
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || null,
      stt: Boolean(process.env.STT_API_KEY)
    },
    stored
  };
}
