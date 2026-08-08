import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// فترات التقارير
const PERIODS = {
  daily: { label: 'يومي', days: 1 },
  weekly: { label: 'أسبوعي', days: 7 },
  monthly: { label: 'شهري', days: 30 },
  quarterly: { label: 'ربع سنوي', days: 90 },
  semiannual: { label: 'نصف سنوي', days: 180 },
  annual: { label: 'سنوي', days: 365 }
};

// الكاشير لا يملك التقارير
function canReport(req) {
  if (req.user.role === 'cashier') return false;
  return true;
}
function scope(req) {
  // owner: كل الفروع | المشرف/الجودة: فرعه إن وُجد
  const u = req.user;
  let where = '1=1', params = [];
  if (u.branch_id) { where = 'o.branch_id=?'; params.push(u.branch_id); }
  else if (u.role !== 'owner' && u.role !== 'admin') { where = 'o.restaurant_id=?'; params.push(u.restaurant_id); }
  return { where, params };
}

router.get('/summary', (req, res) => {
  if (!canReport(req)) return res.status(403).json({ error: 'موظف الكاشير لا يملك صلاحية التقارير' });
  const period = PERIODS[req.query.period] || PERIODS.daily;
  const { where, params } = scope(req);
  const days = period.days;
  const base = `WHERE ${where} AND o.order_no != 'DRAFT' AND o.created_at >= datetime('now','-${days} days') AND o.status != 'cancelled'`;
  const summary = q.get(`SELECT COUNT(*) AS orders, COALESCE(SUM(o.total),0) AS revenue, COALESCE(AVG(o.rating_restaurant),0) AS rest_rating,
    COALESCE(AVG(o.rating_speed),0) AS speed_rating, COALESCE(AVG(o.rating_captain),0) AS cap_rating, COUNT(CASE WHEN o.rating_restaurant IS NOT NULL THEN 1 END) AS rated,
    COALESCE(AVG(o.est_delivery_min),0) AS est_min, COUNT(o.arrived_at) AS arrived_count, COUNT(o.delivered_at) AS delivered_count
    FROM orders o ${base}`, ...params);
  const statuses = q.all(`SELECT o.status, COUNT(*) c FROM orders o ${base} GROUP BY o.status`, ...params);
  const payments = q.all(`SELECT o.payment_method, COUNT(*) c, COALESCE(SUM(o.total),0) rev FROM orders o ${base} GROUP BY o.payment_method`, ...params);
  const topItems = q.all(`SELECT o.items_json FROM orders o ${base} AND o.status='delivered'`, ...params)
    .flatMap(r => { try { return JSON.parse(r.items_json); } catch { return []; } })
    .reduce((acc, i) => { const k = i.name; acc[k] = (acc[k] || 0) + i.quantity; return acc; }, {});
  const top = Object.entries(topItems).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, qty]) => ({ name, qty }));
  // مدى وصول الطلبات: نسبة التسليم والوقت الفعلي
  const delivery = q.get(`SELECT COUNT(*) AS total, SUM(CASE WHEN o.status='delivered' THEN 1 ELSE 0 END) AS delivered,
    SUM(CASE WHEN o.status IN ('arrived','delivered') THEN 1 ELSE 0 END) AS reached
    FROM orders o ${base}`, ...params);
  // أسباب الإلغاء (استبيان العملاء)
  const cancellations = q.all(`SELECT o.cancel_reason, COUNT(*) c FROM orders o WHERE ${where} AND o.order_no != 'DRAFT' AND o.status='cancelled' AND o.cancel_reason IS NOT NULL AND o.created_at >= datetime('now','-${days} days') GROUP BY o.cancel_reason ORDER BY c DESC`, ...params);
  const cancelTotal = q.get(`SELECT COUNT(*) c FROM orders o WHERE ${where} AND o.order_no != 'DRAFT' AND o.status='cancelled' AND o.created_at >= datetime('now','-${days} days')`, ...params);
  res.json({ period: { key: req.query.period || 'daily', ...period }, summary, statuses, payments, top, delivery, cancellations, cancelTotal: cancelTotal.c });
});

router.get('/ratings', (req, res) => {
  if (!canReport(req)) return res.status(403).json({ error: 'موظف الكاشير لا يملك صلاحية التقارير' });
  const period = PERIODS[req.query.period] || PERIODS.daily;
  const { where, params } = scope(req);
  const rows = q.all(`SELECT o.order_no, o.created_at, o.rating_restaurant, o.rating_speed, o.rating_captain, o.rating_comment,
    o.total, o.status, o.arrived_at, o.delivered_at, o.est_delivery_min, c.name AS customer_name, r.name_ar AS restaurant, b.name AS branch
    FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN restaurants r ON r.id=o.restaurant_id LEFT JOIN branches b ON b.id=o.branch_id
    WHERE ${where} AND o.order_no != 'DRAFT' AND o.rating_restaurant IS NOT NULL AND o.created_at >= datetime('now','-${period.days} days')
    ORDER BY o.id DESC LIMIT 200`, ...params);
  res.json(rows);
});

router.get('/orders', (req, res) => {
  if (!canReport(req)) return res.status(403).json({ error: 'موظف الكاشير لا يملك صلاحية التقارير' });
  const period = PERIODS[req.query.period] || PERIODS.daily;
  const { where, params } = scope(req);
  const rows = q.all(`SELECT o.order_no, o.created_at, o.total, o.status, o.payment_method, o.payment_status,
    o.est_delivery_min, o.arrived_at, o.delivered_at, o.rating_restaurant, o.rating_speed, o.rating_captain,
    c.name AS customer_name, b.name AS branch
    FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN branches b ON b.id=o.branch_id
    WHERE ${where} AND o.order_no != 'DRAFT' AND o.created_at >= datetime('now','-${period.days} days')
    ORDER BY o.id DESC LIMIT 500`, ...params);
  res.json(rows);
});

export default router;
