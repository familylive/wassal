import { q, tx } from '../db.js';
import { emitTo, emitAll } from './realtime.js';
import { waSend } from './whatsapp.js';
import { nextOrderNo, now, validatePhone } from '../utils.js';
import { broadcastToCaptains } from './dispatch.js';
import { awardPoints } from './loyalty.js';
import { scheduleBackup } from './backup.js';
import { ordersPhone } from './restUsers.js';

const money = (h) => (Number(h || 0) / 100).toFixed(2);
const PAY_AR = { applepay: '🍎 Apple Pay', mada: '💳 مدى', card: '💳 بطاقة', cash: '💵 كاش عند الاستلام' };

// 🧾 جوال مستلم الطلبات: الكاشير أولاً ثم صاحب النشاط (المالك)
export async function restaurantOrdersPhone(restaurant) {
  if (!restaurant) return null;
  const { ordersPhone } = await import('./restUsers.js');
  try { return ordersPhone(restaurant.id); } catch (e) {
    const direct = restaurant.phone || restaurant.whatsapp_number;
    return direct ? (validatePhone(direct) || String(direct)) : null;
  }
}

// 🔔 إشعار صاحب النشاط بطلب جديد على واتساب (مع أزرار استلمت / جاهز)
export function notifyRestaurantNewOrder(order) {
  try {
    const rest = q.get("SELECT * FROM restaurants WHERE id=?", order.restaurant_id);
    const to = ordersPhone(rest?.id);
    if (!to) { console.log('ORDER_NOTIFY_NO_RECIPIENT', order.restaurant_id); return; }
    let items = [];
    try { items = JSON.parse(order.items_json || '[]'); } catch (e) {}
    const lines = items.map(i => `• ${i.quantity} × ${i.name} — ${money(Number(i.price) * Number(i.quantity))}`).join('\n');
    const isPickup = order.order_type === 'pickup';
    const pre = order.is_preorder ? `\n🗓️ *طلب مسبق* — ${order.scheduled_for || ''} الساعة ${order.scheduled_time || ''}\n` : '';
    const body = `🛎 *${order.is_preorder ? 'طلب مسبق' : 'طلب جديد'}* ${order.order_no}\n🏪 ${rest?.name_ar || ''}${pre}\n━━━━━━━━━━━━━━\n🛒 *الطلب:*\n${lines}\n━━━━━━━━━━━━━━\n🍽 المجموع: ${money(order.subtotal)} ر.س`
      + (Number(order.discount) ? `\n🎁 الخصم: -${money(order.discount)} ر.س` : '')
      + (isPickup ? '\n🏪 *استلام من النشاط*' : `\n🚚 التوصيل: ${money(order.delivery_fee)} ر.س\n📍 ${order.national_address || order.address_label || ''}`)
      + `\n💰 *الإجمالي: ${money(order.total)} ر.س*\n💳 الدفع: ${PAY_AR[order.payment_method] || order.payment_method || '-'}\n🕐 خلال ~${order.est_delivery_min || 30} دقيقة\n\n_اضغط ✅ «استلمت» ليوصل العميل تأكيد، و📦 «جاهز» لمّا يجهز الطلب._`;
    waSend({ phone: to, restaurantId: order.restaurant_id, orderId: order.id, type: 'buttons', body,
      buttons: [{ id: `ordok:${order.id}`, title: '✅ استلمت الطلب' }, { id: `ordready:${order.id}`, title: '📦 الطلب جاهز' }] }).catch(() => {});
  } catch (e) { console.error('ORDER_NOTIFY_FAIL', e.message); }
}

export function addEvent(orderId, event, message, actorType = 'system', actorId = null) {
  q.run("INSERT INTO order_events (order_id, event, message, actor_type, actor_id) VALUES (?,?,?,?,?)",
    orderId, event, message, actorType, actorId);
}

export function createOrder({ restaurant, customer, cart, totals, paymentMethod, address, estDeliveryMin, notes = '', branch = null, orderType = 'delivery', bidding = false, scheduledFor = null, scheduledTime = null, isPreorder = false }) {
  const isPickup = orderType === 'pickup';
  const orderNo = nextOrderNo();
  const deliveryCode = String(Math.floor(100000 + Math.random() * 900000));
  const itemsJson = JSON.stringify(cart.items.map(i => ({ item_id: i.item_id, name: i.name, price: i.price, quantity: i.quantity, offer_id: i.offer_id || null })));
  const r = q.run(`INSERT INTO orders (order_no, restaurant_id, customer_id, items_json, subtotal, discount, delivery_fee, total,
    payment_method, payment_status, status, address_label, national_address, lat, lng, est_delivery_min, branch_id, branch_name, delivery_code, order_type, notes,
    is_preorder, scheduled_for, scheduled_time)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    orderNo, restaurant.id, customer.id, itemsJson, totals.subtotal, totals.discount, totals.delivery_fee, totals.total,
    paymentMethod, 'pending', 'new', address.label, address.national_address, address.lat, address.lng, estDeliveryMin,
    branch?.id || null, branch?.name || null, deliveryCode, isPickup ? 'pickup' : 'delivery', notes,
    isPreorder ? 1 : 0, scheduledFor || null, scheduledTime || null);
  const order = q.get("SELECT * FROM orders WHERE id = ?", r.lastInsertRowid);
  addEvent(order.id, 'new', isPickup ? 'طلب استلام من النشاط (بدون توصيل)' : 'تم إنشاء الطلب وانتظار تأكيد المطعم');
  addEvent(order.id, 'payment', `طريقة الدفع: ${paymentMethod}`);
  emitTo(`restaurant:${restaurant.id}`, 'order:new', { orderId: order.id, order });
  emitTo('admin', 'order:new', { orderId: order.id, order });
  if (isPreorder) {
    // 🏠 طلب مسبق: لا مزاد ولا بث الآن — يُعرض على الكباتن يوم التسليم (المجدول)
    console.log('PREORDER_CREATED', orderNo, scheduledFor, scheduledTime);
  } else if (bidding) {
    // 🚕 مزاد سعر التوصيل: نفتح نافذة التسعير (البث يتولاه startDeliveryBidding)
    q.run("UPDATE orders SET bid_until=datetime('now','+90 seconds') WHERE id=?", order.id);
    order.bid_until = q.get("SELECT bid_until FROM orders WHERE id=?", order.id)?.bid_until || null;
  } else if (!isPickup) {
    broadcastToCaptains(order);   // 🏪 طلب استلام = بلا خدمة كابتن
  }
  // 📦 خصم الكميات المتوفرة (الأسر المنتجة وغيرها) وإخفاء الصنف لو خلص
  try {
    for (const it of cart.items) {
      if (!it.item_id) continue;
      const row = q.get("SELECT id, name, stock_qty, restaurant_id FROM items WHERE id=?", it.item_id);
      if (!row || row.stock_qty === null || row.stock_qty === undefined) continue;
      const left = Math.max(0, Number(row.stock_qty) - Number(it.quantity || 0));
      q.run("UPDATE items SET stock_qty=?, is_available=? WHERE id=?", left, left > 0 ? 1 : 0, row.id);
      if (left === 0) {
        const to = ordersPhone(row.restaurant_id);
        if (to) waSend({ phone: to, type: 'text', body: `⛔ *${row.name}* خلصت كميته من طلب ${order.order_no} — أخفيناه من القائمة تلقائياً ✅\n_(ترجعه بكتابة *رجّع رقم الصنف*)_` }).catch(() => {});
      }
    }
  } catch (e) { console.error('STOCK_DECREMENT_FAIL', e.message); }

  scheduleBackup(); // نسخة احتياطية فورية بعد كل طلب
  notifyRestaurantNewOrder(order);   // 🏪 إشعار صاحب النشاط على واتساب
  return order;
}

export function setStatus(orderId, status, actorType = 'system', actorId = null) {
  const order = q.get("SELECT * FROM orders WHERE id=?", orderId);
  if (!order) return { error: 'طلب غير موجود' };
  const valid = ['confirmed', 'preparing', 'ready', 'with_captain', 'on_the_way', 'arrived', 'delivered', 'cancelled'];
  if (!valid.includes(status)) return { error: 'حالة غير صالحة' };
  q.run("UPDATE orders SET status=?, updated_at=datetime('now') WHERE id=?", status, orderId);
  const isPickupOrder = order.order_type === 'pickup';
  const msgs = {
    confirmed: '✔️ أكد المطعم طلبك وجاري التحضير.',
    preparing: '👨‍🍳 جاري تحضير طلبك الآن.',
    ready: '📦 طلبك جاهز للتسليم.',
    with_captain: '🛵 استلم الكابتن طلبك من المطعم.',
    on_the_way: '🛵 كابتن التوصيل في الطريق إليك!',
    arrived: '📍 وصل كابتن التوصيل! طلبك عند الباب 🚪',
    delivered: isPickupOrder ? '🎉 تم استلام طلبك من الفرع. شكراً لطلبك معنا!' : '🎉 تم تسليم طلبك بنجاح. شكراً لطلبك معنا!',
    ready: isPickupOrder ? '📦 طلبك جاهز — تفضل باستلامه من الفرع 🙏' : '📦 طلبك جاهز للتسليم.'
  };
  addEvent(orderId, status, msgs[status] || status, actorType, actorId);
  const customer = q.get("SELECT phone FROM customers WHERE id=?", order.customer_id);
  if (customer) waSend({ phone: customer.phone, restaurantId: order.restaurant_id, orderId, type: 'text', body: msgs[status] });
  emitTo(`restaurant:${order.restaurant_id}`, 'order:update', { orderId, status, order: { ...order, status } });
  if (order.captain_id) emitTo(`captain:${order.captain_id}`, 'order:update', { orderId, status, order: { ...order, status } });
  if (status === 'arrived') q.run("UPDATE orders SET arrived_at=datetime('now') WHERE id=?", orderId);
  // تقييم العميل عند التسليم/الاستلام (كل المسارات)
  if (status === 'delivered') { try { import('./flow.js').then(({ triggerRating }) => triggerRating(q.get("SELECT * FROM orders WHERE id=?", orderId))); } catch (e) {} }
  // 💵 تحصيل الكاش من العميل على الكابتن (وإيقافه لو وصل سقف التأمين)
  // 🏛 عمولات المنصة: ١٥٪ من النشاط + ١٥٪ من الكابتن (قابلة للتعديل)
  if (status === 'delivered') {
    try { import('./captainAccount.js').then(({ applyCommissions }) => applyCommissions(order)).catch(() => {}); } catch (e) {}
  }
  if (status === 'delivered' && order.payment_method === 'cash' && order.captain_id) {
    try { import('./captainAccount.js').then(({ addCollectedCash }) => addCollectedCash(order.captain_id, order)).catch(() => {}); } catch (e) {}
  }
  if (status === 'delivered') {
    q.run("UPDATE orders SET delivered_at=datetime('now'), payment_status = CASE WHEN payment_method='cash' THEN 'paid' ELSE payment_status END WHERE id=?", orderId);
    if (order.captain_id) q.run("UPDATE captains SET status='available', deliveries_count=deliveries_count+1 WHERE id=?", order.captain_id);
    if (order.customer_id) awardPoints(order.customer_id, orderId, order.total);
    q.run("UPDATE restaurants SET orders_count=orders_count+1 WHERE id=?", order.restaurant_id);
    emitAll('order:delivered', { orderId });
  }
  return { ok: true };
}

// 🏠 بث الطلبات المسبقة المستحقة (يوم التسليم وقبل الموعد)
export async function dispatchDuePreorders() {
  try {
    const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
    const rows = q.all(`SELECT * FROM orders WHERE is_preorder=1 AND preorder_dispatched_at IS NULL
      AND status IN ('new') AND (scheduled_for IS NULL OR scheduled_for <= ?)`, today);
    for (const order of rows) {
      // نبدأ قبل الموعد بـ 90 دقيقة
      const [h, mi] = String(order.scheduled_time || '12:00').split(':').map(Number);
      const now = new Date(Date.now() + 3 * 3600 * 1000);
      const mins = (h * 60 + mi) - (now.getUTCHours() * 60 + now.getUTCMinutes());
      if (order.scheduled_for === today && mins > 90) continue;
      q.run("UPDATE orders SET preorder_dispatched_at=datetime('now') WHERE id=?", order.id);
      if (order.order_type !== 'pickup') {
        const { broadcastToCaptains } = await import('./dispatch.js');
        try { broadcastToCaptains(order); } catch (e) { console.error('PREORDER_BROADCAST_FAIL', e.message); }
      }
      const customer = q.get("SELECT phone FROM customers WHERE id=?", order.customer_id);
      if (customer) waSend({ phone: customer.phone, restaurantId: order.restaurant_id, orderId: order.id, type: 'text',
        body: `🔔 *طلبك المسبق ${order.order_no} صار في التنفيذ* — نعرضه الحين على كباتن التوصيل 🛵` }).catch(() => {});
      console.log('PREORDER_DISPATCHED', order.order_no);
    }
  } catch (e) { console.error('PREORDER_LOOP_FAIL', e.message); }
}

// إغلاق الطلب برمز الاستلام (المندوب يرسله لواتساب المطعم)
export async function closeOrderWithCode(code, senderPhone, actorType = 'captain') {
  const orders = q.all("SELECT * FROM orders WHERE delivery_code=? AND status IN ('transferred','with_captain','on_the_way','arrived') ORDER BY id DESC", String(code).trim());
  if (!orders.length) return { error: 'رمز غير صحيح أو الطلب غير نشط' };
  const captain = q.get("SELECT * FROM captains WHERE phone=? OR phone=?", senderPhone, validatePhone(senderPhone));
  let order = orders.find(o => captain && o.captain_id === captain.id);
  if (!order) return { error: 'الرمز لا يخص طلباً لديك' };
  // 📷 صورة التسليم شرط لإغلاق الطلب
  if (!order.delivery_photo && !order.delivery_photo_at) {
    return { error: 'لازم ترسل *صورة التسليم* أول 📷\nصوّر الطلب عند باب العميل وأرسلها هنا، وبعدها أرسل رمز الاستلام.' };
  }
  const r = setStatus(order.id, 'delivered', actorType, captain?.id);
  if (r.error) return r;
  addEvent(order.id, 'delivered', 'تم إغلاق الطلب برمز الاستلام 🔐');
  const customer = q.get("SELECT phone FROM customers WHERE id=?", order.customer_id);
  if (customer) waSend({ phone: customer.phone, restaurantId: order.restaurant_id, orderId: order.id, type: 'text', body: '🔐 تم التحقق من رمز الاستلام وإغلاق طلبك بنجاح! 🎉' });
  // تقييم الكابتن للعميل (بعد الإغلاق)
  try {
    const { askCaptainToRateCustomer } = await import('./ratings.js');
    const ord = q.get("SELECT * FROM orders WHERE id=?", order.id);
    if (captain) await askCaptainToRateCustomer(captain.phone, ord, captain.id);
  } catch (e) { console.error('ASK_CAPTAIN_RATE_FAIL', e.message); }
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
