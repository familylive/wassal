import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { q } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();
router.use(requireAuth);

const upload = multer({ dest: path.join(__dirname, '../uploads/'), limits: { fileSize: 5 * 1024 * 1024 } });
router.post('/uploads', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف' });
  const ext = path.extname(req.file.originalname) || '.png';
  const name = req.file.filename + ext;
  fs.renameSync(req.file.path, path.join(__dirname, '../uploads/', name));
  res.json({ url: `/uploads/${name}` });
});

// ---------- الأقسام ----------
router.get('/categories', (req, res) => {
  const rid = req.query.restaurant_id || req.user.restaurant_id;
  res.json(q.all("SELECT * FROM categories WHERE restaurant_id=? ORDER BY sort_order, id", rid));
});
router.post('/categories', (req, res) => {
  const b = req.body || {};
  const rid = b.restaurant_id || req.user.restaurant_id;
  const r = q.run("INSERT INTO categories (restaurant_id, name, icon, sort_order) VALUES (?,?,?,?)", rid, b.name, b.icon || null, b.sort_order || 0);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
router.put('/categories/:id', (req, res) => {
  const b = req.body || {};
  const cols = [], vals = [];
  for (const k of ['name', 'icon', 'sort_order', 'is_active']) if (b[k] !== undefined) { cols.push(`${k}=?`); vals.push(b[k]); }
  if (!cols.length) return res.status(400).json({ error: 'لا بيانات' });
  vals.push(req.params.id);
  q.run(`UPDATE categories SET ${cols.join(',')} WHERE id=?`, ...vals);
  res.json({ ok: true });
});
router.delete('/categories/:id', (req, res) => {
  q.run("DELETE FROM categories WHERE id=?", req.params.id);
  res.json({ ok: true });
});

// ---------- الأصناف ----------
router.get('/items', (req, res) => {
  const rid = req.query.restaurant_id || req.user.restaurant_id;
  const cat = req.query.category_id;
  res.json(q.all("SELECT * FROM items WHERE restaurant_id=? AND (? IS NULL OR category_id=?) ORDER BY sort_order, id", rid, cat || null, cat || null));
});
router.post('/items', (req, res) => {
  const b = req.body || {};
  const rid = b.restaurant_id || req.user.restaurant_id;
  const r = q.run(`INSERT INTO items (restaurant_id, category_id, name, description, price, image, is_available, is_popular, prep_time_min, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, rid, b.category_id || null, b.name, b.description || null, b.price || 0, b.image || null, b.is_available ?? 1, b.is_popular || 0, b.prep_time_min || 15, b.sort_order || 0);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
router.put('/items/:id', (req, res) => {
  const b = req.body || {};
  const allowed = ['category_id', 'name', 'description', 'price', 'image', 'is_available', 'is_popular', 'prep_time_min', 'sort_order'];
  const cols = [], vals = [];
  for (const k of allowed) if (b[k] !== undefined) { cols.push(`${k}=?`); vals.push(b[k]); }
  if (!cols.length) return res.status(400).json({ error: 'لا بيانات' });
  vals.push(req.params.id);
  q.run(`UPDATE items SET ${cols.join(',')} WHERE id=?`, ...vals);
  res.json({ ok: true });
});
router.delete('/items/:id', (req, res) => {
  q.run("DELETE FROM items WHERE id=?", req.params.id);
  res.json({ ok: true });
});

export default router;
