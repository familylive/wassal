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

// ---------- ملخص الولاء: الرصيد الفعلي + ما سينتهي ومتى (صلاحية سنة من تاريخ الكسب، FIFO) ----------
export function loyaltySummary(customerId) {
  const c = q.get("SELECT * FROM customers WHERE id=?", customerId);
  const st = ensureSettings();
  const tx = q.all("SELECT * FROM loyalty_transactions WHERE customer_id=? ORDER BY id", customerId);
  const YEAR_MS = 365 * 24 * 3600 * 1000;
  const parse = (t) => new Date(String(t || '').replace(' ', 'T') + 'Z');
  const batches = [];
  for (const t of tx) {
    const pts = Number(t.points || 0);
    if (pts > 0 && String(t.type || 'earn') !== 'redeem') {
      const at = parse(t.created_at);
      batches.push({ left: pts, exp: new Date(at.getTime() + YEAR_MS) });
    } else if (pts < 0 || String(t.type) === 'redeem') {
      let need = Math.abs(pts);
      for (const b of batches) { if (need <= 0) break; const take = Math.min(b.left, need); b.left -= take; need -= take; }
    }
  }
  const now = Date.now();
  const live = batches.filter(b => b.left > 0 && b.exp.getTime() > now);
  const expired = batches.filter(b => b.left > 0 && b.exp.getTime() <= now).reduce((a, b) => a + b.left, 0);
  const soon = live.filter(b => b.exp.getTime() - now <= 30 * 24 * 3600 * 1000);
  const sorted = live.slice().sort((a, b) => a.exp - b.exp);
  return {
    balance: live.reduce((a, b) => a + b.left, 0),
    expired,
    expiringSoon: soon.reduce((a, b) => a + b.left, 0),
    expiringAt: sorted[0] ? sorted[0].exp : null,
    layers: sorted.map(b => ({ points: b.left, expiresAt: b.exp })),
    pointsPerRiyal: Number(st.points_per_riyal || 1),
    redeemPerRiyal: Number(st.redeem_points_per_riyal || 100),
    tier: c?.tier || null,
    stored: Number(c?.points_balance || 0)
  };
}
