import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { addRecipient, approveRecipient, rejectRecipient, sendReportTo, localNow, shiftDate } from '../services/reporting.js';

const router = Router();
router.use(requireAuth);

// قائمة مستلمي التقارير
router.get('/', requireRole('admin'), (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const rows = status
    ? q.all(`SELECT p.*, r.name_ar AS restaurant_name FROM report_recipients p LEFT JOIN restaurants r ON r.id=p.restaurant_id WHERE p.status=? ORDER BY (p.status='pending') DESC, p.id DESC LIMIT 300`, status)
    : q.all(`SELECT p.*, r.name_ar AS restaurant_name FROM report_recipients p LEFT JOIN restaurants r ON r.id=p.restaurant_id ORDER BY (p.status='pending') DESC, p.id DESC LIMIT 300`);
  res.json(rows);
});

// إضافة مباشرة من المنصة (تُعتمد فوراً)
router.post('/', requireRole('admin'), (req, res) => {
  const { restaurant_id, name, phone, hour } = req.body || {};
  if (!restaurant_id || !phone) return res.status(400).json({ error: 'النشاط والجوال مطلوبان' });
  if (!q.get("SELECT id FROM restaurants WHERE id=?", Number(restaurant_id))) return res.status(400).json({ error: 'النشاط غير موجود' });
  const row = addRecipient(Number(restaurant_id), name, phone, hour || '23:30');
  q.run("UPDATE report_recipients SET status='approved', updated_at=datetime('now') WHERE id=?", row.id);
  res.json({ ok: true, recipient: q.get("SELECT * FROM report_recipients WHERE id=?", row.id) });
});

router.post('/:id/approve', requireRole('admin'), async (req, res) => {
  const r = await approveRecipient(Number(req.params.id));
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

router.post('/:id/reject', requireRole('admin'), async (req, res) => {
  const r = await rejectRecipient(Number(req.params.id), String(req.body?.note || ''));
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// تعديل (الاسم / وقت التقرير / الحالة)
router.put('/:id', requireRole('admin'), (req, res) => {
  const { name, report_hour, status } = req.body || {};
  q.run(`UPDATE report_recipients SET
      name=COALESCE(?,name),
      report_hour=COALESCE(?,report_hour),
      status=COALESCE(?,status),
      updated_at=datetime('now')
    WHERE id=?`, name || null, report_hour || null, status || null, Number(req.params.id));
  res.json({ ok: true, recipient: q.get("SELECT * FROM report_recipients WHERE id=?", Number(req.params.id)) });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  q.run("DELETE FROM report_recipients WHERE id=?", Number(req.params.id));
  res.json({ ok: true });
});

// ⏰ وقت تقرير الإدارة المجمّع
router.post('/platform/hour', requireRole('admin'), async (req, res) => {
  const { parseReportHour, setRecipientHour } = await import('../services/reporting.js');
  const raw = req.body?.hour;
  const hour = parseReportHour(raw) || String(raw || '').slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(hour)) return res.status(400).json({ error: 'وقت غير صحيح — مثال: 00:30' });
  q.run("INSERT INTO app_settings (key, value, updated_at) VALUES ('PLATFORM_REPORT_HOUR', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')", hour);
  res.json({ ok: true, hour });
});

// 🏛 تقرير الإدارة المجمّع (كل الأنشطة + حصة المنصة) — إرسال/معاينة
router.post('/platform/send', requireRole('admin'), async (req, res) => {
  const { localNow, shiftDate, sendPlatformReport, buildPlatformReport, platformStats, PLATFORM_REPORT_HOUR, PLATFORM_SHARE_PERCENT } = await import('../services/reporting.js');
  const { date } = localNow();
  const which = String(req.query.which || req.body?.which || 'yesterday');
  const target = which === 'today' ? date : shiftDate(date, -1);
  const preview = String(req.query.preview || '') === '1' || req.body?.preview;
  if (preview) {
    return res.json({ date: target, hour: PLATFORM_REPORT_HOUR, sharePercent: PLATFORM_SHARE_PERCENT, text: buildPlatformReport(target), stats: platformStats(target) });
  }
  try {
    const r = await sendPlatformReport(target, { force: true });
    res.json({ ok: r.ok, date: target, to: r.to || null, share: r.stats?.share });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 📄 معاينة الفاتورة المختومة (PDF) — للإدارة
router.get('/:id/invoice', requireRole('admin'), async (req, res) => {
  const row = q.get("SELECT * FROM report_recipients WHERE id=?", Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'غير موجود' });
  const { buildInvoiceFiles } = await import('../services/invoice.js');
  const { localNow, shiftDate } = await import('../services/reporting.js');
  const { date } = localNow();
  const target = String(req.query.which || 'today') === 'yesterday' ? shiftDate(date, -1) : date;
  try {
    const inv = await buildInvoiceFiles(row.restaurant_id, target);
    if (!inv) return res.status(404).json({ error: 'تعذر إنشاء الفاتورة' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${inv.invoice.no}.pdf"`);
    res.send(inv.pdf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// إرسال تقرير الآن (اختبار / بناءً على الطلب) — which=today|yesterday
router.post('/:id/send', requireRole('admin'), async (req, res) => {
  const row = q.get("SELECT * FROM report_recipients WHERE id=?", Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'غير موجود' });
  const { date } = localNow();
  const target = String(req.body?.which || 'today') === 'yesterday' ? shiftDate(date, -1) : date;
  const ok = await sendReportTo(row.phone, row.restaurant_id, target);
  res.json({ ok, date: target, to: row.phone });
});

export default router;
