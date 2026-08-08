import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { q } from '../db.js';
import { signToken, requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.post('/login', (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: 'أدخل البريد/الجوال وكلمة المرور' });
  const admin = q.get("SELECT * FROM admins WHERE email = ?", identifier);
  if (admin && bcrypt.compareSync(password, admin.password_hash))
    return res.json({ token: signToken({ id: admin.id, role: 'admin', name: admin.name }), user: { id: admin.id, name: admin.name, role: 'admin' } });
  const ru = q.get("SELECT * FROM restaurant_users WHERE (email = ? OR phone = ?) AND is_active=1", identifier, identifier);
  if (ru && bcrypt.compareSync(password, ru.password_hash)) {
    const rest = q.get("SELECT name_ar FROM restaurants WHERE id=?", ru.restaurant_id);
    const branch = ru.branch_id ? q.get("SELECT name FROM branches WHERE id=?", ru.branch_id) : null;
    const role = ru.role || 'restaurant';
    return res.json({ token: signToken({ id: ru.id, role, restaurant_id: ru.restaurant_id, branch_id: ru.branch_id || null, name: ru.name }), user: { id: ru.id, name: ru.name, role, restaurant_id: ru.restaurant_id, branch_id: ru.branch_id || null, branch_name: branch?.name || null, restaurant_name: rest?.name_ar } });
  }
  const cap = q.get("SELECT * FROM captains WHERE phone = ? AND is_active=1", identifier);
  if (cap && bcrypt.compareSync(password, cap.password_hash))
    return res.json({ token: signToken({ id: cap.id, role: 'captain', captain_id: cap.id, name: cap.name }), user: { id: cap.id, name: cap.name, role: 'captain', captain_id: cap.id } });
  return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
});

// إنشاء مطعم + مستخدم صاحب المطعم (الكنترول)
router.post('/register-restaurant', requireAuth, requireRole('admin'), (req, res) => {
  const { name_ar, phone, email, password, ...rest } = req.body || {};
  if (!name_ar || !password) return res.status(400).json({ error: 'الاسم وكلمة المرور مطلوبان' });
  const r = q.run(`INSERT INTO restaurants (name_ar, phone, city, delivery_fee, min_order, avg_prep_time_min)
    VALUES (?,?,?,?,?,?)`, name_ar, phone || null, rest.city || null, rest.delivery_fee || 1000, rest.min_order || 3000, rest.avg_prep_time_min || 25);
  q.run("INSERT INTO restaurant_users (restaurant_id, name, phone, email, password_hash, role) VALUES (?,?,?,?,?,?)",
    Number(r.lastInsertRowid), name_ar, phone || null, email || null, bcrypt.hashSync(password, 10), 'owner');
  res.json({ ok: true, restaurant_id: Number(r.lastInsertRowid) });
});

// إنشاء كابتن (الكنترول)
router.post('/register-captain', requireAuth, requireRole('admin'), (req, res) => {
  const { name, phone, password, vehicle_type, city } = req.body || {};
  if (!name || !phone || !password) return res.status(400).json({ error: 'الاسم والجوال وكلمة المرور مطلوبة' });
  const exists = q.get("SELECT id FROM captains WHERE phone=?", phone);
  if (exists) return res.status(400).json({ error: 'رقم الجوال مستخدم مسبقاً' });
  const r = q.run("INSERT INTO captains (name, phone, password_hash, vehicle_type, city, status) VALUES (?,?,?,?,?,?)",
    name, phone, bcrypt.hashSync(password, 10), vehicle_type || 'دراجة', city || null, 'offline');
  res.json({ ok: true, captain_id: Number(r.lastInsertRowid) });
});

// إنشاء حساب موظف فرع (صاحب المطعم الرئيسي) — مشرف / مدير جودة / كاشير
router.post('/register-branch-user', requireAuth, (req, res) => {
  if (!['restaurant','owner','manager','supervisor','quality'].includes(req.user.role)) return res.status(403).json({ error: 'لا تملك صلاحية' });
  const { branch_id, name, phone, password, role = 'supervisor' } = req.body || {};
  const branch = q.get("SELECT * FROM branches WHERE id=? AND restaurant_id=?", branch_id, req.user.restaurant_id);
  if (!branch) return res.status(400).json({ error: 'الفرع غير موجود لمطعمك' });
  if (!name || !phone || !password) return res.status(400).json({ error: 'الاسم والجوال وكلمة المرور مطلوبة' });
  if (!['supervisor', 'quality', 'cashier'].includes(role)) return res.status(400).json({ error: 'دور غير صالح' });
  const exists = q.get("SELECT id FROM restaurant_users WHERE phone=?", phone);
  if (exists) return res.status(400).json({ error: 'الجوال مستخدم مسبقاً' });
  q.run("INSERT INTO restaurant_users (restaurant_id, branch_id, name, phone, password_hash, role) VALUES (?,?,?,?,?,?)",
    branch.restaurant_id, branch.id, name, phone, bcrypt.hashSync(password, 10), role);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));
export default router;
