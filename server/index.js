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
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { try { req.rawBody = buf; } catch (e) {} } }));

// 🛡️ تحديد معدل الطلبات — قبل تركيب المسارات حتى يعمل فعلاً
app.set('trust proxy', 1);   // وراء Render: نأخذ IP العميل الحقيقي
const { loginLimiter, webhookLimiter, apiLimiter } = await import('./middleware/rateLimit.js');
app.use('/api/auth/login', loginLimiter);
app.use('/api/whatsapp/webhook', webhookLimiter);
app.use('/api/dbadmin', apiLimiter);

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/sim', express.static(path.join(__dirname, 'public/sim')));

// 🩺 فحص عام (بلا بيانات حساسة): هل ملف قاعدة البيانات سليم؟ — للمراقبة من الخارج
// 📞 /call/<token> — رابط اتصال مؤقت للكابتن: لا يحوي رقمًا، ويتوقف فور إغلاق الطلب
app.get('/call/:token', async (req, res) => {
  const page = (icon, title, body, color) => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8" />`
    + `<meta name="viewport" content="width=device-width,initial-scale=1" /><title>${title}</title>`
    + `<style>body{font-family:system-ui,-apple-system,'Segoe UI',Tahoma,sans-serif;background:#f6f7f9;margin:0;padding:24px;text-align:center}`
    + `.card{background:#fff;border-radius:18px;padding:26px 20px;max-width:420px;margin:12vh auto;box-shadow:0 6px 24px rgba(0,0,0,.08)}`
    + `h1{font-size:20px;margin:8px 0 6px;color:${color}}p{color:#555;font-size:15px;line-height:1.8;margin:6px 0}`
    + `.btn{display:block;margin:18px 0 6px;background:#0b7a3b;color:#fff;text-decoration:none;padding:15px;border-radius:12px;font-size:18px;font-weight:700}`
    + `.num{direction:ltr;font-size:22px;font-weight:700;color:#111;letter-spacing:1px;margin:10px 0}</style></head><body><div class="card">`
    + `<div style="font-size:44px">${icon}</div><h1>${title}</h1>${body}</div></body></html>`;
  const gone = (code, icon, title, body) => res.status(code).send(page(icon, title, body, '#b3261e'));
  try {
    const { q } = await import('./db.js');
    const { capCallAllowed } = await import('./services/flow.js');
    const o = q.get("SELECT * FROM orders WHERE call_token=?", String(req.params.token || ''));
    if (!o) return gone(410, '⏱️', 'انتهى الرابط', '<p>رابط الاتصال انتهى ولا يعمل بعد الآن.</p><p>التواصل مع العميل بعد التسليم غير مسموح 🔒</p><p>للحاجة العاجلة تواصل مع الإدارة.</p>');
    if (!capCallAllowed(o)) { try { q.run("UPDATE orders SET call_token=NULL WHERE id=?", o.id); } catch (e) {} return gone(403, '🔒', 'انتهى الإذن', '<p>انتهى إذن الاتصال لهذا الطلب.</p><p>التواصل الآن عبر البوت فقط.</p>'); }
    const c = q.get("SELECT phone FROM customers WHERE id=?", o.customer_id);
    const digits = String(c?.phone || '').replace(/\D/g, '');
    if (!digits) return gone(404, '⚠️', 'غير متاح', '<p>تعذّر جلب الرقم.</p>');
    res.send(page('📞', 'اتصل بالعميل',
      `<p>الإذن ساري حاليًا لهذا الطلب — وينتهي تلقائيًا بعد التسليم.</p>`
      + `<div class="num">+${digits}</div><a class="btn" href="tel:+${digits}">📞 اتصل الآن</a>`
      + `<p>إذا ما افتح الاتصال تلقائيًا اضغط الزر أعلاه.</p>`
      + `<script>setTimeout(function(){try{location.href='tel:+${digits}'}catch(e){}},900)</script>`, '#0b7a3b'));
  } catch (e) {
    gone(500, '⚠️', 'خطأ', '<p>حدث خطأ غير متوقع.</p>');
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const { dbLooksSane } = await import('./services/backup.js');
    const { dbUsable } = await import('./services/backup.js');
    const sane = dbLooksSane(undefined, true), usable = dbUsable();
    return res.json({ ok: true, db: sane ? 'sane' : (usable ? 'malformed_usable' : 'broken'), sane, usable, at: new Date().toISOString() });
  } catch (e) { return res.json({ ok: false, error: e.message }); }
});

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

// 🔑 استعادة كلمة مرور المدير عند الحاجة (نسيت كلمة المرور؟)
// اضبط ADMIN_RESET_PASSWORD في متغيرات البيئة ثم أعد التشغيل — واحذفه فوراً بعد الدخول.
try {
  const _rp = process.env.ADMIN_RESET_PASSWORD;
  if (_rp && String(_rp).length >= 6) {
    const bcrypt = (await import('bcryptjs')).default;
    const { q } = await import('./db.js');
    const row = q.get('SELECT id, email FROM admins ORDER BY id LIMIT 1');
    if (row) {
      q.run('UPDATE admins SET password_hash=? WHERE id=?', bcrypt.hashSync(String(_rp), 10), row.id);
      console.warn('ADMIN_PASSWORD_RESET_OK ⚠️ تم تعيين كلمة مرور المدير من ADMIN_RESET_PASSWORD — احذف المتغير الآن');
    } else console.warn('ADMIN_PASSWORD_RESET_NO_ADMIN');
  }
} catch (e) { console.error('ADMIN_PASSWORD_RESET_FAIL', e.message); }

// 👤 تحقّق من رقم المشرف عند التشغيل (إشعارات الاعتماد تعتمد عليه)
try {
  const { waTo } = await import('./services/whatsapp.js');
  const ap = waTo(config.adminPhone || '');
  if (!ap) console.warn('ADMIN_PHONE_MISSING ⚠️ رقم المشرف غير مضبوط — لن تصل إشعارات اعتماد التسجيلات (اضبط ADMIN_PHONE أو من لوحة التحكم)');
  else if (!/^9665\d{8}$/.test(ap)) console.warn('ADMIN_PHONE_FORMAT ⚠️ رقم المشرف بصيغة غير متوقعة ••••' + ap.slice(-4) + ' — استخدم 9665XXXXXXXX');
  else console.log('ADMIN_PHONE_OK ••••' + ap.slice(-4));
} catch (e) {}

server.listen(config.port, () => console.log(`🚀 منصة تلي هم تعمل على http://localhost:${config.port} (دفع: ${config.paymentMode} | واتساب: ${config.whatsapp.provider} | إعدادات اللوحة: ${settingsApplied})`));

// نسخ احتياطي دوري كل دقيقتين (إضافة للنسخ الفوري بعد الطلبات)
// ⏱ غرامات التأخير للكباتن — فحص كل ٣ دقائق
import('./services/captainAccount.js').then(({ checkLateDeliveries }) => {
  setInterval(() => checkLateDeliveries().then(n => { if (n) console.log('LATE_PENALTIES_APPLIED', n); }).catch(e => console.error('LATE_CHECK_FAIL', e.message)), 3 * 60 * 1000);
  setTimeout(() => checkLateDeliveries().catch(() => {}), 45000);
});

// 📊 تقرير المبيعات اليومي — فحص كل ٥ دقائق (مع تعويض لو كان السيرفر نائماً)
// 📎 الملفات المرفوعة: استعادة عند الإقلاع + نسخ احتياطي دوري
import('./services/backup.js').then(({ restoreUploadsIfNeeded, scheduleUploadsBackup, scheduleWeeklySnapshot }) => {
  restoreUploadsIfNeeded().catch(() => {});
  scheduleUploadsBackup();
  scheduleWeeklySnapshot();   // 📦 النسخة الأسبوعية الكاملة (كل جمعة 12 منتصف الليل)
}).catch(e => console.error('UPLOADS_BACKUP_INIT_FAIL', e.message));

// 🧹 استئناف إغلاق المزايدات المعلّقة (مؤقّت التسعير يُفقد عند إعادة التشغيل) — فحص كل دقيقة
import('./services/flow.js').then(({ sweepStaleBiddings }) => {
  setInterval(() => sweepStaleBiddings().catch(() => {}), 60 * 1000);
  setTimeout(() => sweepStaleBiddings().catch(() => {}), 15000);
}).catch(e => console.error('BID_SWEEP_INIT_FAIL', e.message));

// 🏠 الطلبات المسبقة (الأسر المنتجة): بث المستحق منها للكباتن
import('./services/orderService.js').then(({ dispatchDuePreorders, redispatchUnassigned }) => {
  setInterval(() => {
    dispatchDuePreorders().catch(e => console.error('PREORDER_LOOP_FAIL', e.message));
    redispatchUnassigned().catch(e => console.error('REDISPATCH_LOOP_FAIL', e.message));
  }, 5 * 60 * 1000);
  setTimeout(() => { dispatchDuePreorders().catch(() => {}); redispatchUnassigned().catch(() => {}); }, 40000);
}).catch(() => {});

// ⏱️ فحص غرامات التأخير (كاشير/كابتن) كل دقيقتين
import('./services/sla.js').then(({ runSlaChecks }) => {
  setInterval(() => runSlaChecks().catch(() => {}), 2 * 60 * 1000);
  setTimeout(() => runSlaChecks().catch(() => {}), 60000);
}).catch(() => {});

import('./services/reporting.js').then(({ runDueReports }) => {
  setInterval(() => runDueReports().catch(e => console.error('REPORT_LOOP_FAIL', e.message)), 5 * 60 * 1000);
  setTimeout(() => runDueReports().then(n => { if (n) console.log('REPORTS_CATCHUP', n); }).catch(() => {}), 25000);
});

// 🔄 قناة تليجرام: وضع السحب (polling) هو الافتراضي — لا يعتمد على ويبهوك ولا يتأثر بحجب Cloudflare للطلبات POST
// (لو TELEGRAM_MODE=webhook نرجع للويبهوك كما كان)
import('./routes/telegram.js').then(({ startPolling, ensureWebhook }) => {
  const mode = String(process.env.TELEGRAM_MODE || '').toLowerCase();
  if (mode === 'webhook') {
    setTimeout(() => ensureWebhook().catch(() => {}), 12000);
    setInterval(() => ensureWebhook().catch(() => {}), 30 * 60 * 1000);
    return;
  }
  setTimeout(async () => {
    let ok = false;
    for (let i = 0; i < 3 && !ok; i += 1) {
      ok = await startPolling().catch(() => false);
      if (!ok) await new Promise(r => setTimeout(r, 8000));
    }
    if (ok) console.log('TELEGRAM_MODE_POLLING ✓');
    else {
      console.warn('TELEGRAM_POLLING_FAILED → fallback webhook');
      ensureWebhook().catch(() => {});
      setInterval(() => ensureWebhook().catch(() => {}), 30 * 60 * 1000);
    }
  }, 15000);
}).catch(() => {});

// ⏰ نبضة ذاتية كل 10 دقائق — تمنع «نوم» الخدمة على الخطة المجانية (فتضيع رسائل تليجرام)
import('./config.js').then(({ default: cfg }) => {
  const url = `${String(cfg.publicUrl || '').replace(/\/$/, '')}/api/health`;
  if (!/^https:\/\//.test(url)) return;
  const ping = () => fetch(url, { method: 'GET' }).then(() => {}).catch(() => {});
  setTimeout(ping, 90 * 1000);
  setInterval(ping, 10 * 60 * 1000);
  console.log('SELF_PING armed:', url);
}).catch(() => {});

// 🛵 تحرير الكباتن المنشغلين طويلًا (كل 15 دقيقة)
import('./services/captainAccount.js').then(({ releaseStaleBusyCaptains }) => {
  setInterval(() => releaseStaleBusyCaptains(180), 15 * 60 * 1000);
  setTimeout(() => releaseStaleBusyCaptains(180), 60000);
}).catch(() => {});

// ⏰ تقارير الكابتن اليومية + تذكير العملاء بالعروض
import('./services/reminders.js').then(({ runReminderJobs }) => {
  setInterval(() => runReminderJobs().catch(() => {}), 5 * 60 * 1000);
  setTimeout(() => runReminderJobs().catch(() => {}), 45000);
}).catch(() => {});

import('./services/backup.js').then(({ scheduleBackup, backupNow }) => {
  setInterval(scheduleBackup, 2 * 60 * 1000);
  console.log('🔄 النسخ الاحتياطي التلقائي مفعّل (كل دقيقتين)');
  // نسخة عند الإقلاع إذا كانت القاعدة فيها بيانات
  setTimeout(() => { backupNow().catch(() => {}); }, 15000);
});
