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

// ================= 📦 النسخة الأسبوعية الكاملة (كل جمعة 12:00 منتصف الليل بتوقيت السعودية) =================
// تجمع: الكود + قاعدة البيانات + الملفات المرفوعة + ملفات الشرح → ضغط واحد → المستودع الخاص
const SNAP_DIR = 'snapshots';
const CRON_API = (name) => `https://api.github.com/repos/${OWNER}/${REPO}/contents/${SNAP_DIR}/${name}`;
const SNAP_KEEP = 8;   // نحتفظ بآخر ٨ نسخ أسبوعية

function riyadhNow() { return new Date(Date.now() + 3 * 3600 * 1000); }

// هل اليوم جمعة والساعة صفر (أو فاتنا الموعد اليوم)؟
function isFridayMidnight() {
  const d = riyadhNow();
  return d.getUTCDay() === 5;   // 5 = الجمعة
}

async function apiGet(url) {
  try { const r = await axios.get(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' }, timeout: 20000 }); return r.data; }
  catch (e) { return null; }
}
async function apiPut(url, body) {
  await axios.put(url, body, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' }, timeout: 120000 });
}
async function apiDelete(url, sha, message) {
  try { await axios.delete(url, { data: { message, sha }, headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' }, timeout: 30000 }); return true; }
  catch (e) { return false; }
}

// بناء ملف النسخة الكاملة (zip إن توفر، وإلا tar.gz)
function buildSnapshotArchive(tag) {
  const root = process.cwd();
  const work = path.join(root, 'snapshot-tmp');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  // ١) الكود (بدون node_modules و uploads و قاعدة البيانات)
  execSync(`mkdir -p ${work}/١-الكود && tar czf ${work}/١-الكود/wassal-code.tar.gz --exclude='*/node_modules' --exclude='*/.git' --exclude='*/uploads' --exclude='*/dist' --exclude='*.db' --exclude='*.db-shm' --exclude='*.db-wal' --exclude='snapshot-tmp' --exclude='*.tar.gz' --exclude='*.zip' -C ${root} .`, { stdio: 'ignore' });
  // ٢) قاعدة البيانات
  try { sigDb().exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
  try { fs.mkdirSync(`${work}/٢-قاعدة-البيانات`, { recursive: true }); fs.copyFileSync(config.dbPath, `${work}/٢-قاعدة-البيانات/wassal-db.db`); } catch (e) { console.error('SNAP_DB_FAIL', e.message); }
  // ٣) الملفات المرفوعة
  try {
    const sig = uploadsSignature();
    if (sig.count) { fs.mkdirSync(`${work}/٣-الملفات-المرفوعة`, { recursive: true }); execSync(`tar czf ${work}/٣-الملفات-المرفوعة/uploads.tar.gz -C ${path.dirname(UPLOADS_DIR)} uploads`, { stdio: 'ignore' }); }
  } catch (e) { console.error('SNAP_UPLOADS_FAIL', e.message); }
  // ٤) ملفات الشرح
  fs.writeFileSync(`${work}/اقرأني.txt`, `نسخة كاملة من منصة واتس هم\nالتاريخ: ${tag}\n\n١-الكود/: كل ملفات المنصة البرمجية\n٢-قاعدة-البيانات/: قاعدة البيانات كاملة\n٣-الملفات-المرفوعة/: صور الهويات والرخص والفواتير\n\nللاستعادة: راجع مستند «دليل حفظ المشروع» أو اتبع الخطوات:\n  tar xzf ١-الكود/wassal-code.tar.gz && cd wassal && npm install\n  ضع ٢-قاعدة-البيانات/wassal-db.db في wassal/server/wassal.db\n  tar xzf ٣-الملفات-المرفوعة/uploads.tar.gz -C wassal/server\n`, 'utf8');
  // ٥) الضغط النهائي
  const out = path.join(root, `wassal-full-${tag}.zip`);
  let ok = true;
  try { execSync(`cd ${work} && zip -r -q ${out} .`, { stdio: 'ignore' }); }
  catch (e) { ok = false; }
  if (!ok) { execSync(`tar czf ${out}.tar.gz -C ${work} .`, { stdio: 'ignore' }); }
  const finalPath = ok ? out : `${out}.tar.gz`;
  const size = statSync(finalPath).size;
  fs.rmSync(work, { recursive: true, force: true });
  return { file: finalPath, name: path.basename(finalPath), size };
}

export async function runWeeklySnapshot(force = false) {
  if (!TOKEN) return false;
  const d = riyadhNow();
  const tag = d.toISOString().slice(0, 10);
  try {
    const lastRun = getSigKey('weekly_snapshot_date');
    if (!force) {
      if (!isFridayMidnight()) return false;
      if (lastRun === tag) return false;   // سويناها اليوم
    }
    console.log('WEEKLY_SNAPSHOT_START', tag);
    const snap = buildSnapshotArchive(tag);
    const content = readFileSync(snap.file).toString('base64');
    const name = `wassal-full-${tag}.tar.gz`.replace('.tar.gz', snap.name.endsWith('.zip') ? '.zip' : '.tar.gz');
    const url = CRON_API(name);
    const existing = await apiGet(url);
    const body = { message: `نسخة أسبوعية كاملة ${tag} (${Math.round(snap.size / 1024)}KB)`, content };
    if (existing?.sha) body.sha = existing.sha;
    await apiPut(url, body);
    setSigKey('weekly_snapshot_date', tag);
    setSigKey('weekly_snapshot_name', name);
    fs.rmSync(snap.file, { force: true });
    console.log('WEEKLY_SNAPSHOT_OK', name, snap.size);
    await pruneSnapshots();
    // إشعار المشرف على واتساب
    try {
      const { waSend } = await import('./whatsapp.js');
      if (config.adminPhone) await waSend({ phone: config.adminPhone, type: 'text',
        body: `📦 *النسخة الأسبوعية الكاملة جاهزة* ✅\n\n📅 ${tag}\n🗄 الكود + قاعدة البيانات + الملفات المرفوعة\n📦 الحجم: ${(snap.size / 1048576).toFixed(1)} ميجا\n🔒 محفوظة في المستودع الخاص: github.com/${OWNER}/${REPO}/${SNAP_DIR}/\n\n_(النسخ التلقائية: البيانات كل دقيقتين · الملفات كل 30 دقيقة)_` });
    } catch (e) { console.error('SNAP_NOTIFY_FAIL', e.message); }
    return { ok: true, name, size: snap.size };
  } catch (e) { console.error('WEEKLY_SNAPSHOT_FAIL', e.message); return false; }
}

// نحتفظ بآخر ٨ نسخ فقط
async function pruneSnapshots() {
  try {
    const list = await apiGet(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${SNAP_DIR}`);
    if (!Array.isArray(list) || list.length <= SNAP_KEEP) return;
    const sorted = list.filter(x => x.name.startsWith('wassal-full-')).sort((a, b) => a.name.localeCompare(b.name));
    for (const old of sorted.slice(0, sorted.length - SNAP_KEEP)) {
      await apiDelete(old.url, old.sha, `حذف نسخة قديمة ${old.name}`);
      console.log('SNAPSHOT_PRUNED', old.name);
    }
  } catch (e) { /* لا مشكلة */ }
}

function getSigKey(key) {
  try { return sigDb().prepare("SELECT value FROM app_settings WHERE key=?").get(key)?.value || null; } catch (e) { return null; }
}
function setSigKey(key, value) {
  try { sigDb().prepare("INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')").run(key, String(value)); } catch (e) {}
}

// فحص كل 30 دقيقة (مع تعويض لو كان السيرفر نائماً)
export function scheduleWeeklySnapshot() {
  setInterval(() => { runWeeklySnapshot().catch(() => {}); }, 30 * 60 * 1000);
  setTimeout(() => { runWeeklySnapshot().catch(() => {}); }, 3 * 60 * 1000);
}
