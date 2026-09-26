import axios from 'axios';
import config from '../config.js';
import { q } from '../db.js';

// ---------- provider: Meta WhatsApp Cloud API ----------
// 📞 توحيد رقم المستلم للصيغة الدولية: 05XXXXXXXX → 9665XXXXXXXX · +9665… → 9665… · 00966… → 966…
export function waTo(phone) {
  let s = String(phone || '')
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))   // أرقام عربية
    .replace(/[^\d]/g, '');
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('966')) return s;
  if (s.startsWith('0')) return '966' + s.slice(1);            // صيغة محلية 05…
  if (s.length === 9 && s.startsWith('5')) return '966' + s;   // 5XXXXXXXX بلا صفر
  return s;
}

async function sendCloud({ phone, type, body, buttons, list, image, document }) {
  const { token, phoneNumberId, apiUrl, provider } = config.whatsapp;
  if (!token) throw new Error('WHATSAPP_TOKEN غير معرّف');
  // ميتا تقبل الصيغة الدولية للأرقام بدون + أو 00 — نحوّل الرقم دائماً
  const to = waTo(phone);
  let msg;
  if (type === 'text') msg = { messaging_product: 'whatsapp', to: to, type: 'text', text: { body } };
  else if (type === 'buttons') msg = {
    messaging_product: 'whatsapp', to: to, type: 'interactive',
    interactive: { type: 'button', body: { text: body }, action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) } }
  };
  else if (type === 'list') msg = {
    messaging_product: 'whatsapp', to: to, type: 'interactive',
    interactive: { type: 'list', body: { text: body }, action: { button: 'اختر', sections: list } }
  };
  else if (type === 'image') msg = { messaging_product: 'whatsapp', to: to, type: 'image', image: { link: image, caption: body || '' } };
  else if (type === 'document') msg = { messaging_product: 'whatsapp', to: to, type: 'document', document: { link: document?.link || image, filename: document?.filename || 'file.pdf', caption: body || '' } };
  // 360dialog: نفس صيغة Meta لكن عبر بوابة 360dialog
  const is360 = provider === '360dialog';
  const url = is360 ? `${apiUrl}/v1/messages` : `${apiUrl}/${phoneNumberId}/messages`;
  const headers = is360 ? { 'D360-API-KEY': token } : { Authorization: `Bearer ${token}` };
  const r = await axios.post(url, msg, { headers });
  return r.data;
}

// LetsBot: WhatsApp Web API (formdata) — https://letsbot.net/api/v1
async function sendLetsBot({ phone, type, body, buttons, list, image }) {
  const { token, apiUrl } = config.whatsapp;
  const to = waTo(phone);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' };
  const fd = (obj) => new URLSearchParams(obj).toString();
  let r;
  if (type === 'text') {
    r = await axios.post(`${apiUrl}/message/send`, fd({ phone: to, body }), { headers });
  } else if (type === 'buttons') {
    const p = { phone: to, title: 'واتس هم', body, footer: 'واتس هم' };
    (buttons || []).slice(0, 3).forEach((b, i) => { p[`buttons[${i}][id]`] = b.id; p[`buttons[${i}][title]`] = b.title; });
    r = await axios.post(`${apiUrl}/button`, fd(p), { headers });
  } else if (type === 'list') {
    // LetsBot لا يدعم القوائم التفاعلية عبر API → نص مرقّم (يعمل مع أي مزود)
    let t = (body || '') + '\n';
    let n = 1;
    (list || []).forEach(sec => (sec.rows || []).forEach(row => {
      t += `${n}. ${row.title}${row.description ? ' — ' + row.description : ''}\n`;
      n++;
    }));
    t += '\n📲 أرسل رقم الاختيار';
    r = await axios.post(`${apiUrl}/message/send`, fd({ phone: to, body: t }), { headers });
  } else if (type === 'buttons') {
    let t = (body || '') + '\n';
    (buttons || []).forEach((b, i) => { t += `${i + 1}. ${b.title}\n`; });
    t += '\n📲 أرسل رقم الاختيار';
    r = await axios.post(`${apiUrl}/message/send`, fd({ phone: to, body: t }), { headers });
  } else if (type === 'image' && image) {
    r = await axios.post(`${apiUrl}/send/image`, fd({ phone: to, url: image, caption: body || '' }), { headers });
  }
  return r?.data;
}

// ---------- log + deliver ----------
// تحديد المطعم: من الوسيط، وإلا من جلسة الرقم، وإلا من آخر مطعم معروف للرقم
function resolveRestaurantId(phone, restaurantId) {
  if (restaurantId) return Number(restaurantId);
  try {
    const s = q.get("SELECT restaurant_id, data_json FROM whatsapp_sessions WHERE phone=?", phone);
    if (s) {
      if (s.restaurant_id) return Number(s.restaurant_id);
      // المطعم الحالي محفوظ داخل بيانات الجلسة (currentRestaurantId)
      const d = JSON.parse(s.data_json || '{}');
      if (d.currentRestaurantId) return Number(d.currentRestaurantId);
    }
  } catch (e) {}
  try {
    const h = q.get("SELECT restaurant_id FROM wa_phone_restaurant WHERE phone=?", phone);
    if (h && h.restaurant_id) return Number(h.restaurant_id);
  } catch (e) {}
  return null;
}

// المطعم المعروف لرقم العميل (من الجلسة أو من خرائط الأرقام)
export function restaurantForPhone(phone) {
  return resolveRestaurantId(phone, null);
}

// يُسجَّل من مسار الويب هوك عند معرفة المطعم من رقم النشاط
// حتى تظهر رسائل العميل في شاشة المحادثات قبل أن يختار مطعماً بنفسه
export function rememberPhoneRestaurant(phone, restaurantId) {
  if (!phone || !restaurantId) return;
  try {
    q.run("INSERT INTO wa_phone_restaurant (phone, restaurant_id, updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(phone) DO UPDATE SET restaurant_id=excluded.restaurant_id, updated_at=datetime('now')", String(phone), Number(restaurantId));
  } catch (e) {}
}

export async function waSend({ phone, restaurantId, orderId = null, type = 'text', body = null, buttons = null, list = null, image = null, document = null, participant = 'customer', channel = null }) {
  const payload = JSON.stringify({ buttons, list, image, document });
  const oid = orderId && q.get("SELECT id FROM orders WHERE id=?", orderId) ? orderId : null;   // طلب محذوف؟ لا نكسر السجل
  q.run("INSERT INTO conversations (order_id, phone, restaurant_id, participant_type, direction, channel, message_type, body, payload_json) VALUES (?,?,?,?,?,?,?,?,?)",
    oid, phone || null, resolveRestaurantId(phone, restaurantId), participant, 'out', channel || (config.whatsapp.provider === 'simulator' ? 'simulator' : 'whatsapp'), type, body, payload);
  if (['cloud', '360dialog', 'letsbot'].includes(config.whatsapp.provider) && channel !== 'simulator-only') {
    try {
      if (config.whatsapp.provider === 'letsbot') await sendLetsBot({ phone, type, body, buttons, list, image });
      else await sendCloud({ phone, type, body, buttons, list, image, document });
      console.log('WA_SEND_OK', type, phone);
      // 🎙️ رد صوتي بعد الكتابي (اختياري — للرسائل النصية القصيرة فقط)
      // 🎙️ صوت لكل رسائل البوت (نص + قوائم + أزرار) — ما عدا الصور والمواقع
      if (config.whatsapp.provider === 'cloud' && config.voice.replies && body && ['text', 'list', 'buttons'].includes(type)) {
        const { sendVoiceNote } = await import('./voice.js');
        sendVoiceNote(phone, body).catch(() => {});
      }
    } catch (e) {
      // 🔎 سبب رفض ميتا — يُسجَّل في webhook_log فيظهر عبر /api/whatsapp/debug
      const detail = e?.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : (e?.message || 'خطأ غير معروف');
      console.error('WA_SEND_FAIL', type, phone, detail);
      try {
        q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('send-fail', ?, ?)",
          `${type} → ••••${String(phone || '').slice(-4)}`, detail);
      } catch (err) {}
      return false;                    // ← كان الخطأ يُبلع فيظنّ المستدعي أن الإرسال نجح
    }
  }
  return true;
}

// ---------- log inbound ----------
export function waLogIn({ orderId = null, phone = null, participant = 'customer', type = 'text', body = null, payload = null, channel = null }) {
  const oid = orderId && q.get("SELECT id FROM orders WHERE id=?", orderId) ? orderId : null;
  q.run("INSERT INTO conversations (order_id, phone, restaurant_id, participant_type, direction, channel, message_type, body, payload_json) VALUES (?,?,?,?,?,?,?,?,?)",
    oid, phone || null, resolveRestaurantId(phone, null), participant, 'in', channel || (config.whatsapp.provider === 'simulator' ? 'simulator' : 'whatsapp'), type, body, JSON.stringify(payload || {}));
}
