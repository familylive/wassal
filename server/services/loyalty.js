import { q } from '../db.js';
import { computeTier } from '../utils.js';

export function ensureSettings() {
  let s = q.get("SELECT * FROM loyalty_settings WHERE id=1");
  if (!s) { q.run("INSERT INTO loyalty_settings (id, points_per_riyal, redeem_points_per_riyal, is_active) VALUES (1,1,100,1)"); s = q.get("SELECT * FROM loyalty_settings WHERE id=1"); }
  return s;
}

export function awardPoints(customerId, orderId, totalHalalas) {
  const s = ensureSettings();
  if (!s.is_active) return 0;
  const points = Math.floor(totalHalalas / 100) * s.points_per_riyal;
  if (points <= 0) return 0;
  const c = q.get("SELECT * FROM customers WHERE id=?", customerId);
  if (!c) return 0;
  q.run("INSERT INTO loyalty_transactions (customer_id, order_id, points, type, note) VALUES (?,?,?,?,?)", customerId, orderId, points, 'earn', 'نقاط من طلب');
  const balance = (c.points_balance || 0) + points;
  const tier = computeTier(c.total_points_earned + points);
  q.run("UPDATE customers SET points_balance=?, total_points_earned=total_points_earned+?, total_orders=total_orders+1, total_spent=total_spent+?, tier=? WHERE id=?", balance, points, totalHalalas, tier.name, customerId);
  return points;
}
