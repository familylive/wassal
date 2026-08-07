import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { ensureDefaultBranch } from '../services/branches.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  if (req.user.branch_id) {
    const b = q.get("SELECT * FROM branches WHERE id=? AND restaurant_id=?", req.user.branch_id, req.user.restaurant_id);
    return res.json(b ? [b] : []);
  }
  const rid = req.query.restaurant_id || req.user.restaurant_id;
  if (rid) ensureDefaultBranch(Number(rid));
  res.json(q.all("SELECT * FROM branches WHERE restaurant_id=? ORDER BY id", rid));
});
router.post('/', (req, res) => {
  const b = req.body || {};
  const rid = b.restaurant_id || req.user.restaurant_id;
  const r = q.run(`INSERT INTO branches (restaurant_id, name, city, address, lat, lng, delivery_radius_km, delivery_fee, min_order, phone, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    rid, b.name, b.city || null, b.address || null, b.lat || null, b.lng || null, b.delivery_radius_km ?? 15, b.delivery_fee ?? 1000, b.min_order ?? 3000, b.phone || null, b.is_active ?? 1);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
router.put('/:id', (req, res) => {
  if (req.user.branch_id && Number(req.params.id) !== Number(req.user.branch_id)) return res.status(403).json({ error: 'لا يمكنك تعديل فرع آخر' });
  const b = req.body || {};
  const allowed = ['name', 'city', 'address', 'lat', 'lng', 'delivery_radius_km', 'delivery_fee', 'min_order', 'phone', 'is_active'];
  const cols = [], vals = [];
  for (const k of allowed) if (b[k] !== undefined) { cols.push(`${k}=?`); vals.push(b[k]); }
  if (!cols.length) return res.status(400).json({ error: 'لا بيانات' });
  vals.push(req.params.id);
  q.run(`UPDATE branches SET ${cols.join(',')} WHERE id=?`, ...vals);
  res.json({ ok: true });
});
router.delete('/:id', (req, res) => {
  q.run("DELETE FROM branches WHERE id=?", req.params.id);
  res.json({ ok: true });
});
export default router;
