import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const s = req.query.search;
  const rows = q.all("SELECT * FROM customers WHERE (? IS NULL OR name LIKE ? OR phone LIKE ?) ORDER BY id DESC LIMIT 200", s ? '%' + s + '%' : null, s ? '%' + s + '%' : null, s ? '%' + s + '%' : null);
  res.json(rows);
});
router.get('/:id', (req, res) => {
  const c = q.get("SELECT * FROM customers WHERE id=?", req.params.id);
  if (!c) return res.status(404).json({ error: 'غير موجود' });
  const locations = q.all("SELECT * FROM customer_locations WHERE customer_id=? ORDER BY is_default DESC, id DESC", c.id);
  const orders = q.all("SELECT * FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 50", c.id);
  const loyalty = q.all("SELECT * FROM loyalty_transactions WHERE customer_id=? ORDER BY id DESC LIMIT 50", c.id);
  res.json({ ...c, locations, orders, loyalty });
});
router.put('/:id', (req, res) => {
  const b = req.body || {};
  const cols = [], vals = [];
  for (const k of ['name', 'tier', 'points_balance']) if (b[k] !== undefined) { cols.push(`${k}=?`); vals.push(b[k]); }
  if (!cols.length) return res.status(400).json({ error: 'لا بيانات' });
  vals.push(req.params.id);
  q.run(`UPDATE customers SET ${cols.join(',')} WHERE id=?`, ...vals);
  res.json({ ok: true });
});
// محادثات العميل
router.get('/:id/conversations', (req, res) => {
  const rows = q.all(`SELECT c.*, o.order_no FROM conversations c LEFT JOIN orders o ON o.id=c.order_id
    WHERE c.participant_type='customer' OR o.customer_id=? ORDER BY c.id DESC LIMIT 300`, req.params.id);
  res.json(rows);
});
export default router;
