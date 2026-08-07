import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ensureDefaultBranch } from '../services/branches.js';

const router = Router();
router.use(requireAuth);

// قائمة المطاعم (كنترول) + المطاعم النشطة (عمومي للكباتن)
router.get('/', (req, res) => {
  const rows = q.all(`SELECT r.*, (SELECT COUNT(*) FROM orders o WHERE o.restaurant_id=r.id AND o.status='delivered') AS delivered_count,
    (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.restaurant_id=r.id AND o.status='delivered') AS revenue
    FROM restaurants r ORDER BY r.id DESC`);
  res.json(rows);
});

router.post('/', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const r = q.run(`INSERT INTO restaurants (name_ar, name_en, phone, whatsapp_number, city, address, lat, lng, delivery_fee, min_order, avg_prep_time_min, logo, cover, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    b.name_ar, b.name_en || null, b.phone || null, b.whatsapp_number || null, b.city || null, b.address || null,
    b.lat || null, b.lng || null, b.delivery_fee || 1000, b.min_order || 3000, b.avg_prep_time_min || 25, b.logo || null, b.cover || null, b.is_active ?? 1);
  const id = Number(r.lastInsertRowid);
  ensureDefaultBranch(id);
  res.json({ ok: true, id });
});

router.get('/:id', (req, res) => {
  const r = q.get("SELECT * FROM restaurants WHERE id=?", req.params.id);
  if (!r) return res.status(404).json({ error: 'غير موجود' });
  const cats = q.all("SELECT * FROM categories WHERE restaurant_id=? ORDER BY sort_order, id", r.id);
  const menu = cats.map(c => ({ ...c, items: q.all("SELECT * FROM items WHERE restaurant_id=? AND category_id=? ORDER BY sort_order, id", r.id, c.id) }));
  const offers = q.all("SELECT * FROM offers WHERE restaurant_id=? AND is_active=1 ORDER BY id DESC", r.id);
  const branches = q.all("SELECT * FROM branches WHERE restaurant_id=? ORDER BY id", r.id);
  res.json({ ...r, menu, offers, branches });
});

router.put('/:id', (req, res) => {
  const b = req.body || {};
  const allowed = ['name_ar', 'name_en', 'phone', 'whatsapp_number', 'city', 'address', 'lat', 'lng', 'delivery_fee', 'min_order', 'avg_prep_time_min', 'logo', 'cover', 'is_active'];
  const cols = [], vals = [];
  for (const k of allowed) if (b[k] !== undefined) { cols.push(`${k}=?`); vals.push(b[k]); }
  if (!cols.length) return res.status(400).json({ error: 'لا توجد بيانات' });
  vals.push(req.params.id);
  q.run(`UPDATE restaurants SET ${cols.join(',')} WHERE id=?`, ...vals);
  res.json({ ok: true });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  q.run("DELETE FROM restaurants WHERE id=?", req.params.id);
  res.json({ ok: true });
});

// إحصائيات المطعم (أو الفرع)
router.get('/:id/stats', (req, res) => {
  const id = req.params.id;
  const bf = req.query.branch_id ? 'AND branch_id=' + Number(req.query.branch_id) : '';
  const today = q.get("SELECT COUNT(*) c, COALESCE(SUM(total),0) rev FROM orders WHERE restaurant_id=? " + bf + " AND date(created_at)=date('now') AND status!='cancelled'", id);
  const month = q.get("SELECT COUNT(*) c, COALESCE(SUM(total),0) rev FROM orders WHERE restaurant_id=? " + bf + " AND strftime('%Y-%m', created_at)=strftime('%Y-%m','now') AND status!='cancelled'", id);
  const statuses = q.all("SELECT status, COUNT(*) c FROM orders WHERE restaurant_id=? " + bf + " GROUP BY status", id);
  const top = q.all(`SELECT o.items_json, COUNT(*) c FROM orders o WHERE o.restaurant_id=? AND o.status='delivered' GROUP BY o.items_json ORDER BY c DESC LIMIT 5`, id);
  const open = q.get("SELECT COUNT(*) c FROM orders WHERE restaurant_id=? " + bf + " AND status IN ('new','confirmed','preparing','ready','offered','accepted','transferred','with_captain','on_the_way','arrived')", id);
  res.json({ today: { orders: today.c, revenue: today.rev }, month: { orders: month.c, revenue: month.rev }, statuses, top, open: open.c });
});

// حسابات مدراء الفروع
router.get('/:id/branch-users', (req, res) => {
  res.json(q.all("SELECT ru.id, ru.name, ru.phone, ru.branch_id FROM restaurant_users ru WHERE ru.restaurant_id=? AND ru.branch_id IS NOT NULL", req.params.id));
});

// محادثات المطعم (أو الفرع)
router.get('/:id/conversations', (req, res) => {
  const bf = req.query.branch_id ? 'AND o.branch_id=' + Number(req.query.branch_id) : '';
  const rows = q.all(`SELECT c.*, o.order_no FROM conversations c LEFT JOIN orders o ON o.id=c.order_id
    WHERE o.restaurant_id=? ${bf} ORDER BY c.id DESC LIMIT 300`, req.params.id);
  res.json(rows);
});

export default router;
