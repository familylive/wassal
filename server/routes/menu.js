import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { q } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();
router.use(requireAuth);

// 🔒 الأدوار المسموح لها بتعديل المنيو.
// تبويب «المنيو» في لوحة النشاط يظهر لصاحب النشاط فقط (TABS_OWNER في client/src/pages/Restaurant.jsx)،
// و«admin» للاستخدام الإداري. الكاشير/المشرف/الجودة لا يعدّلون المنيو.
const MENU_ROLES = ['admin', 'owner', 'restaurant'];

// 🔒 تحديد النشاط المسموح: المدير يمكنه تمرير أي نشاط، وغيره مقيّد بنشاطه من التوكن فقط.
// لا يُقبل restaurant_id القادم من الطلب لغير المدير (كان يسمح بتعديل منيو نشاط آخر).
function scopedRid(req, requested) {
  if (req.user.role === 'admin') return Number(requested || req.user.restaurant_id) || null;
  return Number(req.user.restaurant_id) || null;
}

// 🔒 تحقّق ملكية الصف قبل التعديل أو الحذف.
function ownRow(req, table, id) {
  const row = q.get(`SELECT restaurant_id FROM ${table} WHERE id=?`, id);
  if (!row) return { status: 404, error: 'غير موجود' };
  if (req.user.role !== 'admin' && Number(row.restaurant_id) !== Number(req.user.restaurant_id)) {
    return { status: 403, error: 'لا تملك صلاحية على هذا النشاط' };
  }
  return { rid: row.restaurant_id };
}

// 🔒 التأكد أن القسم يخص نفس النشاط (يمنع ربط صنف بقسم نشاط آخر).
function categoryOwnedBy(rid, categoryId) {
  if (categoryId === undefined || categoryId === null || categoryId === '') return true;
  const c = q.get("SELECT restaurant_id FROM categories WHERE id=?", categoryId);
  return !!c && Number(c.restaurant_id) === Number(rid);
}

const upload = multer({ dest: path.join(__dirname, '../uploads/'), limits: { fileSize: 5 * 1024 * 1024 } });
router.post('/uploads', requireRole(...MENU_ROLES), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف' });
  const ext = path.extname(req.file.originalname) || '.png';
  const name = req.file.filename + ext;
  fs.renameSync(req.file.path, path.join(__dirname, '../uploads/', name));
  res.json({ url: `/uploads/${name}` });
});

// ---------- الأقسام ----------
router.get('/categories', (req, res) => {
  const rid = scopedRid(req, req.query.restaurant_id);
  if (!rid) return res.status(403).json({ error: 'لا تملك صلاحية على هذا النشاط' });
  res.json(q.all("SELECT * FROM categories WHERE restaurant_id=? ORDER BY sort_order, id", rid));
});
router.post('/categories', requireRole(...MENU_ROLES), (req, res) => {
  const b = req.body || {};
  const rid = scopedRid(req, b.restaurant_id);
  if (!rid) return res.status(403).json({ error: 'لا تملك صلاحية على هذا النشاط' });
  const r = q.run("INSERT INTO categories (restaurant_id, name, icon, sort_order) VALUES (?,?,?,?)", rid, b.name, b.icon || null, b.sort_order || 0);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
router.put('/categories/:id', requireRole(...MENU_ROLES), (req, res) => {
  const own = ownRow(req, 'categories', req.params.id);
  if (own.status) return res.status(own.status).json({ error: own.error });
  const b = req.body || {};
  const cols = [], vals = [];
  for (const k of ['name', 'icon', 'sort_order', 'is_active']) if (b[k] !== undefined) { cols.push(`${k}=?`); vals.push(b[k]); }
  if (!cols.length) return res.status(400).json({ error: 'لا بيانات' });
  vals.push(req.params.id);
  q.run(`UPDATE categories SET ${cols.join(',')} WHERE id=?`, ...vals);
  res.json({ ok: true });
});
router.delete('/categories/:id', requireRole(...MENU_ROLES), (req, res) => {
  const own = ownRow(req, 'categories', req.params.id);
  if (own.status) return res.status(own.status).json({ error: own.error });
  q.run("DELETE FROM categories WHERE id=?", req.params.id);
  res.json({ ok: true });
});

// ---------- الأصناف ----------
router.get('/items', (req, res) => {
  const rid = scopedRid(req, req.query.restaurant_id);
  if (!rid) return res.status(403).json({ error: 'لا تملك صلاحية على هذا النشاط' });
  const cat = req.query.category_id;
  res.json(q.all("SELECT * FROM items WHERE restaurant_id=? AND (? IS NULL OR category_id=?) ORDER BY sort_order, id", rid, cat || null, cat || null));
});
router.post('/items', requireRole(...MENU_ROLES), (req, res) => {
  const b = req.body || {};
  const rid = scopedRid(req, b.restaurant_id);
  if (!rid) return res.status(403).json({ error: 'لا تملك صلاحية على هذا النشاط' });
  if (!categoryOwnedBy(rid, b.category_id)) return res.status(400).json({ error: 'القسم لا يخص هذا النشاط' });
  const r = q.run(`INSERT INTO items (restaurant_id, category_id, name, description, price, image, is_available, is_popular, prep_time_min, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, rid, b.category_id || null, b.name, b.description || null, b.price || 0, b.image || null, b.is_available ?? 1, b.is_popular || 0, b.prep_time_min || 15, b.sort_order || 0);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
router.put('/items/:id', requireRole(...MENU_ROLES), (req, res) => {
  const own = ownRow(req, 'items', req.params.id);
  if (own.status) return res.status(own.status).json({ error: own.error });
  const b = req.body || {};
  if (b.category_id !== undefined && !categoryOwnedBy(own.rid, b.category_id)) return res.status(400).json({ error: 'القسم لا يخص هذا النشاط' });
  const allowed = ['category_id', 'name', 'description', 'price', 'image', 'is_available', 'is_popular', 'prep_time_min', 'sort_order'];
  const cols = [], vals = [];
  for (const k of allowed) if (b[k] !== undefined) { cols.push(`${k}=?`); vals.push(b[k]); }
  if (!cols.length) return res.status(400).json({ error: 'لا بيانات' });
  vals.push(req.params.id);
  q.run(`UPDATE items SET ${cols.join(',')} WHERE id=?`, ...vals);
  res.json({ ok: true });
});
router.delete('/items/:id', requireRole(...MENU_ROLES), (req, res) => {
  const own = ownRow(req, 'items', req.params.id);
  if (own.status) return res.status(own.status).json({ error: own.error });
  q.run("DELETE FROM items WHERE id=?", req.params.id);
  res.json({ ok: true });
});

export default router;
