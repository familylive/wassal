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
