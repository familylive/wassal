import { q, tx } from '../db.js';
import { emitTo } from './realtime.js';
import { waSend } from './whatsapp.js';
import { addEvent } from './orderService.js';
import { customerScoreLine } from './ratings.js';
import { resolveDelivery } from './branches.js';

// إرسال الطلب لكل الكباتن المتاحين (بدون طلبات نشطة)
export function broadcastToCaptains(order) {
  if (['cancelled', 'delivered'].includes(order.status)) return;
  const captains = q.all("SELECT * FROM captains WHERE status='available' AND is_active=1");
  const restaurant = q.get("SELECT name_ar FROM restaurants WHERE id=?", order.restaurant_id);
  for (const c of captains) {
    const r = q.run("INSERT INTO captain_offers (order_id, captain_id, status) VALUES (?,?,?)", order.id, c.id, 'offered');
    emitTo(`captain:${c.id}`, 'order:offer', {
      offerId: Number(r.lastInsertRowid), orderId: order.id, orderNo: order.order_no,
      restaurant: restaurant.name_ar, total: order.total, est: order.est_delivery_min, address: order.national_address
    });
    waSend({ phone: c.phone, restaurantId: order.restaurant_id, orderId: order.id, participant: 'captain', type: 'text',
      body: `🛵 طلب جديد متاح للتوصيل!\n📦 ${order.order_no} — ${restaurant.name_ar}\n💰 ${(order.total / 100).toFixed(2)} ر.س\n📍 ${order.national_address || ''}\n\n${customerScoreLine(order.customer_id)}\n\n✅ رد على هذا الرقم بكلمة: *اقبل*  (أو *رفض*)` });
  }
  if (captains.length) {
    q.run("UPDATE orders SET status='offered', updated_at=datetime('now') WHERE id=?", order.id);
    addEvent(order.id, 'offered', `عُرض الطلب على ${captains.length} كابتن متاح`);
  }
}

// ---------- 🚕 مزاد سعر التوصيل ----------
// يُعرض الطلب على الكباتن المتاحين مع المسافة، وكل كابتن يرسل سعره
export function broadcastBidding(order, minutes = 2) {
  const restaurant = q.get("SELECT name_ar, city FROM restaurants WHERE id=?", order.restaurant_id);
  const captains = q.all("SELECT * FROM captains WHERE status='available' AND is_active=1");
  const dist = (order.lat && order.lng) ? kmTo(order, order.restaurant_id) : null;
  let n = 0;
  for (const c of captains) {
    q.run("INSERT INTO captain_offers (order_id, captain_id, status) VALUES (?,?,?)", order.id, c.id, 'offered');
    emitTo(`captain:${c.id}`, 'order:offer', { orderId: order.id, orderNo: order.order_no, restaurant: restaurant?.name_ar, total: order.total, km: dist });
    waSend({ phone: c.phone, restaurantId: order.restaurant_id, orderId: order.id, participant: 'captain', type: 'text',
      body: `🚕 *طلب توصيل — حدّد سعرك*\n\n📦 ${order.order_no} — ${restaurant?.name_ar || ''}\n📏 مسافة التوصيل: *${dist != null ? dist + ' كم' : 'غير محددة'}*\n💰 قيمة الطلب: ${(order.total / 100).toFixed(2)} ر.س\n📍 ${order.national_address || ''}\n\n✍️ أرسل *سعر توصيلك* بالريال (مثال: 20)\n⏳ العرض متاح لدقائق محدودة — أول الأسعار تُعرض على العميل` });
    n += 1;
  }
  if (n) addEvent(order.id, 'bidding', `طُلب من ${n} كابتن تحديد سعر التوصيل`);
  return n;
}

// المسافة من الفرع إلى موقع العميل
function kmTo(order, restaurantId) {
  return Math.round(resolveDelivery(restaurantId, order.lat, order.lng).distanceKm * 10) / 10;
}

// حفظ سعر الكابتن
export function bidOnOrder(captainId, amount) {
  const offer = q.get(`SELECT o.* FROM captain_offers o JOIN orders r ON r.id=o.order_id
    WHERE o.captain_id=? AND o.status='offered' AND r.status IN ('new','confirmed','preparing','ready') AND r.bid_until IS NOT NULL AND r.bid_until > datetime('now')
    ORDER BY o.id DESC LIMIT 1`, captainId);
  if (!offer) return { error: 'ما فيه طلب مفتوح للتسعير حالياً 📭' };
  if (offer.bid_amount) return { error: 'سبق أرسلت سعرك لهذا الطلب ✅' };
  q.run("UPDATE captain_offers SET bid_amount=?, bid_at=datetime('now') WHERE id=?", amount, offer.id);
  const order = q.get("SELECT * FROM orders WHERE id=?", offer.order_id);
  addEvent(order.id, 'bid', `الكابتن #${captainId} عرض ${(amount / 100).toFixed(2)} ر.س للتوصيل`);
  return { ok: true, offer, order };
}

// قبول الكابتن للطلب (يُشعر المطعم عبر اللوحة)
export function captainAccept(orderId, captainId) {
  const offer = q.get("SELECT * FROM captain_offers WHERE order_id=? AND captain_id=?", orderId, captainId);
  if (!offer) return { error: 'العرض غير موجود' };
  const order = q.get("SELECT * FROM orders WHERE id=?", orderId);
  if (['transferred', 'delivered', 'cancelled'].includes(order.status)) return { error: 'تم تحويل الطلب لكابتن آخر' };
  q.run("UPDATE captain_offers SET status='accepted', responded_at=datetime('now') WHERE id=?", offer.id);
  q.run("UPDATE orders SET status='accepted', updated_at=datetime('now') WHERE id=?", orderId);
  const captain = q.get("SELECT id,name,phone,rating_avg FROM captains WHERE id=?", captainId);
  addEvent(orderId, 'accepted', `الكابتن ${captain.name} قبل التوصيل — بانتظار تحويل المطعم عبر اللوحة`);
  emitTo(`restaurant:${order.restaurant_id}`, 'captain:accept', { orderId, captainId: captain.id, captainName: captain.name, offerId: offer.id, orderNo: order.order_no });
  return { ok: true, offer, order, captain };
}

// تحويل المطعم للطلب على الكابتن عبر لوحة التحكم
export function restaurantTransfer(orderId, captainId) {
  return tx(() => {
    const order = q.get("SELECT * FROM orders WHERE id=?", orderId);
    if (!order) return { error: 'طلب غير موجود' };
    q.run("UPDATE captain_offers SET status='expired', responded_at=datetime('now') WHERE order_id=? AND captain_id != ? AND status IN ('offered','accepted')", orderId, captainId);
    q.run("UPDATE captain_offers SET status='transferred', transferred_at=datetime('now') WHERE order_id=? AND captain_id=?", orderId, captainId);
    q.run("UPDATE orders SET captain_id=?, status='transferred', updated_at=datetime('now') WHERE id=?", captainId, orderId);
    q.run("UPDATE captains SET status='busy' WHERE id=?", captainId);
    const captain = q.get("SELECT * FROM captains WHERE id=?", captainId);
    addEvent(orderId, 'transferred', `تم تحويل الطلب إلى الكابتن ${captain.name} عبر لوحة المطعم`);
    const updated = q.get("SELECT * FROM orders WHERE id=?", orderId);
    emitTo(`captain:${captainId}`, 'order:assigned', { orderId, order: updated });
    emitTo(`restaurant:${order.restaurant_id}`, 'order:update', { orderId, status: 'transferred', order: updated });
    emitTo('admin', 'order:update', { orderId, status: 'transferred' });
    const customer = q.get("SELECT phone FROM customers WHERE id=?", order.customer_id);
    if (customer) waSend({ phone: customer.phone, restaurantId: order.restaurant_id, orderId, type: 'text', body: `🛵 تم تعيين الكابتن ${captain.name} لتوصيل طلبك ${order.order_no}` });
    return { ok: true, order: updated };
  });
}
