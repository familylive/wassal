import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from './config.js';
// استعادة النسخة الاحتياطية قبل فتح القاعدة (ضد مسح بيانات Render عند النشر)
import { restoreIfNeeded } from './services/backup.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
await restoreIfNeeded();
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
// ترحيلات للقواعد القائمة
try { db.exec("ALTER TABLE orders ADD COLUMN branch_id INTEGER"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN delivery_code TEXT"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN cancel_reason TEXT"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN cancel_note TEXT"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN cancel_requested_at TEXT"); } catch {}
try { db.exec("ALTER TABLE restaurant_users ADD COLUMN branch_id INTEGER"); } catch {}
// جلسات واتساب: موحدة لكل عميل — نعيد إنشاء الجدول فقط إذا كان بالبنية القديمة (مفتاح مركب)
try {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='whatsapp_sessions'").get();
  if (sql && /PRIMARY KEY\s*\(phone,\s*restaurant_id\)/.test(sql.sql)) {
    db.exec("DROP TABLE IF EXISTS whatsapp_sessions");
    db.exec("CREATE TABLE whatsapp_sessions (phone TEXT PRIMARY KEY, restaurant_id INTEGER DEFAULT 0, state TEXT DEFAULT 'idle', data_json TEXT DEFAULT '{}', updated_at TEXT DEFAULT (datetime('now')))");
  }
} catch (e) {}
try { db.exec("ALTER TABLE restaurants ADD COLUMN instagram TEXT"); } catch {}
try { db.exec("ALTER TABLE restaurants ADD COLUMN twitter TEXT"); } catch {}
// نوع النشاط (مطاعم / سوبر ماركت / صيدلية / أسر منتجة ...) — يُدار من لوحة التحكم
try { db.exec("ALTER TABLE restaurants ADD COLUMN business_type_id INTEGER"); } catch {}
// ترحيلات جدول التسجيلات (لو كان الجدول موجوداً بنسخة أقدم)
try { db.exec("ALTER TABLE business_registrations ADD COLUMN kind TEXT DEFAULT 'business'"); } catch {}
try { db.exec("ALTER TABLE business_registrations ADD COLUMN city TEXT"); } catch {}
try { db.exec("ALTER TABLE business_registrations ADD COLUMN district TEXT"); } catch {}
try { db.exec("ALTER TABLE business_registrations ADD COLUMN postal_code TEXT"); } catch {}
try { db.exec("ALTER TABLE business_registrations ADD COLUMN owner_name TEXT"); } catch {}
try { db.exec("ALTER TABLE business_registrations ADD COLUMN owner_id TEXT"); } catch {}
try { db.exec("ALTER TABLE business_registrations ADD COLUMN deposit_paid INTEGER DEFAULT 0"); } catch {}
// 🧾 المستندات بالنظام الجديد: رقم + تاريخ إصدار (بدون رفع ملفات)
try { db.exec("ALTER TABLE business_registrations ADD COLUMN municipal_no TEXT"); } catch {}
try { db.exec("ALTER TABLE business_registrations ADD COLUMN municipal_issued_at TEXT"); } catch {}
try { db.exec("ALTER TABLE business_registrations ADD COLUMN cr_no TEXT"); } catch {}
try { db.exec("ALTER TABLE business_registrations ADD COLUMN cr_issued_at TEXT"); } catch {}
try { db.exec("ALTER TABLE business_registrations ADD COLUMN freelance_issued_at TEXT"); } catch {}
try { db.exec("ALTER TABLE restaurants ADD COLUMN municipal_no TEXT"); } catch {}
try { db.exec("ALTER TABLE restaurants ADD COLUMN municipal_issued_at TEXT"); } catch {}
try { db.exec("ALTER TABLE restaurants ADD COLUMN cr_no TEXT"); } catch {}
try { db.exec("ALTER TABLE restaurants ADD COLUMN cr_issued_at TEXT"); } catch {}
try { db.exec("ALTER TABLE restaurants ADD COLUMN freelance_issued_at TEXT"); } catch {}
try { db.exec("ALTER TABLE captains ADD COLUMN national_id TEXT"); } catch {}
try { db.exec("ALTER TABLE restaurant_users ADD COLUMN national_id TEXT"); } catch {}
try { db.exec("ALTER TABLE report_recipients ADD COLUMN national_id TEXT"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN order_type TEXT DEFAULT 'delivery'"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN bid_until TEXT"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN chosen_captain_id INTEGER"); } catch {}
try { db.exec("ALTER TABLE captain_offers ADD COLUMN bid_amount INTEGER"); } catch {}
try { db.exec("ALTER TABLE captain_offers ADD COLUMN bid_at TEXT"); } catch {}
try { db.exec("ALTER TABLE captains ADD COLUMN deposit_amount INTEGER DEFAULT 50000"); } catch {}
try { db.exec("ALTER TABLE captains ADD COLUMN deposit_paid INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE captains ADD COLUMN deposit_paid_at TEXT"); } catch {}
try { db.exec("ALTER TABLE captains ADD COLUMN wallet_cash INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE captains ADD COLUMN penalty_total INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE captains ADD COLUMN blocked INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE captains ADD COLUMN blocked_reason TEXT"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN promised_at TEXT"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN penalty_quarters INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN penalty_total INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN commission_business INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE customer_locations ADD COLUMN city TEXT"); } catch {}
// 🏪 دوام النشاط والفترات + المستندات الرسمية · 🛵 مستندات الكابتن
for (const [t, c, ty] of [
  ['items', 'stock_qty', 'INTEGER'],
  ['orders', 'is_preorder', 'INTEGER'], ['orders', 'invoice_no', 'INTEGER'], ['orders', 'invoice_file', 'TEXT'], ['orders', 'invoice_sent_at', 'TEXT'], ['orders', 'scheduled_for', 'TEXT'], ['orders', 'scheduled_time', 'TEXT'], ['orders', 'preorder_dispatched_at', 'TEXT'],
  ['customers', 'national_id', 'TEXT'], ['customers', 'birth_date', 'TEXT'], ['customers', 'activation_code', 'TEXT'], ['customers', 'pledged_at', 'TEXT'],
  ['captains', 'id_doc', 'TEXT'], ['restaurant_users', 'id_doc', 'TEXT'], ['restaurant_users', 'birth_date', 'TEXT'], ['business_registrations', 'id_doc', 'TEXT'],
  ['report_recipients', 'birth_date', 'TEXT'], ['report_recipients', 'id_doc', 'TEXT'],
  ['restaurants', 'open_hour', 'TEXT'], ['restaurants', 'close_hour', 'TEXT'], ['restaurants', 'shifts', 'INTEGER'],
  ['restaurants', 's1_from', 'TEXT'], ['restaurants', 's1_to', 'TEXT'], ['restaurants', 's2_from', 'TEXT'], ['restaurants', 's2_to', 'TEXT'],
  ['restaurants', 'municipal_doc', 'TEXT'], ['restaurants', 'entity_type', 'TEXT'], ['restaurants', 'freelance_no', 'TEXT'], ['restaurants', 'freelance_doc', 'TEXT'],
  ['business_registrations', 'entity_type', 'TEXT'], ['business_registrations', 'freelance_no', 'TEXT'], ['business_registrations', 'freelance_doc', 'TEXT'], ['restaurants', 'cr_doc', 'TEXT'], ['restaurants', 'health_count', 'INTEGER'], ['restaurants', 'health_docs', 'TEXT'],
  ['captains', 'vehicle_color', 'TEXT'], ['captains', 'license_doc', 'TEXT'], ['captains', 'criminal_doc', 'TEXT'],
  ['business_registrations', 'open_hour', 'TEXT'], ['business_registrations', 'close_hour', 'TEXT'], ['business_registrations', 'shifts', 'INTEGER'],
  ['business_registrations', 's1_from', 'TEXT'], ['business_registrations', 's1_to', 'TEXT'], ['business_registrations', 's2_from', 'TEXT'], ['business_registrations', 's2_to', 'TEXT'],
  ['business_registrations', 'municipal_doc', 'TEXT'], ['business_registrations', 'cr_doc', 'TEXT'], ['business_registrations', 'health_count', 'INTEGER'], ['business_registrations', 'health_docs', 'TEXT'],
  ['business_registrations', 'vehicle_color', 'TEXT'], ['business_registrations', 'vehicle_plate', 'TEXT'], ['business_registrations', 'license_doc', 'TEXT'], ['business_registrations', 'criminal_doc', 'TEXT'],
]) { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ty}`); } catch {} }

// 🆔 ترقيم الأنشطة يبدأ من 1001
export const RESTAURANT_ID_START = 1001;
export function nextRestaurantId() {
  try {
    const mx = Number(db.prepare("SELECT IFNULL(MAX(id),0) AS m FROM restaurants").get()?.m || 0);
    return Math.max(RESTAURANT_ID_START, mx + 1);
  } catch (e) { return RESTAURANT_ID_START; }
}
export function ensureRestaurantSequence() {
  try {
    const mx = Number(db.prepare("SELECT IFNULL(MAX(id),0) AS m FROM restaurants").get()?.m || 0);
    if (mx >= RESTAURANT_ID_START) return;
    const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='restaurants'").get();
    if (row) db.exec(`UPDATE sqlite_sequence SET seq=${RESTAURANT_ID_START - 1} WHERE name='restaurants'`);
    else db.exec(`INSERT INTO sqlite_sequence (name, seq) VALUES ('restaurants', ${RESTAURANT_ID_START - 1})`);
  } catch (e) { /* sqlite_sequence غير موجود — لا مشكلة */ }
}
try { db.exec("ALTER TABLE orders ADD COLUMN commission_captain INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE captains ADD COLUMN commission_due INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE captains ADD COLUMN deposit_balance INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE restaurants ADD COLUMN subscription_paid INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE restaurants ADD COLUMN subscription_paid_at TEXT"); } catch {}
try { db.exec("ALTER TABLE business_registrations ADD COLUMN subscription_paid INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN delivery_photo TEXT"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN delivery_photo_at TEXT"); } catch {}
try { db.exec("ALTER TABLE captains ADD COLUMN district TEXT"); } catch {}
try { db.exec("ALTER TABLE business_registrations ADD COLUMN vehicle_type TEXT"); } catch {}
try { db.exec("ALTER TABLE business_registrations ADD COLUMN captain_id INTEGER"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN branch_name TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN phone TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN restaurant_id INTEGER"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_restaurant ON conversations(restaurant_id)"); } catch {}
// ترحيل: اربط المحادثات القديمة بالمطعم المختار للرقم حتى تظهر في شاشة المحادثات
// المصادر: خانة restaurant_id في الجلسة، أو الحقل currentRestaurantId داخل data_json، أو جدول wa_phone_restaurant
try {
  db.exec("UPDATE conversations SET restaurant_id = (SELECT COALESCE(NULLIF(s.restaurant_id,0), json_extract(s.data_json,'$.currentRestaurantId')) FROM whatsapp_sessions s WHERE s.phone = conversations.phone LIMIT 1) WHERE restaurant_id IS NULL AND EXISTS (SELECT 1 FROM whatsapp_sessions s WHERE s.phone = conversations.phone AND (s.restaurant_id > 0 OR json_extract(s.data_json,'$.currentRestaurantId') > 0))");
} catch (e) { console.error('MIGRATE_PIN_SESSIONS_FAIL', e.message); }
try {
  db.exec("UPDATE conversations SET restaurant_id = (SELECT h.restaurant_id FROM wa_phone_restaurant h WHERE h.phone = conversations.phone AND h.restaurant_id > 0) WHERE restaurant_id IS NULL AND EXISTS (SELECT 1 FROM wa_phone_restaurant h WHERE h.phone = conversations.phone AND h.restaurant_id > 0)");
} catch {}
try { db.exec("ALTER TABLE payments ADD COLUMN restaurant_id INTEGER"); } catch {}
try { db.exec("ALTER TABLE payments ADD COLUMN phone TEXT"); } catch {}

// 🆔 اضبط بداية ترقيم الأنشطة على 1001
try { ensureRestaurantSequence(); } catch (e) { console.error('SEQ_FAIL', e.message); }
// حقن sqlite في خدمة النسخ الاحتياطي (لتجنّب الاستيراد الدائري)
try { const { initSigDb } = await import('./services/backup.js'); initSigDb(await import('node:sqlite')); } catch (e) {}

// تهيئة أولى فقط: إذا لم توجد أي مطاعم → زرع البيانات (مرة واحدة)
try {
  const seeded = db.prepare("SELECT COUNT(*) AS c FROM restaurants").get();
  // WASSAL_NO_SEED يمنع إعادة التهيئة داخل العمليات الفرعية (seed.js يستورد هذا الملف)
  if (Number(seeded.c) === 0 && !process.env.WASSAL_NO_SEED) {
    console.log('🌱 تهيئة القاعدة لأول مرة...');
    const { execSync } = await import('node:child_process');
    const dir = new URL('.', import.meta.url).pathname;
    execSync('node seed.js && node seed-hashibasha.js', { cwd: dir, stdio: 'inherit', env: { ...process.env, WASSAL_NO_SEED: '1' } });
    console.log('🌱 اكتملت التهيئة');
  }
} catch (e) { console.error('SEED_FAIL', e.message); }

// light query helpers
export const q = {
  get: (sql, ...args) => db.prepare(sql).get(...args),
  all: (sql, ...args) => db.prepare(sql).all(...args),
  run: (sql, ...args) => db.prepare(sql).run(...args),
};
export const tx = (fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};
export default db;
