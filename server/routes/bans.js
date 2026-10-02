// 🚫 إدارة الحظر — للمدير فقط
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { listBans, addBan, liftBan, removeBanById, isBanned } from '../services/bans.js';

const router = Router();
router.use(requireAuth);

router.get('/', requireRole('admin'), (req, res) => {
  res.json({ ok: true, bans: listBans(Number(req.query.limit) || 200) });
});

router.post('/', requireRole('admin'), (req, res) => {
  const { national_id, phone, reason, kind } = req.body || {};
  const id = addBan({
    nationalId: national_id, phone, reason, kind: kind || 'customer',
    by: req.user?.name || req.user?.role || 'admin',
  });
  if (!id) return res.status(400).json({ error: 'أدخل رقم هوية صحيح (١٠ أرقام تبدأ بـ1 أو 2) أو رقم جوال' });
  res.json({ ok: true, id, bans: listBans() });
});

router.post('/lift', requireRole('admin'), (req, res) => {
  const { national_id, phone } = req.body || {};
  const n = liftBan({ nationalId: national_id, phone, by: req.user?.name || 'admin' });
  res.json({ ok: true, lifted: n, bans: listBans() });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const n = removeBanById(Number(req.params.id), req.user?.name || 'admin');
  res.json({ ok: true, removed: n, bans: listBans() });
});

router.get('/check', requireRole('admin'), (req, res) => {
  res.json({ ok: true, banned: !!isBanned({ nationalId: req.query.nid, phone: req.query.phone }) });
});

export default router;
