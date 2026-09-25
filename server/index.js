import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { initRealtime } from './services/realtime.js';
import apiRouter from './routes/index.js';
import { applySettings } from './services/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/sim', express.static(path.join(__dirname, 'public/sim')));
app.use('/api', apiRouter);

const server = http.createServer(app);
initRealtime(server);

// إعدادات لوحة التحكم (توكن واتساب، مفاتيح الصوت) تُطبّق فوق متغيرات البيئة
let settingsApplied = 0;
try {
  const applied = applySettings();
  settingsApplied = Object.keys(applied).length;
} catch (e) { console.error('applySettings failed', e.message); }

// كلمة مرور المدير من متغير البيئة — تثبت بعد كل استعادة للقاعدة
// (لأن تغيير كلمة المرور من الواجهة يضيع مع استعادة النسخة الاحتياطية)
try {
  if (process.env.ADMIN_PASSWORD) {
    const { q } = await import('./db.js');
    const bcrypt = (await import('bcryptjs')).default;
    const row = q.get("SELECT * FROM admins ORDER BY id LIMIT 1");
    if (row && !bcrypt.compareSync(String(process.env.ADMIN_PASSWORD), row.password_hash)) {
      q.run("UPDATE admins SET password_hash=? WHERE id=?", bcrypt.hashSync(String(process.env.ADMIN_PASSWORD), 10), row.id);
      console.log('ADMIN_PASSWORD_SYNCED');
    }
  }
} catch (e) { console.error('ADMIN_PASSWORD_SYNC_FAIL', e.message); }

// ملخص القاعدة عند الإقلاع (لتشخيص ثبات البيانات)
try {
  const { q } = await import('./db.js');
  const c = (s) => q.get(s)?.c ?? '?';
  console.log('DB_SUMMARY', `restaurants=${c('SELECT COUNT(*) c FROM restaurants')}`,
    `conversations=${c('SELECT COUNT(*) c FROM conversations')}`,
    `orders=${c('SELECT COUNT(*) c FROM orders')}`);
} catch (e) { console.error('DB_SUMMARY_FAIL', e.message); }

// production: serve client build
const clientDist = path.join(__dirname, '../client/dist');
app.use(express.static(clientDist));
app.get(/^\/(?!api|sim|uploads).*/, (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'), err => {
    if (err) res.send('خادم وصل يعمل ✅ — شغّل الواجهة عبر `npm run dev` في مجلد client');
  });
});

// نسخة احتياطية قبل إيقاف الخدمة (أثناء النشر) — تقلل ضياع البيانات
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try {
      const { backupNow } = await import('./services/backup.js');
      await backupNow();
      console.log('DB_BACKUP_ON_SHUTDOWN_OK');
    } catch (e) { console.error('DB_BACKUP_ON_SHUTDOWN_FAIL', e.message); }
    process.exit(0);
  });
}

server.listen(config.port, () => console.log(`🚀 منصة وصل تعمل على http://localhost:${config.port} (دفع: ${config.paymentMode} | واتساب: ${config.whatsapp.provider} | إعدادات اللوحة: ${settingsApplied})`));

// نسخ احتياطي دوري كل دقيقتين (إضافة للنسخ الفوري بعد الطلبات)
// 📊 تقرير المبيعات اليومي — فحص كل ٥ دقائق (مع تعويض لو كان السيرفر نائماً)
import('./services/reporting.js').then(({ runDueReports }) => {
  setInterval(() => runDueReports().catch(e => console.error('REPORT_LOOP_FAIL', e.message)), 5 * 60 * 1000);
  setTimeout(() => runDueReports().then(n => { if (n) console.log('REPORTS_CATCHUP', n); }).catch(() => {}), 25000);
});

import('./services/backup.js').then(({ scheduleBackup, backupNow }) => {
  setInterval(scheduleBackup, 2 * 60 * 1000);
  console.log('🔄 النسخ الاحتياطي التلقائي مفعّل (كل دقيقتين)');
  // نسخة عند الإقلاع إذا كانت القاعدة فيها بيانات
  setTimeout(() => { backupNow().catch(() => {}); }, 15000);
});
