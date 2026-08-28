import { Router } from 'express';
import config from '../config.js';
import { q } from '../db.js';
import { handleIncoming, handleCaptainIncoming, isCaptainPhone, onPaymentSuccess, triggerRating } from '../services/flow.js';
import { setStatus, closeOrderWithCode } from '../services/orderService.js';
import { markPaid } from '../services/payments.js';
import { validatePhone } from '../utils.js';
import { transcribeVoice } from '../services/voice.js';

const router = Router();

// سجل تشخيصي لطلبات الويب هوك (في الذاكرة)
const webhookHits = [];
function logHit(kind, summary, raw = '') {
  webhookHits.push({ t: new Date().toISOString(), kind, summary: String(summary).slice(0, 120), raw: String(raw).slice(0, 250) });
  if (webhookHits.length > 100) webhookHits.shift();
  console.log('WEBHOOK', kind, String(summary).slice(0, 100));
}

// تحويل صيغة LetsBot (baileys) إلى رسائل موحدة
function parseLetsBot(body) {
  const msgs = [];
  const collect = (obj, altJid) => {
    const key = obj?.key || {};
    const msg = obj?.message || {};
    // الرقم الحقيقي: remoteJidAlt (بسبب نظام LID الجديد) ثم remoteJid ثم معرّف المحادثة
    const jid = key.remoteJidAlt || key.remoteJid || altJid || '';
    const phone = String(jid).split('@')[0].replace(/[^\d]/g, '');
    if (!phone || key.fromMe) return;
    if (msg.conversation) msgs.push({ phone, type: 'text', body: msg.conversation });
    else if (msg.extendedTextMessage?.text) msgs.push({ phone, type: 'text', body: msg.extendedTextMessage.text });
    else if (msg.locationMessage) msgs.push({ phone, type: 'location', lat: msg.locationMessage.degreesLatitude, lng: msg.locationMessage.degreesLongitude });
    else if (msg.interactiveMessage?.buttonReplyMessage?.id) msgs.push({ phone, type: 'interactive', payload: msg.interactiveMessage.buttonReplyMessage.id });
    else if (msg.interactiveMessage?.listResponseMessage?.singleSelectReply?.selectedRowId) msgs.push({ phone, type: 'interactive', payload: msg.interactiveMessage.listResponseMessage.singleSelectReply.selectedRowId });
    else if (msg.buttonsResponseMessage?.selectedButtonId) msgs.push({ phone, type: 'interactive', payload: msg.buttonsResponseMessage.selectedButtonId });
    else if (msg.listResponseMessage?.singleSelectReply?.selectedRowId) msgs.push({ phone, type: 'interactive', payload: msg.listResponseMessage.singleSelectReply.selectedRowId });
  };
  const walk = (o, altJid) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    // data.conversations[].id = مرسل الرسالة
    if (o.id && typeof o.id === 'string' && o.id.endsWith('@s.whatsapp.net') && o.messages && Array.isArray(o.messages)) {
      for (const m of o.messages) { if (m && m.message) collect(m.message, o.id); }
      Object.values(o).forEach(v => walk(v, altJid));
      return;
    }
    if (o.key && (o.message || o.conversation !== undefined)) collect(o, altJid);
    Object.values(o).forEach(v => walk(v, altJid));
  };
  walk(body);
  return msgs;
}

// ---------- Webhook واتساب (Meta Cloud API + LetsBot) ----------
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) return res.send(challenge);
  return res.sendStatus(403);
});

router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // أجب فوراً لتجنب إعادة الإرسال
  try {
    const entries = req.body?.entry || [];
    const msgs = entries.flatMap(e => (e.changes || []).flatMap(c => c.value?.messages || []));
    const statuses = entries.flatMap(e => (e.changes || []).flatMap(c => c.value?.statuses || []));
    logHit(msgs.length ? 'message' : statuses.length ? 'status' : 'ping', msgs.length ? (msgs[0].from + ':' + (msgs[0].text?.body || msgs[0].type)) : (statuses[0]?.status || 'empty'));
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        for (const msg of change.value?.messages || []) {
          const phone = msg.from;
          const rid = Number(change.value.metadata?.phone_number_id) || null;
          if (msg.type === 'text' && isCaptainPhone(phone)) {
            await handleCaptainIncoming({ phone, body: msg.text?.body });
            continue;
          }
          const metaNumber = String(change.value.metadata?.display_phone_number || '').replace(/[^\d]/g, '');
          let rest = null;
          if (metaNumber) {
            rest = q.get("SELECT id FROM restaurants WHERE whatsapp_number LIKE ? LIMIT 1", '%' + metaNumber.slice(-9) + '%')
                || q.get("SELECT id FROM restaurants ORDER BY id LIMIT 1");
          }
          const targetRid = rest ? rest.id : rid;
          if (msg.type === 'text') await handleIncoming({ phone, restaurantId: targetRid, body: msg.text?.body, type: 'text' });
          else if (msg.type === 'location') await handleIncoming({ phone, restaurantId: targetRid, type: 'location', lat: msg.location?.latitude, lng: msg.location?.longitude });
          else if (msg.type === 'audio' || msg.type === 'voice') {
            // 🎙️ طلب صوتي: تحويله نصاً ثم معالجته كنص عادي (يُسجَّل في المحادثات الكتابية)
            const mediaId = msg.audio?.id || msg.voice?.id;
            if (mediaId) {
              try {
                const text = await transcribeVoice(mediaId);
                logHit('voice', phone + ':' + (text || 'فشل التحويل'));
                if (text) await handleIncoming({ phone, restaurantId: targetRid, body: text, type: 'text', voice: true });
              } catch (e) {
                console.error('voice transcribe error', e.message);
                await handleIncoming({ phone, restaurantId: targetRid, body: 'أرسلت صوتية ولم أستطع فهمها، أعد المحاولة نصياً أو صوتياً', type: 'text' });
              }
            }
          }
          else if (msg.type === 'interactive') {
            const i = msg.interactive;
            const id = i?.button_reply?.id || i?.list_reply?.id || null;
            await handleIncoming({ phone, restaurantId: targetRid, type: 'interactive', payload: id });
          }
        }
      }
    }
    // صيغة LetsBot (baileys) — إن لم تكن رسائل Meta
    if (!msgs.length) {
      const rawSample = JSON.stringify(req.body);
      for (const m of parseLetsBot(req.body)) {
        logHit('message', m.phone + ':' + (m.body || m.payload || m.type), rawSample);
        if (m.type === 'text') await handleIncoming({ phone: m.phone, body: m.body, type: 'text' });
        else if (m.type === 'location') await handleIncoming({ phone: m.phone, type: 'location', lat: m.lat, lng: m.lng });
        else if (m.type === 'interactive') await handleIncoming({ phone: m.phone, type: 'interactive', payload: m.payload });
      }
    }
  } catch (e) { console.error('webhook error', e.message); }
});

// ---------- محاكي واتساب (اختبار كامل التدفق بدون إعدادات حقيقية) ----------
router.post('/simulate', async (req, res) => {
  const { phone, restaurant_id, body = '', type = 'text', payload = null, lat = null, lng = null } = req.body || {};
  if (!phone || !restaurant_id) return res.status(400).json({ error: 'phone و restaurant_id مطلوبان' });
  try {
    if (isCaptainPhone(phone)) await handleCaptainIncoming({ phone, body, payload });
    else await handleIncoming({ phone, restaurantId: Number(restaurant_id), body, type, payload, lat, lng });
    res.json({ ok: true });
  } catch (e) { console.error('simulate error', e); res.status(500).json({ error: e.message }); }
});

// رسالة من جوال المندوب لواتساب المطعم — رمز الاستلام يغلق الطلب
// سجل آخر طلبات الويب هوك (تشخيص)
router.get('/debug', (req, res) => res.json(webhookHits.slice(-25)));

router.post('/captain-message', async (req, res) => {
  const { captain_phone, body = '' } = req.body || {};
  const m = String(body || '').trim();
  const match = m.match(/(رمز|كود|code)\s*[:：]?\s*(\d{4,8})/i);
  const pRaw = String(captain_phone || '').trim(), pNorm = validatePhone(captain_phone);
  const captain = q.get("SELECT * FROM captains WHERE phone=? OR phone=?", pRaw, pNorm);
  if (!captain) return res.status(400).json({ error: 'رقم المندوب غير مسجل' });
  if (!match) return res.json({ ok: false, message: 'أرسل الرمز بصيغة: رمز 123456' });
  const r = await closeOrderWithCode(match[2], captain.phone);
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true, order: r.order });
});

// إغلاق الطلب بالرمز من لوحة المندوب
router.post('/close-order', async (req, res) => {
  const { order_id, code, captain_id } = req.body || {};
  const captain = q.get("SELECT * FROM captains WHERE id=?", captain_id);
  if (!captain) return res.status(400).json({ error: 'مندوب غير موجود' });
  const order = q.get("SELECT * FROM orders WHERE id=? AND captain_id=?", order_id, captain_id);
  if (!order) return res.status(400).json({ error: 'الطلب ليس لديك' });
  if (String(order.delivery_code) !== String(code).trim()) return res.status(400).json({ error: 'رمز الاستلام غير صحيح' });
  const r = await closeOrderWithCode(code, captain.phone);
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true, order: r.order });
});

router.get('/simulate/:phone/conversations', (req, res) => {
  const msgs = q.all("SELECT * FROM conversations WHERE phone=? AND created_at >= datetime('now','-48 hours') ORDER BY id", req.params.phone);
  res.json(msgs);
});

// تصفير محادثة عميل في المحاكي
router.post('/simulate/:phone/reset', (req, res) => {
  const cust = q.get("SELECT id FROM customers WHERE phone=?", req.params.phone);
  if (cust) q.run("DELETE FROM conversations WHERE phone=? AND order_id IS NULL", req.params.phone);
  q.run("DELETE FROM whatsapp_sessions WHERE phone=?", req.params.phone);
  res.json({ ok: true });
});

// ---------- إبلاغ وصول الطلب من جوال فريق التوصيل ----------
router.post('/notify-arrived', async (req, res) => {
  const { order_id } = req.body || {};
  const order = q.get("SELECT * FROM orders WHERE id=?", order_id);
  if (!order) return res.status(404).json({ error: 'طلب غير موجود' });
  const r = setStatus(order_id, 'arrived', 'captain', order.captain_id);
  res.json(r);
});

export default router;
