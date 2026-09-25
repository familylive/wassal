import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getAdRequest, setAdPrice, setAdStatus, publishAd, customersInCity } from '../services/ads.js';

const router = Router();
router.use(requireAuth);

router.get('/', requireRole('admin'), (req, res) => {
  const rows = q.all(`SELECT a.*, r.name_ar AS restaurant_name FROM ad_requests a LEFT JOIN restaurants r ON r.id=a.restaurant_id
    ORDER BY (a.status IN ('requested','priced','paid','content','pending_approval')) DESC, a.id DESC LIMIT 200`);
  res.json(rows.map(r => ({ ...r, cityCustomers: customersInCity(r.city) })));
});

router.post('/:id/price', requireRole('admin'), (req, res) => {
  const price = Number(req.body?.price);
  if (!price || price <= 0) return res.status(400).json({ error: 'اكتب السعر' });
  res.json({ ok: true, request: setAdPrice(Number(req.params.id), Math.round(price * 100)) });
});

router.post('/:id/approve', requireRole('admin'), async (req, res) => {
  const req2 = getAdRequest(Number(req.params.id));
  if (!req2) return res.status(404).json({ error: 'غير موجود' });
  if (!req2.content) return res.status(400).json({ error: 'لا يوجد نص إعلان بعد' });
  const r = await publishAd(req2);
  res.json({ ok: true, ...r });
});

router.post('/:id/reject', requireRole('admin'), (req, res) => {
  res.json({ ok: true, request: setAdStatus(Number(req.params.id), 'rejected', { supervisor_note: String(req.body?.note || 'رفض الإدارة') }) });
});

export default router;
