import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { setStatus, cancelOrder, rateOrder } from '../services/orderService.js';
import { restaurantTransfer } from '../services/dispatch.js';
import { triggerRating } from '../services/flow.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const u = req.user;
  let rows;
  if (u.role === 'admin') {
    rows = q.all("SELECT * FROM orders WHERE order_no != 'DRAFT' ORDER BY id DESC LIMIT 200");
  } else if (u.restaurant_id) {
    // كل أدوار المطعم: المطعم الرئيسي يرى الكل، وموظف الفرع يرى فرعه فقط
    rows = u.branch_id
      ? q.all("SELECT * FROM orders WHERE restaurant_id=? AND branch_id=? AND order_no != 'DRAFT' ORDER BY id DESC LIMIT 200", u.restaurant_id, u.branch_id)
      : q.all("SELECT * FROM orders WHERE restaurant_id=? AND order_no != 'DRAFT' ORDER BY id DESC LIMIT 200", u.restaurant_id);
  } else {
    rows = q.all("SELECT * FROM orders WHERE captain_id=? ORDER BY id DESC LIMIT 200", u.captain_id);
  }
  // أسماء مساعدة
  const enriched = rows.map(o => ({ ...o, restaurant_name: q.get("SELECT name_ar FROM restaurants WHERE id=?", o.restaurant_id)?.name_ar || null }));
  res.json(enriched);
});

// 🖨 إيصال الطلب الحراري (بدون ختم) — صورة PNG بمقاس طابعة الكاشير
router.get('/:id/receipt.png', async (req, res) => {
  const o = q.get("SELECT * FROM orders WHERE id=?", req.params.id);
  if (!o) return res.status(404).json({ error: 'طلب غير موجود' });
  const u = req.user;
  if (u.role !== 'admin' && Number(u.restaurant_id) !== Number(o.restaurant_id)) return res.status(403).json({ error: 'غير مصرح' });
  try {
    const { renderOrderReceiptPng } = await import('../services/receipt.js');
    const r = await renderOrderReceiptPng(o, { widthMm: Number(req.query.mm) || undefined });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Receipt-Width', String(r.width));
    res.sendFile(r.pngFile);
  } catch (e) { console.error('RECEIPT_FAIL', e.message); res.status(500).json({ error: 'تعذّر إنشاء الإيصال' }); }
});
// 📤 توليد الإيصال وإرساله للعميل (صورة غير مختومة)
router.post('/:id/receipt/send', async (req, res) => {
  const o = q.get("SELECT * FROM orders WHERE id=?", req.params.id);
  if (!o) return res.status(404).json({ error: 'طلب غير موجود' });
  const u = req.user;
  if (u.role !== 'admin' && Number(u.restaurant_id) !== Number(o.restaurant_id)) return res.status(403).json({ error: 'غير مصرح' });
  const { sendReceiptToCustomer } = await import('../services/receipt.js');
  const r = await sendReceiptToCustomer(o.id);
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true, url: r.url, width: r.width });
});
// 🧾 معلومات الإيصال (المقاس الحالي)
router.get('/:id/receipt/info', async (req, res) => {
  const { receiptWidthMm } = await import('../services/receipt.js');
  res.json({ mm: receiptWidthMm() });
});

router.get('/:id', (req, res) => {
  const o = q.get("SELECT * FROM orders WHERE id=? AND order_no != 'DRAFT'", req.params.id);
  if (!o) return res.status(404).json({ error: 'طلب غير موجود' });
  const events = q.all("SELECT * FROM order_events WHERE order_id=? ORDER BY id", o.id);
  const conversations = q.all("SELECT * FROM conversations WHERE order_id=? ORDER BY id", o.id);
  const offers = q.all(`SELECT co.*, c.name AS captain_name, c.phone AS captain_phone FROM captain_offers co LEFT JOIN captains c ON c.id=co.captain_id WHERE co.order_id=? ORDER BY co.id`, o.id);
  const items = JSON.parse(o.items_json || '[]');
  let customer = q.get("SELECT id, name, phone FROM customers WHERE id=?", o.customer_id);
  // 🔒 خصوصية العميل: الكابتن ما يشوف جوال العميل (منعًا لأي إزعاج/تحرش) — والعميل هو اللي يقدر يتواصل مع الكابتن
  if (req.user?.role === 'captain' && customer) customer = { ...customer, phone: null };
  const captain = o.captain_id ? q.get("SELECT id, name, phone, vehicle_type FROM captains WHERE id=?", o.captain_id) : null;
  res.json({ ...o, items, events, conversations, offers, customer, captain, restaurant_name: q.get("SELECT name_ar FROM restaurants WHERE id=?", o.restaurant_id)?.name_ar });
});

// تغيير الحالة: المطعم (confirm/preparing/ready) — الكابتن (with_captain/on_the_way/arrived/delivered)
router.post('/:id/status', (req, res) => {
  const { status } = req.body || {};
  const o = q.get("SELECT * FROM orders WHERE id=?", req.params.id);
  if (!o) return res.status(404).json({ error: 'طلب غير موجود' });
  const r = setStatus(o.id, status, req.user.role, req.user.id);
  if (r.error) return res.status(400).json(r);
  if (status === 'delivered') {
    const fresh = q.get("SELECT * FROM orders WHERE id=?", o.id);
    triggerRating(fresh);
  }
  res.json({ ok: true });
});

// 🛵 إعادة البحث عن كابتن: نعرض الطلب مرة أخرى على الكباتن المتاحين (زر الكاشير/صاحب النشاط)
router.post('/:id/redispatch', async (req, res) => {
  const o = q.get("SELECT * FROM orders WHERE id=? AND order_no != 'DRAFT'", req.params.id);
  if (!o) return res.status(404).json({ error: 'طلب غير موجود' });
  const u = req.user || {};
  if (u.role !== 'admin' && u.restaurant_id && Number(u.restaurant_id) !== Number(o.restaurant_id))
    return res.status(403).json({ error: 'لا تملك صلاحية على هذا الطلب' });
  if (['delivered', 'cancelled'].includes(o.status)) return res.status(400).json({ error: 'الطلب منتهٍ — لا حاجة لكابتن' });
  if (o.captain_id) return res.status(400).json({ error: 'الطلب مُحوَّل لكابتن بالفعل' });
  try {
    const { broadcastToCaptains } = await import('../services/dispatch.js');
    broadcastToCaptains(o);
    const count = Number(q.get("SELECT COUNT(*) c FROM captain_offers WHERE order_id=? AND status='offered'", o.id)?.c) || 0;
    // نسمح للطلب المسبق بإعادة العرض لاحقاً إن لم يوجد كابتن
    if (!count) q.run("UPDATE orders SET preorder_dispatched_at=NULL WHERE id=?", o.id);
    res.json({
      ok: true, offered: count,
      note: count ? `عُرض الطلب على ${count} كابتن متاح 🛵` : 'ما فيه كابتن متاح حالياً — فعّل كابتن أو أعد المحاولة بعد قليل',
      available: Number(q.get("SELECT COUNT(*) c FROM captains WHERE status='available' AND is_active=1 AND COALESCE(blocked,0)=0")?.c) || 0
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// المطعم يحوّل الطلب على كابتن عبر اللوحة
router.post('/:id/assign', (req, res) => {
  const { captain_id } = req.body || {};
  const r = restaurantTransfer(req.params.id, captain_id);
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true, order: r.order });
});

router.post('/:id/cancel', (req, res) => {
  const r = cancelOrder(req.params.id, req.body?.reason || '');
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true });
});

// تقييم العميل (المطعم / السرعة / الكابتن)
router.post('/:id/rate', (req, res) => {
  const b = req.body || {};
  const r = rateOrder(req.params.id, { restaurant: b.restaurant, speed: b.speed, captain: b.captain, comment: b.comment });
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true });
});

export default router;
