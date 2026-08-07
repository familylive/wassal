import axios from 'axios';
import config from '../config.js';
import { q } from '../db.js';

// ---------- provider: Meta WhatsApp Cloud API ----------
async function sendCloud({ phone, type, body, buttons, list, image }) {
  const { token, phoneNumberId, apiUrl } = config.whatsapp;
  if (!token || !phoneNumberId) throw new Error('WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID غير معرّفة');
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
  const r = await axios.post(`${apiUrl}/${phoneNumberId}/messages`, msg, { headers: { Authorization: `Bearer ${token}` } });
  return r.data;
}

// ---------- log + deliver ----------
export async function waSend({ phone, restaurantId, orderId = null, type = 'text', body = null, buttons = null, list = null, image = null, participant = 'customer', channel = null }) {
  const payload = JSON.stringify({ buttons, list, image });
  q.run("INSERT INTO conversations (order_id, phone, participant_type, direction, channel, message_type, body, payload_json) VALUES (?,?,?,?,?,?,?,?)",
    orderId, phone || null, participant, 'out', channel || (config.whatsapp.provider === 'simulator' ? 'simulator' : 'whatsapp'), type, body, payload);
  if (config.whatsapp.provider === 'cloud' && channel !== 'simulator-only') {
    try { await sendCloud({ phone, type, body, buttons, list, image }); }
    catch (e) { console.error('WA send failed:', e.message); }
  }
}

// ---------- log inbound ----------
export function waLogIn({ orderId = null, phone = null, participant = 'customer', type = 'text', body = null, payload = null, channel = null }) {
  q.run("INSERT INTO conversations (order_id, phone, participant_type, direction, channel, message_type, body, payload_json) VALUES (?,?,?,?,?,?,?,?)",
    orderId, phone || null, participant, 'in', channel || (config.whatsapp.provider === 'simulator' ? 'simulator' : 'whatsapp'), type, body, JSON.stringify(payload || {}));
}
