import { Router } from 'express';
import axios from 'axios';
import config from '../config.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { publicSettings, saveSettings, parseEnvText } from '../services/settings.js';

const router = Router();
router.use(requireAuth);

// قراءة الإعدادات الحالية (التوكن والمفاتيح مقنّعة)
router.get('/', requireRole('admin'), (req, res) => {
  res.json(publicSettings());
});

// تعديل الإعدادات — يقبل حقولاً مباشرة أو نص KEY=VALUE في الحقل raw
router.put('/', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  let patch = {};
  if (b.raw) patch = { ...parseEnvText(b.raw) };
  for (const k of Object.keys(b)) {
    if (k === 'raw') continue;
    if (b[k] === '' || b[k] === null || b[k] === undefined) continue;
    patch[k] = b[k];
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'لا توجد قيم للتحديث' });
  try {
    const out = saveSettings(patch);
    res.json({ ok: true, applied: Object.keys(patch), settings: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// إرسال رسالة اختبار حقيقية للتأكد أن التوكن يعمل — يعرض رسالة ميتا كما هي
router.post('/test-whatsapp', requireRole('admin'), async (req, res) => {
  const to = String(req.body?.phone || '').replace(/[^\d]/g, '');
  if (to.length < 10) return res.status(400).json({ ok: false, error: 'أدخل رقم الجوال بالصيغة الدولية، مثال: 966501234567' });
  const { token, phoneNumberId, apiUrl, provider } = config.whatsapp;
  if (!token) return res.status(400).json({ ok: false, error: 'ما فيه توكن محفوظ — الصق التوكن واحفظ أولاً' });
  if (provider === 'simulator') return res.status(400).json({ ok: false, error: 'المزود حالياً simulator — اختر cloud أولاً' });
  const text = String(req.body?.text || '✅ رسالة اختبار من منصة واتس هم — الإرسال يعمل');
  try {
    const r = await axios.post(`${apiUrl}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
    res.json({ ok: true, sent_to: to, meta: r.data });
  } catch (e) {
    const d = e.response?.data?.error || { message: e.message, code: e.response?.status || null };
    res.status(400).json({ ok: false, error: `${d.code ? '(' + d.code + ') ' : ''}${d.message || 'فشل الإرسال'}`, details: d });
  }
});

export default router;
