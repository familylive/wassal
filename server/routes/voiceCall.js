// ☎️ المكالمات الصوتية — يرد البوت بصوت حقيقي ويأخذ الطلب بالمكالمة
// متوافق مع مزوّدي TwiML (Twilio · Plivo · وما شابه): اربط رقمك على:
//    A call comes in  →  POST  https://<دومينك>/api/voice/incoming
// الفكرة: نرد بصوت (TTS مولّد عندنا) ونسجّل كلام العميل (<Record>) ثم نحوّله نصًا
//         (Groq STT) ونمرّره على نفس محرّك الطلب في المنصة.
import express, { Router } from 'express';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { q } from '../db.js';
import { validatePhone } from '../utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'uploads', 'voice');
const router = Router();
// المزوّدون يرسلون البيانات بصيغة form-urlencoded (Twilio/Plivo) — لا بد من محلّل لها
router.use(express.urlencoded({ extended: false }));

// ---------- أدوات ----------
function publicBase() {
  return String(config.publicUrl || '').replace(/\/$/, '') || 'http://localhost:' + (process.env.PORT || 4000);
}
function xml(s) { return `<?xml version="1.0" encoding="UTF-8"?><Response>${s}</Response>`; }
const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// نص → ملف صوتي منشور (لأن المزوّد يحتاج رابطًا يشغّله)
async function ttsUrl(text) {
  try {
    const { buildTtsAudio } = await import('../services/voice.js');
    const buf = await buildTtsAudio(String(text).slice(0, 400));
    if (!buf) return null;
    try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (e) {}
    const name = `v${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`;
    fs.writeFileSync(path.join(OUT_DIR, name), buf);
    // تنظيف الملفات الأقدم من ساعة
    try {
      const now = Date.now();
      for (const f of fs.readdirSync(OUT_DIR)) {
        const p = path.join(OUT_DIR, f);
        if (now - fs.statSync(p).mtimeMs > 3600e3) fs.unlinkSync(p);
      }
    } catch (e) {}
    return `${publicBase()}/uploads/voice/${name}`;
  } catch (e) { console.error('VOICE_TTS_URL_FAIL', e.message); return null; }
}

// يرد بصوت: <Play> لو نجح التوليد، وإلا <Say> (احتياطي)
async function playOrSay(text) {
  const url = await ttsUrl(text);
  return url ? `<Play>${esc(url)}</Play>` : `<Say language="ar" voice="Polly.Zeina">${esc(text)}</Say>`;
}
const recordTag = (step, extra = '') =>
  `<Record action="${esc(publicBase())}/api/voice/step?step=${esc(step)}" method="POST" maxLength="12" timeout="4" playBeep="true" trim="trim-silence" finishOnKey="#" ${extra}/>`;

// ---------- جلسة المكالمة (مفتاحها رقم المتصل) ----------
function sess(phone) {
  const r = q.get("SELECT * FROM whatsapp_sessions WHERE phone=?", phone);
  return { state: r?.state || 'idle', data: r ? JSON.parse(r.data_json || '{}') : {} };
}
function save(phone, state, data) {
  q.run(`INSERT INTO whatsapp_sessions (phone, restaurant_id, state, data_json, updated_at)
         VALUES (?, COALESCE((SELECT restaurant_id FROM whatsapp_sessions WHERE phone=?), 0), ?, ?, datetime('now'))
         ON CONFLICT(phone) DO UPDATE SET state=excluded.state, data_json=excluded.data_json, updated_at=datetime('now')`,
    phone, phone, state, JSON.stringify(data || {}));
}

// ---------- تحويل كلام العميل إلى نص ----------
async function speechToText(recordingUrl) {
  try {
    const { groqTranscribe } = await import('../services/voice.js');
    const auth = process.env.VOICE_SID && process.env.VOICE_TOKEN
      ? { username: process.env.VOICE_SID, password: process.env.VOICE_TOKEN } : undefined;
    const r = await axios.get(recordingUrl, { responseType: 'arraybuffer', timeout: 45000, auth });
    return (await groqTranscribe(Buffer.from(r.data), 'audio/wav')) || '';
  } catch (e) { console.error('VOICE_STT_FAIL', e.response?.status || e.message); return ''; }
}

// ---------- منيو مختصر للنطق ----------
function menuSpeech(rid, max = 5) {
  const items = q.all("SELECT name, price FROM items WHERE restaurant_id=? AND is_available=1 ORDER BY is_popular DESC, id LIMIT ?", rid, max);
  if (!items.length) return 'المنيو فاضي حاليًا';
  return items.map((i) => `${i.name} بـ ${(Number(i.price) / 100).toFixed(0)} ريال`).join('، و');
}

// 🧭 من هو العميل في هذه المكالمة؟ (وارد: From · صادر من Twilio: To)
// ⚠️ فخّ: validatePhone('') ترجّع '+966' (قيمة صحيحة!) — فنُصفّي الفراغ قبلها وإلا انقلبت الهوية
const normP = (v) => {
  const d = String(v || '').replace(/[^\d]/g, '');
  return d.length >= 9 ? validatePhone(d) : '';
};
function custPhone(req) {
  const qp = normP(req.query?.customer);
  if (qp) return qp;
  const from = normP(req.body?.From || req.body?.from || req.body?.caller);
  const to = normP(req.body?.To || req.body?.to);
  const tw = normP(config.twilio?.fromNumber);
  if (tw && from && from === tw && to) return to;   // مكالمة صادرة من رقمنا ⇒ العميل هو المُتَّصل عليه
  return from || to || '';
}

// ---------- ① بداية المكالمة ----------
router.post('/incoming', async (req, res) => {
  const phone = custPhone(req);
  // 🛡️ حد بسيط: ٤٠ مكالمة كحد أقصى لنفس الرقم في الساعة (حماية من الإساءة على توليد الصوت)
  try {
    const n = Number(q.get("SELECT COUNT(*) c FROM webhook_log WHERE kind='voice-call' AND summary=? AND created_at >= datetime('now','-1 hour')", String(phone).slice(-4))?.c || 0);
    if (n > 40) return res.type('text/xml').send(xml('<Say language="ar">عذرًا، عدد المكالمات كبير حاليًا. جرّب بعد قليل.</Say><Hangup/>'));
  } catch (e) {}
  q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('voice-call', ?, ?)",
    String(phone).slice(-4), JSON.stringify({ sid: req.body?.CallSid || req.body?.call_uuid || null }).slice(0, 200));
  save(phone, 'voice_call', { vStep: 'ask', voiceCart: [], vRestaurant: null });
  const greet = await playOrSay('السلام عليكم، معك تلي هم منصة الطلبات والتوصيل. وش تبي تطلب اليوم؟ قل اسم النشاط أو اسم الأكل.');
  res.type('text/xml').send(xml(`${greet}${recordTag('ask')}`));
});

// ---------- ② استقبال كلام العميل وتوجيهه ----------
router.post('/step', async (req, res) => {
  const phone = custPhone(req);
  const rec = req.body?.RecordingUrl || req.body?.recording_url || null;
  const debug = process.env.VOICE_DEBUG === '1' ? String(req.body?.debug_text || req.query?.debug_text || '') : '';
  let text = debug || (rec ? await speechToText(rec) : '');
  text = String(text || '').trim();
  if ((req.body?.Digits || req.body?.digits) && !text) text = String(req.body.Digits);

  const s = sess(phone);
  const data = { ...(s.data || {}) };
  let cart = Array.isArray(data.voiceCart) ? data.voiceCart : [];
  let rid = Number(data.vRestaurant || 0) || 0;

  try { q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('voice-step', ?, ?)", (text || '(فاضي)').slice(0, 60), JSON.stringify({ step: req.query?.step, rid }).slice(0, 200)); } catch (e) {}

  // عميل جديد بلا كلام مفهوم
  if (!text) {
    const say = await playOrSay('ما سمعتك زين. عيد لي وش تبي تطلب.');
    return res.type('text/xml').send(xml(`${say}${recordTag('ask')}`));
  }
  const t = text.toLowerCase();
  const bye = /(السلام|مع السلامة|شكرا|باي|اقفل|انهي)/.test(t) && !/(شاورما|طلب|ابغى|أبغى)/.test(t);
  if (bye && !cart.length) {
    return res.type('text/xml').send(xml(`${await playOrSay('شكرًا لتواصلك مع تلي هم، في أمان الله.')}<Hangup/>`));
  }

  const { parseVoiceOrder, localMatch } = await import('../services/voiceOrder.js');

  // ① ما فيه نشاط محدد ⇒ نبحث عن اسم النشاط في كلامه
  if (!rid) {
    const rows = q.all("SELECT id, name_ar AS name, 0 AS price FROM restaurants WHERE COALESCE(is_active,1)=1 LIMIT 200");
    const hit = localMatch(text, rows)[0];
    if (hit) {
      rid = Number(hit.item_id);
      data.vRestaurant = rid;
      const r = q.get("SELECT name_ar FROM restaurants WHERE id=?", rid);
      const say = await playOrSay(`تمام، ${r?.name_ar || 'النشاط'}. عندنا ${menuSpeech(rid)}. وش تختار؟`);
      save(phone, 'voice_call', { ...data, vStep: 'items' });
      return res.type('text/xml').send(xml(`${say}${recordTag('items')}`));
    }
    const say = await playOrSay('ما عرفت النشاط. عيد اسم النشاط، مثال: مطعم شاورما الضيافة.');
    return res.type('text/xml').send(xml(`${say}${recordTag('ask')}`));
  }

  // ② تأكيد الطلب؟
  if (/^(نعم|ايوه|أيوه|تمام|اكد|أكد|موافق|اوكي|طيب)$/.test(t.replace(/\s/g, ''))) {
    if (!cart.length) {
      const say = await playOrSay('ما فيه أصناف بعد. وش تبي تطلب؟');
      return res.type('text/xml').send(xml(`${say}${recordTag('items')}`));
    }
    const result = await handoffToChat(phone, rid, cart);
    const total = result.total || (cart.reduce((a, c) => a + Number(c.price || 0) * Number(c.quantity || 0), 0) / 100).toFixed(2);
    const say = await playOrSay(result.ok
      ? `تمام، طلبك جاهز بمجموع ${total} ريال. أرسلنا لك رسالة على تلي هم لإرسال موقعك وإتمام الدفع. شكرًا لثقتك.`
      : `ما قدرت أكمل الطلب. بنرسل لك رسالة ونكمل معك. شكرًا.`);
    save(phone, 'idle', { });
    return res.type('text/xml').send(xml(`${say}<Hangup/>`));
  }

  // ③ خلاص / لا يزيد
  if (/^(خلاص|بس|كذا|لا|كافي|هذا)$/.test(t.replace(/\s/g, '')) && cart.length) {
    const total = (cart.reduce((a, c) => a + Number(c.price || 0) * Number(c.quantity || 0), 0) / 100).toFixed(2);
    const say = await playOrSay(`المجموع ${total} ريال. أأكّد الطلب؟ قل نعم للتأكيد.`);
    save(phone, 'voice_call', { ...data, vStep: 'confirm' });
    return res.type('text/xml').send(xml(`${say}${recordTag('confirm')}`));
  }

  // ④ أصناف جديدة
  const items = q.all("SELECT id, name, price FROM items WHERE restaurant_id=? AND is_available=1", rid);
  const parsed = (await parseVoiceOrder(text, items))?.items || [];
  if (parsed.length) {
    for (const it of parsed) {
      const ex = cart.find((c) => Number(c.item_id) === Number(it.item_id));
      if (ex) ex.quantity += it.quantity; else cart.push({ item_id: it.item_id, name: it.name, price: it.price, quantity: it.quantity });
    }
    const total = (cart.reduce((a, c) => a + Number(c.price || 0) * Number(c.quantity || 0), 0) / 100).toFixed(2);
    const last = parsed.map((p) => `${p.quantity} ${p.name}`).join(' و');
    const say = await playOrSay(`تمام، ${last}. صار المجموع ${total} ريال. تبي زود شي؟ قل خلاص إذا خلصت.`);
    save(phone, 'voice_call', { ...data, voiceCart: cart, vStep: 'items' });
    return res.type('text/xml').send(xml(`${say}${recordTag('items')}`));
  }

  const say = await playOrSay(`ما فهمت الصنف. نعيد: عندنا ${menuSpeech(rid)}. وش تبي؟`);
  save(phone, 'voice_call', { ...data, voiceCart: cart });
  return res.type('text/xml').send(xml(`${say}${recordTag('items')}`));
});

// ---------- ③ تسليم الطلب للبوت (نفس حسابات المنصة: التوصيل · الخصم · الدفع) ----------
async function handoffToChat(phone, rid, cart) {
  try {
    const { ensureCustomer, saveSession, getSession } = await import('../services/flow.js');
    const { waSend } = await import('../services/whatsapp.js');
    let customer = q.get("SELECT * FROM customers WHERE phone=? OR phone=?", phone, validatePhone(phone));
    if (!customer) customer = ensureCustomer(phone);
    const cur = getSession(phone);
    saveSession(phone, 'cart', { ...(cur.data || {}), currentRestaurantId: rid, cart: { items: cart }, voiceCart: null });
    const total = (cart.reduce((a, c) => a + Number(c.price || 0) * Number(c.quantity || 0), 0) / 100).toFixed(2);
    const lines = cart.map((c) => `• ${c.quantity} × ${c.name} — ${(Number(c.price) * Number(c.quantity) / 100).toFixed(2)} ر.س`).join('\n');
    await waSend({ phone: customer.phone, restaurantId: rid, type: 'buttons',
      body: `☎️ *طلبك من المكالمة وصلنا!*\n\n${lines}\n━━━━━━━━━━\n💰 المجموع: *${total} ر.س*\n\n📍 أكمل بإرسال موقعك واختيار الدفع 👇`,
      buttons: [{ id: 'cart', title: '🛒 إتمام الطلب' }, { id: 'menu', title: '➕ أضف صنف' }] });
    return { ok: true, total };
  } catch (e) { console.error('VOICE_HANDOFF_FAIL', e.message); return { ok: false }; }
}

// ---------- ④ Wave: اتصال بصري (click-to-call) ----------
// POST /api/voice/call-me  { phone, restaurant_id? }  ⇒ يتصل على العميل من رقم المنصة
router.post('/call-me', async (req, res) => {
  const phone = validatePhone(req.body?.phone || req.body?.to || '');
  if (!phone) return res.status(400).json({ error: 'أرسل رقم الجوال (phone) بالصيغة الدولية +9665…' });
  const key = config.wave?.apiKey;
  if (!key) return res.status(400).json({ error: 'مفتاح Wave غير مضبوط', hint: 'أضف WAVE_API_KEY من إعدادات اللوحة (أو Render) — من wave.sa → API Keys' });
  // 🛡️ حد: ٥ اتصالات لنفس الرقم في الساعة
  try {
    const n = Number(q.get("SELECT COUNT(*) c FROM webhook_log WHERE kind='wave-callback' AND summary=? AND created_at >= datetime('now','-1 hour')", phone.slice(-4))?.c || 0);
    if (n >= 5) return res.status(429).json({ error: 'عدد المحاولات كبير — جرّب بعد قليل' });
  } catch (e) {}
  try {
    // ⚠️ Wave ترفض أي قيمة غير نصية في metadata (مثال: null) — نبنيها نصية فقط
    const meta = { source: 'telyham' };
    if (req.body?.restaurant_id != null && req.body.restaurant_id !== '') meta.restaurant_id = String(req.body.restaurant_id);
    const payload = { to: phone, metadata: meta };
    if (req.body?.caller_id_name || true) payload.caller_id_name = String(req.body?.caller_id_name || 'Tely Ham');
    if (config.wave.fromNumber) payload.caller_id_number = String(config.wave.fromNumber);
    if (req.body?.from_queue) payload.from_queue = String(req.body.from_queue);
    const r = await axios.post(`${config.wave.baseUrl}/v1/callback`, payload, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 30000 });
    try { q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('wave-callback', ?, ?)", phone.slice(-4), JSON.stringify({ status: r.status, call_id: r.data?.call_id || r.data?.id || null }).slice(0, 200)); } catch (e) {}
    return res.json({ ok: true, sandbox: String(key).startsWith('sk_sandbox'), data: r.data });
  } catch (e) {
    const st = e.response?.status || null;
    const code = e.response?.data?.error_code || e.response?.data?.error?.code || null;
    const hint = code === 'SANDBOX_EXPIRED' ? 'انتهت نافذة الساندبوكس (٣٠ دقيقة من أول استدعاء) — اطلب Go-Live من لوحة Wave'
      : code === 'SANDBOX_DESTINATION_NOT_ALLOWED' ? 'في الساندبوكس نتصل فقط على رقمك أنت (رقم التسجيل) — للأرقام الأخرى تحتاج ترقية الإنتاج'
      : st === 401 ? 'المفتاح مرفوض — تأكد أنه من Wave → API Keys' : 'راجع المفتاح أو الصلاحيات';
    try { q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('wave-error', ?, ?)", String(code || st).slice(0, 60), String(e.message).slice(0, 200)); } catch (_) {}
    return res.status(400).json({ error: e.response?.data?.message || e.message, status: st, error_code: code, hint, raw: e.response?.data || null });
  }
});

// 🧪 رابط تجربة بضغطة: افتحه من جوالك ⇒ يرن جوالك فورًا
//   https://telyham.com/api/voice/wave/test-call            (يستخدم الرقم المحفوظ)
//   https://telyham.com/api/voice/wave/test-call?phone=%2B9665XXXXXXXX (رقم آخر مسموح في الساندبوكس)
router.get('/wave/test-call', async (req, res) => {
  const phone = validatePhone(req.query.phone || config.wave?.fromNumber || '');
  const key = config.wave?.apiKey;
  if (!phone) return res.json({ ok: false, error: 'حدّد رقم الجوال في ?phone=+9665… أو احفظ WAVE_FROM_NUMBER' });
  if (!key) return res.json({ ok: false, error: 'مفتاح Wave غير مضبوط — احفظه في إعدادات اللوحة' });
  try {
    const r = await axios.post(`${config.wave.baseUrl}/v1/callback`, {
      to: phone, caller_id_name: 'Tely Ham', metadata: { source: 'telyham' },
      ...(config.wave.fromNumber ? { caller_id_number: String(config.wave.fromNumber) } : {}),
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 30000 });
    try { q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('wave-callback', ?, ?)", String(phone).slice(-4), JSON.stringify({ via: 'test-call', status: r.status, id: r.data?.call_id || null }).slice(0, 200)); } catch (e) {}
    return res.json({ ok: true, message: '🔔 جاري الاتصال على ' + phone + ' … استقبل على جوالك', data: r.data });
  } catch (e) {
    const st = e.response?.status || null;
    const code = e.response?.data?.error_code || null;
    const hint = code === 'SANDBOX_EXPIRED' ? 'انتهت نافذة الساندبوكس (٣٠ دقيقة) — اطلب Go-Live'
      : code === 'SANDBOX_DESTINATION_NOT_ALLOWED' ? 'الساندبوكس يتصل على رقم التسجيل فقط'
      : st === 401 ? 'المفتاح مرفوض' : 'راجع الخطأ';
    return res.status(400).json({ ok: false, error: e.response?.data?.message || e.message, status: st, error_code: code, hint, raw: e.response?.data || null });
  }
});

// ---------- 📞 Twilio: نحن نتصل على جوالك (إنت ما تدفع شي — يُخصم من رصيد Twilio) ----------
//   https://telyham.com/api/voice/twilio/call-me
//   ?phone=%2B9665XXXXXXXX   (اختياري — وإلا يستخدم TWILIO_TO_NUMBER المحفوظ)
router.get('/twilio/call-me', async (req, res) => {
  const t = config.twilio || {};
  if (!t.accountSid || !t.authToken || !t.fromNumber) {
    return res.json({ ok: false, error: 'أضف بيانات Twilio في إعدادات اللوحة: Account SID · Auth Token · رقم Twilio' });
  }
  const phone = validatePhone(req.query.phone || t.toNumber || '');
  if (!phone) return res.json({ ok: false, error: 'حدّد رقم جوالك: ?phone=%2B9665XXXXXXXX أو احفظ TWILIO_TO_NUMBER في الإعدادات' });
  const url = `${publicBase()}/api/voice/incoming?customer=${encodeURIComponent(phone)}`;
  try {
    const body = new URLSearchParams({ To: phone, From: t.fromNumber, Url: url, Method: 'POST', Timeout: '30' });
    const r = await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}/Calls.json`, body.toString(), {
      auth: { username: t.accountSid, password: t.authToken },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });
    try { q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('twilio-call', ?, ?)", String(phone).slice(-4), JSON.stringify({ sid: r.data?.sid, status: r.data?.status }).slice(0, 200)); } catch (e) {}
    return res.json({ ok: true, message: `🔔 جاري الاتصال على ${phone} … استقبل على جوالك`, sid: r.data?.sid, status: r.data?.status });
  } catch (e) {
    const st = e.response?.status || null;
    const code = e.response?.data?.code || null;
    const hint = code === 21219 ? 'حساب تجريبي: لا يتصل إلا بأرقام موثّقة — أضف جوالك في Verified Caller IDs'
      : code === 21608 ? 'رقمك غير موثّق في Twilio — Phone Numbers → Verified Caller IDs → أضف رقمك'
      : code === 21215 ? 'رقم Twilio غير مسموح للإرسال، أو صلاحية الدولة (السعودية) موقوفة في Geographic Permissions'
      : code === 21211 ? 'صيغة الرقم غير صحيحة — استخدم +9665XXXXXXXX'
      : st === 401 ? 'Account SID أو Auth Token خطأ' : 'راجع الخطأ';
    return res.json({ ok: false, error: e.response?.data?.message || e.message, code, status: st, hint, raw: e.response?.data || null });
  }
});

// 📲 توثيق جوالك للحساب التجريبي — بضغطة: Twilio يتصل ويطلب منك الكود من الكيبورد
//   https://telyham.com/api/voice/twilio/verify-number
router.get('/twilio/verify-number', async (req, res) => {
  const t = config.twilio || {};
  if (!t.accountSid || !t.authToken) return res.json({ ok: false, error: 'بيانات Twilio غير مضبوطة (SID/التوكن)' });
  const phone = validatePhone(req.query.phone || t.toNumber || '');
  if (!phone) return res.json({ ok: false, error: 'حدّد الرقم ?phone=%2B9665XXXXXXXX' });
  const auth = { username: t.accountSid, password: t.authToken };
  try {
    const v = await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}/OutgoingCallerIds.json?PageSize=50`, { auth, timeout: 20000 });
    const list = (v.data?.outgoing_caller_ids || []).map((x) => x.phone_number);
    if (list.includes(phone)) return res.json({ ok: true, already: true, verifiedNumbers: list, message: '✅ رقمك موثّق أصلًا — افتح رابط الاتصال الآن 🔔' });
    const body = new URLSearchParams({ PhoneNumber: phone, FriendlyName: 'Tely Ham' });
    const r = await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}/ValidationRequests.json`, body.toString(), {
      auth, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000,
    });
    return res.json({
      ok: true, already: false, phone,
      message: `📞 Twilio يتصل الآن على ${phone} — اررد ثم اكتب الكود من كيبورد الجوال (أو اضغط أي رقم ليُقرأ لك الكود الثاني)`,
      code_read_aloud_hint: 'Twilio سيقرأ لك كودًا، اكتبه على الكيبورد وانتهى التوثيق',
      code: r.data?.validation_code || null,
      callSid: r.data?.call_sid || null,
    });
  } catch (e) {
    const st = e.response?.status || null;
    const code = e.response?.data?.code || null;
    const hint = code === 21421 ? 'صيغة الرقم غير مقبولة لهذي الدولة — تأكد أنه +9665XXXXXXXX'
      : code === 21422 ? 'لا يمكن توثيق هذا الرقم (رقم Twilio نفسه أو غير مدعوم)'
      : code === 21608 ? 'رقمك غير مسجّل — راجع الخطوة'
      : st === 401 ? 'بيانات Twilio غير صحيحة' : 'راجع الخطأ';
    return res.json({ ok: false, error: e.response?.data?.message || e.message, code, status: st, hint, raw: e.response?.data || null });
  }
});

// 📊 هل Twilio مضبوط؟ + تشخيص عميق (اختبار المصادقة · حالة الحساب · الأرقام الموثّقة)
router.get('/twilio/health', async (req, res) => {
  const t = config.twilio || {};
  const out = {
    ok: true,
    configured: Boolean(t.accountSid && t.authToken && t.fromNumber),
    sidHead: t.accountSid ? t.accountSid.slice(0, 2) : null,
    sidLen: t.accountSid ? t.accountSid.length : 0,
    sidTail: t.accountSid ? t.accountSid.slice(-4) : null,
    tokenLen: t.authToken ? t.authToken.length : 0,
    tokenTail: t.authToken ? t.authToken.slice(-4) : null,
    fromNumber: t.fromNumber || null,
    toNumber: t.toNumber || null,
    hasToken: Boolean(t.authToken),
  };
  if (!t.accountSid || !t.authToken) return res.json(out);
  const auth = { username: t.accountSid, password: t.authToken };
  try {
    const a = await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}.json`, { auth, timeout: 20000 });
    out.auth = { ok: true, name: a.data?.friendly_name, type: a.data?.type, status: a.data?.status };
    try {
      const v = await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}/OutgoingCallerIds.json?PageSize=20`, { auth, timeout: 20000 });
      out.verifiedNumbers = (v.data?.outgoing_caller_ids || []).map((x) => x.phone_number);
      out.toVerified = out.verifiedNumbers.includes(t.toNumber);
    } catch (e) { out.verifiedError = e.response?.data?.message || e.message; }
    try {
      const n = await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}/IncomingPhoneNumbers.json?PageSize=20`, { auth, timeout: 20000 });
      out.numbers = (n.data?.incoming_phone_numbers || []).map((x) => x.phone_number);
    } catch (e) {}
  } catch (e) {
    out.auth = { ok: false, status: e.response?.status || null, code: e.response?.data?.code || null, message: e.response?.data?.message || e.message };
    out.diagnosis = String(t.accountSid).slice(0, 2) !== 'AC'
      ? 'خانة Account SID لا تبدأ بـ AC ⇒ غالبًا لصقت شيئًا آخر (API Key أو التوكن) فيها ✗'
      : (String(t.authToken).length < 30 ? 'Auth Token قصير جدًا ⇒ يبدو ناقصًا ✗' : 'SID والتوكن غير متطابقين ⇒ أعد نسخهما من نفس قسم Account Info ⧉');
  }
  return res.json(out);
});

// ---------- 🎙️ تجربة: نتصل ثم نشغّل صوتنا داخل المكالمة (يحتاج calls:write) ----------
//   GET /api/voice/wave/say-demo            → يتصل على الرقم المحفوظ ويشغّل ترحيبًا صوتيًا
//   GET /api/voice/wave/say-demo?text=...   → نفس الشي بنص مخصص
router.get('/wave/say-demo', async (req, res) => {
  const key = config.wave?.apiKey;
  if (!key) return res.json({ ok: false, error: 'مفتاح Wave غير مضبوط' });
  const phone = validatePhone(req.query.phone || config.wave?.fromNumber || '');
  if (!phone) return res.json({ ok: false, error: 'حدّد رقم الجوال' });
  const text = String(req.query.text || 'أهلًا وسهلًا، معك تلي هم منصة الطلبات والتوصيل. وش تبي تطلب اليوم؟');
  const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const out = { steps: [] };
  try {
    // ① ابدأ المكالمة
    const cb = await axios.post(`${config.wave.baseUrl}/v1/callback`, { to: phone, caller_id_name: 'Tely Ham', metadata: { source: 'telyham-demo' } }, { headers: H, timeout: 30000 });
    const callId = cb.data?.call_id || cb.data?.id;
    out.steps.push({ step: 'callback', ok: true, call_id: callId, status: cb.data?.status });
    if (!callId) return res.json({ ok: false, out, raw: cb.data });
    // ② ولّد صوتنا وانشره على رابط عام https
    const url = await ttsUrl(text);
    out.steps.push({ step: 'tts', ok: !!url, url: url || null });
    if (!url) return res.json({ ok: false, out, error: 'تعذّر توليد الصوت' });
    // ③ شغّل الصوت (مع إعادة المحاولة حتى يرد العميل)
    let played = null;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const pr = await axios.post(`${config.wave.baseUrl}/v1/calls/${callId}/play`, { url }, { headers: H, timeout: 25000 });
        played = { attempt: i + 1, status: pr.status, data: pr.data };
        break;
      } catch (e) {
        played = { attempt: i + 1, status: e.response?.status || null, error: e.response?.data?.message || e.message, code: e.response?.data?.error_code || null };
        if (e.response?.status === 403 || e.response?.status === 404) break;   // صلاحية/مكالمة غير موجودة ⇒ لا فائدة من التكرار
      }
    }
    out.steps.push({ step: 'play', ...played });
    try { q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('wave-demo', ?, ?)", String(phone).slice(-4), JSON.stringify(out).slice(0, 600)); } catch (e) {}
    return res.json({ ok: !!(played && played.status === 200), out });
  } catch (e) {
    const st = e.response?.status || null;
    const code = e.response?.data?.error_code || null;
    out.steps.push({ step: 'error', status: st, code, error: e.response?.data?.message || e.message });
    return res.json({ ok: false, out, raw: e.response?.data || null });
  }
});

// ---------- ⑤ Wave: استقبال أحداث المكالمات (Webhooks) ----------
// أضف هذا الرابط في لوحة Wave → Webhooks: https://<دومينك>/api/voice/wave/webhook
router.post('/wave/webhook', (req, res) => {
  const ev = req.body || {};
  try {
    q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('wave-event', ?, ?)",
      String(ev.event || 'unknown').slice(0, 40),
      JSON.stringify({ call_id: ev.data?.call_id || null, status: ev.data?.status || null, duration: ev.data?.duration || null }).slice(0, 300));
  } catch (e) {}
  res.json({ ok: true });   // Wave يعيد المحاولة لو ما رجّعنا 2xx
});

// ---------- ⑥ حالة Wave ----------
router.get('/wave/status', (req, res) => {
  const k = String(config.wave?.apiKey || '');
  res.json({ ok: true, configured: !!k, mode: !k ? 'none' : (k.startsWith('sk_sandbox') ? 'sandbox' : 'live'),
    fromNumber: config.wave?.fromNumber || null, keyTail: k ? k.slice(-4) : null });
});

// ---------- فحص سريع ----------
router.get('/health', (req, res) => res.json({ ok: true, base: publicBase(), provider: config.whatsapp.provider, hasTts: true }));

export default router;
