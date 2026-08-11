import { Router } from 'express';
import config from '../config.js';
import { q } from '../db.js';
import { handleIncoming, handleCaptainIncoming, isCaptainPhone, onPaymentSuccess, triggerRating } from '../services/flow.js';
import { setStatus, closeOrderWithCode } from '../services/orderService.js';
import { markPaid } from '../services/payments.js';
import { validatePhone } from '../utils.js';

const router = Router();

// سجل تشخيصي لطلبات الويب هوك (في الذاكرة)
const webhookHits = [];
function logHit(kind, summary) {
  webhookHits.push({ t: new Date().toISOString(), kind, summary: String(summary).slice(0, 120) });
  if (webhookHits.length > 100) webhookHits.shift();
  console.log('WEBHOOK', kind, String(summary).slice(0, 100));
}

// ---------- Webhook واتساب (Meta Cloud API) ----------
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
    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        for (const msg of change.value?.messages || []) {
          const phone = msg.from;
          const rid = Number(change.value.metadata?.phone_number_id) || null;
          if (msg.type === 'text' && isCaptainPhone(phone)) {
            await handleCaptainIncoming({ phone, body: msg.text?.body });
            continue;
          }
          // المطعم صاحب الرقم: نطابق رقم الواتساب الوارد مع المطاعم المسجلة
          const metaNumber = String(change.value.metadata?.display_phone_number || '').replace(/[^\d]/g, '');
          let rest = null;
          if (metaNumber) {
            rest = q.get("SELECT id FROM restaurants WHERE whatsapp_number LIKE ? LIMIT 1", '%' + metaNumber.slice(-9) + '%')
                || q.get("SELECT id FROM restaurants ORDER BY id LIMIT 1");
          }
          const targetRid = rest ? rest.id : rid;
          if (msg.type === 'text') await handleIncoming({ phone, restaurantId: targetRid, body: msg.text?.body, type: 'text' });
          else if (msg.type === 'location') await handleIncoming({ phone, restaurantId: targetRid, type: 'location', lat: msg.location?.latitude, lng: msg.location?.longitude });
          else if (msg.type === 'interactive') {
            const i = msg.interactive;
            const id = i?.button_reply?.id || i?.list_reply?.id || null;
            await handleIncoming({ phone, restaurantId: targetRid, type: 'interactive', payload: id });
          }
        }
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
