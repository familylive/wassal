// ---------- نسخ احتياطي تلقائي لقاعدة البيانات (مستودع GitHub خاص) ----------
// المشكلة: قاعدة SQLite على Render تُمسح عند كل نشر
// الحل: رفع نسخة للمستودع الخاص familylive/wassal-db-backup + استعادة عند الإقلاع
import fs, { readFileSync, existsSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import axios from 'axios';
import config from './../config.js';

const OWNER = 'familylive';
const REPO = 'wassal-db-backup';
const FILE = 'wassal.db';
const TOKEN = process.env.GH_BACKUP_TOKEN || '';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;

// جلب النسخة الاحتياطية من GitHub (مع تاريخ آخر تعديل)
async function fetchBackup() {
  if (!TOKEN) return null;
  try {
    const r = await axios.get(API, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' }, timeout: 20000 });
    const content = Buffer.from(r.data.content, 'base64');
    if (!content || content.length <= 4000) return null;
    let date = 0;
    try {
      const c = await axios.get(`https://api.github.com/repos/${OWNER}/${REPO}/commits?path=${FILE}&per_page=1`,
        { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' }, timeout: 15000 });
      const d = c.data?.[0]?.commit?.committer?.date;
      if (d) date = Date.parse(d) || 0;
    } catch (e) { console.error('BACKUP_DATE_FAIL', e.message); }
    return { content, date, size: content.length };
  } catch (e) { console.error('FETCH_BACKUP_FAIL', e.message); }
  return null;
}

// حالة القاعدة المحلية: هل فيها بيانات؟ ومتى آخر تعديل لها؟
import { statSync as _statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

function localInfo() {
  let hasData = false, mtime = 0;
  try { mtime = _statSync(config.dbPath).mtimeMs; } catch { mtime = 0; }
  try {
    const db = new DatabaseSync(config.dbPath, { readOnly: true });
    const r = db.prepare("SELECT COUNT(*) AS c FROM restaurants").get();
    db.close();
    hasData = Number(r.c) > 0;
  } catch { hasData = false; }
  return { hasData, mtime };
}
function localHasData() { return localInfo().hasData; }

// استعادة عند الإقلاع
// القاعدة: نستعيد النسخة الاحتياطية إذا (١) القاعدة المحلية فاضية، أو (٢) النسخة الاحتياطية أحدث من الملف المحلي
// هكذا لا يضيع أي شي بعد كل نشر (Render يمسح القرص)، وفي نفس الوقت لا نستبدل بيانات أحدث بنسخة أقدم.
export async function restoreIfNeeded() {
  const local = localInfo();
  const remote = await fetchBackup();
  if (!remote) {
    console.error('DB_RESTORE_SKIP no remote backup available', { localHasData: local.hasData, token: Boolean(TOKEN) });
    return false;
  }
  const remoteNewer = remote.date > 0 && remote.date > (local.mtime - 5000);
  if (local.hasData && !remoteNewer) {
    console.log('DB_KEEP_LOCAL', { localMtime: new Date(local.mtime).toISOString(), remote: remote.date ? new Date(remote.date).toISOString() : 'n/a', remoteSize: remote.size });
    return false;
  }
  const head = remote.content.slice(0, 16).toString('ascii');
  if (!head.includes('SQLite format 3')) { console.error('DB_RESTORE_BAD_HEADER'); return false; }
  if (remote.size < 60000) { console.error('DB_RESTORE_TOO_SMALL', remote.size); return false; }
  try {
    try { rmSync(config.dbPath + '-wal', { force: true }); } catch {}
    try { rmSync(config.dbPath + '-shm', { force: true }); } catch {}
    // احفظ نسخة من المحلي قبل الاستبدال (حماية)
    try { if (existsSync(config.dbPath)) writeFileSync(config.dbPath + '.bak', readFileSync(config.dbPath)); } catch {}
    writeFileSync(config.dbPath, remote.content);
    console.log('DB_RESTORED_FROM_BACKUP', remote.size, remote.date ? new Date(remote.date).toISOString() : 'n/a', local.hasData ? '(local was stale)' : '(local empty)');
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

// ================= 📎 نسخ احتياطي للملفات المرفوعة (هويات · رخص · فواتير · صور تسليم) =================
// مجلد uploads يُمسح عند كل نشر — نحفظه مضغوطاً في نفس المستودع الخاص ونستعيده عند الإقلاع
const UP_API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/uploads.tar.gz`;
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const TAR = path.join(process.cwd(), 'uploads.tar.gz');

export function uploadsSignature() {
  try {
    let count = 0, size = 0, newest = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = `${d}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else { const st = fs.statSync(p); count++; size += st.size; newest = Math.max(newest, st.mtimeMs); }
      }
    };
    if (fs.existsSync(UPLOADS_DIR)) walk(UPLOADS_DIR);
    return { count, size, newest: Math.round(newest) };
  } catch (e) { return { count: 0, size: 0, newest: 0 }; }
}

export async function backupUploads(force = false) {
  if (!TOKEN) return false;
  try {
    const sig = uploadsSignature();
    if (!sig.count) return false;
    if (!force) {
      const prev = getSig();
      if (prev && prev.count === sig.count && prev.size === sig.size && prev.newest === sig.newest) return false;
    }
    execSync(`tar czf ${TAR} -C ${path.dirname(UPLOADS_DIR)} uploads`, { stdio: 'ignore' });
    const size = statSync(TAR).size;
    if (size > 45 * 1024 * 1024) { console.log('UPLOADS_BACKUP_TOO_BIG', size); return false; }
    const content = readFileSync(TAR).toString('base64');
    let sha = null;
    try {
      const g = await axios.get(UP_API, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' }, timeout: 15000 });
      sha = g.data.sha;
    } catch { /* أول مرة */ }
    const body = { message: `uploads ${new Date().toISOString().slice(0, 19)} (${sig.count} ملف)`, content };
    if (sha) body.sha = sha;
    await axios.put(UP_API, body, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' }, timeout: 60000 });
    saveSig(sig);
    console.log('UPLOADS_BACKUP_OK', sig.count, size);
    fs.rmSync(TAR, { force: true });
    return true;
  } catch (e) { console.error('UPLOADS_BACKUP_FAIL', e.message); return false; }
}

// اتصال قراءة/كتابة مستقل (لتجنّب الاستيراد الدائري مع db.js)
function sigDb() {
  const { DatabaseSync } = _sqlite;
  if (!_sqliteConn) _sqliteConn = new DatabaseSync(config.dbPath);
  return _sqliteConn;
}
let _sqlite = null, _sqliteConn = null;
export function initSigDb(mod) { _sqlite = mod; }
function getSig() {
  try { const v = sigDb().prepare("SELECT value FROM app_settings WHERE key='uploads_backup_sig'").get()?.value; return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
}
function saveSig(sig) {
  try {
    sigDb().prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('uploads_backup_sig',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')").run(JSON.stringify(sig));
  } catch (e) { /* لا مشكلة */ }
}

// استعادة الملفات عند الإقلاع إذا كان المجلد فاقداً
export async function restoreUploadsIfNeeded() {
  if (!TOKEN) return false;
  try {
    const sig = uploadsSignature();
    if (sig.count > 0) return true;
    const r = await axios.get(UP_API, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' }, timeout: 60000 });
    const buf = Buffer.from(r.data.content, 'base64');
    if (!buf?.length) return false;
    writeFileSync(TAR, buf);
    execSync(`tar xzf ${TAR} -C ${path.dirname(UPLOADS_DIR)}`, { stdio: 'ignore' });
    fs.rmSync(TAR, { force: true });
    console.log('UPLOADS_RESTORED', uploadsSignature().count);
    return true;
  } catch (e) { console.error('UPLOADS_RESTORE_FAIL', e.message); return false; }
}

export function scheduleUploadsBackup() {
  setInterval(() => { backupUploads().catch(() => {}); }, 30 * 60 * 1000);
  setTimeout(() => { backupUploads().catch(() => {}); }, 120 * 1000);
}
