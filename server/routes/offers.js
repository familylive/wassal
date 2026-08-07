import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rid = req.query.restaurant_id || req.user.restaurant_id;
  const rows = q.all("SELECT * FROM offers WHERE (? IS NULL OR restaurant_id=?) ORDER BY id DESC", rid || null, rid || null);
  res.json(rows);
});
router.post('/', (req, res) => {
  const b = req.body || {};
  const rid = b.restaurant_id || req.user.restaurant_id;
  const r = q.run(`INSERT INTO offers (restaurant_id, title, description, type, value, min_order, bundle_item_ids, starts_at, ends_at, is_active, image)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    rid, b.title, b.description || null, b.type || 'percent', b.value || 0, b.min_order || 0, b.bundle_item_ids ? JSON.stringify(b.bundle_item_ids) : null, b.starts_at || null, b.ends_at || null, b.is_active ?? 1, b.image || null);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
router.put('/:id', (req, res) => {
  const b = req.body || {};
  const allowed = ['title', 'description', 'type', 'value', 'min_order', 'bundle_item_ids', 'starts_at', 'ends_at', 'is_active', 'image'];
  const cols = [], vals = [];
  for (const k of allowed) if (b[k] !== undefined) { cols.push(`${k}=?`); vals.push(k === 'bundle_item_ids' ? JSON.stringify(b[k]) : b[k]); }
  if (!cols.length) return res.status(400).json({ error: 'لا بيانات' });
  vals.push(req.params.id);
  q.run(`UPDATE offers SET ${cols.join(',')} WHERE id=?`, ...vals);
  res.json({ ok: true });
});
router.delete('/:id', (req, res) => {
  q.run("DELETE FROM offers WHERE id=?", req.params.id);
  res.json({ ok: true });
});
export default router;
