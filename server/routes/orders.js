import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { setStatus, cancelOrder, rateOrder } from '../services/orderService.js';
import { restaurantTransfer } from '../services/dispatch.js';
import { triggerRating } from '../services/flow.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const u = req.user;
  let rows;
  if (u.role === 'admin') {
    rows = q.all("SELECT * FROM orders WHERE order_no != 'DRAFT' ORDER BY id DESC LIMIT 200");
  } else if (u.restaurant_id) {
    // كل أدوار المطعم: المطعم الرئيسي يرى الكل، وموظف الفرع يرى فرعه فقط
    rows = u.branch_id
      ? q.all("SELECT * FROM orders WHERE restaurant_id=? AND branch_id=? AND order_no != 'DRAFT' ORDER BY id DESC LIMIT 200", u.restaurant_id, u.branch_id)
      : q.all("SELECT * FROM orders WHERE restaurant_id=? AND order_no != 'DRAFT' ORDER BY id DESC LIMIT 200", u.restaurant_id);
  } else {
    rows = q.all("SELECT * FROM orders WHERE captain_id=? ORDER BY id DESC LIMIT 200", u.captain_id);
  }
  // أسماء مساعدة
  const enriched = rows.map(o => ({ ...o, restaurant_name: q.get("SELECT name_ar FROM restaurants WHERE id=?", o.restaurant_id)?.name_ar || null }));
  res.json(enriched);
});

router.get('/:id', (req, res) => {
  const o = q.get("SELECT * FROM orders WHERE id=? AND order_no != 'DRAFT'", req.params.id);
  if (!o) return res.status(404).json({ error: 'طلب غير موجود' });
  const events = q.all("SELECT * FROM order_events WHERE order_id=? ORDER BY id", o.id);
  const conversations = q.all("SELECT * FROM conversations WHERE order_id=? ORDER BY id", o.id);
  const offers = q.all(`SELECT co.*, c.name AS captain_name, c.phone AS captain_phone FROM captain_offers co LEFT JOIN captains c ON c.id=co.captain_id WHERE co.order_id=? ORDER BY co.id`, o.id);
  const items = JSON.parse(o.items_json || '[]');
  const customer = q.get("SELECT id, name, phone FROM customers WHERE id=?", o.customer_id);
  const captain = o.captain_id ? q.get("SELECT id, name, phone, vehicle_type FROM captains WHERE id=?", o.captain_id) : null;
  res.json({ ...o, items, events, conversations, offers, customer, captain, restaurant_name: q.get("SELECT name_ar FROM restaurants WHERE id=?", o.restaurant_id)?.name_ar });
});

// تغيير الحالة: المطعم (confirm/preparing/ready) — الكابتن (with_captain/on_the_way/arrived/delivered)
router.post('/:id/status', (req, res) => {
  const { status } = req.body || {};
  const o = q.get("SELECT * FROM orders WHERE id=?", req.params.id);
  if (!o) return res.status(404).json({ error: 'طلب غير موجود' });
  const r = setStatus(o.id, status, req.user.role, req.user.id);
  if (r.error) return res.status(400).json(r);
  if (status === 'delivered') {
    const fresh = q.get("SELECT * FROM orders WHERE id=?", o.id);
    triggerRating(fresh);
  }
  res.json({ ok: true });
});

// المطعم يحوّل الطلب على كابتن عبر اللوحة
router.post('/:id/assign', (req, res) => {
  const { captain_id } = req.body || {};
  const r = restaurantTransfer(req.params.id, captain_id);
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true, order: r.order });
});

router.post('/:id/cancel', (req, res) => {
  const r = cancelOrder(req.params.id, req.body?.reason || '');
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true });
});

// تقييم العميل (المطعم / السرعة / الكابتن)
router.post('/:id/rate', (req, res) => {
  const b = req.body || {};
  const r = rateOrder(req.params.id, { restaurant: b.restaurant, speed: b.speed, captain: b.captain, comment: b.comment });
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true });
});

export default router;
