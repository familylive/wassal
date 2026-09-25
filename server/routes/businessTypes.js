import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// قائمة أنواع الأنشطة (يقرأها الجميع — يعدّلها الكنترول)
router.get('/', (req, res) => {
  const rows = q.all(`SELECT b.*, (SELECT COUNT(*) FROM restaurants r WHERE r.business_type_id=b.id) AS restaurants_count
    FROM business_types b ORDER BY b.sort_order, b.id`);
  res.json(rows);
});

// إضافة نوع جديد
router.post('/', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const name = String(b.name_ar || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'اسم النوع مطلوب' });
  const dup = q.get("SELECT id FROM business_types WHERE name_ar=?", name);
  if (dup) return res.status(400).json({ error: 'هذا النوع موجود مسبقاً' });
  const r = q.run("INSERT INTO business_types (name_ar, icon, sort_order, is_active) VALUES (?,?,?,1)",
    name, String(b.icon || '🏬').slice(0, 4), Number(b.sort_order) || 99);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

// تعديل نوع (الاسم/الأيقونة/الترتيب/التفعيل)
router.put('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const row = q.get("SELECT * FROM business_types WHERE id=?", id);
  if (!row) return res.status(404).json({ error: 'النوع غير موجود' });
  const b = req.body || {};
  q.run("UPDATE business_types SET name_ar=?, icon=?, sort_order=?, is_active=? WHERE id=?",
    b.name_ar !== undefined ? String(b.name_ar).trim() : row.name_ar,
    b.icon !== undefined ? String(b.icon).slice(0, 4) : row.icon,
    b.sort_order !== undefined ? Number(b.sort_order) : row.sort_order,
    b.is_active !== undefined ? (b.is_active ? 1 : 0) : row.is_active,
    id);
  res.json({ ok: true, type: q.get("SELECT * FROM business_types WHERE id=?", id) });
});

// حذف نوع (يُرفض إذا كان مستخدماً — الأفضل إيقافه)
router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const used = Number(q.get("SELECT COUNT(*) AS c FROM restaurants WHERE business_type_id=?", id)?.c || 0);
  if (used) return res.status(400).json({ error: `النوع مستخدم في ${used} نشاط — أوقفه بدل حذفه` });
  q.run("DELETE FROM business_types WHERE id=?", id);
  res.json({ ok: true });
});

export default router;
