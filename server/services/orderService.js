import { q, tx } from '../db.js';
import { emitTo, emitAll } from './realtime.js';
import { waSend } from './whatsapp.js';
import { nextOrderNo, now, validatePhone } from '../utils.js';
import { broadcastToCaptains } from './dispatch.js';
import { awardPoints } from './loyalty.js';

export function addEvent(orderId, event, message, actorType = 'system', actorId = null) {
  q.run("INSERT INTO order_events (order_id, event, message, actor_type, actor_id) VALUES (?,?,?,?,?)",
    orderId, event, message, actorType, actorId);
}

export function createOrder({ restaurant, customer, cart, totals, paymentMethod, address, estDeliveryMin, notes = '', branch = null }) {
  const orderNo = nextOrderNo();
  const deliveryCode = String(Math.floor(100000 + Math.random() * 900000));
  const itemsJson = JSON.stringify(cart.items.map(i => ({ item_id: i.item_id, name: i.name, price: i.price, quantity: i.quantity, offer_id: i.offer_id || null })));
  const r = q.run(`INSERT INTO orders (order_no, restaurant_id, customer_id, items_json, subtotal, discount, delivery_fee, total,
    payment_method, payment_status, status, address_label, national_address, lat, lng, est_delivery_min, branch_id, branch_name, delivery_code, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    orderNo, restaurant.id, customer.id, itemsJson, totals.subtotal, totals.discount, totals.delivery_fee, totals.total,
    paymentMethod, 'pending', 'new', address.label, address.national_address, address.lat, address.lng, estDeliveryMin,
    branch?.id || null, branch?.name || null, deliveryCode, notes);
  const order = q.get("SELECT * FROM orders WHERE id = ?", r.lastInsertRowid);
  addEvent(order.id, 'new', 'تم إنشاء الطلب وانتظار تأكيد المطعم');
  addEvent(order.id, 'payment', `طريقة الدفع: ${paymentMethod}`);
  emitTo(`restaurant:${restaurant.id}`, 'order:new', { orderId: order.id, order });
  emitTo('admin', 'order:new', { orderId: order.id, order });
  broadcastToCaptains(order);
  return order;
}

export function setStatus(orderId, status, actorType = 'system', actorId = null) {
  const order = q.get("SELECT * FROM orders WHERE id=?", orderId);
  if (!order) return { error: 'طلب غير موجود' };
  const valid = ['confirmed', 'preparing', 'ready', 'with_captain', 'on_the_way', 'arrived', 'delivered', 'cancelled'];
  if (!valid.includes(status)) return { error: 'حالة غير صالحة' };
  q.run("UPDATE orders SET status=?, updated_at=datetime('now') WHERE id=?", status, orderId);
  const msgs = {
    confirmed: '✔️ أكد المطعم طلبك وجاري التحضير.',
    preparing: '👨‍🍳 جاري تحضير طلبك الآن.',
    ready: '📦 طلبك جاهز للتسليم.',
    with_captain: '🛵 استلم الكابتن طلبك من المطعم.',
    on_the_way: '🛵 كابتن التوصيل في الطريق إليك!',
    arrived: '📍 وصل كابتن التوصيل! طلبك عند الباب 🚪',
    delivered: '🎉 تم تسليم طلبك بنجاح. شكراً لطلبك معنا!'
  };
  addEvent(orderId, status, msgs[status] || status, actorType, actorId);
  const customer = q.get("SELECT phone FROM customers WHERE id=?", order.customer_id);
  if (customer) waSend({ phone: customer.phone, restaurantId: order.restaurant_id, orderId, type: 'text', body: msgs[status] });
  emitTo(`restaurant:${order.restaurant_id}`, 'order:update', { orderId, status, order: { ...order, status } });
  if (order.captain_id) emitTo(`captain:${order.captain_id}`, 'order:update', { orderId, status, order: { ...order, status } });
  if (status === 'arrived') q.run("UPDATE orders SET arrived_at=datetime('now') WHERE id=?", orderId);
  if (status === 'delivered') {
    q.run("UPDATE orders SET delivered_at=datetime('now'), payment_status = CASE WHEN payment_method='cash' THEN 'paid' ELSE payment_status END WHERE id=?", orderId);
    if (order.captain_id) q.run("UPDATE captains SET status='available', deliveries_count=deliveries_count+1 WHERE id=?", order.captain_id);
    if (order.customer_id) awardPoints(order.customer_id, orderId, order.total);
    q.run("UPDATE restaurants SET orders_count=orders_count+1 WHERE id=?", order.restaurant_id);
    emitAll('order:delivered', { orderId });
  }
  return { ok: true };
}

// إغلاق الطلب برمز الاستلام (المندوب يرسله لواتساب المطعم)
export async function closeOrderWithCode(code, senderPhone, actorType = 'captain') {
  const orders = q.all("SELECT * FROM orders WHERE delivery_code=? AND status IN ('transferred','with_captain','on_the_way','arrived') ORDER BY id DESC", String(code).trim());
  if (!orders.length) return { error: 'رمز غير صحيح أو الطلب غير نشط' };
  const captain = q.get("SELECT * FROM captains WHERE phone=? OR phone=?", senderPhone, validatePhone(senderPhone));
  let order = orders.find(o => captain && o.captain_id === captain.id);
  if (!order) return { error: 'الرمز لا يخص طلباً لديك' };
  const r = setStatus(order.id, 'delivered', actorType, captain?.id);
  if (r.error) return r;
  addEvent(order.id, 'delivered', 'تم إغلاق الطلب برمز الاستلام 🔐');
  const customer = q.get("SELECT phone FROM customers WHERE id=?", order.customer_id);
  if (customer) waSend({ phone: customer.phone, restaurantId: order.restaurant_id, orderId: order.id, type: 'text', body: '🔐 تم التحقق من رمز الاستلام وإغلاق طلبك بنجاح! 🎉' });
  try { const { triggerRating } = await import('./flow.js'); triggerRating(q.get("SELECT * FROM orders WHERE id=?", order.id)); } catch (e) {}
  emitAll('order:delivered', { orderId: order.id });
  return { ok: true, order: q.get("SELECT * FROM orders WHERE id=?", order.id) };
}

export function cancelOrder(orderId, reason = '', opts = {}) {
  const order = q.get("SELECT * FROM orders WHERE id=?", orderId);
  if (!order) return { error: 'طلب غير موجود' };
  const note = opts.note || null;
  q.run("UPDATE orders SET status='cancelled', cancel_reason=?, cancel_note=?, cancel_requested_at=COALESCE(cancel_requested_at, datetime('now')), updated_at=datetime('now') WHERE id=?",
    reason || null, note, orderId);
  addEvent(orderId, 'cancelled', `أُلغي الطلب${reason ? ' — السبب: ' + reason + (note ? ' (' + note + ')' : '') : ''}`, opts.actorType || 'customer', opts.actorId || null);
  if (order.captain_id) { q.run("UPDATE captains SET status='available' WHERE id=?", order.captain_id); emitTo(`captain:${order.captain_id}`, 'order:update', { orderId, status: 'cancelled' }); }
  emitTo(`restaurant:${order.restaurant_id}`, 'order:cancelled', { orderId, order_no: order.order_no, reason: reason || null, note });
  emitTo(`restaurant:${order.restaurant_id}`, 'order:update', { orderId, status: 'cancelled' });
  emitTo('admin', 'order:cancelled', { orderId, order_no: order.order_no, reason: reason || null });
  const customer = q.get("SELECT phone FROM customers WHERE id=?", order.customer_id);
  if (customer) waSend({ phone: customer.phone, restaurantId: order.restaurant_id, orderId, type: 'text', body: `تم إلغاء الطلب ${order.order_no}${reason ? ' — ' + reason : ''}` });
  return { ok: true };
}

export function rateOrder(orderId, { restaurant, speed, captain, comment }) {
  return tx(() => {
    const order = q.get("SELECT * FROM orders WHERE id=?", orderId);
    if (!order) return { error: 'طلب غير موجود' };
    const cols = [], vals = [];
    if (restaurant != null) { cols.push('rating_restaurant=?'); vals.push(restaurant); }
    if (speed != null) { cols.push('rating_speed=?'); vals.push(speed); }
    if (captain != null) { cols.push('rating_captain=?'); vals.push(captain); }
    if (comment != null) { cols.push('rating_comment=?'); vals.push(comment); }
    if (!cols.length) return { error: 'لا توجد تقييمات' };
    cols.push('rated_at=?'); vals.push(now());
    vals.push(orderId);
    q.run(`UPDATE orders SET ${cols.join(',')} WHERE id=?`, ...vals);
    if (restaurant != null && order.restaurant_id) {
      const r = q.get("SELECT * FROM restaurants WHERE id=?", order.restaurant_id);
      const rc = (r.rating_count || 0) + 1;
      const avg = ((r.rating_avg || 0) * (r.rating_count || 0) + restaurant) / rc;
      q.run("UPDATE restaurants SET rating_avg=?, rating_count=? WHERE id=?", Math.round(avg * 10) / 10, rc, order.restaurant_id);
    }
    if (captain != null && order.captain_id) {
      const c = q.get("SELECT * FROM captains WHERE id=?", order.captain_id);
      const cc = (c.rating_count || 0) + 1;
      const avg = ((c.rating_avg || 0) * (c.rating_count || 0) + captain) / cc;
      q.run("UPDATE captains SET rating_avg=?, rating_count=? WHERE id=?", Math.round(avg * 10) / 10, cc, order.captain_id);
      const customer = q.get("SELECT name FROM customers WHERE id=?", order.customer_id);
      waSend({ phone: c.phone, restaurantId: order.restaurant_id, orderId, participant: 'captain', type: 'text',
        body: `⭐ تقييم العميل ${customer?.name || 'العميل'} لك على الطلب ${order.order_no}:\n🚚 الكابتن: ${'⭐'.repeat(captain)} (${captain}/5)\n🏠 السرعة: ${'⭐'.repeat(speed || 0)}${speed ? ` (${speed}/5)` : ''}\n${comment ? `💬 تعليق: ${comment}` : ''}` });
    }
    return { ok: true, order: q.get("SELECT * FROM orders WHERE id=?", orderId) };
  });
}
