// 📨 قناة تليجرام — نفس تدفقات واتس هم بلا أي تعديل على منطق التدفق
// الاستقبال: webhook من تليجرام → تحويل للرسالة الموحدة → handleIncoming
// الإرسال: waSend يوجّه إلى sendTelegram حسب WHATSAPP_PROVIDER=telegram
import { Router } from 'express';
import axios from 'axios';
import config from '../config.js';
import { q } from '../db.js';
import { handleIncoming } from '../services/flow.js';
import { validatePhone } from '../utils.js';
import { waTo } from '../services/whatsapp.js';

const router = Router();
const tg = (m) => `https://api.telegram.org/bot${config.telegram.token}/${m}`;
const post = async (m, payload) => (await axios.post(tg(m), payload, { timeout: 20000 })).data;

function linkPhone(chatId, phoneRaw, username = null) {
  const norm = validatePhone(phoneRaw);
  q.run(`INSERT INTO telegram_links (chat_id, phone, username, updated_at) VALUES (?,?,?,datetime('now'))
         ON CONFLICT(chat_id) DO UPDATE SET phone=excluded.phone, username=excluded.username, updated_at=datetime('now')`,
    String(chatId), norm, username);
  return norm;
}
function phoneOf(chatId) {
  const r = q.get("SELECT phone FROM telegram_links WHERE chat_id=?", String(chatId));
  return r?.phone || null;
}
// نطلب رقم الجوال بزر مشاركة (تليجرام لا يعطي الرقم تلقائياً)
function askContact(chatId, text) {
  return post('sendMessage', {
    chat_id: chatId, text,
    reply_markup: { keyboard: [[{ text: '📱 مشاركة رقم جوالي', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
  }).catch(() => {});
}

// ---------- استقبال تحديثات تليجرام ----------
router.post('/webhook', async (req, res) => {
  res.sendStatus(200);                       // نرد فوراً لتليجرام
  try {
    const secret = String(config.telegram.secret || '');
    if (secret && req.get('x-telegram-bot-api-secret-token') !== secret) return;
    const upd = req.body || {};

    // ١) ضغط زر
    const cb = upd.callback_query;
    if (cb) {
      await post('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
      const chatId = cb.message?.chat?.id;
      const phone = phoneOf(chatId);
      if (!phone) return askContact(chatId, 'أهلًا بك في *واتس هم* 🌸\nنحتاج رقم جوالك أول — اضغط الزر 👇');
      return handleIncoming({ phone, restaurantId: 1, type: 'interactive', payload: String(cb.data || '') });
    }

    const msg = upd.message || upd.edited_message;
    if (!msg) return;
    const chatId = msg.chat?.id;

    // ٢) مشاركة جهة الاتصال = تسجيل الرقم
    if (msg.contact?.phone_number) {
      const phone = linkPhone(chatId, msg.contact.phone_number, msg.from?.username);
      await post('sendMessage', { chat_id: chatId, text: '✅ تم ربط رقمك — أهلًا بك 🌸', reply_markup: { remove_keyboard: true } }).catch(() => {});
      return handleIncoming({ phone, restaurantId: 1, type: 'text', body: 'مرحبا' });
    }

    const phone = phoneOf(chatId);
    if (!phone) return askContact(chatId, 'أهلًا بك في *واتس هم* 🌸\nخدمة الطلبات والتوصيل 🍽️🛵\n\nنحتاج رقم جوالك للتسجيل — اضغط الزر 👇');

    // ٣) الموقع
    if (msg.location) return handleIncoming({ phone, restaurantId: 1, type: 'location', lat: msg.location.latitude, lng: msg.location.longitude });

    // ٤) الصور — نوجّه المستخدم للنص (لا قراءة أصناف في تليجرام حالياً)
    if (msg.photo?.length) {
      await post('sendMessage', { chat_id: chatId, text: '📷 وصلتني الصورة 🙏\n\n• لطلب: أرسل *المنيو*\n• لتسجيل نشاطك: أرسل *انضمام*\n• ولو تكمل خطوة الحين: أكملها *نصاً*' }).catch(() => {});
      return;
    }

    // ٥) نص / أزرار لوحة المفاتيح
    const body = msg.text || msg.caption || '';
    if (body === '/start') return handleIncoming({ phone, restaurantId: 1, type: 'text', body: 'مرحبا' });
    return handleIncoming({ phone, restaurantId: 1, type: 'text', body });
  } catch (e) {
    console.error('TELEGRAM_HANDLE_FAIL', e.message);
  }
});

// ---------- ربط الويب هوك ببوت تليجرام (تُفتح بالمتصفح بعد وضع التوكن) ----------
router.get('/setup-webhook', async (req, res) => {
  if (!config.telegram.token) return res.json({ ok: false, error: 'TELEGRAM_BOT_TOKEN غير مضبوط — ضعه من الإعدادات أولاً' });
  const base = String(config.publicUrl || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  const url = `${base}/api/telegram/webhook`;
  if (!/^https:\/\//.test(url)) return res.json({ ok: false, error: 'رابط الموقع غير معروف (PUBLIC_URL) — راجع الإعدادات', url });
  try {
    const r = await post('setWebhook', { url, secret_token: config.telegram.secret || undefined, allowed_updates: ['message', 'edited_message', 'callback_query'] });
    return res.json({ ok: true, url, telegram: r });
  } catch (e) {
    return res.json({ ok: false, url, error: e.response?.data?.description || e.message });
  }
});

// ---------- حالة القناة ----------
router.get('/status', async (req, res) => {
  const out = { ok: false, tokenSet: Boolean(config.telegram.token), provider: config.whatsapp.provider };
  try { out.links = q.get("SELECT COUNT(*) c FROM telegram_links")?.c ?? 0; } catch (e) {}
  try {
    const admin = waTo(config.adminPhone || '');
    const tgAdmin = waTo(config.telegram.adminPhone || config.adminPhone || '');
    out.adminPhone = config.adminPhone || null;
    out.telegramAdminPhone = config.telegram.adminPhone || null;
    out.adminLinked = Boolean(admin && q.get("SELECT chat_id FROM telegram_links WHERE phone=? OR phone=? OR phone LIKE ?", admin, tgAdmin, '%' + String(admin).slice(-9))?.chat_id);
    out.linkedPhones = q.all("SELECT phone, updated_at FROM telegram_links ORDER BY updated_at DESC LIMIT 5").map(r => ({ phone: '••••' + String(r.phone).slice(-4), at: r.updated_at }));
  } catch (e) {}
  if (!config.telegram.token) return res.json({ ...out, error: 'التوكن غير مضبوط' });
  try {
    const r = await axios.get(tg('getWebhookInfo'), { timeout: 20000 });
    const me = await axios.get(tg('getMe'), { timeout: 20000 }).catch(() => null);
    return res.json({ ...out, ok: true, bot: me?.data?.result?.username || null, webhook: r.data?.result });
  } catch (e) {
    return res.json({ ...out, error: e.response?.data?.description || e.message });
  }
});

export default router;
