import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { approveRegistration, rejectRegistration, safeItems } from '../services/registrations.js';

const router = Router();
router.use(requireAuth);

// قائمة طلبات التسجيل (أنشطة + كباتن)
router.get('/', requireRole('admin'), (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const rows = status
    ? q.all("SELECT * FROM business_registrations WHERE status=? ORDER BY id DESC LIMIT 300", status)
    : q.all("SELECT * FROM business_registrations ORDER BY id DESC LIMIT 300");
  res.json(rows.map(r => ({ ...r, items: safeItems(r.items_json) })));
});

router.post('/:id/approve', requireRole('admin'), async (req, res) => {
  const r = await approveRegistration(Number(req.params.id));
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

router.post('/:id/reject', requireRole('admin'), async (req, res) => {
  const r = await rejectRegistration(Number(req.params.id), String(req.body?.note || ''));
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

export default router;
