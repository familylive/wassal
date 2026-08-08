import { q } from '../db.js';
import { waSend, waLogIn } from './whatsapp.js';
import { createOrder } from './orderService.js';
import { createPayment, markPaid } from './payments.js';
import { validatePhone, computeTier, TIERS } from '../utils.js';
import { resolveDelivery, ensureDefaultBranch } from './branches.js';
import config from '../config.js';

// ---------- session ----------
export function getSession(phone) {
  let s = q.get("SELECT * FROM whatsapp_sessions WHERE phone=?", phone);
  if (!s) {
    q.run("INSERT INTO whatsapp_sessions (phone, restaurant_id, state, data_json) VALUES (?,?,?,?)", phone, 0, 'directory', '{}');
    s = q.get("SELECT * FROM whatsapp_sessions WHERE phone=?", phone);
  }
  return { state: s.state, data: JSON.parse(s.data_json || '{}') };
}
export function saveSession(phone, state, data) {
  q.run("UPDATE whatsapp_sessions SET state=?, data_json=?, updated_at=datetime('now') WHERE phone=?",
    state, JSON.stringify(data || {}), phone);
}

export function ensureCustomer(phone) {
  const ph = validatePhone(phone);
  let c = q.get("SELECT * FROM customers WHERE phone=?", ph);
  if (!c) { q.run("INSERT INTO customers (phone) VALUES (?)", ph); c = q.get("SELECT * FROM customers WHERE phone=?", ph); }
  return c;
}

// ---------- send helpers ----------
const send = (phone, rid, orderId, type, body, extra = {}) => waSend({ phone, restaurantId: rid, orderId, type, body, ...extra });
const rls = (h) => (h / 100).toFixed(2);

// ---------- menu / cart ----------
function menuData(rid) {
  return q.all("SELECT * FROM categories WHERE restaurant_id=? AND is_active=1 ORDER BY sort_order, id", rid)
    .map(c => ({ ...c, items: q.all("SELECT * FROM items WHERE restaurant_id=? AND category_id=? AND is_available=1 ORDER BY is_popular DESC, sort_order, id", rid, c.id) }));
}
function activeOffers(rid) {
  return q.all("SELECT * FROM offers WHERE restaurant_id=? AND is_active=1 AND (ends_at IS NULL OR ends_at >= datetime('now')) ORDER BY id DESC", rid);
}
function cartTotals(rid, cart, branch = null) {
  const r = q.get("SELECT delivery_fee, min_order FROM restaurants WHERE id=?", rid);
  const fee = branch ? branch.delivery_fee : r.delivery_fee;
  const minOrder = branch ? branch.min_order : r.min_order;
  let subtotal = 0; for (const i of cart.items) subtotal += i.price * i.quantity;
  let discount = 0;
  if (cart.offer && subtotal >= (cart.offer.min_order || 0)) {
    discount += cart.offer.type === 'percent' ? Math.round(subtotal * cart.offer.value / 100) : Math.min(cart.offer.value, subtotal);
  }
  if (cart.coupon) {
    const cp = q.get("SELECT * FROM coupons WHERE code=? AND is_active=1 AND (expires_at IS NULL OR expires_at >= datetime('now'))", cart.coupon);
    if (cp && subtotal >= cp.min_order) discount += cp.type === 'percent' ? Math.round(subtotal * cp.value / 100) : Math.min(cp.value, subtotal);
  }
  const delivery_fee = subtotal >= (minOrder || 0) ? 0 : fee;
  return { subtotal, discount, delivery_fee, total: subtotal - discount + delivery_fee };
}
function cartText(rid, cart, branch = null) {
  const t = cartTotals(rid, cart, branch);
  let s = '🛒 *سلة الطلب:*\n';
  for (const i of cart.items) s += `• ${i.name} ×${i.quantity} — ${rls(i.price * i.quantity)} ر.س\n`;
  if (cart.offer) s += `🔥 عرض: ${cart.offer.title}\n`;
  if (cart.coupon) s += `🏷 كود خصم: ${cart.coupon}\n`;
  s += `\nالمجموع: ${rls(t.subtotal)} ر.س\n`;
  if (t.discount) s += `الخصم: -${rls(t.discount)} ر.س\n`;
  s += `التوصيل: ${t.delivery_fee ? rls(t.delivery_fee) + ' ر.س' : 'مجاني ✅'}\n━━━━━━━━━━━━\n*الإجمالي: ${rls(t.total)} ر.س*`;
  return s;
}
// دليل المطاعم: كل المطاعم في النظام — العميل يختار ويفتح محادثة واتسابه
function showRestaurants(phone) {
  const rests = q.all("SELECT r.*, (SELECT COUNT(*) FROM branches b WHERE b.restaurant_id=r.id AND b.is_active=1) AS branches_count FROM restaurants r WHERE r.is_active=1 ORDER BY r.rating_avg DESC, r.id");
  saveSession(phone, 'directory', {});
  if (!rests.length) return send(phone, null, null, 'text', 'لا توجد مطاعم متاحة حالياً 🍽️');
  const rows = rests.slice(0, 10).map(r => ({
    id: 'rest:' + r.id,
    title: r.name_ar,
    description: (r.city || '') + (r.rating_avg ? ' · ⭐ ' + r.rating_avg : '') + (r.branches_count ? ' · ' + r.branches_count + ' فرع' : '')
  }));
  return send(phone, null, null, 'list', '🏪 *اختر المطعم الذي تريد الطلب منه:*\nاضغط على المطعم وسيفتح لك محادثة واتسابه 👇', {
    list: [{ title: '🍽 المطاعم المتاحة', rows }]
  });
}
function handleDirectory(phone, p) {
  if (p.startsWith('rest:')) {
    const rid = Number(p.split(':')[1]);
    const rest = q.get("SELECT id FROM restaurants WHERE id=? AND is_active=1", rid);
    if (!rest) return showRestaurants(phone);
    const session = getSession(phone);
    saveSession(phone, 'idle', { ...session.data, currentRestaurantId: rid });
    send(phone, rid, null, 'text', `✅ تم اختيار *${q.get('SELECT name_ar FROM restaurants WHERE id=?', rid).name_ar}* 🍽️`);
    return mainMenu(phone, rid);
  }
  return showRestaurants(phone);
}

function mainMenu(phone, rid) {
  const ad = q.get("SELECT a.*, r.name_ar AS rname FROM ads_campaigns a LEFT JOIN restaurants r ON r.id=a.restaurant_id WHERE a.is_active=1 AND a.placement='whatsapp' AND (a.ends_at IS NULL OR a.ends_at>=datetime('now')) ORDER BY a.id DESC LIMIT 1");
  const rest = q.get("SELECT name_ar, logo, cover FROM restaurants WHERE id=?", rid);
  let txt = `أهلاً بك في *${rest.name_ar}* 🍽️\nنوصل طلبك حتى باب بيتك بسرعة!`;
  if (ad) txt += `\n\n📣 *إعلان:* ${ad.title}${ad.rname ? ' — ' + ad.rname : ''}`;
  send(phone, rid, null, 'list', txt, { list: [{ title: 'القائمة الرئيسية', rows: [
    { id: 'menu', title: '🍽 قائمة الطعام', description: 'تصفح الأقسام والأصناف' },
    { id: 'offers', title: '🔥 العروض', description: 'أقوى عروض المطعم' },
    { id: 'cart', title: '🛒 سلة الطلب', description: 'عرض طلبك الحالي' },
    { id: 'track', title: '📦 حالة الطلب', description: 'تتبع طلبك الحالي' },
    { id: 'loyalty', title: '⭐ نقاطي ومستواي', description: 'رصيد نقاط الولاء' },
    { id: 'addresses', title: '📍 عناويني', description: 'عناوين التوصيل المحفوظة' },
    { id: 'cancel', title: '❌ إلغاء الطلب', description: 'إلغاء طلب نشط مع ذكر السبب' },
    { id: 'restaurants', title: '🏪 جميع المطاعم', description: 'الرجوع لقائمة المطاعم' }
  ] }] });
}

// ---------- main dispatcher ----------
export async function handleIncoming({ phone, restaurantId, body = '', type = 'text', payload = null, lat = null, lng = null }) {
  const customer = ensureCustomer(phone);
  const session = getSession(phone);
  const { state, data } = session;
  // المطعم الفعال: المطعم الذي اختاره العميل من الدليل (أو الذي أرسل له كبديل)
  const rid = data.currentRestaurantId || restaurantId || 1;
  const b = String(body || '').trim();
  const p = payload ? String(payload) : '';

  waLogIn({ orderId: data.orderId || null, phone, type, body: b || p, payload: { state } });

  // أول زيارة: نطلب اسم العميل ثم نعرض له كل المطاعم
  if (!customer.name && state !== 'ask_name') {
    saveSession(phone, 'ask_name', { ...data, pendingState: 'directory' });
    return send(phone, rid, null, 'text', `أهلاً بك في واتس هم! 🍽️\nما هو *اسمك الكريم*؟ (اكتب اسمك وسيتم حفظه) 📝`);
  }
  if (state === 'ask_name') {
    if (b.length < 2) return send(phone, rid, null, 'text', 'الرجاء كتابة اسمك حتى نكمل طلبك 😊');
    q.run("UPDATE customers SET name=? WHERE id=?", b.slice(0, 40), customer.id);
    send(phone, rid, null, 'text', `تسجيلاً مرحباً *${b.slice(0, 40)}* 🎉 تم حفظ اسمك بنجاح.`);
    return showRestaurants(phone);
  }

  // الأوامر العامة في أي وقت
  const bLower = b.toLowerCase();
  if (['إلغاء', 'الغاء', 'ألغي', 'الغاء الطلب', 'إلغاء الطلب', 'cancel'].includes(bLower) || p === 'cancel') {
    return handleCancelRequest(phone, rid, customer, data);
  }
  if (['المطاعم', 'restaurants', 'الدليل'].includes(bLower) || p === 'restaurants') {
    return showRestaurants(phone);
  }
  if (['القائمة', 'قائمة الطعام', 'المنيو', 'menu', 'ابدأ', 'start', 'رجوع', 'الرئيسية'].includes(bLower) && state !== 'idle' && state !== 'directory') {
    saveSession(phone, 'idle', {});
    return mainMenu(phone, rid);
  }

  if (state === 'directory') return handleDirectory(phone, p);

  switch (state) {
    case 'idle': return handleIdle(phone, rid, customer, p, b);
    case 'browse_categories': return handleCat(phone, rid, customer, p);
    case 'browse_items': return handleItems(phone, rid, customer, p);
    case 'item_detail': return handleItemDetail(phone, rid, customer, data, p, b);
    case 'item_qty': return handleItemQty(phone, rid, customer, data, b);
    case 'browse_offers': return handleOffers(phone, rid, customer, data, p);
    case 'cart': return handleCart(phone, rid, customer, data, p, b);
    case 'order_review': return handleOrderReview(phone, rid, customer, data, p, b);
    case 'coupon': return handleCoupon(phone, rid, customer, data, b);
    case 'payment_method': return handlePayMethod(phone, rid, customer, data, p);
    case 'awaiting_payment': return handleAwaitPay(phone, rid, customer, data, p);
    case 'location_request': return handleLocation(phone, rid, customer, data, type, lat, lng, p);
    case 'new_location_request': return handleNewLocation(phone, rid, customer, data, type, lat, lng, p);
    case 'address_confirm': return handleAddressConfirm(phone, rid, customer, data, p);
    case 'delivery_time': return handleDeliveryTime(phone, rid, customer, data, p);
    case 'tracking': return handleTracking(phone, rid, customer, data, p);
    case 'cancel_reason': return handleCancelReason(phone, rid, customer, data, p, b);
    case 'cancel_reason_text': return handleCancelReasonText(phone, rid, customer, data, b);
    case 'rate_restaurant': return handleRate(phone, rid, customer, data, p, b, 'restaurant');
    case 'rate_speed': return handleRate(phone, rid, customer, data, p, b, 'speed');
    case 'rate_captain': return handleRate(phone, rid, customer, data, p, b, 'captain');
    case 'rate_comment': return handleRateComment(phone, rid, customer, data, b);
    default:
      saveSession(phone, 'idle', {});
      return mainMenu(phone, rid);
  }
}

function handleIdle(phone, rid, customer, p, b) {
  const c = { menu: 'menu', 'قائمة الطعام': 'menu', القائمة: 'menu', المنيو: 'menu', menu: 'menu',
    offers: 'offers', العروض: 'offers', cart: 'cart', السلة: 'cart', 'سلة الطلب': 'cart',
    track: 'track', 'حالة الطلب': 'track', حالة: 'track', loyalty: 'loyalty', نقاطي: 'loyalty',
    addresses: 'addresses', عناويني: 'addresses' };
  const sel = c[p] || c[b.toLowerCase()] || null;
  if (sel === 'menu') return showCategories(phone, rid, customer);
  if (sel === 'offers') return showOffers(phone, rid, customer);
  if (sel === 'cart') return showCart(phone, rid, customer);
  if (sel === 'track') return showTracking(phone, rid, customer);
  if (sel === 'loyalty') return showLoyalty(phone, rid, customer);
  if (sel === 'addresses') return showAddresses(phone, rid, customer);
  return mainMenu(phone, rid);
}

// ---------- تصفح الأقسام ----------
function showCategories(phone, rid, customer) {
  const cats = q.all("SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category_id=c.id AND i.is_available=1) AS cnt FROM categories c WHERE c.restaurant_id=? AND c.is_active=1 ORDER BY c.sort_order, c.id", rid);
  const pop = q.all("SELECT * FROM items WHERE restaurant_id=? AND is_available=1 AND is_popular=1 ORDER BY id LIMIT 5", rid);
  const sections = [];
  if (pop.length) sections.push({ title: '⭐ الأكثر طلباً', rows: pop.map(i => ({ id: 'item:' + i.id, title: i.name, description: rls(i.price) + ' ر.س' })) });
  if (cats.length) sections.push({ title: '📂 الأقسام', rows: cats.map(c => ({ id: 'cat:' + c.id, title: c.name, description: (c.cnt || 0) + ' صنف' })) });
  const session = getSession(phone);
  saveSession(phone, 'browse_categories', session.data);
  return send(phone, rid, null, 'list', 'اختر القسم 👇', { list: sections.length ? sections : [{ title: 'الأقسام', rows: [{ id: 'none', title: 'لا توجد أصناف بعد' }] }] });
}
// بطاقة صنف تفاعلية: صورة + اسم + سعر + أزرار (إضافة العدد والتصفح)
function sendItemCard(phone, rid, idx, items) {
  const item = items[idx];
  const session = getSession(phone);
  const cart = session.data.cart || { items: [] };
  const inCart = cart.items.find(i => i.item_id === item.id);
  const txt = `*${item.name}*\n${item.description ? item.description + '\n' : ''}💰 ${rls(item.price)} ر.س${inCart ? `\n🛒 في سلتك: *×${inCart.quantity}*` : ''}`;
  if (item.image) send(phone, rid, null, 'image', txt, { image: item.image });
  else send(phone, rid, null, 'text', txt);
  let btns;
  if (inCart) btns = [{ id: 'inc1', title: '➕ زيادة 1' }, { id: 'dec1', title: '➖ نقصان 1' }];
  else btns = [{ id: 'add1', title: '➕ إضافة 1' }, { id: 'qty', title: '🔢 كمية أخرى' }];
  btns.push(idx < items.length - 1 ? { id: 'next', title: '⬅️ التالي' } : { id: 'cart', title: '🛒 السلة' });
  return send(phone, rid, null, 'buttons', `(${idx + 1}/${items.length}) اختر:`, { buttons: btns });
}
// زيادة/نقصان كمية صنف في السلة
function adjustQty(phone, rid, itemId, delta) {
  const session = getSession(phone);
  const cart = session.data.cart || { items: [] };
  const ex = cart.items.find(i => i.item_id === itemId);
  if (ex) {
    ex.quantity += delta;
    if (ex.quantity <= 0) cart.items = cart.items.filter(i => i.item_id !== itemId);
  } else if (delta > 0) {
    const item = q.get("SELECT * FROM items WHERE id=?", itemId);
    if (item) cart.items.push({ item_id: item.id, name: item.name, price: item.price, quantity: delta });
  }
  saveSession(phone, 'browse_items', { ...session.data, cart });
  return ex;
}
function browseItemAt(phone, rid, customer, idx) {
  const session = getSession(phone);
  const items = (session.data.catItems || []).map(id => q.get("SELECT * FROM items WHERE id=?", id)).filter(Boolean);
  if (idx < 0 || idx >= items.length) { send(phone, rid, null, 'text', 'وصلت لنهاية القسم ✅'); return showCart(phone, rid, customer); }
  saveSession(phone, 'browse_items', { ...session.data, itemIndex: idx, currentItem: items[idx].id });
  return sendItemCard(phone, rid, idx, items);
}
function handleCat(phone, rid, customer, p) {
  if (p.startsWith('cat:')) {
    const cid = Number(p.split(':')[1]);
    const items = q.all("SELECT * FROM items WHERE restaurant_id=? AND category_id=? AND is_available=1 ORDER BY is_popular DESC, sort_order, id", rid, cid);
    const cat = q.get("SELECT name FROM categories WHERE id=?", cid);
    const session = getSession(phone);
    if (!items.length) return send(phone, rid, null, 'text', 'لا توجد أصناف في هذا القسم حالياً.');
    saveSession(phone, 'browse_items', { ...session.data, lastCat: cid, catItems: items.map(i => i.id), itemIndex: 0 });
    send(phone, rid, null, 'text', `🍽 قسم *${cat?.name}* — ${items.length} صنف\nتصفح كل صنف بصورته وسعره، واضغط ➕ لإضافته 👇`);
    return browseItemAt(phone, rid, customer, 0);
  }
  if (p.startsWith('item:')) return itemDetail(phone, rid, customer, p);
  return showCategories(phone, rid, customer);
}
function handleItems(phone, rid, customer, p) {
  const session = getSession(phone);
  const data = session.data;
  if (p === 'next') return browseItemAt(phone, rid, customer, (data.itemIndex || 0) + 1);
  if (p === 'prev') return browseItemAt(phone, rid, customer, (data.itemIndex || 0) - 1);
  if (p === 'inc1' || p === 'dec1') {
    const idx = data.itemIndex || 0;
    const items = (data.catItems || []).map(id => q.get("SELECT * FROM items WHERE id=?", id)).filter(Boolean);
    const item = items[idx];
    if (item) {
      const ex = adjustQty(phone, rid, item.id, p === 'inc1' ? 1 : -1);
      if (p === 'dec1' && !ex) send(phone, rid, null, 'text', '🗑 تمت إزالة الصنف من السلة');
      return browseItemAt(phone, rid, customer, idx);
    }
  }
  if (p.startsWith('item:')) return itemDetail(phone, rid, customer, p);
  if (p === 'add1' || p === 'qty' || p === 'cart') return handleItemDetail(phone, rid, customer, data, p, '');
  return showCategories(phone, rid, customer);
}

function itemDetail(phone, rid, customer, p) {
  const id = Number(p.split(':')[1]);
  const item = q.get("SELECT * FROM items WHERE id=? AND restaurant_id=?", id, rid);
  if (!item) return send(phone, rid, null, 'text', 'الصنف غير متوفر.');
  let txt = `*${item.name}*\n${item.description ? item.description + '\n' : ''}💰 ${rls(item.price)} ر.س\n⏱ جاهز خلال ${item.prep_time_min || 15} دقيقة`;
  const session = getSession(phone);
  saveSession(phone, 'item_detail', { ...session.data, currentItem: item.id });
  if (item.image) send(phone, rid, null, 'image', txt, { image: item.image });
  else send(phone, rid, null, 'text', txt);
  return send(phone, rid, null, 'buttons', 'ماذا تريد أن تفعل؟', { buttons: [
    { id: 'add1', title: '➕ إضافة 1' }, { id: 'qty', title: '🔢 كمية أخرى' }, { id: 'cart', title: '🛒 السلة' }
  ] });
}
function handleItemDetail(phone, rid, customer, data, p, b) {
  const item = q.get("SELECT * FROM items WHERE id=?", data.currentItem);
  if (p === 'add1' || b === '1') return addToCart(phone, rid, customer, item, 1);
  if (p === 'qty') { saveSession(phone, 'item_qty', { ...data }); return send(phone, rid, null, 'text', `كم كمية *${item.name}*؟ (اكتب الرقم)`); }
  if (p === 'cart') return showCart(phone, rid, customer);
  if (p.startsWith('cat:')) return handleCat(phone, rid, customer, p);
  return showCategories(phone, rid, customer);
}
function handleItemQty(phone, rid, customer, data, b) {
  const item = q.get("SELECT * FROM items WHERE id=?", data.currentItem);
  const n = parseInt(b, 10);
  if (!n || n < 1 || n > 50) return send(phone, rid, null, 'text', 'الرجاء كتابة رقم صحيح (1-50)');
  return addToCart(phone, rid, customer, item, n);
}
function addToCart(phone, rid, customer, item, qty) {
  const session = getSession(phone);
  const cart = session.data.cart || { items: [] };
  const ex = cart.items.find(i => i.item_id === item.id);
  if (ex) ex.quantity += qty; else cart.items.push({ item_id: item.id, name: item.name, price: item.price, quantity: qty });
  cart.offer = cart.offer || null;
  saveSession(phone, 'cart', { ...session.data, cart });
  send(phone, rid, null, 'text', `✅ تمت إضافة *${item.name}* ×${qty} إلى السلة.`);
  return showCart(phone, rid, customer);
}
function showCart(phone, rid, customer) {
  const session = getSession(phone);
  const cart = session.data.cart;
  if (!cart || !cart.items.length) {
    send(phone, rid, null, 'text', 'سلتك فارغة حالياً 🛒\nاختر من القائمة لبدء الطلب.');
    return showCategories(phone, rid, customer);
  }
  saveSession(phone, 'cart', session.data);
  send(phone, rid, null, 'text', cartText(rid, cart));
  send(phone, rid, null, 'text', '🔢 لتعديل كمية أي صنف: تصفح صنفه من القائمة واضغط ➕ زيادة أو ➖ نقصان');
  return send(phone, rid, null, 'buttons', 'ماذا تريد؟', { buttons: [
    { id: 'checkout', title: '✅ إتمام الطلب' }, { id: 'coupon', title: '🏷 كود خصم' }, { id: 'menu', title: '⬅️ القائمة' }
  ] });
}
function sendOrderReview(phone, rid, customer) {
  const session = getSession(phone);
  const cart = session.data.cart;
  if (!cart || !cart.items.length) return showCart(phone, rid, customer);
  const t = cartTotals(rid, cart);
  let s = '🧾 *مراجعة طلبك الكامل*\n\n';
  for (const i of cart.items) s += `• ${i.name} ×${i.quantity} — ${rls(i.price * i.quantity)} ر.س\n`;
  if (cart.offer) s += `🔥 عرض: ${cart.offer.title}\n`;
  if (cart.coupon) s += `🏷 كود: ${cart.coupon}\n`;
  s += `\nالمجموع: ${rls(t.subtotal)} ر.س\n`;
  if (t.discount) s += `الخصم: -${rls(t.discount)} ر.س\n`;
  s += `التوصيل: ${t.delivery_fee ? rls(t.delivery_fee) + ' ر.س' : 'مجاني ✅'}\n━━━━━━━━━━━━\n*الإجمالي: ${rls(t.total)} ر.س*\n\n📌 رسوم التوصيل النهائية حسب أقرب فرع لموقعك.`;
  saveSession(phone, 'order_review', session.data);
  send(phone, rid, null, 'text', s);
  return send(phone, rid, null, 'buttons', 'تأكيد الطلب والانتقال للدفع؟', { buttons: [
    { id: 'confirm', title: '✅ تأكيد والدفع' }, { id: 'coupon', title: '🏷 كود خصم' }, { id: 'menu', title: '⬅️ تعديل السلة' }
  ] });
}
function handleOrderReview(phone, rid, customer, data, p, b) {
  if (p === 'confirm') return choosePayment(phone, rid, customer);
  if (p === 'coupon') { saveSession(phone, 'coupon', data); return send(phone, rid, null, 'text', 'أرسل كود الخصم 🏷'); }
  if (p === 'menu') return showCart(phone, rid, customer);
  return sendOrderReview(phone, rid, customer);
}
function handleCart(phone, rid, customer, data, p, b) {
  if (p === 'checkout') return sendOrderReview(phone, rid, customer);
  if (p === 'coupon') { saveSession(phone, 'coupon', data); return send(phone, rid, null, 'text', 'أرسل كود الخصم 🏷'); }
  if (p === 'menu' || p === 'clear') {
    const d = { ...data }; d.cart = { items: [] }; delete d.cart.offer;
    saveSession(phone, 'idle', d);
    return mainMenu(phone, rid);
  }
  return showCart(phone, rid, customer);
}
function handleCoupon(phone, rid, customer, data, b) {
  const cp = q.get("SELECT * FROM coupons WHERE code=? AND is_active=1 AND (expires_at IS NULL OR expires_at >= datetime('now'))", b.trim());
  if (!cp) { send(phone, rid, null, 'text', 'كود الخصم غير صالح ❌'); return showCart(phone, rid, customer); }
  const cart = data.cart || { items: [] };
  cart.coupon = cp.code;
  saveSession(phone, 'cart', { ...data, cart });
  send(phone, rid, null, 'text', `🏷 تم تطبيق كود الخصم *${cp.code}*`);
  return showCart(phone, rid, customer);
}

// ---------- العروض ----------
function showOffers(phone, rid, customer) {
  const offers = activeOffers(rid);
  const session = getSession(phone);
  saveSession(phone, 'browse_offers', session.data);
  if (!offers.length) { send(phone, rid, null, 'text', 'لا توجد عروض حالياً 🔥'); return mainMenu(phone, rid); }
  const rows = offers.slice(0, 10).map(o => ({
    id: 'offer:' + o.id,
    title: o.title,
    description: (o.type === 'percent' ? `خصم ${o.value}%` : o.type === 'fixed' ? `خصم ${rls(o.value)} ر.س` : 'عرض خاص') + (o.min_order ? ` (طلب ${rls(o.min_order)}+)` : '')
  }));
  return send(phone, rid, null, 'list', '🔥 عروض المطعم:', { list: [{ title: 'العروض', rows }] });
}
function handleOffers(phone, rid, customer, data, p) {
  if (p.startsWith('offer:')) {
    const o = q.get("SELECT * FROM offers WHERE id=? AND restaurant_id=?", Number(p.split(':')[1]), rid);
    if (!o) return showOffers(phone, rid, customer);
    saveSession(phone, 'browse_offers', { ...data, currentOffer: o });
    send(phone, rid, null, 'text', `🔥 *${o.title}*\n${o.description || ''}\n${o.type === 'percent' ? `خصم ${o.value}%` : o.type === 'fixed' ? `خصم ${rls(o.value)} ر.س` : ''}${o.min_order ? `\nالحد الأدنى: ${rls(o.min_order)} ر.س` : ''}`);
    return send(phone, rid, null, 'buttons', 'تطبيق العرض؟', { buttons: [{ id: 'apply_offer', title: '🔥 أضف العرض' }, { id: 'menu', title: '⬅️ القائمة' }] });
  }
  if (p === 'apply_offer') {
    const o = data.currentOffer;
    const session = getSession(phone);
    const cart = session.data.cart || { items: [] };
    if (!cart.items.length) { send(phone, rid, null, 'text', 'أضف أصنافاً أولاً ثم طبق العرض 🛒'); return showCategories(phone, rid, customer); }
    cart.offer = { id: o.id, title: o.title, type: o.type, value: o.value, min_order: o.min_order };
    saveSession(phone, 'cart', { ...session.data, cart });
    send(phone, rid, null, 'text', `🔥 تم إضافة العرض *${o.title}* لطلبك!`);
    return showCart(phone, rid, customer);
  }
  return showOffers(phone, rid, customer);
}

// ---------- الدفع ----------
// ---------- الدفع ----------
function choosePayment(phone, rid, customer) {
  const session = getSession(phone);
  saveSession(phone, 'payment_method', session.data);
  send(phone, rid, null, 'buttons', '💰 اختر طريقة الدفع:', { buttons: [
    { id: 'pay:applepay', title: '🍎 Apple Pay' }, { id: 'pay:mada', title: '💳 مدى' }, { id: 'pay:card', title: '💳 بطاقة' }
  ] });
  return send(phone, rid, null, 'buttons', 'أو ادفع عند الاستلام:', { buttons: [{ id: 'pay:cash', title: '💵 كاش عند الاستلام' }] });
}
async function handlePayMethod(phone, rid, customer, data, p) {
  const method = p.replace('pay:', '');
  if (!['applepay', 'mada', 'card', 'cash'].includes(method)) return choosePayment(phone, rid, customer);
  const session = getSession(phone);
  const cart = session.data.cart;
  if (!cart || !cart.items.length) return showCart(phone, rid, customer);
  const totals = cartTotals(rid, cart);
  if (method === 'cash') {
    return askLocation(phone, rid, customer, { ...session.data, paymentMethod: 'cash', paid: false });
  }
  const rest = q.get("SELECT name_ar FROM restaurants WHERE id=?", rid);
  const pay = await createPayment({ total: totals.total, order_no: 'طلب جديد', restaurant_name: rest.name_ar }, method, { phone, restaurant_id: rid });
  saveSession(phone, 'awaiting_payment', { ...session.data, paymentMethod: method, paymentId: pay.payment_id || null, paymentUrl: pay.payment_url || null });
  send(phone, rid, null, 'text', `💰 المطلوب: *${rls(totals.total)} ر.س*\nاضغط الرابط لإتمام الدفع بأمان (Apple Pay / مدى):`);
  send(phone, rid, null, 'text', pay.payment_url || 'https://sandbox.moyasar.com/pay (رابط تجريبي)');
  return send(phone, rid, null, 'buttons', 'بعد إتمام الدفع اضغط هنا 👇', { buttons: [{ id: 'paid', title: '✅ تم الدفع' }, { id: 'cancel', title: '❌ إلغاء' }] });
}
function handleAwaitPay(phone, rid, customer, data, p) {
  if (p === 'cancel') { saveSession(phone, 'idle', {}); return mainMenu(phone, rid); }
  if (p === 'paid' || p === 'yes') {
    const row = data.paymentId ? q.get("SELECT * FROM payments WHERE id=?", data.paymentId) : null;
    if (!row) return send(phone, rid, null, 'text', 'تعذر العثور على عملية الدفع.');
    if (row.status !== 'paid') {
      if (config.paymentMode === 'mock') { const r = markPaid(row.id); if (r.status !== 'paid') return send(phone, rid, null, 'text', 'لم يتم تأكيد الدفع بعد ⏳'); }
      else return send(phone, rid, null, 'text', 'لم يتم تأكيد الدفع بعد ⏳ انتظر لحظات ثم اضغط ✅ تم الدفع.');
    }
    send(phone, rid, null, 'text', '✅ تم تأكيد الدفع بنجاح!');
    return askLocation(phone, rid, customer, { ...data, paid: true });
  }
  return send(phone, rid, null, 'buttons', 'أرسل ✅ تم الدفع بعد إتمام العملية', { buttons: [{ id: 'paid', title: '✅ تم الدفع' }] });
}

// ---------- الموقع والعنوان ----------
function askLocation(phone, rid, customer, data = {}) {
  saveSession(phone, 'location_request', data);
  send(phone, rid, null, 'text', '📍 أرسل *موقعك* الآن ليصلك الطلب.\n(في واتساب: زر 📎 ثم الموقع)\nوسيتم حفظه في قاعدة البيانات لاستخدامه في طلباتك القادمة.');
  return send(phone, rid, null, 'buttons', 'أو اضغط هنا:', { buttons: [{ id: 'send_location', title: '📍 إرسال الموقع' }] });
}
function handleLocation(phone, rid, customer, data, type, lat, lng, p) {
  if (type !== 'location' && p !== 'send_location') return send(phone, rid, null, 'buttons', 'أرسل موقعك 📍 أو اضغط الزر', { buttons: [{ id: 'send_location', title: '📍 إرسال الموقع' }] });
  const delivery = resolveDelivery(rid, lat, lng);
  if (!delivery.ok || delivery.reason === 'out_of_range') {
    send(phone, rid, null, 'text', `🚫 نعتذر، موقعك *خارج نطاق التوصيل* لدينا حالياً (${Math.round(delivery.distanceKm)} كم من أقرب فرع).\nأقرب فرع لك: *${delivery.branch?.name || ''}* — ${delivery.branch?.address || ''}\n\nيمكنك المحاولة من موقع آخر أو التواصل معنا.`);
    saveSession(phone, 'location_request', { ...data, outOfRange: true });
    return send(phone, rid, null, 'buttons', '', { buttons: [{ id: 'send_location', title: '📍 إرسال موقع آخر' }, { id: 'menu', title: '⬅️ القائمة الرئيسية' }] });
  }
  const saved = saveLocation(customer.id, lat, lng, data, p, delivery.branch);
  const prev = q.get("SELECT COUNT(*) AS c FROM customer_locations WHERE customer_id=?", customer.id);
  if (Number(prev.c) === 1) {
    saveSession(phone, 'delivery_time', { ...data, address: saved });
    send(phone, rid, null, 'text', `📍 تم حفظ عنوانك: ${saved.label}\n${saved.national_address || (lat + ',' + lng)}\n🏪 سيتولى توصيلك: *${delivery.branch.name}* (${Math.round(delivery.distanceKm)} كم)`);
    return askTime(phone, rid);
  }
  saveSession(phone, 'address_confirm', { ...data, address: saved, newLoc: saved });
  const def = q.get("SELECT * FROM customer_locations WHERE customer_id=? ORDER BY is_default DESC, id DESC LIMIT 1", customer.id);
  send(phone, rid, null, 'text', `📍 هل ترغب أن يصلك الطلب على عنوانك الوطني المسجل سابقاً؟\n*${def.label}:* ${def.national_address || (def.lat + ',' + def.lng)}\n🏪 الفرع المسؤول: *${delivery.branch.name}*`);
  return send(phone, rid, null, 'buttons', '', { buttons: [{ id: 'addr_yes', title: '✅ نعم نفس العنوان' }, { id: 'addr_new', title: '🆕 مكان آخر' }] });
}

function handleAddressConfirm(phone, rid, customer, data, p) {
  if (p === 'addr_yes') {
    const def = q.get("SELECT * FROM customer_locations WHERE customer_id=? ORDER BY is_default DESC, id DESC LIMIT 1", customer.id);
    if (def.lat && def.lng) {
      const delivery = resolveDelivery(rid, def.lat, def.lng);
      if (!delivery.ok || delivery.reason === 'out_of_range') {
        send(phone, rid, null, 'text', `🚫 نعتذر، عنوانك السابق *خارج نطاق التوصيل* الحالي (${Math.round(delivery.distanceKm)} كم من أقرب فرع).`);
        saveSession(phone, 'address_confirm', data);
        return send(phone, rid, null, 'buttons', '', { buttons: [{ id: 'addr_new', title: '🆕 مكان آخر' }] });
      }
      def.branch_id = delivery.branch.id; def.branch_name = delivery.branch.name; def.branch = delivery.branch;
    }
    saveSession(phone, 'delivery_time', { ...data, address: def });
    return askTime(phone, rid);
  }
  if (p === 'addr_new') {
    saveSession(phone, 'new_location_request', { ...data });
    send(phone, rid, null, 'text', '📍 أرسل الموقع الجديد الذي تريد التوصيل إليه.');
    return send(phone, rid, null, 'buttons', '', { buttons: [{ id: 'send_location', title: '📍 إرسال الموقع' }] });
  }
  send(phone, rid, null, 'text', '📍 اختر: نفس العنوان السابق أم مكان آخر؟');
  return send(phone, rid, null, 'buttons', '', { buttons: [{ id: 'addr_yes', title: '✅ نفس العنوان' }, { id: 'addr_new', title: '🆕 مكان آخر' }] });
}
function handleNewLocation(phone, rid, customer, data, type, lat, lng, p) {
  if (type !== 'location' && p !== 'send_location') return send(phone, rid, null, 'buttons', 'أرسل الموقع الجديد 📍', { buttons: [{ id: 'send_location', title: '📍 إرسال الموقع' }] });
  const delivery = resolveDelivery(rid, lat, lng);
  if (!delivery.ok || delivery.reason === 'out_of_range') {
    send(phone, rid, null, 'text', `🚫 نعتذر، الموقع الجديد *خارج نطاق التوصيل* (${Math.round(delivery.distanceKm)} كم من أقرب فرع).\nأقرب فرع: *${delivery.branch?.name || ''}* — ${delivery.branch?.address || ''}`);
    saveSession(phone, 'new_location_request', { ...data, outOfRange: true });
    return send(phone, rid, null, 'buttons', '', { buttons: [{ id: 'send_location', title: '📍 إرسال موقع آخر' }] });
  }
  const saved = saveLocation(customer.id, lat, lng, data, p, delivery.branch);
  saveSession(phone, 'delivery_time', { ...data, address: saved });
  send(phone, rid, null, 'text', `📍 تم حفظ العنوان الجديد: ${saved.national_address || (lat + ',' + lng)}\n🏪 الفرع المسؤول: *${delivery.branch.name}*`);
  return askTime(phone, rid);
}

function saveLocation(customerId, lat, lng, data, p, branch = null) {
  const isDefault = q.get("SELECT COUNT(*) AS c FROM customer_locations WHERE customer_id=?", customerId).c === 0 ? 1 : 0;
  const na = (p && p.startsWith('loc:')) ? p.slice(4) : null;
  const r = q.run("INSERT INTO customer_locations (customer_id, label, national_address, lat, lng, is_default) VALUES (?,?,?,?,?,?)",
    customerId, isDefault ? 'المنزل' : (data.nextLabel || 'موقع جديد'), na, lat, lng, isDefault);
  const saved = q.get("SELECT * FROM customer_locations WHERE id=?", r.lastInsertRowid);
  if (branch) { saved.branch_id = branch.id; saved.branch_name = branch.name; saved.branch = branch; }
  return saved;
}

function askTime(phone, rid) {
  send(phone, rid, null, 'text', '🕐 حدد الوقت التقريبي لتوصيل طلبك:');
  return send(phone, rid, null, 'buttons', '', { buttons: [
    { id: 'time:30', title: '⚡ أسرع وقت (~30 د)' }, { id: 'time:45', title: '🕐 خلال 45 دقيقة' }, { id: 'time:90', title: '🕑 خلال ساعة ونصف' }
  ] });
}
function handleDeliveryTime(phone, rid, customer, data, p) {
  const est = p.startsWith('time:') ? Number(p.split(':')[1]) : 30;
  return placeOrder(phone, rid, customer, { ...data, estDeliveryMin: est });
}

// ---------- إنشاء الطلب ----------
function placeOrder(phone, rid, customer, data) {
  const session = getSession(phone);
  const cart = session.data.cart;
  if (!cart || !cart.items.length) { saveSession(phone, 'idle', {}); return mainMenu(phone, rid); }
  const rest = q.get("SELECT * FROM restaurants WHERE id=?", rid);
  const branch = data.address?.branch || null;
  const totals = cartTotals(rid, cart, branch);
  const order = createOrder({ restaurant: rest, customer, cart, totals, paymentMethod: data.paymentMethod, address: data.address, estDeliveryMin: data.estDeliveryMin || 30, branch });
  if (data.paymentId) q.run("UPDATE payments SET order_id=? WHERE id=?", order.id, data.paymentId);
  if (data.paid) q.run("UPDATE orders SET payment_status='paid' WHERE id=?", order.id);
  q.run("UPDATE conversations SET order_id=? WHERE phone=? AND order_id IS NULL AND created_at >= datetime('now','-3 hours')", order.id, customer.phone);
  const d = { ...session.data, orderId: order.id };
  saveSession(phone, 'tracking', d);
  send(phone, rid, order.id, 'text', `✅ *تم استلام طلبك ${order.order_no}!*\n\n${cartText(rid, cart, branch)}\n📍 التوصيل إلى: ${data.address.national_address || (data.address.lat + ',' + data.address.lng)}\n🕐 الوصول التقريبي: خلال ${data.estDeliveryMin || 30} دقيقة\n\n🔐 *رمز استلام طلبك: ${order.delivery_code}*\nسلّمه للمندوب عند استلام طلبك — لا تعطه لأي شخص آخر.\n\nسيبقيك واتساب على اطلاع بكل مرحلة حتى وصول طلبك 🛵`);
  return send(phone, rid, order.id, 'buttons', '', { buttons: [{ id: 'track', title: '📦 حالة الطلب' }, { id: 'menu', title: '⬅️ القائمة الرئيسية' }] });
}

// ---------- التتبع ----------
function showTracking(phone, rid, customer) {
  const last = q.get("SELECT * FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 3", customer.id);
  if (!last) { send(phone, rid, null, 'text', 'لا توجد طلبات سابقة بعد.'); return mainMenu(phone, rid); }
  const session = getSession(phone);
  saveSession(phone, 'tracking', { ...session.data, orderId: last.id });
  return sendOrderStatus(phone, rid, last);
}
function handleTracking(phone, rid, customer, data, p) {
  if (p === 'track' && data.orderId) {
    const o = q.get("SELECT * FROM orders WHERE id=?", data.orderId);
    if (o) return sendOrderStatus(phone, rid, o);
  }
  return showTracking(phone, rid, customer);
}
const STATUS_EMOJI = { new: '🆕', confirmed: '✔️', preparing: '👨‍🍳', ready: '📦', offered: '📢', accepted: '🤝', transferred: '🛵', with_captain: '🛵', on_the_way: '🚀', arrived: '📍', delivered: '🎉', cancelled: '❌' };
const STATUS_NAME = { new: 'استلمنا طلبك', confirmed: 'تم التأكيد', preparing: 'قيد التحضير', ready: 'جاهز للتسليم', offered: 'عُرض على الكباتن', accepted: 'كابتن يقبل الطلب', transferred: 'مع كابتن التوصيل', with_captain: 'مع الكابتن', on_the_way: 'في الطريق إليك', arrived: 'وصل الطلب', delivered: 'تم التسليم', cancelled: 'ملغي' };
function sendOrderStatus(phone, rid, o) {
  const events = q.all("SELECT * FROM order_events WHERE order_id=? ORDER BY id", o.id);
  let t = `📦 *حالة الطلب ${o.order_no}*\n${STATUS_EMOJI[o.status] || ''} *${STATUS_NAME[o.status] || o.status}*\n\n`;
  for (const e of events.slice(-5)) t += `• ${e.message}\n`;
  t += `\n💵 الإجمالي: ${rls(o.total)} ر.س — ${o.payment_status === 'paid' ? 'مدفوع ✅' : 'غير مدفوع'}`;
  return send(phone, rid, o.id, 'text', t);
}

// ---------- الولاء والعناوين ----------
function showLoyalty(phone, rid, customer) {
  const tier = computeTier(customer.total_points_earned || 0);
  send(phone, rid, null, 'text', `⭐ *برنامج الولاء*\nرصيد نقاطك: *${customer.points_balance || 0}*\nمستواك: *${customer.tier || tier.name}*\nعدد طلباتك: ${customer.total_orders || 0}\n\n💡 كل ريال = نقطة. استبدل نقاطك بخصومات في طلباتك القادمة!`);
  return mainMenu(phone, rid);
}
function showAddresses(phone, rid, customer) {
  const locs = q.all("SELECT * FROM customer_locations WHERE customer_id=? ORDER BY is_default DESC, id DESC", customer.id);
  if (!locs.length) { send(phone, rid, null, 'text', 'لا توجد عناوين محفوظة بعد 📍'); return mainMenu(phone, rid); }
  let t = '📍 *عناوينك المحفوظة:*\n';
  locs.forEach((l, i) => { t += `${i + 1}. ${l.is_default ? '⭐' : ''} ${l.label}: ${l.national_address || (l.lat + ',' + l.lng)}\n`; });
  send(phone, rid, null, 'text', t);
  return mainMenu(phone, rid);
}

// ---------- التقيم ----------
export function triggerRating(order) {
  const customer = q.get("SELECT phone FROM customers WHERE id=?", order.customer_id);
  if (!customer) return;
  const session = getSession(customer.phone);
  saveSession(customer.phone, 'rate_restaurant', { ...session.data, orderId: order.id, ratings: {} });
  send(customer.phone, order.restaurant_id, order.id, 'text', '🎉 تم توصيل طلبك! ساعدنا بتقييم تجربتك ⭐');
  send(customer.phone, order.restaurant_id, order.id, 'buttons', 'قيّم *المطعم* (1-5):', { buttons: [
    { id: 'rate:1', title: '⭐' }, { id: 'rate:3', title: '⭐⭐⭐' }, { id: 'rate:5', title: '⭐⭐⭐⭐⭐' }
  ] });
  return send(customer.phone, order.restaurant_id, order.id, 'buttons', 'أو أدخل رقم 1-5:', { buttons: [
    { id: 'rate:2', title: '⭐⭐' }, { id: 'rate:4', title: '⭐⭐⭐⭐' }
  ] });
}
function handleRate(phone, rid, customer, data, p, b, key) {
  let v = parseInt(p.startsWith('rate:') ? p.split(':')[1] : b, 10);
  if (!v || v < 1 || v > 5) return send(phone, rid, data.orderId, 'text', 'الرجاء إرسال رقم بين 1 و 5 ⭐');
  const ratings = { ...(data.ratings || {}), [key]: v };
  const next = key === 'restaurant' ? 'rate_speed' : key === 'speed' ? 'rate_captain' : null;
  const label = key === 'restaurant' ? 'سرعة التوصيل 🏍' : key === 'speed' ? 'كابتن التوصيل 🛵' : '';
  if (next) {
    saveSession(phone, next, { ...data, ratings });
    send(phone, rid, data.orderId, 'text', `تم ✅ الآن قيّم *${label}* (1-5):`);
    send(phone, rid, data.orderId, 'buttons', '', { buttons: [
      { id: 'rate:1', title: '⭐' }, { id: 'rate:3', title: '⭐⭐⭐' }, { id: 'rate:5', title: '⭐⭐⭐⭐⭐' }
    ] });
    return send(phone, rid, data.orderId, 'buttons', 'أو أدخل رقم 1-5:', { buttons: [
      { id: 'rate:2', title: '⭐⭐' }, { id: 'rate:4', title: '⭐⭐⭐⭐' }
    ] });
  }
  saveSession(phone, 'rate_comment', { ...data, ratings });
  return send(phone, rid, data.orderId, 'text', 'تم ✅ شكراً لتقييمك! 📝 أضف ملاحظة أو اكتب "تخطي"');
}
function handleRateComment(phone, rid, customer, data, b) {
  const comment = b && b.toLowerCase() !== 'تخطي' ? b : null;
  return finishRating(phone, rid, customer, data, comment);
}
function finishRating(phone, rid, customer, data, comment = null) {
  const ratings = data.ratings || {};
  const cols = [], vals = [];
  if (ratings.restaurant) { cols.push('rating_restaurant=?'); vals.push(ratings.restaurant); }
  if (ratings.speed) { cols.push('rating_speed=?'); vals.push(ratings.speed); }
  if (ratings.captain) { cols.push('rating_captain=?'); vals.push(ratings.captain); }
  if (comment) { cols.push('rating_comment=?'); vals.push(comment); }
  if (cols.length && data.orderId) { vals.push(data.orderId); q.run(`UPDATE orders SET ${cols.join(',')}, rated_at=datetime('now') WHERE id=?`, ...vals); }
  if (ratings.restaurant && data.orderId) {
    const o = q.get("SELECT * FROM orders WHERE id=?", data.orderId);
    if (o && o.restaurant_id) {
      const r = q.get("SELECT * FROM restaurants WHERE id=?", o.restaurant_id);
      const rc = (r.rating_count || 0) + 1;
      const avg = ((r.rating_avg || 0) * (r.rating_count || 0) + ratings.restaurant) / rc;
      q.run("UPDATE restaurants SET rating_avg=?, rating_count=? WHERE id=?", Math.round(avg * 10) / 10, rc, o.restaurant_id);
    }
    if (ratings.captain && o.captain_id) {
      const c = q.get("SELECT * FROM captains WHERE id=?", o.captain_id);
      const cc = (c.rating_count || 0) + 1;
      const avg = ((c.rating_avg || 0) * (c.rating_count || 0) + ratings.captain) / cc;
      q.run("UPDATE captains SET rating_avg=?, rating_count=? WHERE id=?", Math.round(avg * 10) / 10, cc, o.captain_id);
      send(c.phone, rid, data.orderId, 'text', `⭐ تقييم العميل لك على الطلب ${o.order_no}:\n🛵 الكابتن: ${'⭐'.repeat(ratings.captain)} (${ratings.captain}/5)\n🏠 السرعة: ${'⭐'.repeat(ratings.speed || 0)}${ratings.speed ? ` (${ratings.speed}/5)` : ''}${comment ? `\n💬 تعليق: ${comment}` : ''}`);
    }
  }
  const fresh = q.get("SELECT * FROM customers WHERE id=?", customer.id);
  send(phone, rid, data.orderId, 'text', `شكراً لتقييمك! 🙏\n🎁 كسبت *${fresh.points_balance || 0}* نقطة ولاء — مستواك: ${fresh.tier}\nنتطلع لخدمتك مرة أخرى!`);
  saveSession(phone, 'idle', {});
  return mainMenu(phone, rid);
}

// ---------- استكمال التدفق بعد نجاح الدفع (ويب هوك مويصر) ----------
export function onPaymentSuccess(phone, rid) {
  const session = getSession(phone);
  if (session.state !== 'awaiting_payment') return;
  send(phone, rid, null, 'text', '✅ تم تأكيد الدفع بنجاح!');
  return askLocation(phone, rid, ensureCustomer(phone));
}

// ================= تدفق الكابتن على نفس واتساب المطعم =================
// الكابتن يرسل لنفس رقم المطعم — البوت يميّزه من رقمه المسجل ويعامله ككابتن
export function isCaptainPhone(phone) {
  return !!q.get("SELECT id FROM captains WHERE phone=? OR phone=?", phone, validatePhone(phone));
}

export async function handleCaptainIncoming({ phone, body = '', payload = null }) {
  const captain = q.get("SELECT * FROM captains WHERE phone=? OR phone=?", phone, validatePhone(phone));
  if (!captain) return { ok: false };
  const b = String(body || '').trim();
  const p = payload ? String(payload) : '';
  const cmd = (b || p).toLowerCase();
  const rid = q.get("SELECT id FROM branches WHERE id IN (SELECT id FROM branches) LIMIT 1")?.id; // غير مستخدم
  const { captainAccept } = await import('./dispatch.js');

  // 1) رمز الاستلام: يغلق الطلب
  const codeMatch = cmd.match(/(رمز|كود|code)\s*[:：]?\s*(\d{4,8})/i);
  if (codeMatch) {
    const { closeOrderWithCode } = await import('./orderService.js');
    const r = await closeOrderWithCode(codeMatch[2], captain.phone);
    if (r.ok) return send(captain.phone, r.order.restaurant_id, r.order.id, 'text', '🔐 تم التحقق من رمز الاستلام وإغلاق الطلب بنجاح! ✅');
    return send(captain.phone, null, null, 'text', '❌ ' + (r.error || 'رمز غير صحيح'));
  }

  // 2) قبول الطلب
  if (['اقبل', 'قبول', 'accept', 'اقبل الطلب'].includes(b) || p === 'accept' || p.startsWith('accept:')) {
    const offer = q.get("SELECT * FROM captain_offers WHERE captain_id=? AND status='offered' ORDER BY id DESC LIMIT 1", captain.id);
    if (!offer) return send(captain.phone, null, null, 'text', 'لا توجد طلبات متاحة للقبول حالياً 📭');
    const r = captainAccept(offer.order_id, captain.id);
    if (r.error) return send(captain.phone, null, null, 'text', '❌ ' + r.error);
    const o = q.get("SELECT order_no FROM orders WHERE id=?", offer.order_id);
    return send(captain.phone, null, offer.order_id, 'text', `✅ قبلت الطلب ${o?.order_no || ''}!\nالمطعم سيقوم بتحويل الطلب عليك عبر لوحة التحكم.`);
  }

  // 3) رفض الطلب
  if (['رفض', 'reject', 'لا'].includes(b) || p === 'reject') {
    const offer = q.get("SELECT * FROM captain_offers WHERE captain_id=? AND status='offered' ORDER BY id DESC LIMIT 1", captain.id);
    if (offer) q.run("UPDATE captain_offers SET status='rejected', responded_at=datetime('now') WHERE id=?", offer.id);
    return send(captain.phone, null, null, 'text', 'تم رفض العرض 👌');
  }

  // 4) استلمت / انطلقت / وصلت: مراحل التوصيل من واتساب
  const activeQ = q.get("SELECT * FROM orders WHERE captain_id=? AND status IN ('transferred','with_captain','on_the_way') ORDER BY id DESC LIMIT 1", captain.id);
  if (['استلمت', 'استلم', 'اخذت'].includes(b)) {
    if (!activeQ) return send(captain.phone, null, null, 'text', 'لا يوجد طلب نشط لك حالياً.');
    const r = setStatus(activeQ.id, 'with_captain', 'captain', captain.id);
    return send(captain.phone, null, activeQ.id, 'text', r.error ? '❌ ' + r.error : '🛵 تم التأكيد: استلمت الطلب من المطعم.\nعند انطلاقك أرسل: *انطلقت*');
  }
  if (['انطلقت', 'انطلق', 'طلعت'].includes(b)) {
    if (!activeQ) return send(captain.phone, null, null, 'text', 'لا يوجد طلب نشط لك حالياً.');
    const r = setStatus(activeQ.id, 'on_the_way', 'captain', captain.id);
    return send(captain.phone, null, activeQ.id, 'text', r.error ? '❌ ' + r.error : '🚀 انطلقت للتوصيل!\nعند وصولك للعميل أرسل: *وصلت*');
  }
  if (['وصلت', 'وصل', 'اوصلت'].includes(b)) {
    if (!activeQ) return send(captain.phone, null, null, 'text', 'لا يوجد طلب نشط لك حالياً.');
    const r = setStatus(activeQ.id, 'arrived', 'captain', captain.id);
    if (r.error) return send(captain.phone, null, null, 'text', '❌ ' + r.error);
    return send(captain.phone, null, activeQ.id, 'text', '📍 تم إبلاغ العميل بوصولك!\n🔐 اطلب منه رمز الاستلام ثم أرسله هنا: رمز XXXXXX');
  }
  // 5) الحالة: طلباتي النشطة
  if (['حالة', 'status', 'طلباتي'].includes(b)) {
    const active = q.all("SELECT * FROM orders WHERE captain_id=? AND status NOT IN ('delivered','cancelled') ORDER BY id DESC", captain.id);
    if (!active.length) return send(captain.phone, null, null, 'text', 'لا توجد طلبات نشطة لك حالياً 🟢');
    let t = '📦 *طلباتك النشطة:*\n';
    for (const o of active) t += `${o.order_no} — ${o.status}\n`;
    return send(captain.phone, null, null, 'text', t);
  }

  // 6) افتراضي: الأوامر المتاحة
  return send(captain.phone, null, null, 'text',
    `🛵 أهلاً كابتن *${captain.name}* — أوامر سريعة عبر واتساب:\n` +
    `✅ *اقبل* — قبول آخر طلب متاح\n` +
    `❌ *رفض* — رفض العرض\n` +
    `📍 *وصلت* — إبلاغ العميل بالوصول\n` +
    `🔐 *رمز 123456* — إغلاق الطلب برمز الاستلام\n` +
    `📦 *حالة* — طلباتك النشطة`);
}


// ---------- إلغاء الطلب مع استبيان السبب ----------
function activeOrderFor(phone) {
  const cust = q.get("SELECT id FROM customers WHERE phone=?", phone);
  if (!cust) return null;
  return q.get("SELECT * FROM orders WHERE customer_id=? AND status NOT IN ('delivered','cancelled') AND order_no != 'DRAFT' ORDER BY id DESC LIMIT 1", cust.id);
}
function handleCancelRequest(phone, rid, customer, data) {
  const order = activeOrderFor(phone);
  if (!order) return send(phone, rid, null, 'text', 'لا يوجد طلب نشط يمكنك إلغاؤه حالياً ✅');
  const now = Date.now();
  const created = new Date(order.created_at.replace(' ', 'T') + 'Z').getTime();
  const isPaid = order.payment_status === 'paid' && order.payment_method !== 'cash';
  if (isPaid) {
    // مدفوع (Apple Pay/مدى): الإلغاء مقبول خلال دقيقتين من الدفع فقط
    const pay = q.get("SELECT created_at FROM payments WHERE order_id=? AND status='paid' ORDER BY id DESC LIMIT 1", order.id);
    const paidTime = pay ? new Date(pay.created_at.replace(' ', 'T') + 'Z').getTime() : created;
    const sincePaid = Math.floor((now - paidTime) / 1000);
    if (sincePaid >= 120) {
      return send(phone, rid, order.id, 'text', `❌ لا يمكن إلغاء الطلب ${order.order_no} بعد مرور دقيقتين على الدفع — تم تأكيد المبلغ.\nيمكنك التواصل مع المطعم لترتيب الإرجاع.`);
    }
    const wait = 120 - sincePaid;
    send(phone, rid, order.id, 'text', `⏳ يمكنك إلغاء الطلب خلال ${wait} ثانية فقط (قاعدة الدقيقتين بعد الدفع).`);
  } else {
    // غير مدفوع (كاش): الإلغاء مقبول بعد مرور دقيقتين من إنشاء الطلب
    const sinceCreated = Math.floor((now - created) / 1000);
    if (sinceCreated < 120) {
      const wait = 120 - sinceCreated;
      return send(phone, rid, order.id, 'text', `⏳ يمكنك إلغاء الطلب ${order.order_no} بعد مرور دقيقتين من إنشائه.\n⏱ باقي ${wait} ثانية — حاول بعد قليل.`);
    }
  }
  saveSession(phone, 'cancel_reason', { ...data, cancelOrderId: order.id });
  send(phone, rid, order.id, 'text', `❓ لماذا تريد إلغاء الطلب ${order.order_no}؟\n(ملاحظتك ستصل لمشرف المطعم)`);
  return send(phone, rid, order.id, 'buttons', '', { buttons: [
    { id: 'cr:late_reply', title: '⏱ تأخر الرد' },
    { id: 'cr:late_captain', title: '🛵 تأخر الكابتن' },
    { id: 'cr:other', title: '📝 سبب آخر' }
  ] });
}
async function handleCancelReason(phone, rid, customer, data, p, b) {
  const map = { 'cr:late_reply': 'تأخر الرد', 'cr:late_captain': 'تأخر الكابتن', 'cr:other': 'سبب آخر' };
  const reason = map[p] || (['تأخر الرد', 'تأخر الكابتن', 'سبب آخر'].includes(b) ? b : null);
  if (!reason) return send(phone, rid, data.cancelOrderId, 'buttons', 'اختر سبب الإلغاء:', { buttons: [
    { id: 'cr:late_reply', title: '⏱ تأخر الرد' }, { id: 'cr:late_captain', title: '🛵 تأخر الكابتن' }, { id: 'cr:other', title: '📝 سبب آخر' }
  ] });
  if (reason === 'سبب آخر') {
    saveSession(phone, 'cancel_reason_text', { ...data, cancelReason: reason });
    return send(phone, rid, data.cancelOrderId, 'text', '📝 اكتب سبب الإلغاء بالتفصيل:');
  }
  return finishCancel(phone, rid, customer, data, reason);
}
async function handleCancelReasonText(phone, rid, customer, data, b) {
  if (!b || b.length < 2) return send(phone, rid, data.cancelOrderId, 'text', 'الرجاء كتابة السبب (أو أرسل "تخطي")');
  const note = b === 'تخطي' ? null : b.slice(0, 200);
  return finishCancel(phone, rid, customer, data, data.cancelReason || 'سبب آخر', note);
}
async function finishCancel(phone, rid, customer, data, reason, note = null) {
  const { cancelOrder } = await import('./orderService.js');
  const order = q.get("SELECT * FROM orders WHERE id=?", data.cancelOrderId);
  if (!order) { saveSession(phone, 'idle', {}); return mainMenu(phone, rid); }
  cancelOrder(order.id, reason, { note, actorType: 'customer', actorId: customer.id });
  send(phone, rid, order.id, 'text', `✅ تم إلغاء الطلب ${order.order_no}.\nشكراً لملاحظتك — وصلت لإدارة المطعم 🙏`);
  const session = getSession(phone);
  saveSession(phone, 'idle', { ...session.data, orderId: null, cart: { items: [] } });
  return mainMenu(phone, rid);
}
