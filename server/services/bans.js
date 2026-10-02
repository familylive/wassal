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

export function addBan({ nationalId = null, phone = null, reason = '', by = null, kind = 'customer' } = {}) {
  const nid = normNid(nationalId);
  const ph = normPhone(phone);
  if (!nid && !ph) return null;
  // إلغاء أي سطر قديم لنفس الشخص ثم إضافة الحظر النشط
  try {
    if (nid) q.run("UPDATE bans SET active=0 WHERE national_id=? AND active=1", nid);
    if (ph) q.run("UPDATE bans SET active=0 WHERE phone=? AND active=1", ph);
    const r = q.run(
      "INSERT INTO bans (kind, national_id, phone, reason, created_by, active) VALUES (?,?,?,?,?,1)",
      kind, nid, ph, String(reason || '').slice(0, 200), by ? String(by).slice(0, 40) : null,
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

export function removeBanById(id, by = null) {
  try { return Number(q.run("UPDATE bans SET active=0, lifted_by=?, lifted_at=datetime('now') WHERE id=? AND active=1", by, Number(id))?.changes || 0); }
  catch (e) { return 0; }
}

export function listBans(limit = 100) {
  try { return q.all("SELECT * FROM bans WHERE active=1 ORDER BY id DESC LIMIT ?", limit); } catch (e) { return []; }
}

// رسالة موحّدة (بلا تفاصيل — لا نكشف سبب الحظر)
export const BAN_MSG = 'تعذّر إتمام طلبك 🙏\nحسابك موقوف حاليًا. للاستفسار تواصل مع الدعم.';
