// ---------- نسخ احتياطي تلقائي لقاعدة البيانات (مستودع GitHub خاص) ----------
// المشكلة: قاعدة SQLite على Render تُمسح عند كل نشر
// الحل: رفع نسخة للمستودع الخاص familylive/wassal-db-backup + استعادة عند الإقلاع
import { readFileSync, existsSync, writeFileSync, statSync, rmSync } from 'node:fs';
import axios from 'axios';
import config from './../config.js';

const OWNER = 'familylive';
const REPO = 'wassal-db-backup';
const FILE = 'wassal.db';
const TOKEN = process.env.GH_BACKUP_TOKEN || '';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;

// جلب النسخة الاحتياطية من GitHub
async function fetchBackup() {
  if (!TOKEN) return null;
  try {
    const r = await axios.get(API, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' }, timeout: 20000 });
    const content = Buffer.from(r.data.content, 'base64');
    if (content && content.length > 4000) return content;
  } catch (e) { console.error('FETCH_BACKUP_FAIL', e.message); }
  return null;
}

// استعادة عند الإقلاع: النسخة الاحتياطية هي الأحدث دائماً — نستبدل القاعدة المحلية بها
export async function restoreIfNeeded() {
  const backup = await fetchBackup();
  if (!backup) return false;
  // تحقق أن الملف قاعدة SQLite صحيحة (ترويسة)
  const head = backup.slice(0, 16).toString('ascii');
  if (!head.includes('SQLite format 3')) return false;
  if (backup.length < 60000) return false; // قاعدة شبه فارغة — نتجاهلها ونبقي المحلية
  try {
    // حذف ملفات WAL قديمة قبل الكتابة فوق القاعدة (تجنب فساد)
    try { rmSync(config.dbPath + '-wal', { force: true }); } catch {}
    try { rmSync(config.dbPath + '-shm', { force: true }); } catch {}
    writeFileSync(config.dbPath, backup);
    console.log('DB_RESTORED_FROM_BACKUP', backup.length);
    return true;
  } catch (e) { console.error('DB_RESTORE_FAIL', e.message); }
  return false;
}

// رفع نسخة الآن — مع تدقيق WAL أولاً حتى تشمل النسخة أحدث البيانات
export async function backupNow() {
  if (!TOKEN) return false;
  try {
    if (!existsSync(config.dbPath)) return false;
    // ⚠️ مهم: تدقيق WAL قبل القراءة (وإلا تفوت النسخة أحدث الطلبات)
    try {
      const { q } = await import('../db.js');
      q.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) { console.error('WAL_CHECKPOINT_FAIL', e.message); }
    const content = readFileSync(config.dbPath).toString('base64');
    let sha = null;
    try {
      const g = await axios.get(API, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' }, timeout: 15000 });
      sha = g.data.sha;
    } catch { /* أول مرة */ }
    const body = { message: `db ${new Date().toISOString().slice(0, 19)}`, content };
    if (sha) body.sha = sha;
    await axios.put(API, body, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' }, timeout: 30000 });
    console.log('DB_BACKUP_OK', new Date().toISOString());
    return true;
  } catch (e) { console.error('DB_BACKUP_FAIL', e.message); return false; }
}

// جدولة نسخة بعد أي تغيير (مؤجلة 12 ثانية لتجميع العمليات)
let backupTimer = null, dirty = false;
export function scheduleBackup() {
  dirty = true;
  if (backupTimer) return;
  backupTimer = setTimeout(async () => {
    backupTimer = null;
    if (!dirty) return;
    dirty = false;
    await backupNow();
  }, 12000);
}
