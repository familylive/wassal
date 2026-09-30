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

// ---------- ① بداية المكالمة ----------
router.post('/incoming', async (req, res) => {
  const from = validatePhone(req.body?.From || req.body?.from || req.body?.caller || '');
  const phone = from || String(req.body?.From || '').replace(/^\+/, '');
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
  const from = validatePhone(req.body?.From || req.body?.from || req.body?.caller || '');
  const phone = from || String(req.body?.From || req.body?.To || '').replace(/^\+/, '');
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
    const r = await axios.post(`${config.wave.baseUrl}/v1/callback`, {
      to: phone,
      caller_id_name: req.body?.caller_id_name || 'تلي هم',
      caller_id_number: config.wave.fromNumber || undefined,
      metadata: { source: 'telyham', restaurant_id: req.body?.restaurant_id || null },
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 30000 });
    try { q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('wave-callback', ?, ?)", phone.slice(-4), JSON.stringify({ status: r.status, call_id: r.data?.call_id || r.data?.id || null }).slice(0, 200)); } catch (e) {}
    return res.json({ ok: true, sandbox: String(key).startsWith('sk_sandbox'), data: r.data });
  } catch (e) {
    const st = e.response?.status || null;
    const code = e.response?.data?.error_code || e.response?.data?.error?.code || null;
    const hint = code === 'SANDBOX_EXPIRED' ? 'انتهت نافذة الساندبوكس (٣٠ دقيقة من أول استدعاء) — اطلب Go-Live من لوحة Wave'
      : code === 'SANDBOX_DESTINATION_NOT_ALLOWED' ? 'في الساندبوكس نتصل فقط على رقمك أنت (رقم التسجيل) — للأرقام الأخرى تحتاج ترقية الإنتاج'
      : st === 401 ? 'المفتاح مرفوض — تأكد أنه من Wave → API Keys' : 'راجع المفتاح أو الصلاحيات';
    try { q.run("INSERT INTO webhook_log (kind, summary, raw) VALUES ('wave-error', ?, ?)", String(code || st).slice(0, 60), String(e.message).slice(0, 200)); } catch (_) {}
    return res.status(400).json({ error: e.response?.data?.message || e.message, status: st, error_code: code, hint });
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
