// 👥 مستخدمو الأنشطة: صاحب النشاط (المالك) · الكاشير · المدير
import bcrypt from 'bcryptjs';
import { q } from '../db.js';
import { validatePhone } from '../utils.js';

export const ROLE_AR = {
  owner: 'صاحب النشاط (المالك)',
  cashier: 'الكاشير',
  manager: 'المدير',
  supervisor: 'المشرف',
  quality: 'الجودة',
  restaurant: 'النشاط'
};
export const roleAr = (r) => ROLE_AR[r] || r || 'النشاط';

export function restUserByPhone(phone) {
  const p = validatePhone(phone) || String(phone || '');
  if (!p) return null;
  return q.get("SELECT * FROM restaurant_users WHERE (phone=? OR phone=?) AND is_active=1 ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'restaurant' THEN 1 WHEN 'cashier' THEN 2 ELSE 3 END, id LIMIT 1", p, String(phone || ''));
}

export function isCashierPhone(phone) {
  const u = restUserByPhone(phone);
  return !!u && u.role === 'cashier';
}

export function isOwnerPhone(phone) {
  const u = restUserByPhone(phone);
  return !!u && ['owner', 'restaurant'].includes(u.role);
}

// جوال صاحب النشاط: رقم النشاط ثم أول مستخدم مالك/النشاط
export function ownerPhone(rid) {
  const r = q.get("SELECT * FROM restaurants WHERE id=?", rid);
  const u = q.get("SELECT phone FROM restaurant_users WHERE restaurant_id=? AND role IN ('owner','restaurant') AND is_active=1 ORDER BY id LIMIT 1", rid);
  return (r?.phone && (validatePhone(r.phone) || r.phone)) || (u?.phone && (validatePhone(u.phone) || u.phone)) || r?.whatsapp_number || null;
}

// جوال الكاشير (أحدث كاشير مفعّل)
export function cashierPhone(rid) {
  const u = q.get("SELECT phone FROM restaurant_users WHERE restaurant_id=? AND role='cashier' AND is_active=1 ORDER BY id DESC LIMIT 1", rid);
  return u?.phone ? (validatePhone(u.phone) || u.phone) : null;
}

// 🧾 الطلبات توصل للكاشير أولاً — وإذا ما فيه كاشير: لصاحب النشاط
export function ordersPhone(rid) {
  return cashierPhone(rid) || ownerPhone(rid);
}

export function addCashier({ restaurant_id, name, phone }) {
  const p = validatePhone(phone) || String(phone || '');
  const pass = String(p).slice(-6) || '123456';
  const dup = q.get("SELECT * FROM restaurant_users WHERE phone=? AND restaurant_id=?", p, restaurant_id);
  if (dup) {
    q.run("UPDATE restaurant_users SET role='cashier', name=COALESCE(?,name), is_active=1 WHERE id=?", name || null, dup.id);
    return { user: q.get("SELECT * FROM restaurant_users WHERE id=?", dup.id), created: false, password: null };
  }
  const r = q.run("INSERT INTO restaurant_users (restaurant_id, name, phone, password_hash, role, is_active) VALUES (?,?,?,?, 'cashier', 1)",
    restaurant_id, name || 'الكاشير', p, bcrypt.hashSync(pass, 10));
  return { user: q.get("SELECT * FROM restaurant_users WHERE id=?", Number(r.lastInsertRowid)), created: true, password: pass };
}

export function listUsers(rid) {
  return q.all("SELECT id, name, phone, role, is_active, created_at FROM restaurant_users WHERE restaurant_id=? ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'restaurant' THEN 1 WHEN 'cashier' THEN 2 ELSE 3 END, id", rid);
}
