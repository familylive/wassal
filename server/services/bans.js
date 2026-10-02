// 🚫 نظام الحظر — بالهوية الوطنية أو الجوال (قرار: «إذا جيت أبنده يتبند بالرقم للهوية»)
// الهوية لا تُستبدل بسهولة (بخلاف الجوال) ⇒ الحظر يلاحق المتهرب حتى لو غيّر رقمه.
import { q } from '../db.js';

// تطبيع موحّد للأرقام (يتفادى فخّ validatePhone('') الذي يرجّع '+966')
export function normPhone(v) {
  let d = String(v || '').replace(/[^\d]/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '966' + d.slice(1);
  if (!d.startsWith('966') && d.length <= 9) d = '966' + d;
  // ✅ رقم سعودي صحيح فقط (966 + 9 أرقام) — نمنع حفظ أرقام مشوّهة
  if (!/^966\d{9}$/.test(d)) return null;
  return '+' + d;
}

export function normNid(v) {
  const d = String(v || '').replace(/[^\d]/g, '');
  return /^[12]\d{9}$/.test(d) ? d : null;
}

// هل هذا الشخص محظور؟ (نفحص الهوية أولًا ثم الجوال) — kind: customer | captain | business | all
export function isBanned({ nationalId = null, phone = null, kind = 'customer' } = {}) {
  const nid = normNid(nationalId);
  const ph = normPhone(phone);
  if (!nid && !ph) return null;
  try {
    const row = q.get(
      `SELECT * FROM bans WHERE active=1 AND kind IN (?, 'all')
         AND ((national_id IS NOT NULL AND national_id = ?) OR (phone IS NOT NULL AND phone = ?))
       ORDER BY CASE WHEN national_id = ? THEN 0 ELSE 1 END, id DESC LIMIT 1`,
      kind, nid || '\u0000', ph || '\u0000', nid || '\u0000',
    );
    return row || null;
  } catch (e) { return null; }
}

// 🧭 إكمال الحظر: نربط الجوال بالهوية تلقائيًا (المستخدم: «الحظر برقم الجوال مع الهوية»)
const ID_TABLES = [['customers', 'customer'], ['captains', 'captain'], ['restaurant_users', 'business']];

function lookupByIdentity(nid) {
  for (const [t, k] of ID_TABLES) {
    try {
      const r = q.get(`SELECT phone, name FROM ${t} WHERE national_id=? AND phone IS NOT NULL AND phone<>'' ORDER BY id DESC LIMIT 1`, nid);
      if (r?.phone) return { phone: r.phone, name: r.name || null, kind: k };
    } catch (e) {}
  }
  return null;
}

function lookupByPhone(ph) {
  for (const [t, k] of ID_TABLES) {
    try {
      const r = q.get(`SELECT national_id, name FROM ${t} WHERE (phone=? OR phone=?) AND national_id IS NOT NULL ORDER BY id DESC LIMIT 1`, ph, String(ph).replace(/^\+/, ''));
      if (r?.national_id) return { nationalId: r.national_id, name: r.name || null, kind: k };
    } catch (e) {}
  }
  return null;
}

export function addBan({ nationalId = null, phone = null, reason = '', by = null, kind = 'customer' } = {}) {
  let nid = normNid(nationalId);
  let ph = normPhone(phone);
  // 🔗 نكمّل الناقص من سجلاتنا: الهوية ⇒ الجوال · الجوال ⇒ الهوية (الحظر يشمل الاثنين دائمًا)
  let pname = null;
  try {
    if (nid && !ph) { const f = lookupByIdentity(nid); if (f) { ph = normPhone(f.phone); pname = f.name || null; } }
    else if (ph && !nid) { const f = lookupByPhone(ph); if (f) { nid = normNid(f.nationalId); pname = f.name || null; } }
    else if (nid && ph) { const f = lookupByIdentity(nid); pname = f?.name || null; }
  } catch (e) {}
  if (!nid && !ph) return null;
  // إلغاء أي سطر قديم لنفس الشخص ثم إضافة الحظر النشط
  try {
    if (nid) q.run("UPDATE bans SET active=0 WHERE national_id=? AND active=1", nid);
    if (ph) q.run("UPDATE bans SET active=0 WHERE phone=? AND active=1", ph);
    const r = q.run(
      "INSERT INTO bans (kind, national_id, phone, reason, created_by, active, person_name) VALUES (?,?,?,?,?,1,?)",
      kind, nid, ph, String(reason || '').slice(0, 200), by ? String(by).slice(0, 40) : null, pname,
    );
    return r?.lastInsertRowid || q.get("SELECT id FROM bans ORDER BY id DESC LIMIT 1")?.id || null;
  } catch (e) { console.error('BAN_ADD_FAIL', e.message); return null; }
}

export function liftBan({ nationalId = null, phone = null, by = null } = {}) {
  const nid = normNid(nationalId);
  const ph = normPhone(phone);
  if (!nid && !ph) return 0;
  let n = 0;
  try {
    if (nid) n += Number(q.run("UPDATE bans SET active=0, lifted_by=?, lifted_at=datetime('now') WHERE national_id=? AND active=1", by, nid)?.changes || 0);
    if (ph) n += Number(q.run("UPDATE bans SET active=0, lifted_by=?, lifted_at=datetime('now') WHERE phone=? AND active=1", by, ph)?.changes || 0);
  } catch (e) { console.error('BAN_LIFT_FAIL', e.message); }
  return n;
}

// تحديث/ربط الجوال بسطر حظر قائم (يُستدعى عند محاولة المحظور فأصبح جواله معروفًا)
export function linkBanPhone({ nationalId = null, phone = null } = {}) {
  const nid = normNid(nationalId);
  const ph = normPhone(phone);
  if (!nid || !ph) return 0;
  try { return Number(q.run("UPDATE bans SET phone=COALESCE(phone,?) WHERE national_id=? AND active=1 AND (phone IS NULL OR phone='')", ph, nid)?.changes || 0); } catch (e) { return 0; }
}

export function removeBanById(id, by = null) {
  try { return Number(q.run("UPDATE bans SET active=0, lifted_by=?, lifted_at=datetime('now') WHERE id=? AND active=1", by, Number(id))?.changes || 0); }
  catch (e) { return 0; }
}

export function listBans(limit = 100) {
  try { return q.all("SELECT * FROM bans WHERE active=1 ORDER BY id DESC LIMIT ?", limit); } catch (e) { return []; }
}

// رسالة موحّدة (بلا تفاصيل — لا نكشف سبب الحظر)
export const BAN_MSG = 'تعذّر إتمام طلبك 🙏\nحسابك موقوف حاليًا. للاستفسار تواصل مع الدعم.';
