import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { q } from '../db.js';
import { backupNow, scheduleBackup, dbLooksSane, dbUsable, repairInPlace, restoreFromHistory } from '../services/backup.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();
router.use(requireAuth, requireRole('admin'));

// تصدير نسخة من قاعدة البيانات (قبل النشر)
router.get('/export', (req, res) => {
  const dbPath = config.dbPath;
  if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'لا توجد قاعدة' });
  res.download(dbPath, 'wassal.db');
});

// استيراد النسخة (بعد النشر)
router.post('/import', (req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      const dbPath = config.dbPath;
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      // إغلاق الاتصال الحالي عبر إعادة تشغيل السيرفر بعد الكتابة
      fs.writeFileSync(dbPath + '.import', Buffer.concat(chunks));
      fs.renameSync(dbPath + '.import', dbPath);
      res.json({ ok: true, size: Buffer.concat(chunks).length, note: 'أعد تشغيل السيرفر لتفعيل القاعدة المستوردة' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});


// 🔎 حالة القاعدة: سلامة الملف + أعداد الصفوف الرئيسية
router.get('/health', (req, res) => {
  const out = { path: config.dbPath, sane: dbLooksSane(), usable: dbUsable(), size: 0, counts: {} };
  try { out.size = fs.statSync(config.dbPath).size; } catch {}
  for (const t of ['restaurants', 'customers', 'conversations', 'orders', 'business_registrations', 'restaurant_users', 'captains', 'app_settings', 'admins', 'telegram_links']) {
    try { out.counts[t] = Number(q.get(`SELECT COUNT(*) c FROM "${t}"`).c) || 0; } catch { out.counts[t] = null; }
  }
  res.json(out);
});

// ♻️ استرجاع آخر نسخة سليمة من تاريخ النسخ الاحتياطية (يكتب الملف — يحتاج إعادة تشغيل الخدمة)
// ⚠️ لا نلمس ملفات قاعدة البيانات أثناء عمل الخدمة (القاعدة مفتوحة — الاستبدال الحيّ يفسدها).
// لذلك نسجّل «طلب إصلاح» ويُنفَّذ في الإقلاع التالي حيث لا يوجد أي اتصال مفتوح.
router.post('/restore', requireRole('admin'), async (req, res) => {
  if (String(req.query.confirm || req.body?.confirm || '') !== 'YES') return res.status(400).json({ error: 'أرسل confirm=YES للتأكيد' });
  try {
    q.run(`INSERT INTO app_settings (key,value,updated_at) VALUES ('restore_request','YES',datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value='YES', updated_at=datetime('now')`);
    res.json({ ok: true, queued: true, note: 'تم تسجيل طلب الإصلاح/الاسترجاع — أعد تشغيل الخدمة (Restart) لتنفيذه بأمان' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// تفريغ البيانات التجريبية: المطاعم · المشتركين · الكباتن · الطلبات
// يُبقي: حساب المدير · إعدادات المنصة · أنواع الأنشطة
const DEMO_TABLES = [
  'orders', 'order_events', 'payments', 'captain_offers', 'captains', 'restaurant_captains',
  'restaurant_users', 'items', 'categories', 'branches', 'offers', 'coupons', 'ads_campaigns',
  'customers', 'customer_locations', 'loyalty_transactions', 'business_registrations',
  'conversations', 'whatsapp_sessions', 'webhook_log', 'wa_phone_restaurant', 'restaurants'
];
const KEEP_TABLES = ['admins', 'app_settings', 'business_types', 'loyalty_settings', 'loyalty_tiers'];

router.post('/reset-demo', requireRole('admin'), async (req, res) => {
  const confirm = String(req.query.confirm || req.body?.confirm || '');
  if (confirm !== 'YES') return res.status(400).json({ error: 'أرسل confirm=YES للتأكيد' });
  const existing = new Set(q.all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name));
  const cleared = {};
  try {
    await backupNow();                                   // نسخة أمان قبل الحذف
    for (const t of DEMO_TABLES) {
      if (!existing.has(t)) continue;
      const before = Number(q.get(`SELECT COUNT(*) c FROM "${t}"`).c) || 0;
      if (before) q.run(`DELETE FROM "${t}"`);
      cleared[t] = before;
    }
    try {
      q.run(`DELETE FROM sqlite_sequence WHERE name IN (${DEMO_TABLES.map(() => '?').join(',')})`, ...DEMO_TABLES);
    } catch (e) { /* لا يوجد عدّاد */ }
    const kept = {};
    for (const t of KEEP_TABLES) if (existing.has(t)) kept[t] = Number(q.get(`SELECT COUNT(*) c FROM "${t}"`).c) || 0;
    scheduleBackup();                                    // ارفع النسخة النظيفة
    console.log('DB_RESET_DEMO_OK', JSON.stringify(cleared));
    res.json({ ok: true, cleared, kept });
  } catch (e) {
    res.status(500).json({ error: e.message, cleared });
  }
});

export default router;
