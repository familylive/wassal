// 📨 قناة تليجرام — نفس تدفقات تلي هم بلا أي تعديل على منطق التدفق
// الاستقبال: webhook من تليجرام → تحويل للرسالة الموحدة → handleIncoming
// الإرسال: waSend يوجّه إلى sendTelegram حسب WHATSAPP_PROVIDER=telegram
import { Router } from 'express';
import axios from 'axios';
import config from '../config.js';
import { q } from '../db.js';
import { handleIncoming } from '../services/flow.js';
import { validatePhone } from '../utils.js';
import { waTo } from '../services/whatsapp.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
const tg = (m) => `https://api.telegram.org/bot${config.telegram.token}/${m}`;
const post = async (m, payload) => (await axios.post(tg(m), payload, { timeout: 20000 })).data;

function linkPhone(chatId, phoneRaw, username = null) {
  const norm = validatePhone(phoneRaw);
  q.run(`INSERT INTO telegram_links (chat_id, phone, username, updated_at) VALUES (?,?,?,datetime('now'))
         ON CONFLICT(chat_id) DO UPDATE SET phone=excluded.phone, username=excluded.username, updated_at=datetime('now')`,
    String(chatId), norm, username);
  // رقم واحد = محادثة واحدة: نحذف أي ربط قديم لنفس الرقم بمحادثة أخرى
  // (وإلا قد يُرسل الرد لمحادثة قديمة فيظهر «العميل ما تصله القائمة»)
  try { q.run("DELETE FROM telegram_links WHERE phone=? AND chat_id<>?", norm, String(chatId)); } catch (e) {}
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
    const gotSecret = req.get('x-telegram-bot-api-secret-token') || '';
    const upd = req.body || {};
    // 🔎 تسجيل كل تحديث وارد (قبل الفحوص) — لتشخيص «لا يصل شيء» من تليجرام
    try {
      const kind = upd.callback_query ? 'callback' : upd.message?.location ? 'location' : upd.message?.contact ? 'contact' : upd.message?.photo ? 'photo' : upd.message ? 'message' : Object.keys(upd)[0] || 'unknown';
      q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('inbound', ?, ?)",
        `${kind}${upd.callback_query?.data ? ':' + String(upd.callback_query.data).slice(0, 60) : ''}`,
        JSON.stringify({ secret_ok: secret ? gotSecret === secret : null, has_secret_header: Boolean(gotSecret), upd_id: upd.update_id }).slice(0, 300));
    } catch (e) {}
    if (secret && gotSecret !== secret) {
      try { q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('webhook-error', ?, ?)", 'secret_mismatch — تم تجاهل التحديث', JSON.stringify({ has_header: Boolean(gotSecret) }).slice(0, 200)); } catch (e) {}
      return;
    }

    // ١) ضغط زر
    const cb = upd.callback_query;
    if (cb) {
      // 🔎 تسجيل كل ضغطة زر (تشخيص: هل تصل ضغطات الأزرار من تليجرام أصلاً؟)
      try { q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('callback', ?, ?)",
        String(cb.data || '').slice(0, 120), JSON.stringify({ chat: cb.message?.chat?.id, data: cb.data, from: cb.from?.id }).slice(0, 400)); } catch (e) {}
      await post('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
      const chatId = cb.message?.chat?.id;
      const phone = phoneOf(chatId);
      if (!phone) return askContact(chatId, 'أهلًا بك في *تلي هم* 🌸\nنحتاج رقم جوالك أول — اضغط الزر 👇');
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
    if (!phone) return askContact(chatId, 'أهلًا بك في *تلي هم* 🌸\nخدمة الطلبات والتوصيل 🍽️🛵\n\nنحتاج رقم جوالك للتسجيل — اضغط الزر 👇');

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
    try { q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('webhook-error', ?, ?)", String(e.message).slice(0, 160), String(e.stack || '').slice(0, 400)); } catch (_) {}
  }
});

// ---------- ربط الويب هوك ببوت تليجرام (تُفتح بالمتصفح بعد وضع التوكن) ----------
// 🔒 خاص بالمشرف فقط — لا يُسمح لأي زائر بإعادة توجيه webhook البوت
router.get('/setup-webhook', requireAuth, requireRole('admin'), async (req, res) => {
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

// 🔧 ضبط الويب هوك تلقائياً (يصلح انحراف الرابط أو السرّ) — يُستدعى عند الإقلاع ودوريًا
export async function ensureWebhook() {
  try {
    if (!config.telegram.token) return { ok: false, error: 'no_token' };
    const base = String(config.publicUrl || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
    const url = `${base}/api/telegram/webhook`;
    if (!/^https:\/\//.test(url)) return { ok: false, error: 'no_public_url', url };
    const r = await post('setWebhook', {
      url, secret_token: config.telegram.secret || undefined,
      allowed_updates: ['message', 'edited_message', 'callback_query'], drop_pending_updates: false
    });
    const info = await post('getWebhookInfo', {}).catch(() => null);
    try {
      q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('webhook-set', ?, ?)",
        url, JSON.stringify({ ok: r?.ok, pending: info?.result?.pending_update_count, last_error: info?.result?.last_error_message }).slice(0, 300));
    } catch (e) {}
    console.log('TELEGRAM_WEBHOOK_SET', url, r?.ok, 'pending:', info?.result?.pending_update_count);
    return { ok: true, url, telegram: r };
  } catch (e) {
    console.error('TELEGRAM_WEBHOOK_SET_FAIL', e.response?.data?.description || e.message);
    return { ok: false, error: e.response?.data?.description || e.message };
  }
}

// ---------- حالة القناة ----------
router.get('/status', async (req, res) => {
  const out = { ok: false, tokenSet: Boolean(config.telegram.token), provider: config.whatsapp.provider };
  try { out.links = q.get("SELECT COUNT(*) c FROM telegram_links")?.c ?? 0; } catch (e) {}
  try {
    const admin = waTo(config.adminPhone || '');
    const tgAdmin = waTo(config.telegram.adminPhone || config.adminPhone || '');
    // 🔒 نقنّع الأرقام في الرد العام (كانت تظهر كاملة)
    const mask = (p) => (p ? '••••' + String(p).replace(/\D/g, '').slice(-4) : null);
    out.adminPhone = mask(config.adminPhone);
    out.telegramAdminPhone = mask(config.telegram.adminPhone);
    out.adminLinked = Boolean(admin && q.get("SELECT chat_id FROM telegram_links WHERE phone=? OR phone=? OR phone LIKE ?", admin, tgAdmin, '%' + String(admin).slice(-9))?.chat_id);
    out.linkedPhones = q.all("SELECT phone, updated_at FROM telegram_links ORDER BY updated_at DESC LIMIT 5").map(r => ({ phone: '••••' + String(r.phone).slice(-4), at: r.updated_at }));
  } catch (e) {}
  if (!config.telegram.token) return res.json({ ...out, error: 'التوكن غير مضبوط' });
  try {
    const r = await axios.get(tg('getWebhookInfo'), { timeout: 20000 });
    const me = await axios.get(tg('getMe'), { timeout: 20000 }).catch(() => null);
    // 🔎 تشخيص الأزرار: هل وصلت ضغطة؟ هل فيه أخطاء؟
    try {
      const lc = q.get("SELECT created_at, summary FROM webhook_log WHERE kind='callback' ORDER BY id DESC LIMIT 1");
      out.lastCallback = lc || null;
      out.lastInbound = q.get("SELECT created_at, summary FROM webhook_log WHERE kind='inbound' ORDER BY id DESC LIMIT 1") || null;
      out.lastOutbound = q.get("SELECT created_at, summary FROM webhook_log WHERE kind='outbound' ORDER BY id DESC LIMIT 1") || null;
      out.lastOutError = q.get("SELECT created_at, summary FROM webhook_log WHERE kind='out-error' ORDER BY id DESC LIMIT 1") || null;
      out.outErrors24h = q.get("SELECT COUNT(*) c FROM webhook_log WHERE kind='out-error' AND created_at >= datetime('now','-1 day')")?.c || 0;
      out.inbound24h = Number(q.get("SELECT COUNT(*) c FROM webhook_log WHERE kind='inbound' AND created_at > datetime('now','-1 day')")?.c || 0);
      out.lastWebhookSet = q.get("SELECT created_at, summary, raw FROM webhook_log WHERE kind='webhook-set' ORDER BY id DESC LIMIT 1") || null;
      out.callbacks24h = Number(q.get("SELECT COUNT(*) c FROM webhook_log WHERE kind='callback' AND created_at > datetime('now','-1 day')")?.c || 0);
      out.webhookErrors24h = Number(q.get("SELECT COUNT(*) c FROM webhook_log WHERE kind='webhook-error' AND created_at > datetime('now','-1 day')")?.c || 0);
      out.lastWebhookError = q.get("SELECT created_at, summary FROM webhook_log WHERE kind='webhook-error' ORDER BY id DESC LIMIT 1") || null;
    } catch (e) {}
    return res.json({ ...out, ok: true, bot: me?.data?.result?.username || null, webhook: r.data?.result });
  } catch (e) {
    return res.json({ ...out, error: e.response?.data?.description || e.message });
  }
});

export default router;
