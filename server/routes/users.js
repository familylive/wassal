import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { q } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { listUsers, roleAr } from '../services/restUsers.js';

const router = Router();
router.use(requireAuth);

export const ROLES_AR = {
  admin: '🔴 مدير المنصة',
  owner: '👤 صاحب النشاط (المالك)',
  cashier: '🧾 الكاشير',
  manager: '📊 المدير (مستلم التقارير)',
  captain: '🛵 كابتن توصيل',
  customer: '🙋 العميل'
};

// 👥 كل المستخدمين في المنصة مع أدوارهم
router.get('/', requireRole('admin'), (req, res) => {
  const admins = q.all("SELECT id, name, email, created_at FROM admins").map(a => ({ ...a, kind: 'admin', role: 'admin', role_ar: ROLES_AR.admin, login: a.email }));
  const restUsers = q.all(`SELECT u.id, u.name, u.phone, u.email, u.role, u.national_id, u.is_active, u.created_at, u.restaurant_id, r.name_ar AS restaurant_name
    FROM restaurant_users u LEFT JOIN restaurants r ON r.id=u.restaurant_id ORDER BY u.restaurant_id, CASE u.role WHEN 'owner' THEN 0 WHEN 'cashier' THEN 1 ELSE 2 END, u.id`)
    .map(u => ({ ...u, kind: 'restaurant_user', role_ar: roleAr(u.role), login: u.phone || u.email }));
  const managers = q.all(`SELECT p.id, p.name, p.phone, p.national_id, p.status, p.report_hour, p.restaurant_id, r.name_ar AS restaurant_name
    FROM report_recipients p LEFT JOIN restaurants r ON r.id=p.restaurant_id ORDER BY p.id DESC`)
    .map(p => ({ ...p, kind: 'manager', role: 'manager', role_ar: ROLES_AR.manager, is_active: p.status === 'approved', login: p.phone }));
  const captains = q.all(`SELECT id, name, phone, email, city, status, is_active, blocked, deposit_balance, created_at FROM captains ORDER BY id DESC`)
    .map(c => ({ ...c, kind: 'captain', role: 'captain', role_ar: ROLES_AR.captain, login: c.phone }));
  const customers = q.all(`SELECT c.id, c.name, c.phone, c.total_orders, c.total_spent, c.created_at,
      (SELECT COUNT(*) FROM customer_locations cl WHERE cl.customer_id=c.id) AS addresses
    FROM customers c ORDER BY c.id DESC`).map(c => ({ ...c, kind: 'customer', role: 'customer', role_ar: ROLES_AR.customer, login: c.phone }));
  res.json({ admins, restaurant_users: restUsers, managers, captains, customers, roles: ROLES_AR,
    counts: { admins: admins.length, restaurant_users: restUsers.length, managers: managers.length, captains: captains.length, customers: customers.length } });
});

// 🔑 إعادة تعيين كلمة مرور (لصاحب النشاط/الكاشير/الكابتن) = آخر ٦ أرقام من الجوال
router.post('/reset-password', requireRole('admin'), (req, res) => {
  const { kind, id } = req.body || {};
  const numId = Number(id);
  if (!numId || !['restaurant_user', 'captain'].includes(kind)) return res.status(400).json({ error: 'نوع غير مدعوم' });
  const table = kind === 'captain' ? 'captains' : 'restaurant_users';
  const row = q.get(`SELECT * FROM ${table} WHERE id=?`, numId);
  if (!row) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const pass = String(row.phone || '').replace(/\D/g, '').slice(-6) || '123456';
  q.run(`UPDATE ${table} SET password_hash=? WHERE id=?`, bcrypt.hashSync(pass, 10), numId);
  res.json({ ok: true, password: pass, name: row.name, phone: row.phone });
});

export default router;
