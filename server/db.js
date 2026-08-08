import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
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
try { db.exec("ALTER TABLE payments ADD COLUMN restaurant_id INTEGER"); } catch {}
try { db.exec("ALTER TABLE payments ADD COLUMN phone TEXT"); } catch {}

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
