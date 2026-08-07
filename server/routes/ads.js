import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', requireRole('admin'), (req, res) => {
  res.json(q.all("SELECT a.*, r.name_ar AS rname FROM ads_campaigns a LEFT JOIN restaurants r ON r.id=a.restaurant_id ORDER BY a.id DESC"));
});
router.post('/', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const r = q.run(`INSERT INTO ads_campaigns (title, restaurant_id, image, placement, starts_at, ends_at, budget, is_active)
    VALUES (?,?,?,?,?,?,?,?)`, b.title, b.restaurant_id || null, b.image || null, b.placement || 'home', b.starts_at || null, b.ends_at || null, b.budget || 0, b.is_active ?? 1);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
router.put('/:id', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const allowed = ['title', 'restaurant_id', 'image', 'placement', 'starts_at', 'ends_at', 'budget', 'is_active'];
  const cols = [], vals = [];
  for (const k of allowed) if (b[k] !== undefined) { cols.push(`${k}=?`); vals.push(b[k]); }
  if (!cols.length) return res.status(400).json({ error: 'لا بيانات' });
  vals.push(req.params.id);
  q.run(`UPDATE ads_campaigns SET ${cols.join(',')} WHERE id=?`, ...vals);
  res.json({ ok: true });
});
router.delete('/:id', requireRole('admin'), (req, res) => {
  q.run("DELETE FROM ads_campaigns WHERE id=?", req.params.id);
  res.json({ ok: true });
});
// تتبع المشاهدات والنقرات
router.post('/:id/track', (req, res) => {
  const type = req.body?.type === 'click' ? 'click' : 'impression';
  if (type === 'click') q.run("UPDATE ads_campaigns SET clicks=clicks+1 WHERE id=?", req.params.id);
  else q.run("UPDATE ads_campaigns SET impressions=impressions+1, spent=impressions WHERE id=?", req.params.id);
  res.json({ ok: true });
});
export default router;
