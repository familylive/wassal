import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { captainAccept } from '../services/dispatch.js';

const router = Router();

// قائمة عامة للكباتن (للمحاكي/الواجهات العامة)
router.get('/public', (req, res) => {
  const rows = q.all("SELECT id, name, phone, status, vehicle_type FROM captains WHERE is_active=1 ORDER BY id");
  res.json(rows);
});

router.use(requireAuth);

router.get('/', (req, res) => {
  const self = req.user.role === 'captain';
  const rows = self
    ? q.all("SELECT * FROM captains WHERE id=?", req.user.captain_id)
    : q.all("SELECT * FROM captains ORDER BY id DESC");
  res.json(rows);
});
router.post('/', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const bcrypt = b.password_hash || null;
  const r = q.run(`INSERT INTO captains (name, phone, email, password_hash, vehicle_type, vehicle_plate, city, status, is_active)
    VALUES (?,?,?,?,?,?,?,?,?)`, b.name, b.phone || null, b.email || null, bcrypt, b.vehicle_type || 'دراجة', b.vehicle_plate || null, b.city || null, 'offline', b.is_active ?? 1);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
router.put('/:id', (req, res) => {
  const b = req.body || {};
  const allowed = ['name', 'phone', 'email', 'vehicle_type', 'vehicle_plate', 'city', 'lat', 'lng', 'status', 'is_active'];
  const cols = [], vals = [];
  for (const k of allowed) if (b[k] !== undefined) { cols.push(`${k}=?`); vals.push(b[k]); }
  if (!cols.length) return res.status(400).json({ error: 'لا بيانات' });
  vals.push(req.params.id);
  q.run(`UPDATE captains SET ${cols.join(',')} WHERE id=?`, ...vals);
  res.json({ ok: true });
});
// تغيير الحالة (متاح/مشغول/غير متصل)
router.post('/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!['available', 'busy', 'offline'].includes(status)) return res.status(400).json({ error: 'حالة غير صالحة' });
  q.run("UPDATE captains SET status=? WHERE id=?", status, req.params.id);
  res.json({ ok: true });
});
// طلبات الكابتن
router.get('/:id/orders', (req, res) => {
  const rows = q.all("SELECT * FROM orders WHERE captain_id=? ORDER BY id DESC LIMIT 100", req.params.id);
  res.json(rows);
});
// كل المحادثات المحفوظة في حساب الكابتن (من بداية الطلب حتى التقيم)
router.get('/:id/conversations', (req, res) => {
  const rows = q.all(`SELECT c.*, o.order_no FROM conversations c LEFT JOIN orders o ON o.id=c.order_id
    WHERE o.captain_id=? ORDER BY c.id DESC LIMIT 500`, req.params.id);
  res.json(rows);
});
// العروض المتاحة للكابتن
router.get('/:id/offers', (req, res) => {
  const rows = q.all(`SELECT co.*, o.order_no, o.total, o.national_address, o.est_delivery_min, r.name_ar AS restaurant
    FROM captain_offers co JOIN orders o ON o.id=co.order_id JOIN restaurants r ON r.id=o.restaurant_id
    WHERE co.captain_id=? AND co.status='offered' ORDER BY co.id DESC`, req.params.id);
  res.json(rows);
});
// قبول / رفض العرض
router.post('/offers/:offerId/respond', (req, res) => {
  const offer = q.get("SELECT * FROM captain_offers WHERE id=?", req.params.offerId);
  if (!offer) return res.status(404).json({ error: 'العرض غير موجود' });
  const action = req.body?.action;
  if (action === 'accept') return res.json(captainAccept(offer.order_id, offer.captain_id));
  if (action === 'reject') {
    q.run("UPDATE captain_offers SET status='rejected', responded_at=datetime('now') WHERE id=?", offer.id);
    return res.json({ ok: true });
  }
  return res.status(400).json({ error: 'action = accept | reject' });
});
export default router;
