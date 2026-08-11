import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
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

export default router;
