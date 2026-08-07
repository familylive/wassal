import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/admin', requireRole('admin'), (req, res) => {
  const restaurants = q.get("SELECT COUNT(*) c FROM restaurants");
  const captains = q.get("SELECT COUNT(*) c FROM captains");
  const customers = q.get("SELECT COUNT(*) c FROM customers");
  const today = q.get("SELECT COUNT(*) c, COALESCE(SUM(total),0) rev FROM orders WHERE date(created_at)=date('now') AND status!='cancelled' AND order_no!='DRAFT'");
  const month = q.get("SELECT COUNT(*) c, COALESCE(SUM(total),0) rev FROM orders WHERE strftime('%Y-%m',created_at)=strftime('%Y-%m','now') AND status!='cancelled' AND order_no!='DRAFT'");
  const statuses = q.all("SELECT status, COUNT(*) c FROM orders WHERE order_no!='DRAFT' GROUP BY status ORDER BY c DESC");
  const topRestaurants = q.all(`SELECT r.name_ar, COUNT(o.id) c, COALESCE(SUM(o.total),0) rev FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.status='delivered' GROUP BY o.restaurant_id ORDER BY rev DESC LIMIT 5`);
  const openOrders = q.all(`SELECT o.*, r.name_ar FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.status IN ('new','offered','accepted','transferred','with_captain','on_the_way','arrived','confirmed','preparing','ready') ORDER BY o.id DESC LIMIT 10`);
  const availableCaptains = q.get("SELECT COUNT(*) c FROM captains WHERE status='available'");
  res.json({ counts: { restaurants: restaurants.c, captains: captains.c, customers: customers.c, availableCaptains: availableCaptains.c },
    today: { orders: today.c, revenue: today.rev }, month: { orders: month.c, revenue: month.rev }, statuses, topRestaurants, openOrders });
});

export default router;
