import axios from 'axios';
import config from '../config.js';
import { q } from '../db.js';

// ---------- provider: Meta WhatsApp Cloud API ----------
async function sendCloud({ phone, type, body, buttons, list, image }) {
  const { token, phoneNumberId, apiUrl, provider } = config.whatsapp;
  if (!token) throw new Error('WHATSAPP_TOKEN غير معرّف');
  let msg;
  if (type === 'text') msg = { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body } };
  else if (type === 'buttons') msg = {
    messaging_product: 'whatsapp', to: phone, type: 'interactive',
    interactive: { type: 'button', body: { text: body }, action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) } }
  };
  else if (type === 'list') msg = {
    messaging_product: 'whatsapp', to: phone, type: 'interactive',
    interactive: { type: 'list', body: { text: body }, action: { button: 'اختر', sections: list } }
  };
  else if (type === 'image') msg = { messaging_product: 'whatsapp', to: phone, type: 'image', image: { link: image, caption: body || '' } };
  // 360dialog: نفس صيغة Meta لكن عبر بوابة 360dialog
  const is360 = provider === '360dialog';
  const url = is360 ? `${apiUrl}/v1/messages` : `${apiUrl}/${phoneNumberId}/messages`;
  const headers = is360 ? { 'D360-API-KEY': token } : { Authorization: `Bearer ${token}` };
  const r = await axios.post(url, msg, { headers });
  return r.data;
}

// ---------- log + deliver ----------
export async function waSend({ phone, restaurantId, orderId = null, type = 'text', body = null, buttons = null, list = null, image = null, participant = 'customer', channel = null }) {
  const payload = JSON.stringify({ buttons, list, image });
  q.run("INSERT INTO conversations (order_id, phone, participant_type, direction, channel, message_type, body, payload_json) VALUES (?,?,?,?,?,?,?,?)",
    orderId, phone || null, participant, 'out', channel || (config.whatsapp.provider === 'simulator' ? 'simulator' : 'whatsapp'), type, body, payload);
  if (['cloud', '360dialog'].includes(config.whatsapp.provider) && channel !== 'simulator-only') {
    try { await sendCloud({ phone, type, body, buttons, list, image }); }
    catch (e) { console.error('WA send failed:', e.message); }
  }
}

// ---------- log inbound ----------
export function waLogIn({ orderId = null, phone = null, participant = 'customer', type = 'text', body = null, payload = null, channel = null }) {
  q.run("INSERT INTO conversations (order_id, phone, participant_type, direction, channel, message_type, body, payload_json) VALUES (?,?,?,?,?,?,?,?)",
    orderId, phone || null, participant, 'in', channel || (config.whatsapp.provider === 'simulator' ? 'simulator' : 'whatsapp'), type, body, JSON.stringify(payload || {}));
}
