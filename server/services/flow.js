import { q } from '../db.js';
import { waSend, waLogIn } from './whatsapp.js';
import { createOrder } from './orderService.js';
import { createPayment, markPaid } from './payments.js';
import { validatePhone, computeTier, TIERS, validNationalId } from '../utils.js';
import { resolveDelivery, ensureDefaultBranch } from './branches.js';
import { notifySupervisor, approveRegistration, rejectRegistration } from './registrations.js';
import { addRecipient, notifySupervisorRecipient, approveRecipient, rejectRecipient, findRecipientByPhone, buildDailyReport } from './reporting.js';
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
// مفتاح الجلسة دائماً بصيغة الوارد من واتساب (أرقام بلا +) حتى لا تتفرّع الجلسات
const sessPhone = (p) => String(p || '').replace(/^\+/, '');
const rls = (h) => (h / 100).toFixed(2);
const PAY_METHOD_AR = { applepay: '🍎 Apple Pay', mada: '💳 مدى', card: '💳 بطاقة', cash: '💵 كاش' };
// نص خطوة الأصناف (بعد اكتمال بيانات المسؤول)
const ITEMS_PROMPT = (pre = '') => `${pre}الحين أرسل *أصنافك* — كل صنف في سطر والسعر بعده:\n\nنفر حاشي كبسة 60\nبيبسي 5\nملوخية 9\n\nوإذا تبي أقسام، اكتب اسم القسم ثم نقطتين:\n\n*مشروبات:*\nبيبسي 5\nماء 2\n\n📷 أو *ارفع صورة واضحة للأصناف* وأنا أقرأها لك وأسجّلها تلقائياً.\n🎙 أو أرسلها *رسالة صوتية* وأنا أفرّغها لك.`;

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
  // 🏪 طلب استلام من النشاط: بلا رسوم توصيل ولا حد أدنى
  const delivery_fee = cart?.pickup ? 0 : (subtotal >= (minOrder || 0) ? 0 : fee);
  return { subtotal, discount, delivery_fee, total: subtotal - discount + delivery_fee };
}
function cartText(rid, cart, branch = null) {
  const t = cartTotals(rid, cart, branch);
  let s = '🛒 *سلتك*\n━━━━━━━━━━━━━━━━\n';
  cart.items.forEach((i, n) => { s += `${n + 1}. ${i.name} ×${i.quantity} — ${rls(i.price * i.quantity)} ر.س\n`; });
  if (cart.offer) s += `🔥 عرض: ${cart.offer.title}\n`;
  if (cart.coupon) s += `🏷 كود: ${cart.coupon}\n`;
  s += '━━━━━━━━━━━━━━━━\n';
  s += `🧾 المجموع: ${rls(t.subtotal)} ر.س\n`;
  if (t.discount) s += `🏷 الخصم: -${rls(t.discount)} ر.س\n`;
  s += `🛵 التوصيل: ${t.delivery_fee ? rls(t.delivery_fee) + ' ر.س' : 'مجاني ✅'}\n`;
  s += `💰 *الإجمالي: ${rls(t.total)} ر.س*`;
  return s;
}
// دليل المطاعم: حسب موقع العميل — يعرض فقط المطاعم التي لها فرع ضمن نطاق التوصيل
function getCustomerLocation(phone) {
  const c = q.get("SELECT id FROM customers WHERE phone=? OR phone=?", phone, validatePhone(phone));
  if (!c) return null;
  return q.get("SELECT * FROM customer_locations WHERE customer_id=? ORDER BY is_default DESC, id DESC LIMIT 1", c.id);
}
function showRestaurants(phone) {
  const loc = getCustomerLocation(phone);
  // لا يوجد موقع محفوظ → اطلب الموقع أولاً بدل عرض كل المطاعم
  if (!loc || loc.lat == null || loc.lng == null) {
    saveSession(phone, 'directory', {});
    send(phone, null, null, 'text', '📍 لتظهر لك *المطاعم القريبة منك* فقط، أرسل موقعك الحالي الآن.\n(في واتساب: زر 📎 ← الموقع)\nأو اضغط الزر 👇');
    return send(phone, null, null, 'buttons', '', { buttons: [{ id: 'send_location', title: '📍 إرسال الموقع' }] });
  }
  const rests = q.all("SELECT r.* FROM restaurants r WHERE r.is_active=1");
  const nearby = [];
  for (const r of rests) {
    const d = resolveDelivery(r.id, loc.lat, loc.lng);
    if (d.ok && d.branch && d.distanceKm <= (d.branch.delivery_radius_km || 15)) {
      nearby.push({ ...r, distKm: Math.round(d.distanceKm * 10) / 10, branchName: d.branch.name, branchCity: d.branch.city || r.city });
    }
  }
  if (!nearby.length) {
    saveSession(phone, 'directory', {});
    send(phone, null, null, 'text', '🚫 لا توجد مطاعم ضمن نطاق التوصيل (15 كم) من موقعك حالياً.\nيمكنك إرسال موقع آخر أو التواصل معنا.');
    return send(phone, null, null, 'buttons', '', { buttons: [{ id: 'send_location', title: '📍 إرسال موقع آخر' }] });
  }
  nearby.sort((a, b) => a.distKm - b.distKm);
  saveSession(phone, 'directory', { restList: nearby.map(r => r.id) });
  let t = `📍 *المطاعم القريبة منك:* (ضمن 15 كم)\n`;
  nearby.slice(0, 10).forEach((r, i) => {
    t += `${i + 1}. ${r.name_ar} — ${r.branchName} (${r.distKm} كم)${r.rating_avg ? ' ⭐' + r.rating_avg : ''}\n`;
  });
  send(phone, null, null, 'text', t);
  const rows = nearby.slice(0, 10).map(r => ({
    id: 'rest:' + r.id,
    title: r.name_ar,
    description: `${r.branchName} · ${r.distKm} كم${r.rating_avg ? ' · ⭐ ' + r.rating_avg : ''}`
  }));
  return send(phone, null, null, 'list', '🏪 *هذي المطاعم القريبة منك:*\nاختر اللي يعجبك وأنا أكمل معك 👇', {
    list: [{ title: '🍽 المطاعم القريبة', rows }]
  });
}
function handleDirectory(phone, p, b, type, lat, lng) {
  // استلام الموقع من العميل (زر إرسال الموقع أو مشاركة موقع)
  if (p === 'send_location' || type === 'location') {
    if (type !== 'location') return send(phone, null, null, 'buttons', 'وصلني موقعك 📍 أو اضغط الزر', { buttons: [{ id: 'send_location', title: '📍 إرسال الموقع' }] });
    const customer = q.get("SELECT * FROM customers WHERE phone=? OR phone=?", phone, validatePhone(phone));
    if (!customer) return showRestaurants(phone);
    saveLocation(customer.id, lat, lng, {}, '');
    send(phone, null, null, 'text', `📍 تم استلام موقعك ✅`);
    return showRestaurants(phone);
  }
  if (p.startsWith('rest:')) return selectRestaurant(phone, Number(p.split(':')[1]));
  // اختيار المطعم برقم
  if (!p && b && /^\d+$/.test(b)) {
    const session = getSession(phone);
    const list = session.data.restList || [];
    const rid = list[parseInt(b, 10) - 1];
    if (rid) return selectRestaurant(phone, rid);
  }
  // دعم كتابة اسم المطعم بدل الضغط
  if (b && b.length > 1) {
    const loc = getCustomerLocation(phone);
    const rests = q.all("SELECT * FROM restaurants WHERE is_active=1");
    const clean = b.replace(/[\-٠-٩0-9\/،,]/g, ' ').replace(/\s+/g, ' ').trim();
    const match = rests.find(r => clean.includes(r.name_ar) || r.name_ar.includes(clean) || (r.name_en && clean.toLowerCase().includes(r.name_en.toLowerCase())));
    if (match) return selectRestaurant(phone, match.id);
  }
  return showRestaurants(phone);
}
function selectRestaurant(phone, rid) {
  const rest = q.get("SELECT * FROM restaurants WHERE id=? AND is_active=1", rid);
  if (!rest) return showRestaurants(phone);
  const session = getSession(phone);
  saveSession(phone, 'idle', { ...session.data, currentRestaurantId: rid });
  // تثبيت المطعم على الجلسة وعلى رسائل الرقم غير المرتبطة بمطعم —
  // حتى تظهر المحادثة كاملة في شاشة محادثات المطعم المختار
  try {
    q.run("UPDATE whatsapp_sessions SET restaurant_id=? WHERE phone=?", rid, phone);
    q.run("UPDATE conversations SET restaurant_id=? WHERE phone=? AND restaurant_id IS NULL", rid, phone);
  } catch (e) {}
  send(phone, rid, null, 'text', `✅ تم اختيار *${rest.name_ar}* 🍽️`);
  return mainMenu(phone, rid);
}

// هل يحتاج ترحيب؟ (مرة كل 6 ساعات)
function needsGreeting(phone) {
  const s = getSession(phone);
  return Date.now() - Number(s.data.greetedAt || 0) >= 6 * 60 * 60 * 1000;
}
// إرسال الترحيب الودّي
function sendGreeting(phone, rid, customer) {
  const s = getSession(phone);
  saveSession(phone, s.state, { ...s.data, greetedAt: Date.now() });
  const lastOrder = q.get("SELECT * FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 1", customer.id);
  const extra = lastOrder ? `\n\n🔁 أو اكتب *نفس طلبي* وأرجّع لك طلبك السابق 😉` : '';
  send(phone, rid, null, 'text', `هلا *${customer.name}* 🌸 كيف حالك؟ عساك طيب؟\n*أمرني* — وش تبي تطلب اليوم؟ 😋${extra}`);
  return true;
}

function mainMenu(phone, rid) {
  const ad = q.get("SELECT a.*, r.name_ar AS rname FROM ads_campaigns a LEFT JOIN restaurants r ON r.id=a.restaurant_id WHERE a.is_active=1 AND a.placement='whatsapp' AND (a.ends_at IS NULL OR a.ends_at>=datetime('now')) ORDER BY a.id DESC LIMIT 1");
  const rest = q.get("SELECT name_ar, logo, cover FROM restaurants WHERE id=?", rid);
  let txt = `هلا بك في *${rest.name_ar}* 🍽️\nأنا واتس هم، أمرني وش تحب تطلب؟ 😋`;
  if (ad) txt += `\n\n📣 *إعلان:* ${ad.title}${ad.rname ? ' — ' + ad.rname : ''}`;
  // حفظ خيارات القائمة للاختيار بالأرقام
  const session = getSession(phone);
  saveSession(phone, 'idle', { ...session.data, mainOptions: ['menu', 'offers', 'cart', 'track', 'loyalty', 'addresses', 'cancel', 'restaurants'] });
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

  // ===== المشرف: اعتماد/رفض طلبات التسجيل من أزرار الإشعار =====
  try {
    const isSupervisor = config.adminPhone && (phone === config.adminPhone || validatePhone(phone) === validatePhone(config.adminPhone));
    if (isSupervisor && p) {
      const m = p.match(/^(biz|cap|rp)_(ok|no):(\d+)$/);
      if (m) {
        const kind = m[1], act = m[2], id = Number(m[3]);
        const r = kind === 'rp'
          ? (act === 'ok' ? await approveRecipient(id) : await rejectRecipient(id))
          : (act === 'ok' ? await approveRegistration(id) : await rejectRegistration(id));
        const who = r?.name ? `: ${r.name}` : '';
        const label = kind === 'rp' ? 'مستلم التقرير' : '';
        return send(phone, rid, null, 'text', r?.error ? `⚠️ ${r.error}` : (act === 'ok' ? `✅ تم الاعتماد${label ? ' ' + label : ''}${who}` : `❌ تم الرفض${who}`));
      }
    }
  } catch (e) { console.error('SUPERVISOR_ACTION_FAIL', e.message); }

  // ===== مدير المطعم / تقرير المبيعات (لأصحاب الأنشطة ومستلمي التقارير) =====
  const bt = String(b || '').trim();
  if (/^تقرير\s+(أمس|امس|البارح)$/.test(bt)) return sendReportNow(phone, rid, true);
  if (/^(تقرير|تقرير اليوم|تقرير مبيعات)$/.test(bt)) return sendReportNow(phone, rid, false);
  if (/^(مدير|مدير المطعم|أضف مدير|اضف مدير|إضافة مدير|اضافة مدير)$/.test(bt)) return startAddManager(phone, rid, session);

  // ===== بدء التسجيل الذاتي (نشاط / كابتن) =====
  if (/^تسجيل\s*(كابتن|مندوب)$/.test(b)) return startCaptainReg(phone, rid, session);
  if (/^تسجيل(\s+(نشاط|مطعم|بقالة|سوبر\s?ماركت|صيدلية|أسرة منتجة|اسر منتجة))?$/.test(b)) return startBusinessReg(phone, rid, session);

  // ترحيب طبيعي للعميل المعروف — وإن كانت رسالته فيها طلب واضح نكمل معالجته
  if (customer.name && state === 'idle' && (b || p) && needsGreeting(phone)) {
    const isClearRequest = !!findItemByName(rid, b) || wantsSameAsBefore(b) ||
      ['menu','القائمة','المنيو','قائمة الطعام'].includes(String(b).toLowerCase());
    sendGreeting(phone, rid, customer);
    if (!isClearRequest) return;
  }

  // أول زيارة: نطلب اسم العميل ثم نعرض له كل المطاعم
  // (نتخطى هذا أثناء تسجيل نشاط/كابتن حتى لا يخطف مسار الاسم جلسة التسجيل)
  const IN_REG_FLOW = ['reg_type', 'reg_name', 'reg_city', 'reg_district', 'reg_postal', 'reg_owner', 'reg_owner_id', 'reg_items', 'reg_prices', 'reg_review', 'reg_subscribe', 'cap_name', 'cap_id', 'cap_city', 'cap_district', 'cap_vehicle', 'cap_deposit', 'cap_deposit_wait', 'rep_name', 'rep_id', 'rep_phone'].includes(state);
  if (!IN_REG_FLOW && !customer.name && state !== 'ask_name') {
    saveSession(phone, 'ask_name', { ...data, pendingState: 'directory' });
    return send(phone, rid, null, 'text', `السلام عليكم ورحمة الله 🌸\nكيف حالك؟ عساك طيب 😊\n\nأنا *واتس هم* — خدمة طلبات المطاعم 🍽️\nأطلب لك من مطاعم كثيرة وأوصله لبابك 🛵\n\nوش *اسمك الكريم*؟`);
  }
  if (!IN_REG_FLOW && state === 'ask_name') {
    if (b.length < 2) return send(phone, rid, null, 'text', 'عطني اسمك الكريم 🌸 عشان أكمل طلبك');
    q.run("UPDATE customers SET name=? WHERE id=?", b.slice(0, 40), customer.id);
    send(phone, rid, null, 'text', `هلا *${b.slice(0, 40)}* 🌸 الله يحييك ويسعدك!\nعساك طيب؟ 🙌\n\n*أمرني* — وش تبي تطلب اليوم؟ 😋`);
    // 📍 الموقع مطلوب: نخزّنه من أول مرة (تسجيل العميل) لعرض أقرب الأنشطة وحساب التوصيل
    const loc = getCustomerLocation(phone);
    if (!loc || loc.lat == null || loc.lng == null) {
      saveSession(phone, 'signup_location', {});
      send(phone, rid, null, 'text', '📍 *خطوة أخيرة يا غالي:* أرسل لنا موقعك الحالي\nعشان نعرض لك *أقرب الأنشطة* لك ونحسب التوصيل بدقة ✅');
      return send(phone, rid, null, 'buttons', 'في واتساب: زر 📎 ← الموقع 👇', { buttons: [{ id: 'send_location', title: '📍 إرسال الموقع' }] });
    }
    return showRestaurants(phone);
  }

  // الأوامر العامة في أي وقت
  const bLower = b.toLowerCase();
  if (!IN_REG_FLOW && (['إلغاء', 'الغاء', 'ألغي', 'الغاء الطلب', 'إلغاء الطلب', 'cancel'].includes(bLower) || p === 'cancel')) {
    return handleCancelRequest(phone, rid, customer, data);
  }
  if (['المطاعم', 'restaurants', 'الدليل'].includes(bLower) || p === 'restaurants') {
    return showRestaurants(phone);
  }
  if (['القائمة', 'قائمة الطعام', 'المنيو', 'menu'].includes(bLower) && !IN_REG_FLOW) {
    return showMenu(phone, rid);
  }
  if (['ابدأ', 'start', 'رجوع', 'الرئيسية'].includes(bLower) && state !== 'idle' && state !== 'directory') {
    saveSession(phone, 'idle', {});
    return mainMenu(phone, rid);
  }

  if (state === 'directory') return handleDirectory(phone, p, b, type, lat, lng);

  switch (state) {
    case 'idle': return handleIdle(phone, rid, customer, p, b);
    case 'reg_type': return handleRegType(phone, rid, session, b, p);
    case 'reg_name': return handleRegName(phone, rid, session, b);
    case 'reg_city': return handleRegCity(phone, rid, session, b);
    case 'reg_district': return handleRegDistrict(phone, rid, session, b);
    case 'reg_postal': return handleRegPostal(phone, rid, session, b);
    case 'reg_owner': return handleRegOwner(phone, rid, session, b);
    case 'reg_owner_id': return handleRegOwnerId(phone, rid, session, b);
    case 'reg_items': return handleRegItems(phone, rid, session, b);
    case 'reg_prices': return handleRegPrices(phone, rid, session, b);
    case 'reg_review': return handleRegReview(phone, rid, session, b, p);
    case 'reg_subscribe': return handleRegSubscribe(phone, rid, session, b, p);
    case 'cap_name': return handleCapName(phone, rid, session, b);
    case 'cap_id': return handleCapId(phone, rid, session, b);
    case 'cap_city': return handleCapCity(phone, rid, session, b);
    case 'cap_district': return handleCapDistrict(phone, rid, session, b);
    case 'cap_vehicle': return handleCapVehicle(phone, rid, session, b, p);
    case 'cap_deposit': return handleCapDeposit(phone, rid, session, b, p);
    case 'cap_deposit_wait': return handleCapDeposit(phone, rid, session, b, p);
    case 'rep_name': return handleRepName(phone, rid, session, b);
    case 'rep_id': return handleRepId(phone, rid, session, b);
    case 'rep_phone': return handleRepPhone(phone, rid, session, b);
    case 'browse_categories': return handleCat(phone, rid, customer, p, b);
    case 'browse_items': return handleItems(phone, rid, customer, p, b);
    case 'item_detail': return handleItemDetail(phone, rid, customer, data, p, b);
    case 'item_qty': return handleItemQty(phone, rid, customer, data, b);
    case 'browse_offers': return handleOffers(phone, rid, customer, data, p);
    case 'cart': return handleCart(phone, rid, customer, data, p, b);
    case 'cart_manage': return handleCartManage(phone, rid, customer, data, p);
    case 'cart_item': return handleCartItem(phone, rid, customer, data, p);
    case 'order_review': return handleOrderReview(phone, rid, customer, data, p, b);
    case 'coupon': return handleCoupon(phone, rid, customer, data, b);
    case 'order_type': return handleOrderType(phone, rid, customer, data, p, b);
    case 'choose_captain': return (p && p.startsWith('bid:')) ? handleBidPick(phone, rid, customer, data, p) : null;
    case 'bidding': return send(phone, rid, data.orderId || null, 'text', '⏳ نجمع لك عروض الكباتن — ثواني وتوصلك العروض لتختار 👌');
    case 'payment_method': return handlePayMethod(phone, rid, customer, data, p);
    case 'awaiting_payment': return handleAwaitPay(phone, rid, customer, data, p);
    case 'address_pick': return handleAddressPick(phone, rid, customer, data, p);
    case 'location_request': return handleLocation(phone, rid, customer, data, type, lat, lng, p);
    case 'signup_location': return handleSignupLocation(phone, rid, customer, data, type, lat, lng, p);
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
  // اختيار برقم القائمة
  const n = parseInt(b, 10);
  if (n >= 1 && n <= 8) {
    const opts = ['menu', 'offers', 'cart', 'track', 'loyalty', 'addresses', 'cancel', 'restaurants'];
    p = opts[n - 1]; b = opts[n - 1];
  }
  const sel = c[p] || c[b.toLowerCase()] || null;
  if (sel === 'menu') return showMenu(phone, rid);
  if (sel === 'offers') return showOffers(phone, rid, customer);
  if (sel === 'cart') return showCart(phone, rid, customer);
  if (sel === 'track') return showTracking(phone, rid, customer);
  if (sel === 'loyalty') return showLoyalty(phone, rid, customer);
  if (sel === 'addresses') return showAddresses(phone, rid, customer);
  if (sel === 'restaurants') return showRestaurants(phone);
  if (sel === 'cancel') return handleCancelRequest(phone, rid, customer, getSession(phone).data);

  // 🍽 طلب مباشر بالاسم (بدون منيو): "أبي 2 كبسة"
  const direct = findItemByName(rid, b);
  if (direct && b.length >= 3) {
    const d2 = addItemToCart(phone, rid, direct.item, direct.qty);
    saveSession(phone, 'cart', d2);
    send(phone, rid, null, 'text', `✅ أبشر! أضفت *${direct.item.name}* ×${direct.qty} 🛒`);
    return showCart(phone, rid, customer);
  }
  // 🔁 "نفس طلبي السابق"
  if (wantsSameAsBefore(b)) {
    const last = q.get("SELECT * FROM orders WHERE customer_id=? AND status NOT IN ('cancelled') ORDER BY id DESC LIMIT 1", customer.id);
    if (last) {
      let items = [];
      try { items = JSON.parse(last.items_json || '[]'); } catch (e) {}
      const priced = items.map(i => { const it = q.get("SELECT * FROM items WHERE id=?", i.item_id); return it ? { item_id: it.id, name: it.name, price: it.price, quantity: i.quantity || 1 } : null; }).filter(Boolean);
      if (priced.length) {
        const session = getSession(phone);
        saveSession(phone, 'cart', { ...session.data, cart: { items: priced } });
        send(phone, rid, null, 'text', `🔁 رجّعت لك نفس طلبك السابق 🛒`);
        return showCart(phone, rid, customer);
      }
    }
  }
  return mainMenu(phone, rid);
}


// ---------- فهم الطلب المباشر (بدون منيو) ----------
function normAr(x) {
  return String(x || '')
    .replace(/[أإآٱ]/g, 'ا').replace(/[ىئ]/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function findItemByName(rid, text) {
  const t = normAr(text);
  if (t.length < 3) return null;
  let qty = 1;
  // أول رقم في الجملة = الكمية (يدعم الأرقام العربية بعد التطبيع)
  const m = t.match(/(?:^|\s)([1-9])(?:\s|$)/);
  if (m) qty = Math.min(9, Math.max(1, parseInt(m[1], 10)));
  const stripped = t.replace(/(?:^|\s)[1-9](?:\s|$)/, ' ').trim();
  if (stripped.length < 3) return null;
  const tWords = stripped.split(' ').filter(w => w.length >= 3);
  const items = q.all("SELECT * FROM items WHERE restaurant_id=? AND is_available=1", rid);
  let best = null, bestScore = 0;
  for (const it of items) {
    const nm = normAr(it.name);
    if (!nm) continue;
    let score = 0;
    if (stripped.includes(nm)) score += 100;                 // الاسم كامل موجود
    const iWords = nm.split(' ').filter(w => w.length >= 3);
    for (const w of iWords) if (tWords.some(tw => tw.includes(w) || w.includes(tw))) score += w.length + 2;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return (best && bestScore >= 5) ? { item: best, qty } : null;
}
function wantsSameAsBefore(text) {
  const t = normAr(text);
  return ['نفس الطلب', 'نفس طلبي', 'طلبي السابق', 'نفس اللي قبل', 'المعتاد', 'نفسه', 'نفس الشي', 'كرر الطلب'].some(k => t.includes(normAr(k)));
}
function addItemToCart(phone, rid, item, qty = 1) {
  const session = getSession(phone);
  const cart = session.data.cart || { items: [] };
  const ex = cart.items.find(i => i.item_id === item.id);
  if (ex) ex.quantity += qty; else cart.items.push({ item_id: item.id, name: item.name, price: item.price, quantity: qty });
  return { ...session.data, cart };
}

// ---------- تصفح الأقسام ----------
function showCategories(phone, rid, customer) {
  const cats = q.all("SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category_id=c.id AND i.is_available=1) AS cnt FROM categories c WHERE c.restaurant_id=? AND c.is_active=1 ORDER BY c.sort_order, c.id", rid);
  const session = getSession(phone);
  saveSession(phone, 'browse_categories', { ...session.data, catList: cats.map(c => c.id) });
  if (!cats.length) return send(phone, rid, null, 'text', 'المعذرة، ما فيه أقسام متاحة الحين 🙏');
  let t = '🍽 اختر القسم (أرسل رقمه):\n';
  cats.forEach((c, i) => { t += `${i + 1}. ${c.icon || ''} ${c.name} — ${c.cnt || 0} صنف\n`; });
  send(phone, rid, null, 'text', t);
  return send(phone, rid, null, 'list', 'اختر القسم اللي يعجبك 👇', { list: [{ title: 'الأقسام', rows: cats.map(c => ({ id: 'cat:' + c.id, title: c.name, description: (c.cnt || 0) + ' صنف' })) }] });
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
  if (idx < 0 || idx >= items.length) { send(phone, rid, null, 'text', 'هذا آخر شي بالقسم ✅'); return showCart(phone, rid, customer); }
  saveSession(phone, 'browse_items', { ...session.data, itemIndex: idx, currentItem: items[idx].id });
  return sendItemCard(phone, rid, idx, items);
}
// قائمة الأصناف بعلامات صح: اضغط على الصنف لتحديده (✓) أو إلغاء تحديده، ثم أرسل الطلب
function showItemsList(phone, rid, cid) {
  const items = q.all("SELECT * FROM items WHERE restaurant_id=? AND category_id=? AND is_available=1 ORDER BY is_popular DESC, sort_order, id", rid, cid);
  const cat = q.get("SELECT name FROM categories WHERE id=?", cid);
  const session = getSession(phone);
  const cart = session.data.cart || { items: [] };
  let num = `📂 *${cat?.name || 'الأصناف'}*\n━━━━━━━━━━━━━━━━\n`;
  items.forEach((i, idx) => {
    const ex = cart.items.find(x => x.item_id === i.id);
    num += `${ex ? '✅' : '▫️'} ${idx + 1}. ${i.name} — ${rls(i.price)} ر.س${ex ? `  (×${ex.quantity})` : ''}\n`;
  });
  num += '━━━━━━━━━━━━━━━━\n✍️ أرسل `2×3` = صنف ٢ عدد ٣ · أو `2` = واحد · `حذف 2` للحذف';
  send(phone, rid, null, 'text', num);
  // الأرقام المعروضة = المنبو المرقّم لهذا القسم (تنطبق على رسائل العميل)
  const map = items.map(i => ({ id: i.id, name: i.name, price: i.price, cat: cat?.name || '' }));
  const rows = items.map(i => {
    const ex = cart.items.find(x => x.item_id === i.id);
    return { id: 'item:' + i.id, title: (ex ? '✅ ' : '') + i.name, description: rls(i.price) + ' ر.س' + (ex ? ' — في السلة ×' + ex.quantity : '') };
  });
  saveSession(phone, 'browse_items', { ...session.data, lastCat: cid, catItems: items.map(i => i.id), menuMap: map, itemIndex: 0, viewAll: false });
  for (let i = 0; i < rows.length; i += 10) {
    send(phone, rid, null, 'list', 'أو اضغط عليه عشان تضيفه:', { list: [{ title: (cat?.name || '').slice(0, 24), rows: rows.slice(i, i + 10) }] });
  }
  return sendItemButtons(phone, rid);
}

// الأزرار الموحدة أسفل المنيو: سلتي · إرسال الطلب · المنيو
function sendItemButtons(phone, rid) {
  return send(phone, rid, null, 'buttons', 'اختر من المنيو أو أرسل طلبك 👇', { buttons: [
    { id: 'cart', title: '🛒 سلتي' },
    { id: 'send_order', title: '✅ إرسال الطلب' },
    { id: 'browse_cats', title: '📂 الأقسام' }
  ] });
}

// ---------- المنيو المرقّم المنظّم (أساس الطلب) ----------
function normalizeDigits(s) {
  return String(s)
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0));
}
function chunkText(t, max = 3000) {
  const out = [];
  let cur = '';
  for (const line of String(t).split('\n')) {
    if (cur && (cur + line).length > max) { out.push(cur.trimEnd()); cur = ''; }
    cur += line + '\n';
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out;
}

// يبني المنيو كامل مرقّم + خريطة الأرقام (أرقام ثابتة ما تتغيّر)
function buildMenu(rid, cart = null) {
  const r = q.get("SELECT * FROM restaurants WHERE id=?", rid);
  const bt = r?.business_type_id ? q.get("SELECT * FROM business_types WHERE id=?", r.business_type_id) : null;
  const cats = q.all("SELECT * FROM categories WHERE restaurant_id=? AND is_active=1 ORDER BY sort_order, id", rid);
  const map = [];
  const inCart = (id) => (cart?.items || []).find(x => x.item_id === id);
  let t = `${bt?.icon || '🍽'} *${r?.name_ar || 'المنيو'}*\n`;
  if (r?.city) t += `📍 ${r.city}\n`;
  t += '━━━━━━━━━━━━━━━━\n';
  for (const c of cats) {
    const items = q.all("SELECT * FROM items WHERE restaurant_id=? AND category_id=? AND is_available=1 ORDER BY is_popular DESC, sort_order, id", rid, c.id);
    if (!items.length) continue;
    t += `\n${c.icon || '▪️'} *${c.name}*\n`;
    for (const i of items) {
      map.push({ id: i.id, name: i.name, price: i.price, cat: c.name });
      const ex = inCart(i.id);
      t += `${ex ? '✅' : '▫️'} ${map.length}. ${i.name} — ${rls(i.price)} ر.س${ex ? `  (×${ex.quantity})` : ''}\n`;
    }
  }
  t += '\n━━━━━━━━━━━━━━━━\n';
  t += '✍️ *طريقة الطلب*\n';
  t += 'أرسل رقم الصنف والكمية مع بعض:\n';
  t += '▪️ `1×2` = صنف ١ عدد ٢\n';
  t += '▪️ `5` = صنف ٥ عدد ١\n';
  t += '▪️ عدة أصناف مرة واحدة: `1×2 4 7×3`\n';
  t += '▪️ للحذف: `حذف 4`\n';
  t += 'سلتك تتراكم، وترسل الطلب كامل مرة واحدة ✅';
  return { text: t, map };
}

// عرض المنيو كامل بترتيب مرقّم
function showMenu(phone, rid) {
  const session = getSession(phone);
  const cart = session.data.cart || { items: [] };
  const { text, map } = buildMenu(rid, cart);
  if (!map.length) return send(phone, rid, null, 'text', 'المعذرة، المنيو فاضي الحين 🙏');
  saveSession(phone, 'browse_items', { ...session.data, menuMap: map, catItems: map.map(m => m.id), viewAll: true, lastCat: null, itemIndex: 0 });
  for (const part of chunkText(text, 3000)) send(phone, rid, null, 'text', part);
  return sendItemButtons(phone, rid);
}
function showAllItems(phone, rid) { return showMenu(phone, rid); }

// خريطة الأرقام: آخر منيو معروض، وإلا المنيو كامل
function menuFor(data, rid) {
  if (data?.menuMap?.length) return data.menuMap;
  if (data?.catItems?.length) {
    const items = data.catItems.map(id => q.get("SELECT * FROM items WHERE id=?", id)).filter(Boolean);
    if (items.length) return items.map(i => ({ id: i.id, name: i.name, price: i.price }));
  }
  return buildMenu(rid).map;
}

// إدخال الطلب بالأرقام والكميات: `1×2` · `5` · `1×2 4 7×3` · `حذف 4`
function applyOrderEntry(phone, rid, data, b) {
  const raw = normalizeDigits(String(b || '')).replace(/[،,؛;+]+/g, ' ').trim();
  if (!raw || !/\d/.test(raw)) return null;
  const menu = menuFor(data, rid);
  if (!menu.length) return null;
  const isDel = /^(حذف|احذف|أحذف|شيل|امسح|إلغاء|الغاء|remove|del)(?=\s|$)/.test(raw);
  const body = raw.replace(/^(حذف|احذف|أحذف|شيل|امسح|إلغاء|الغاء|remove|del)\s*/, '');
  const session = getSession(phone);
  const cart = session.data.cart || { items: [] };
  let changed = 0;
  const notes = [];
  for (const tk of body.split(/\s+/).filter(Boolean)) {
    const m = tk.match(/^(\d{1,3})(?:[×x*:=\-]|عدد)?(\d{1,3})?$/i);
    if (!m) continue;
    const item = menu[parseInt(m[1], 10) - 1];
    if (!item) continue;
    const explicit = m[2] !== undefined;
    const qty = isDel ? 0 : (explicit ? parseInt(m[2], 10) : 1);
    const ex = cart.items.find(i => i.item_id === item.id);
    if (qty <= 0) {
      if (!ex) continue;
      cart.items = cart.items.filter(i => i.item_id !== item.id);
      notes.push(`🗑 ${item.name}`); changed++;
      continue;
    }
    if (ex) { ex.quantity = explicit ? qty : ex.quantity + qty; notes.push(`✅ ${item.name} ×${ex.quantity}`); }
    else { cart.items.push({ item_id: item.id, name: item.name, price: item.price, quantity: qty }); notes.push(`✅ ${item.name} ×${qty}`); }
    changed++;
  }
  if (!changed) return null;
  cart.offer = cart.offer || null;
  saveSession(phone, 'cart', { ...session.data, cart });
  send(phone, rid, null, 'text', notes.join('\n'));
  return showCart(phone, rid, null);
}
// اختيار متعدد بالأرقام — ولو الصنف مضاف مسبقاً تزيد كميته
function selectByNumbers(phone, rid, data, b) {
  const nums = b.split(/[\s،,]+/).map(n => parseInt(n, 10)).filter(n => !isNaN(n) && n >= 1);
  if (!nums.length) return null;
  const items = (data.catItems || []).map(id => q.get("SELECT * FROM items WHERE id=?", id)).filter(Boolean);
  const session = getSession(phone);
  const cart = session.data.cart || { items: [] };
  let added = 0, last = null;
  for (const n of nums) {
    const item = items[n - 1];
    if (!item) continue;
    const ex = cart.items.find(i => i.item_id === item.id);
    if (ex) ex.quantity += 1;
    else cart.items.push({ item_id: item.id, name: item.name, price: item.price, quantity: 1 });
    added++; last = item;
  }
  if (!added) return null;
  saveSession(phone, 'browse_items', { ...session.data, cart });
  send(phone, rid, null, 'text', `✅ تم تحديث *${last?.name}* — تابع التحديد أو اضغط "أرسل الطلب"`);
  return session.data.viewAll ? showAllItems(phone, rid) : showItemsList(phone, rid, session.data.lastCat);
}
// تحديد صنف — كل ضغطة تزيد الكمية وتعرض السلة
function toggleItem(phone, rid, itemId) {
  const session = getSession(phone);
  const cart = session.data.cart || { items: [] };
  const item = q.get("SELECT * FROM items WHERE id=?", itemId);
  if (!item) return sendItemButtons(phone, rid);
  const ex = cart.items.find(i => i.item_id === itemId);
  if (ex) ex.quantity += 1; else cart.items.push({ item_id: item.id, name: item.name, price: item.price, quantity: 1 });
  cart.offer = cart.offer || null;
  saveSession(phone, 'cart', { ...session.data, cart });
  send(phone, rid, null, 'text', `✅ *${item.name}* — الكمية الآن ×${(cart.items.find(i => i.item_id === itemId) || {}).quantity}`);
  return showCart(phone, rid, null);
}
function handleCat(phone, rid, customer, p, b) {
  // اختيار القسم برقم
  if (!p && b && /^\d+$/.test(b)) {
    const session = getSession(phone);
    const list = session.data.catList || [];
    const cid = list[parseInt(b, 10) - 1];
    if (cid) p = 'cat:' + cid;
  }
  if (p.startsWith('cat:')) {
    const cid = Number(p.split(':')[1]);
    const items = q.all("SELECT * FROM items WHERE restaurant_id=? AND category_id=? AND is_available=1 ORDER BY is_popular DESC, sort_order, id", rid, cid);
    if (!items.length) return send(phone, rid, null, 'text', 'المعذرة، ما فيه أصناف بهذا القسم الحين 🙏');
    return showItemsList(phone, rid, cid);
  }
  if (p.startsWith('item:')) return itemDetail(phone, rid, customer, p);
  return showCategories(phone, rid, customer);
}
function handleItems(phone, rid, customer, p, b) {
  const session = getSession(phone);
  const data = session.data;
  if (p.startsWith('item:')) return toggleItem(phone, rid, Number(p.split(':')[1]));
  if (p === 'send_order') return sendOrderReview(phone, rid, customer);
  if (p === 'cart') return showCart(phone, rid, customer);
  if (p === 'menu' || p === 'browse_all') return showMenu(phone, rid);
  if (p === 'browse_cats' || p === 'cats') return showCategories(phone, rid, customer);
  if (p.startsWith('cat:')) return showItemsList(phone, rid, Number(p.split(':')[1]));
  if (p === 'add1' || p === 'qty') return handleItemDetail(phone, rid, customer, data, p, '');
  // رجوع للأقسام بشكل صريح
  if (/^(اقسام|أقسام|القسم|رجوع)$/i.test(String(b || '').trim())) return showCategories(phone, rid, customer);
  // الطلب بالأرقام والكميات (1×2 ...) — السلة تتراكم
  const byNums = applyOrderEntry(phone, rid, data, b);
  if (byNums) return byNums;
  return sendItemButtons(phone, rid);
}

function itemDetail(phone, rid, customer, p) {
  const id = Number(p.split(':')[1]);
  const item = q.get("SELECT * FROM items WHERE id=? AND restaurant_id=?", id, rid);
  if (!item) return send(phone, rid, null, 'text', 'المعذرة، هذا الصنف خلص 🙏');
  let txt = `*${item.name}*\n${item.description ? item.description + '\n' : ''}💰 ${rls(item.price)} ر.س\n⏱ جاهز خلال ${item.prep_time_min || 15} دقيقة`;
  const session = getSession(phone);
  saveSession(phone, 'item_detail', { ...session.data, currentItem: item.id });
  if (item.image) send(phone, rid, null, 'image', txt, { image: item.image });
  else send(phone, rid, null, 'text', txt);
  return send(phone, rid, null, 'buttons', 'وش تحب أسوي لك؟', { buttons: [
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
  if (!n || n < 1 || n > 50) return send(phone, rid, null, 'text', 'اكتب رقم صحيح من 1 إلى 50 🙏');
  return addToCart(phone, rid, customer, item, n);
}
function addToCart(phone, rid, customer, item, qty) {
  const session = getSession(phone);
  const cart = session.data.cart || { items: [] };
  const ex = cart.items.find(i => i.item_id === item.id);
  if (ex) ex.quantity += qty; else cart.items.push({ item_id: item.id, name: item.name, price: item.price, quantity: qty });
  cart.offer = cart.offer || null;
  const totalQty = cart.items.reduce((s, i) => s + i.quantity, 0);
  saveSession(phone, 'browse_items', { ...session.data, cart });
  // تأكيد سريع فقط — السلة الكاملة تُرسل عند الضغط على 🛒 السلة أو إتمام الطلب
  send(phone, rid, null, 'text', `✅ أُضيف *${item.name}* ×${qty} — الإجمالي ${totalQty} صنف.\nتابع الإضافة أو اضغط 🛒 السلة عند الانتهاء.`);
  if (session.data.catItems) return browseItemAt(phone, rid, customer, session.data.itemIndex || 0);
  return send(phone, rid, null, 'buttons', '', { buttons: [{ id: 'cart', title: '🛒 السلة' }, { id: 'menu', title: '⬅️ القائمة' }] });
}
function showCart(phone, rid, customer) {
  const session = getSession(phone);
  const cart = session.data.cart;
  if (!cart || !cart.items.length) {
    send(phone, rid, null, 'text', 'سلتك فاضية 🛒\nاختر من المنيو وخلنا نبدأ 😋');
    return showCategories(phone, rid, customer);
  }
  saveSession(phone, 'cart', session.data);
  send(phone, rid, null, 'text', cartText(rid, cart));
  return send(phone, rid, null, 'buttons', 'نكمل أو نرسل الطلب؟ 👇', { buttons: [
    { id: 'checkout', title: '✅ إرسال الطلب' }, { id: 'menu', title: '📂 المنيو' }, { id: 'manage', title: '🔢 تعديل الكميات' }
  ] });
}
// تعديل السلة: قائمة الأصناف لتعديل كل واحد
function showCartManage(phone, rid, customer) {
  const session = getSession(phone);
  const cart = session.data.cart;
  if (!cart || !cart.items.length) return showCart(phone, rid, customer);
  saveSession(phone, 'cart_manage', session.data);
  send(phone, rid, null, 'text', '🔢 *تعديل السلة:*\nاضغط على الصنف لتغيير كميته أو حذفه:');
  const rows = cart.items.map(i => ({ id: 'cm:' + i.item_id, title: i.name, description: '×' + i.quantity + ' — ' + rls(i.price * i.quantity) + ' ر.س' }));
  return send(phone, rid, null, 'list', 'أصناف السلة:', { list: [{ title: '🛒 السلة', rows }] });
}
function handleCartManage(phone, rid, customer, data, p) {
  if (p.startsWith('cm:')) {
    const itemId = Number(p.split(':')[1]);
    const item = q.get("SELECT * FROM items WHERE id=?", itemId);
    saveSession(phone, 'cart_item', { ...data, manageItemId: itemId });
    send(phone, rid, null, 'text', `🔢 *${item?.name}* — الكمية الحالية: ${(data.cart?.items || []).find(i => i.item_id === itemId)?.quantity || 0}`);
    return send(phone, rid, null, 'buttons', '', { buttons: [
      { id: 'mi_inc', title: '➕ زيادة 1' }, { id: 'mi_dec', title: '➖ نقصان 1' }, { id: 'mi_del', title: '🗑 حذف' }
    ] });
  }
  return showCartManage(phone, rid, customer);
}
function handleCartItem(phone, rid, customer, data, p) {
  const itemId = data.manageItemId;
  const session = getSession(phone);
  const cart = session.data.cart || { items: [] };
  const ex = cart.items.find(i => i.item_id === itemId);
  if (p === 'mi_inc' && ex) ex.quantity += 1;
  if (p === 'mi_dec' && ex) { ex.quantity -= 1; if (ex.quantity <= 0) cart.items = cart.items.filter(i => i.item_id !== itemId); }
  if (p === 'mi_del') cart.items = cart.items.filter(i => i.item_id !== itemId);
  saveSession(phone, 'cart', { ...session.data, cart });
  send(phone, rid, null, 'text', '🛒 تم التعديل:');
  return showCart(phone, rid, customer);
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
  return send(phone, rid, null, 'buttons', 'نأكد الطلب وننزل للدفع؟', { buttons: [
    { id: 'confirm', title: '✅ تأكيد والدفع' }, { id: 'coupon', title: '🏷 كود خصم' }, { id: 'menu', title: '⬅️ تعديل السلة' }
  ] });
}
function handleOrderReview(phone, rid, customer, data, p, b) {
  if (p === 'confirm') return chooseOrderType(phone, rid, customer);
  if (p === 'coupon') { saveSession(phone, 'coupon', data); return send(phone, rid, null, 'text', 'وصلني كود الخصم 🏷'); }
  if (p === 'menu') return showCart(phone, rid, customer);
  return sendOrderReview(phone, rid, customer);
}
function handleCart(phone, rid, customer, data, p, b) {
  if (p === 'checkout' || p === 'send_order') return sendOrderReview(phone, rid, customer);
  if (p === 'manage') return showCartManage(phone, rid, customer);
  if (p === 'coupon') { saveSession(phone, 'coupon', data); return send(phone, rid, null, 'text', 'وصلني كود الخصم 🏷'); }
  if (p === 'clear') {
    const d = { ...data }; d.cart = { items: [] }; delete d.cart.offer;
    saveSession(phone, 'idle', d);
    return mainMenu(phone, rid);
  }
  if (p === 'menu' || p === 'browse_all') return showMenu(phone, rid);
  if (p === 'browse_cats' || p === 'cats') return showCategories(phone, rid, customer);
  // لمس صنف من قائمة قديمة يزيد كميته حتى ونحن في السلة
  if (p.startsWith('item:')) return toggleItem(phone, rid, Number(p.split(':')[1]));
  // تعديل الطلب بالأرقام مباشرة من السلة: 1×3 أو حذف 2
  const byNums = applyOrderEntry(phone, rid, data, b);
  if (byNums) return byNums;
  return showCart(phone, rid, customer);
}
function handleCoupon(phone, rid, customer, data, b) {
  const cp = q.get("SELECT * FROM coupons WHERE code=? AND is_active=1 AND (expires_at IS NULL OR expires_at >= datetime('now'))", b.trim());
  if (!cp) { send(phone, rid, null, 'text', 'هذا الكود ما يشتغل 🙈 جرّب كود ثاني'); return showCart(phone, rid, customer); }
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
  if (!offers.length) { send(phone, rid, null, 'text', 'ما فيه عروض الحين 🙏'); return mainMenu(phone, rid); }
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
    return send(phone, rid, null, 'buttons', 'نطبق العرض؟', { buttons: [{ id: 'apply_offer', title: '🔥 أضف العرض' }, { id: 'menu', title: '⬅️ القائمة' }] });
  }
  if (p === 'apply_offer') {
    const o = data.currentOffer;
    const session = getSession(phone);
    const cart = session.data.cart || { items: [] };
    if (!cart.items.length) { send(phone, rid, null, 'text', 'اختر أصنافك أول 🛒 وبعدها نطبق العرض'); return showCategories(phone, rid, customer); }
    cart.offer = { id: o.id, title: o.title, type: o.type, value: o.value, min_order: o.min_order };
    saveSession(phone, 'cart', { ...session.data, cart });
    send(phone, rid, null, 'text', `🔥 تم إضافة العرض *${o.title}* لطلبك!`);
    return showCart(phone, rid, customer);
  }
  return showOffers(phone, rid, customer);
}

// ---------- الدفع ----------
// ---------- الدفع ----------
// 🛵 توصيل أم 🏪 استلام من النشاط
function chooseOrderType(phone, rid, customer) {
  const session = getSession(phone);
  saveSession(phone, 'order_type', session.data);
  return send(phone, rid, null, 'buttons', 'كيف تحب تستلم طلبك؟', { buttons: [
    { id: 'otype:delivery', title: '🛵 توصيل لي' },
    { id: 'otype:pickup', title: '🏪 استلام من النشاط' }
  ] });
}
function handleOrderType(phone, rid, customer, data, p, b) {
  const session = getSession(phone);
  const cart = session.data.cart;
  if (!cart || !cart.items.length) return showCart(phone, rid, customer);
  let kind = p && p.startsWith('otype:') ? p.slice(6) : null;
  if (!kind && /^(توصيل|دليفري)$/.test(String(b).trim())) kind = 'delivery';
  if (!kind && /^(استلام|استلم|أستلم|من الفرع|من المطعم)$/.test(String(b).trim())) kind = 'pickup';
  if (!['delivery', 'pickup'].includes(kind)) return chooseOrderType(phone, rid, customer);
  cart.pickup = kind === 'pickup';
  const next = { ...session.data, cart, orderType: kind };
  saveSession(phone, 'payment_method', next);
  const rName = q.get("SELECT name_ar FROM restaurants WHERE id=?", rid)?.name_ar || 'النشاط';
  if (kind === 'pickup') {
    send(phone, rid, null, 'text', `🏪 تمام — *استلام من ${rName}*\nبلا رسوم توصيل ✅`);
    return choosePayment(phone, rid, customer);
  }
  // 🛵 توصيل: نأخذ العنوان أولاً ثم نعرض الطلب على الكباتن لتحديد سعر التوصيل
  send(phone, rid, null, 'text', `🛵 تمام — *توصيل*\nالحين نحدد موقع التوصيل، وبعدها نعرض طلبك على الكباتن ليحددوا سعر التوصيل وتختار الأنسب 👌`);
  saveSession(phone, 'payment_method', next);
  return askLocation(phone, rid, customer, next);
}
function choosePayment(phone, rid, customer) {
  const session = getSession(phone);
  saveSession(phone, 'payment_method', session.data);
  send(phone, rid, null, 'buttons', '💰 كيف تحب تدفع؟', { buttons: [
    { id: 'pay:applepay', title: '🍎 Apple Pay' }, { id: 'pay:mada', title: '💳 مدى' }, { id: 'pay:card', title: '💳 بطاقة' }
  ] });
  return send(phone, rid, null, 'buttons', 'أو تدفع كاش عند الاستلام:', { buttons: [{ id: 'pay:cash', title: '💵 كاش عند الاستلام' }] });
}
async function handlePayMethod(phone, rid, customer, data, p) {
  const method = p.replace('pay:', '');
  if (!['applepay', 'mada', 'card', 'cash'].includes(method)) return choosePayment(phone, rid, customer);
  if (data.payForOrderId) return payForExistingOrder(phone, rid, customer, data, method);
  // 🧪 وضع تجريبي: الدفع الإلكتروني يُحتسب مدفوعاً فوراً
  if (method !== 'cash' && config.paymentMode === 'mock') {
    const cart = getSession(phone).data.cart;
    if (!cart || !cart.items.length) return showCart(phone, rid, customer);
    const totals = cartTotals(rid, cart);
    const { mockPayNow } = await import('./payments.js');
    mockPayNow(totals.total, method, { phone, restaurant_id: rid });
    send(phone, rid, null, 'text', `🧪 *وضع تجريبي:* تم الدفع وهمياً ✅ (${PAY_METHOD_AR[method] || method}) — المبلغ ${rls(totals.total)} ر.س`);
    const d = { ...getSession(phone).data, paymentMethod: method, paid: true };
    if (cart.pickup) return placeOrder(phone, rid, customer, { ...d, orderType: 'pickup', address: pickupAddress(rid), estDeliveryMin: 20 });
    return askLocation(phone, rid, customer, d);
  }
  const session = getSession(phone);
  const cart = session.data.cart;
  if (!cart || !cart.items.length) return showCart(phone, rid, customer);
  const totals = cartTotals(rid, cart);
  if (method === 'cash') {
    const d = { ...session.data, paymentMethod: 'cash', paid: false };
    if (cart.pickup) return placeOrder(phone, rid, customer, { ...d, orderType: 'pickup', address: pickupAddress(rid), estDeliveryMin: 20 });
    return askLocation(phone, rid, customer, d);
  }
  const rest = q.get("SELECT name_ar FROM restaurants WHERE id=?", rid);
  const pay = await createPayment({ total: totals.total, order_no: 'طلب جديد', restaurant_name: rest.name_ar }, method, { phone, restaurant_id: rid });
  saveSession(phone, 'awaiting_payment', { ...session.data, paymentMethod: method, paymentId: pay.payment_id || null, paymentUrl: pay.payment_url || null });
  send(phone, rid, null, 'text', `💰 المطلوب: *${rls(totals.total)} ر.س*\nاضغط الرابط وادفع بأمان (Apple Pay / مدى):`);
  send(phone, rid, null, 'text', pay.payment_url || 'https://sandbox.moyasar.com/pay (رابط تجريبي)');
  return send(phone, rid, null, 'buttons', 'إذا خلصت الدفع اضغط هنا 👇', { buttons: [{ id: 'paid', title: '✅ تم الدفع' }, { id: 'cancel', title: '❌ إلغاء' }] });
}
// دفع طلب مبني مسبقاً (بعد اختيار كابتن المزاد) ثم تحويله للكابتن
async function payForExistingOrder(phone, rid, customer, data, method) {
  const order = q.get("SELECT * FROM orders WHERE id=?", data.payForOrderId);
  if (!order) return send(phone, rid, null, 'text', 'ما لقيت الطلب 🙏');
  const cap = q.get("SELECT * FROM captains WHERE id=?", data.captainId || order.chosen_captain_id);
  const { restaurantTransfer } = await import('./dispatch.js');
  if (method === 'cash') {
    q.run("UPDATE orders SET payment_method='cash', payment_status='pending', updated_at=datetime('now') WHERE id=?", order.id);
    saveSession(phone, 'tracking', { ...data, orderId: order.id });
    restaurantTransfer(order.id, cap.id);
    send(phone, rid, order.id, 'text', `💵 تمام — *كاش ${rls(order.total)} ر.س* عند التسليم للكابتن.`);
    return send(phone, rid, order.id, 'buttons', 'بخليك على علم بكل مرحلة 👇', { buttons: [{ id: 'track', title: '📦 حالة الطلب' }, { id: 'menu', title: '⬅️ القائمة الرئيسية' }] });
  }
  // 🧪 وضع تجريبي: ننجح الدفع فوراً ونحوّل الطلب للكابتن
  if (config.paymentMode === 'mock') {
    const { mockPayNow } = await import('./payments.js');
    mockPayNow(order.total, method, { phone, restaurant_id: order.restaurant_id, order_id: order.id });
    q.run("UPDATE orders SET payment_method=?, payment_status='paid', updated_at=datetime('now') WHERE id=?", method, order.id);
    send(phone, rid, order.id, 'text', `🧪 *وضع تجريبي:* تم الدفع وهمياً ✅ (${PAY_METHOD_AR[method] || method}) — ${rls(order.total)} ر.س`);
    restaurantTransfer(order.id, cap.id);
    saveSession(phone, 'tracking', { ...data, orderId: order.id });
    return send(phone, rid, order.id, 'buttons', '🛵 حوّلنا طلبك للكابتن — بخليك على علم بكل مرحلة 👇', { buttons: [{ id: 'track', title: '📦 حالة الطلب' }, { id: 'menu', title: '⬅️ القائمة الرئيسية' }] });
  }
  const rest = q.get("SELECT name_ar FROM restaurants WHERE id=?", order.restaurant_id);
  const pay = await createPayment({ total: order.total, order_no: order.order_no, restaurant_name: rest?.name_ar || '' }, method, { phone, restaurant_id: order.restaurant_id });
  q.run("UPDATE orders SET payment_method=?, updated_at=datetime('now') WHERE id=?", method, order.id);
  saveSession(phone, 'awaiting_payment', { ...data, paymentId: pay.payment_id || null, paymentUrl: pay.payment_url || null });
  send(phone, rid, order.id, 'text', `💰 *المطلوب: ${rls(order.total)} ر.س*\n(منها ${rls(order.delivery_fee)} ر.س توصيل — الكابتن ${cap?.name || ''})\n\nاضغط الرابط وادفع بأمان (Apple Pay / مدى):`);
  send(phone, rid, order.id, 'text', pay.payment_url || 'https://sandbox.moyasar.com/pay (رابط تجريبي)');
  return send(phone, rid, order.id, 'buttons', 'أول ما تخلص الدفع اضغط هنا 👇', { buttons: [{ id: 'paid', title: '✅ تم الدفع' }, { id: 'cancel', title: '❌ إلغاء' }] });
}

async function handleAwaitPay(phone, rid, customer, data, p) {
  if (p === 'cancel') { saveSession(phone, 'idle', {}); return mainMenu(phone, rid); }
  if (p === 'paid' || p === 'yes') {
    const row = data.paymentId ? q.get("SELECT * FROM payments WHERE id=?", data.paymentId) : null;
    if (!row) return send(phone, rid, null, 'text', 'ما لقيت عملية الدفع 🙏 جرّب مرة ثانية');
    if (row.status !== 'paid') {
      if (config.paymentMode === 'mock') {
        const r = markPaid(row.id);
        if (r.status !== 'paid') return send(phone, rid, null, 'text', 'لم يتم تأكيد الدفع بعد ⏳ انتظر لحظات ثم اضغط ✅ تم الدفع.');
      } else {
        return send(phone, rid, null, 'text', 'لم يتم تأكيد الدفع بعد ⏳ انتظر لحظات ثم اضغط ✅ تم الدفع.');
      }
    }
    send(phone, rid, null, 'text', '✅ تم الدفع بنجاح، يعطيك العافية 🌸');
    // 🚕 دفع طلب المزاد → تحويل الطلب للكابتن المختار
    if (data.payForOrderId) {
      const ord = q.get("SELECT * FROM orders WHERE id=?", data.payForOrderId);
      if (ord) {
        q.run("UPDATE orders SET payment_status='paid', updated_at=datetime('now') WHERE id=?", ord.id);
        try {
          const { restaurantTransfer } = await import('./dispatch.js');
          restaurantTransfer(ord.id, data.captainId || ord.chosen_captain_id);
        } catch (e) { console.error('BID_TRANSFER_FAIL', e.message); }
        saveSession(phone, 'tracking', { ...data, orderId: ord.id });
        return send(phone, rid, ord.id, 'buttons', '🛵 حوّلنا طلبك للكابتن — بخليك على علم بكل مرحلة 👇', { buttons: [{ id: 'track', title: '📦 حالة الطلب' }, { id: 'menu', title: '⬅️ القائمة الرئيسية' }] });
      }
    }
    // 🏪 استلام من النشاط: ما نحتاج عنوان
    const cartNow = getSession(phone).data.cart || {};
    if (cartNow.pickup) return placeOrder(phone, rid, customer, { ...data, orderType: 'pickup', address: pickupAddress(rid), paid: true, estDeliveryMin: 20 });
    // 🚀 الطلب المبسّط: العنوان محفوظ؟ → ينشئ الطلب فوراً
    if (config.quickOrder && quickPlaceAfterPayment(phone, rid, customer, { ...data, paid: true })) return;
    return askLocation(phone, rid, customer, { ...data, paid: true });
  }
  return send(phone, rid, null, 'buttons', 'أرسل ✅ تم الدفع بعد إتمام العملية', { buttons: [{ id: 'paid', title: '✅ تم الدفع' }] });
}


// ---------- طلب مبسّط: إنشاء الطلب فوراً من العنوان المحفوظ (بعد الدفع) ----------
function quickPlaceAfterPayment(phone, rid, customer, data) {
  try {
    const loc = q.get("SELECT * FROM customer_locations WHERE customer_id=? ORDER BY is_default DESC, id DESC LIMIT 1", customer.id);
    if (!loc || loc.lat == null || loc.lng == null) return false;
    const delivery = resolveDelivery(rid, loc.lat, loc.lng);
    const address = { label: loc.label || 'المنزل', national_address: loc.national_address || (loc.lat + ',' + loc.lng), lat: loc.lat, lng: loc.lng, branch: delivery.branch || null };
    placeOrder(phone, rid, customer, { ...data, address, estDeliveryMin: data.estDeliveryMin || 30, paid: true });
    return true;
  } catch (e) { console.error('QUICK_ORDER_FAIL', e.message); return false; }
}

// ---------- الموقع والعنوان ----------
function askLocation(phone, rid, customer, data = {}) {
  // إذا عنده عنوان محفوظ مسبقاً → اسأله: نفس الموقع أم جديد؟
  const saved = q.get("SELECT * FROM customer_locations WHERE customer_id=? AND lat IS NOT NULL ORDER BY is_default DESC, id DESC LIMIT 1", customer.id);
  if (saved && !data.forceNewLocation) {
    saveSession(phone, 'address_pick', { ...data, savedLocId: saved.id });
    send(phone, rid, null, 'text', `📍 هل نوصّل طلبك على *نفس الموقع السابق*؟\n${saved.label || 'المنزل'}: ${saved.national_address || (saved.lat + ',' + saved.lng)}`);
    return send(phone, rid, null, 'buttons', 'اختر 👇', { buttons: [
      { id: 'same_loc', title: '✅ نفس الموقع السابق' },
      { id: 'new_loc', title: '🆕 موقع جديد' }
    ] });
  }
  saveSession(phone, 'location_request', { ...data, forceNewLocation: false });
  send(phone, rid, null, 'text', '📍 وصلني موقعك الحين وأوصل طلبك 🛵\n(من واتساب: زر 📎 ثم الموقع)\nوأحفظه لك لطلباتك الجاية 😊');
  return send(phone, rid, null, 'buttons', 'أو اضغط هنا:', { buttons: [{ id: 'send_location', title: '📍 إرسال الموقع' }] });
}

// اختيار: نفس الموقع السابق أم موقع جديد
function handleAddressPick(phone, rid, customer, data, p) {
  if (p === 'new_loc') return askLocation(phone, rid, customer, { ...data, forceNewLocation: true });
  if (p === 'same_loc' || p === 'send_location' || !p) {
    const loc = data.savedLocId ? q.get("SELECT * FROM customer_locations WHERE id=?", data.savedLocId)
                                : q.get("SELECT * FROM customer_locations WHERE customer_id=? ORDER BY is_default DESC, id DESC LIMIT 1", customer.id);
    if (!loc || loc.lat == null) return askLocation(phone, rid, customer, { ...data, forceNewLocation: true });
    const delivery = resolveDelivery(rid, loc.lat, loc.lng);
    if (!delivery.ok || delivery.reason === 'out_of_range') {
      send(phone, rid, null, 'text', `🚫 نعتذر، عنوانك السابق *خارج نطاق التوصيل* حالياً (${Math.round(delivery.distanceKm || 0)} كم من أقرب فرع).\nأقرب فرع: *${delivery.branch?.name || ''}*`);
      return askLocation(phone, rid, customer, { ...data, forceNewLocation: true });
    }
    const address = { label: loc.label || 'المنزل', national_address: loc.national_address || (loc.lat + ',' + loc.lng), lat: loc.lat, lng: loc.lng, branch: delivery.branch || null };
    saveSession(phone, 'delivery_time', { ...data, address, newLoc: null });
    send(phone, rid, null, 'text', `📍 تمام — التوصيل على: ${address.label}\n🏪 الفرع: *${delivery.branch?.name || ''}* (${Math.round(delivery.distanceKm)} كم)`);
    return askTime(phone, rid);
  }
  return askLocation(phone, rid, customer, data);
}
function handleLocation(phone, rid, customer, data, type, lat, lng, p) {
  if (type !== 'location' && p !== 'send_location') return send(phone, rid, null, 'buttons', 'وصلني موقعك 📍 أو اضغط الزر', { buttons: [{ id: 'send_location', title: '📍 إرسال الموقع' }] });
  const delivery = resolveDelivery(rid, lat, lng);
  if (!delivery.ok || delivery.reason === 'out_of_range') {
    send(phone, rid, null, 'text', `🚫 المعذرة يا طويل العمر، موقعك *خارج نطاق التوصيل* الحين (${Math.round(delivery.distanceKm)} كم من أقرب فرع).\nأقرب فرع لك: *${delivery.branch?.name || ''}* — ${delivery.branch?.address || ''}\n\nوصلني موقع ثاني وأبشر 😊`);
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
    send(phone, rid, null, 'text', '📍 وصلني الموقع الجديد اللي تحب نوصل له.');
    return send(phone, rid, null, 'buttons', '', { buttons: [{ id: 'send_location', title: '📍 إرسال الموقع' }] });
  }
  send(phone, rid, null, 'text', '📍 نفس العنوان السابق ولا مكان ثاني؟');
  return send(phone, rid, null, 'buttons', '', { buttons: [{ id: 'addr_yes', title: '✅ نفس العنوان' }, { id: 'addr_new', title: '🆕 مكان آخر' }] });
}
// 📍 حفظ موقع العميل عند التسجيل (أول مرة) ثم عرض أقرب الأنشطة
function handleSignupLocation(phone, rid, customer, data, type, lat, lng, p) {
  if (type !== 'location' && p !== 'send_location') return send(phone, rid, null, 'buttons', 'وصلني موقعك 📍 أو اضغط الزر', { buttons: [{ id: 'send_location', title: '📍 إرسال الموقع' }] });
  const delivery = resolveDelivery(rid, lat, lng);
  if (!delivery.ok || delivery.reason === 'out_of_range') {
    send(phone, rid, null, 'text', `🚫 موقعك *خارج نطاق التوصيل* الحين (${Math.round(delivery.distanceKm)} كم من أقرب فرع).\nأقرب فرع: *${delivery.branch?.name || ''}* — ${delivery.branch?.address || ''}\n\nخذ فكرة عن الأنشطة، وأي طلب داخل النطاق يوصلك 😊`);
    saveSession(phone, 'directory', {});
    return showRestaurants(phone);
  }
  const saved = saveLocation(customer.id, lat, lng, data, p, delivery.branch);
  send(phone, rid, null, 'text', `✅ حفظت موقعك: ${saved.label}\n${saved.national_address || (lat + ',' + lng)}\n🏪 الفرع المسؤول عن توصيلك: *${delivery.branch.name}* (${Math.round(delivery.distanceKm)} كم)`);
  saveSession(phone, 'directory', {});
  return showRestaurants(phone);
}

function handleNewLocation(phone, rid, customer, data, type, lat, lng, p) {
  if (type !== 'location' && p !== 'send_location') return send(phone, rid, null, 'buttons', 'وصلني الموقع الجديد 📍', { buttons: [{ id: 'send_location', title: '📍 إرسال الموقع' }] });
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
  send(phone, rid, null, 'text', '🕐 متى تحب يوصل طلبك؟');
  return send(phone, rid, null, 'buttons', '', { buttons: [
    { id: 'time:30', title: '⚡ أسرع وقت (~30 د)' }, { id: 'time:45', title: '🕐 خلال 45 دقيقة' }, { id: 'time:90', title: '🕑 خلال ساعة ونصف' }
  ] });
}
function handleDeliveryTime(phone, rid, customer, data, p) {
  const est = p.startsWith('time:') ? Number(p.split(':')[1]) : 30;
  const session = getSession(phone);
  const cart = session.data.cart || {};
  if (cart.pickup) return placeOrder(phone, rid, customer, { ...data, estDeliveryMin: est, orderType: 'pickup', address: data.address || pickupAddress(rid) });
  return startDeliveryBidding(phone, rid, customer, { ...data, estDeliveryMin: est });
}

// ---------- 🚕 مزاد سعر التوصيل ----------
const BID_WINDOW_SECONDS = Number(process.env.BID_WINDOW_SECONDS || 90);
const vehicleAr = (v) => v === 'سيارة' ? '🚗 سيارة' : v === 'شاحنة صغيرة' ? '🚚 شاحنة' : '🏍 دراجة';

// العميل أكمل بياناته → ننشئ الطلب ونعرضه على الكباتن لتحديد السعر
async function startDeliveryBidding(phone, rid, customer, data) {
  const session = getSession(phone);
  const cart = session.data.cart;
  if (!cart || !cart.items.length) { saveSession(phone, 'idle', {}); return mainMenu(phone, rid); }
  const rest = q.get("SELECT * FROM restaurants WHERE id=?", rid);
  const branch = data.address?.branch || null;
  const totals = cartTotals(rid, cart, branch);
  const order = createOrder({ restaurant: rest, customer, cart, totals, paymentMethod: 'cash', address: data.address, estDeliveryMin: data.estDeliveryMin || 30, branch, orderType: 'delivery', bidding: true });
  q.run("UPDATE conversations SET order_id=? WHERE phone=? AND order_id IS NULL AND created_at >= datetime('now','-3 hours')", order.id, customer.phone);
  saveSession(phone, 'bidding', { ...session.data, orderId: order.id, bidOrderId: order.id, deliveryFeePaid: false });
  send(phone, rid, order.id, 'text', `✅ *وصلنا طلبك ${order.order_no}!*\n\n🛵 نعرض طلبك الحين على *كباتن التوصيل* وكل واحد يحدد سعره حسب المسافة.\n⏳ انتظر لحظات وبنجيب لك العروض وتختار اللي يناسبك 👌`);
  const { broadcastBidding } = await import('./dispatch.js');
  let n = 0;
  try { n = broadcastBidding(order); } catch (e) { console.error('BID_BROADCAST_FAIL', e.message); }
  if (!n) send(phone, rid, order.id, 'text', '⏳ ما فيه كابتن متاح حالياً — بنعيد المحاولة في أقرب وقت.');
  setTimeout(() => { closeBidding(order.id).catch(e => console.error('CLOSE_BIDDING_FAIL', e.message)); }, BID_WINDOW_SECONDS * 1000);
  return;
}

// انتهت نافذة التسعير → نعرض العروض على العميل
export async function closeBidding(orderId) {
  const order = q.get("SELECT * FROM orders WHERE id=?", orderId);
  if (!order || order.chosen_captain_id) return;
  const cust = q.get("SELECT * FROM customers WHERE id=?", order.customer_id);
  if (!cust) return;
  const offers = q.all(`SELECT o.*, c.name, c.rating_avg, c.rating_count, c.vehicle_type
      FROM captain_offers o JOIN captains c ON c.id=o.captain_id
      WHERE o.order_id=? AND o.bid_amount IS NOT NULL AND o.status='offered'
      ORDER BY o.bid_amount ASC LIMIT 10`, orderId);
  if (!offers.length) {
    // نعيد العرض بحد أقصى ٤ محاولات، ثم نبلغ المشرف
    const tries = Number(q.get("SELECT COUNT(*) c FROM order_events WHERE order_id=? AND event='bidding'", order.id).c) || 0;
    if (tries < 4) {
      send(sessPhone(cust.phone), order.restaurant_id, order.id, 'text', `⏳ ما وصلتنا عروض توصيل لطلبك ${order.order_no} إلى الآن.\nبنعرض طلبك مرة ثانية وأول ما يوصل عرض بنبلغك 🙏`);
      try { const { broadcastBidding } = await import('./dispatch.js'); broadcastBidding(order); } catch (e) {}
      setTimeout(() => { closeBidding(orderId).catch(() => {}); }, BID_WINDOW_SECONDS * 1000);
    } else {
      send(sessPhone(cust.phone), order.restaurant_id, order.id, 'text', `🙏 نعتذر — ما توفر كابتن لطلبك ${order.order_no} حالياً.\nالإدارة على علم بالطلب وبيتواصلون معك.`);
      try {
        const cfg = (await import('../config.js')).default;
        if (cfg.adminPhone) {
          const { waSend } = await import('./whatsapp.js');
          await waSend({ phone: cfg.adminPhone, type: 'text', body: `⚠️ *ما توفر كابتن لطلب* ${order.order_no} — ${order.national_address || ''}\nالمبلغ: ${rls(order.total)} ر.س` });
        }
      } catch (e) { console.error('BID_NO_CAPTAIN_NOTIFY_FAIL', e.message); }
    }
    return;
  }
  const { customerScoreLine } = { customerScoreLine: null };
  const rows = offers.map(o => ({
    id: `bid:${o.id}`,
    title: `${o.name.slice(0, 12)} — ${(o.bid_amount / 100).toFixed(2)} ر.س`.slice(0, 24),
    description: `${o.rating_count ? '⭐ ' + o.rating_avg + '/5' : '🆕 كابتن جديد'} · ${vehicleAr(o.vehicle_type)}`.slice(0, 72)
  }));
  const cp = sessPhone(cust.phone);
  const sess = getSession(cp);
  saveSession(cp, 'choose_captain', { ...sess.data, orderId: order.id, bidOrderId: order.id });
  send(cp, order.restaurant_id, order.id, 'text', `🛵 *وصلتك ${offers.length} عروض توصيل لطلبك ${order.order_no}*\n\nكل عرض يوضح اسم الكابتن وتقييمه وسعر التوصيل.\nاختر الأنسب لك 👇`);
  return send(cp, order.restaurant_id, order.id, 'list', 'عروض التوصيل:', { list: [{ title: 'الكباتن', rows }] });
}

// العميل اختار عرض كابتن → نحدّث رسوم التوصيل ثم نطلب الدفع
async function handleBidPick(phone, rid, customer, data, p) {
  const offerId = Number(String(p).split(':')[1]);
  const offer = q.get("SELECT * FROM captain_offers WHERE id=?", offerId);
  if (!offer) return send(phone, rid, null, 'text', 'ما لقيت هذا العرض 🙏 اطلب العروض من جديد.');
  const order = q.get("SELECT * FROM orders WHERE id=?", offer.order_id);
  if (!order || Number(order.customer_id) !== Number(customer.id)) return send(phone, rid, null, 'text', 'هذا العرض ما يخص طلبك 🙏');
  const cap = q.get("SELECT * FROM captains WHERE id=?", offer.captain_id);
  const fee = Number(offer.bid_amount) || 0;
  const newTotal = Math.max(0, Number(order.subtotal) - Number(order.discount) + fee);
  q.run("UPDATE orders SET delivery_fee=?, total=?, chosen_captain_id=?, updated_at=datetime('now') WHERE id=?", fee, newTotal, cap.id, order.id);
  try { const { addEvent } = await import('./orderService.js'); addEvent(order.id, 'bid_chosen', `العميل اختار الكابتن ${cap.name} بسعر توصيل ${(fee / 100).toFixed(2)} ر.س`); } catch (e) {}
  send(phone, rid, order.id, 'text', `✅ اخترت *${cap.name}*${cap.rating_count ? ` (⭐ ${cap.rating_avg}/5)` : ' (🆕 جديد)'}\n🛵 سعر التوصيل: *${rls(fee)} ر.س*\n💰 الإجمالي الجديد: *${rls(newTotal)} ر.س*\n\nباقي خطوة الدفع — وبعدها نحوّل طلبك للكابتن مباشرة ✅`);
  const next = { ...data, orderId: order.id, payForOrderId: order.id, captainId: cap.id };
  saveSession(phone, 'payment_method', next);
  send(phone, rid, order.id, 'buttons', '💰 كيف تحب تدفع؟', { buttons: [
    { id: 'pay:applepay', title: '🍎 Apple Pay' }, { id: 'pay:mada', title: '💳 مدى' }, { id: 'pay:card', title: '💳 بطاقة' }
  ] });
  return send(phone, rid, order.id, 'buttons', 'أو كاش للكابتن عند التسليم:', { buttons: [{ id: 'pay:cash', title: '💵 كاش عند التسليم' }] });
}

// ---------- إنشاء الطلب ----------
// عنوان «استلام من الفرع» (أقرب/أول فرع للنشاط)
function pickupAddress(rid) {
  const r = q.get("SELECT * FROM restaurants WHERE id=?", rid);
  const b = q.get("SELECT * FROM branches WHERE restaurant_id=? ORDER BY id LIMIT 1", rid);
  const parts = [b?.name, b?.city || r?.city, r?.address].filter(Boolean);
  return {
    label: 'استلام من الفرع',
    national_address: parts.join(' — ') || (r?.name_ar || ''),
    lat: b?.lat ?? r?.lat ?? null,
    lng: b?.lng ?? r?.lng ?? null,
    branch: b || null,
    pickup: true
  };
}

function placeOrder(phone, rid, customer, data) {
  const session = getSession(phone);
  const cart = session.data.cart;
  if (!cart || !cart.items.length) { saveSession(phone, 'idle', {}); return mainMenu(phone, rid); }
  const rest = q.get("SELECT * FROM restaurants WHERE id=?", rid);
  const branch = data.address?.branch || null;
  const totals = cartTotals(rid, cart, branch);
  const orderType = data.orderType || (cart.pickup ? 'pickup' : 'delivery');
  const order = createOrder({ restaurant: rest, customer, cart, totals, paymentMethod: data.paymentMethod, address: data.address, estDeliveryMin: data.estDeliveryMin || 30, branch, orderType });
  if (data.paymentId) q.run("UPDATE payments SET order_id=? WHERE id=?", order.id, data.paymentId);
  if (data.paid) q.run("UPDATE orders SET payment_status='paid' WHERE id=?", order.id);
  q.run("UPDATE conversations SET order_id=? WHERE phone=? AND order_id IS NULL AND created_at >= datetime('now','-3 hours')", order.id, customer.phone);
  const d = { ...session.data, orderId: order.id };
  saveSession(phone, 'tracking', d);
  if (orderType === 'pickup') {
    send(phone, rid, order.id, 'text', `✅ *استلمت طلبك ${order.order_no}!*\n\n${cartText(rid, cart, branch)}\n🏪 *استلام من:* ${data.address.national_address}\n🕐 جاهز تقريباً خلال ${data.estDeliveryMin || 20} دقيقة\n\n🔐 *رقم استلام طلبك: ${order.delivery_code}*\nأعطهم الرقم وقت الاستلام من الفرع 🌸\n\nبنبلغك أول ما يصير طلبك جاهز 📦`);
  } else {
    send(phone, rid, order.id, 'text', `✅ *استلمت طلبك ${order.order_no}!*\n\n${cartText(rid, cart, branch)}\n📍 التوصيل إلى: ${data.address.national_address || (data.address.lat + ',' + data.address.lng)}\n🕐 يوصل تقريباً خلال ${data.estDeliveryMin || 30} دقيقة\n\n🔐 *رمز استلام طلبك: ${order.delivery_code}*\nلا تعطيه لأحد إلا للمندوب وقت الاستلام 🌸\n\nبخليك على علم بكل مرحلة لين يوصل طلبك 🛵`);
  }
  return send(phone, rid, order.id, 'buttons', '', { buttons: [{ id: 'track', title: '📦 حالة الطلب' }, { id: 'menu', title: '⬅️ القائمة الرئيسية' }] });
}

// ---------- التتبع ----------
function showTracking(phone, rid, customer) {
  const last = q.get("SELECT * FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 3", customer.id);
  if (!last) { send(phone, rid, null, 'text', 'ما فيه طلبات سابقة 😊'); return mainMenu(phone, rid); }
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
  if (!locs.length) { send(phone, rid, null, 'text', 'ما عندك عناوين محفوظة للحين 📍'); return mainMenu(phone, rid); }
  let t = '📍 *عناوينك المحفوظة:*\n';
  locs.forEach((l, i) => { t += `${i + 1}. ${l.is_default ? '⭐' : ''} ${l.label}: ${l.national_address || (l.lat + ',' + l.lng)}\n`; });
  send(phone, rid, null, 'text', t);
  return mainMenu(phone, rid);
}

// ---------- التقيم ----------
export function triggerRating(order) {
  const customer = q.get("SELECT phone FROM customers WHERE id=?", order.customer_id);
  if (!customer) return;
  const cp = sessPhone(customer.phone);
  const session = getSession(cp);
  saveSession(cp, 'rate_restaurant', { ...session.data, orderId: order.id, ratings: {} });
  send(cp, order.restaurant_id, order.id, 'text', '🎉 وصل طلبك! قيّم تجربتك معنا ⭐');
  send(cp, order.restaurant_id, order.id, 'buttons', 'قيّم *المطعم* (1-5):', { buttons: [
    { id: 'rate:1', title: '⭐' }, { id: 'rate:3', title: '⭐⭐⭐' }, { id: 'rate:5', title: '⭐⭐⭐⭐⭐' }
  ] });
  return send(cp, order.restaurant_id, order.id, 'buttons', 'أو أدخل رقم 1-5:', { buttons: [
    { id: 'rate:2', title: '⭐⭐' }, { id: 'rate:4', title: '⭐⭐⭐⭐' }
  ] });
}
function handleRate(phone, rid, customer, data, p, b, key) {
  let v = parseInt(p.startsWith('rate:') ? p.split(':')[1] : b, 10);
  if (!v || v < 1 || v > 5) return send(phone, rid, data.orderId, 'text', 'أرسل رقم من 1 إلى 5 ⭐');
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
  send(phone, rid, null, 'text', '✅ تم الدفع بنجاح، يعطيك العافية 🌸');
  const customer = ensureCustomer(phone);
  // 🚀 الطلب المبسّط: العنوان محفوظ؟ → ينشئ الطلب فوراً بدون خطوات إضافية
  if (config.quickOrder && quickPlaceAfterPayment(phone, rid, customer, session.data)) return;
  return askLocation(phone, rid, customer);
}

// ================= تدفق الكابتن على نفس واتساب المطعم =================
// الكابتن يرسل لنفس رقم المطعم — البوت يميّزه من رقمه المسجل ويعامله ككابتن
// ================= تسجيل الأنشطة والكباتن عبر واتساب =================
const REG_CANCEL = /^(الغاء|إلغاء|الغاء التسجيل|إلغاء التسجيل|توقف|كنسل)$/;

function cancelReg(phone, rid, session) {
  saveSession(phone, 'idle', { ...session.data, reg: null });
  return send(phone, rid, null, 'text', 'تم إلغاء التسجيل 👍\nاكتب *تسجيل* متى ما تحب تبدّي من جديد.');
}

// ---- تسجيل نشاط ----
function startBusinessReg(phone, rid, session) {
  const types = q.all("SELECT * FROM business_types WHERE is_active=1 ORDER BY sort_order, id");
  saveSession(phone, 'reg_type', { ...session.data, reg: { phone } });
  if (!types.length) return send(phone, rid, null, 'text', 'خدمة التسجيل غير متاحة حالياً 🙏');
  let t = '📝 *تسجيل نشاط جديد*\n\nوش نوع نشاطك؟ أرسل الرقم:\n';
  types.forEach((x, i) => { t += `${i + 1}. ${x.icon} ${x.name_ar}\n`; });
  t += '\n_(لإلغاء التسجيل في أي وقت اكتب: إلغاء)_';
  send(phone, rid, null, 'text', t);
  return send(phone, rid, null, 'list', 'اختر نوع النشاط 👇', { list: [{ title: 'أنواع الأنشطة', rows: types.map(x => ({ id: 'btype:' + x.id, title: String(x.name_ar).slice(0, 24), description: '' })) }] });
}

function handleRegType(phone, rid, session, b, p) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const types = q.all("SELECT * FROM business_types WHERE is_active=1 ORDER BY sort_order, id");
  let t = null;
  if (p && p.startsWith('btype:')) t = types.find(x => x.id === Number(p.split(':')[1]));
  else { const n = parseInt(String(b).trim(), 10); if (n >= 1 && n <= types.length) t = types[n - 1]; }
  if (!t) return startBusinessReg(phone, rid, session);
  saveSession(phone, 'reg_name', { ...session.data, reg: { ...(session.data.reg || { phone }), type_id: t.id, type_name: t.name_ar, icon: t.icon } });
  return send(phone, rid, null, 'text', `${t.icon} تمام — *${t.name_ar}*\n\nوش *اسم النشاط*؟`);
}

function handleRegName(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const name = String(b).trim();
  if (name.length < 2) return send(phone, rid, null, 'text', 'اكتب اسم النشاط 🌸');
  saveSession(phone, 'reg_city', { ...session.data, reg: { ...session.data.reg, name: name.slice(0, 60) } });
  return send(phone, rid, null, 'text', `ما شاء الله 🌟 *${name}*\n\nوش *المدينة*؟`);
}

function handleRegCity(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const city = String(b).trim();
  if (city.length < 2) return send(phone, rid, null, 'text', 'اكتب المدينة 🌸');
  const clean = city.slice(0, 40);
  saveSession(phone, 'reg_district', { ...session.data, reg: { ...session.data.reg, city: clean } });
  return send(phone, rid, null, 'text', `📍 ${clean}\n\nوبأي *حي*؟ (مثال: حي النرجس — أو اكتب *تخطى*)`);
}

// الحي (نشاط) → الأصناف
function handleRegDistrict(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const raw = String(b).trim();
  const skip = /^(تخطى|تخطي|بدون|لا|تجاوز|-|0)$/i.test(raw);
  if (!skip && raw.length < 2) return send(phone, rid, null, 'text', 'اكتب اسم الحي، أو *تخطى* 🌸');
  const district = skip ? null : raw.replace(/^حي\s+/,'').slice(0, 40);
  saveSession(phone, 'reg_postal', { ...session.data, reg: { ...session.data.reg, district } });
  return send(phone, rid, null, 'text', `${district ? '🏘 ' + district + '\n' : ''}\nوش *الرمز البريدي* (العنوان المختصر)؟\nمثال: *AKMF0000*\n\nأو اكتب *تخطى*`);
}

// الرمز البريدي → الأصناف
function handleRegPostal(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const raw = String(b).trim();
  const skip = /^(تخطى|تخطي|بدون|لا|تجاوز|-|0)$/i.test(raw);
  const code = skip ? null : raw.replace(/[\s\-]/g, '').toUpperCase();
  if (!skip && !/^[A-Z0-9]{4,12}$/.test(code)) {
    return send(phone, rid, null, 'text', 'اكتب الرمز بصيغة صحيحة — مثال: *AKMF0000* (أو اكتب *تخطى*)');
  }
  saveSession(phone, 'reg_owner', { ...session.data, reg: { ...session.data.reg, postal: code ? code.slice(0, 12) : null } });
  return send(phone, rid, null, 'text', `${code ? '🔢 ' + code + '\n\n' : ''}👤 وش *اسم المسؤول* عن النشاط؟ (الاسم الكامل)`);
}

// اسم المسؤول → رقم الهوية
function handleRegOwner(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const name = String(b).trim();
  if (name.length < 3) return send(phone, rid, null, 'text', 'اكتب الاسم الكامل 🌸');
  saveSession(phone, 'reg_owner_id', { ...session.data, reg: { ...session.data.reg, owner: name.slice(0, 60) } });
  return send(phone, rid, null, 'text', `👤 *${name.slice(0, 60)}*\n\n🔢 و*رقم الهوية الوطنية* (أو الإقامة) — ١٠ أرقام؟`);
}

// رقم الهوية → الأصناف
function handleRegOwnerId(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const id = validNationalId(b);
  if (!id) return send(phone, rid, null, 'text', 'رقم الهوية لازم *١٠ أرقام* ويبدأ بـ ١ أو ٢ 🙏\nمثال: 1023456789');
  saveSession(phone, 'reg_items', { ...session.data, reg: { ...session.data.reg, owner_id: id } });
  return send(phone, rid, null, 'text', ITEMS_PROMPT('✅ تم حفظ بياناتك.\n\n'));
}

// تحليل نص الأصناف: اسم + سعر (اختياري) + قسم (اختياري)
function parseItemLine(line, cat) {
  let name = String(line || '').trim(), price = 0;
  const m = name.match(/^(.*?)[\s\-–—=]+(\d+(?:[.,]\d{1,2})?)\s*(?:ر\.?س|ريال)?$/);
  if (m) { name = m[1].trim(); price = Math.round(parseFloat(m[2].replace(',', '.')) * 100); }
  name = name.replace(/^[-*•\d.)\s]+/, '').trim();
  if (!name || name.length < 2) return null;
  return { name: name.slice(0, 80), price: Number.isFinite(price) ? price : 0, category: cat || null };
}
function parseItems(text) {
  const items = [];
  let cat = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cm = line.match(/^(.{2,30}?)\s*[:：]\s*(.*)$/);
    if (cm) {
      const rest = cm[2].trim();
      if (!rest) { cat = cm[1].trim(); continue; }
      for (const part of rest.split(/[،,؛;]+/)) { const it = parseItemLine(part, cat); if (it) items.push(it); }
      continue;
    }
    const it = parseItemLine(line, cat);
    if (it) items.push(it);
  }
  return items;
}

function handleRegItems(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const items = parseItems(b);
  if (!items.length) return send(phone, rid, null, 'text', 'ما وصلني أصناف واضحة 🌸\n\nأرسل كل صنف في سطر، مثلاً:\nنفر حاشي كبسة 60\nبيبسي 5');
  const withPrice = items.filter(i => i.price > 0).length;
  const next = { ...session.data, reg: { ...session.data.reg, items } };
  let t = `✅ وصلني *${items.length}* صنف${withPrice < items.length ? ` — و${items.length - withPrice} بلا سعر` : ''}:\n\n`;
  t += items.slice(0, 18).map((i, idx) => `${idx + 1}. ${i.name}${i.price ? ' — ' + rls(i.price) + ' ر.س' : ' — ❓'}${i.category ? ` (${i.category})` : ''}`).join('\n');
  if (items.length > 18) t += `\n… و${items.length - 18} غيرها`;
  send(phone, rid, null, 'text', t);
  if (withPrice === items.length) return sendRegReview(phone, rid, next);
  saveSession(phone, 'reg_prices', next);
  return send(phone, rid, null, 'text', 'الآن أرسل *الأسعار* — سطر لكل صنف:\n\nنفر حاشي كبسة 60\nبيبسي 5\n\n_(أو اكتب *تخطى* ونكمل)_');
}

function handleRegPrices(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const reg = session.data.reg || {};
  let items = reg.items || [];
  if (!/^(تخطى|تخطي|مو الحين|لاحقاً|لاحقا|بعدين)$/.test(String(b).trim())) {
    const prices = parseItems(b);
    if (prices.length) {
      for (const pr of prices) {
        const target = items.find(i => i.name.includes(pr.name) || pr.name.includes(i.name));
        if (target && pr.price > 0) target.price = pr.price;
      }
      // إذا جاءت أسعار بترتيب الأصناف (أرقام فقط)
      const nums = String(b).trim().split(/[\s،,]+/).map(x => parseFloat(x.replace(',', '.')));
      if (nums.length === items.length && nums.every(n => Number.isFinite(n))) {
        items = items.map((i, idx) => ({ ...i, price: Math.round(nums[idx] * 100) }));
      }
    }
  }
  const next = { ...session.data, reg: { ...reg, items } };
  return sendRegReview(phone, rid, next);
}

function sendRegReview(phone, rid, data) {
  const reg = data.reg || {};
  const items = reg.items || [];
  let t = '📋 *مراجعة التسجيل*\n\n';
  t += `🏷 النوع: ${reg.icon || ''} ${reg.type_name || ''}\n🍽 الاسم: *${reg.name || ''}*\n📍 المدينة: ${reg.city || ''}\n🏘 الحي: ${reg.district || '—'}${reg.owner ? `\n👤 المسؤول: ${reg.owner}${reg.owner_id ? ' — هوية ' + reg.owner_id : ''}` : ''}${reg.postal ? `\n🔢 الرمز البريدي: ${reg.postal}` : ''}\n📱 الجوال: ${reg.phone}\n\n`;
  t += `*الأصناف (${items.length}):*\n`;
  t += items.slice(0, 12).map((i, idx) => `${idx + 1}. ${i.name}${i.price ? ' — ' + rls(i.price) + ' ر.س' : ' — ❓ بلا سعر'}`).join('\n');
  if (items.length > 12) t += `\n… و${items.length - 12} غيرها`;
  t += '\n\nصحيحة كلها؟ اضغط *اعتماد وإرسال* وبيوصل طلبك للإدارة.';
  saveSession(phone, 'reg_review', data);
  return send(phone, rid, null, 'buttons', t.slice(0, 1000), { buttons: [
    { id: 'reg_submit', title: '✅ اعتماد وإرسال' },
    { id: 'reg_fix', title: '✏️ تعديل الأصناف' },
    { id: 'reg_cancel', title: '❌ إلغاء' }
  ] });
}

async function handleRegReview(phone, rid, session, b, p) {
  if (p === 'reg_cancel' || REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  if (p === 'reg_fix') { saveSession(phone, 'reg_items', session.data); return send(phone, rid, null, 'text', 'أرسل الأصناف من جديد ✏️ (نص · 🎙 صوتية · 📷 صورة واضحة)'); }
  if (p === 'reg_submit' || /^(اعتماد|ارسال|إرسال|تم|اوكي|أوكي)$/.test(String(b).trim())) {
    const sub = Math.round(Number(config.businessSubscription || 100000) / 100);
    saveSession(phone, 'reg_subscribe', session.data);
    send(phone, rid, null, 'text', `💳 *اشتراك النشاط السنوي: ${sub.toFixed(2)} ر.س*\n\nمبلغ اشتراك سنوي يُدفع للمنصة عند التسجيل ✅`);
    return send(phone, rid, null, 'buttons', 'كيف تحب تكمل؟', { buttons: [
      { id: 'sub_pay', title: '💳 ادفع الاشتراك' },
      { id: 'sub_later', title: '⏳ أدفعه لاحقاً' }
    ] });
  }
  return sendRegReview(phone, rid, session.data);
}

// خطوة اشتراك النشاط
async function handleRegSubscribe(phone, rid, session, b, p) {
  const sub = Math.round(Number(config.businessSubscription || 100000) / 100);
  if (p === 'sub_later') return submitBusinessReg(phone, rid, session, { subscriptionPaid: false });
  if (p === 'sub_paid') return submitBusinessReg(phone, rid, session, { subscriptionPaid: false, claimed: true });
  if (p === 'sub_pay' && config.paymentMode === 'mock') {
    send(phone, rid, null, 'text', `🧪 *وضع تجريبي:* تم دفع الاشتراك وهمياً ✅ — ${sub.toFixed(2)} ر.س`);
    return submitBusinessReg(phone, rid, session, { subscriptionPaid: true });
  }
  if (p === 'sub_pay') {
    send(phone, rid, null, 'text', `💳 *اشتراك النشاط ${sub.toFixed(2)} ر.س*\n\nحوّل المبلغ لحساب المنصة، وبعد التحويل اضغط *✅ تم التحويل*.`);
    if (config.adminPhone) send(phone, rid, null, 'text', `📱 للتحويل أو الاستفسار: الإدارة على الرقم ${config.adminPhone}`);
    return send(phone, rid, null, 'buttons', 'بعد التحويل اضغط هنا 👇', { buttons: [
      { id: 'sub_paid', title: '✅ تم التحويل' }, { id: 'sub_later', title: '⏳ لاحقاً' }
    ] });
  }
  return send(phone, rid, null, 'buttons', 'اختر 👇', { buttons: [
    { id: 'sub_pay', title: '💳 ادفع الاشتراك' }, { id: 'sub_later', title: '⏳ أدفعه لاحقاً' }
  ] });
}

// إنشاء طلب تسجيل النشاط بعد خطوة الاشتراك
async function submitBusinessReg(phone, rid, session, { subscriptionPaid = false, claimed = false } = {}) {
  {
    const reg = session.data.reg || {};
    const items = reg.items || [];
    const r = q.run(`INSERT INTO business_registrations (kind, phone, business_name, business_type_id, city, district, postal_code, owner_name, owner_id, items_json, subscription_paid, note, status)
      VALUES ('business', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')`, phone, reg.name || '', reg.type_id || null, reg.city || null, reg.district || null, reg.postal || null, reg.owner || null, reg.owner_id || null, JSON.stringify(items), subscriptionPaid ? 1 : 0, claimed ? 'يقول إنه حوّل الاشتراك' : null);
    const row = q.get("SELECT * FROM business_registrations WHERE id=?", Number(r.lastInsertRowid));
    saveSession(phone, 'idle', { ...session.data, reg: null });
    const ok = await notifySupervisor(row);
    return send(phone, rid, null, 'text', ok
      ? `🎉 *تم إرسال طلبك للإدارة!*\n\n🍽 ${reg.name}\n🍽 الأصناف: ${items.length}\n📍 ${[reg.city, reg.district, reg.postal].filter(Boolean).join(' — ')}\n👤 ${reg.owner || ''}\n\nبنراجعه ونبلغك بالاعتماد قريباً 🙏`
      : '✅ تم حفظ طلبك.\n\n⚠️ رقم المشرف غير مضبوط — كلّم الإدارة للاعتماد.');
  }
}

// ---- تسجيل كابتن ----
function startCaptainReg(phone, rid, session) {
  if (isCaptainPhone(phone)) return send(phone, rid, null, 'text', 'أنت مسجّل عندنا كابتن توصيل ✅ — بيجيك الطلبات هنا.');
  saveSession(phone, 'cap_name', { ...session.data, reg: { phone, kind: 'captain' } });
  return send(phone, rid, null, 'text', '🛵 *تسجيل كابتن توصيل*\n\nوش *اسمك*؟');
}
function handleCapName(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const name = String(b).trim();
  if (name.length < 2) return send(phone, rid, null, 'text', 'اكتب اسمك 🌸');
  saveSession(phone, 'cap_id', { ...session.data, reg: { ...session.data.reg, name: name.slice(0, 40) } });
  return send(phone, rid, null, 'text', `👤 *${name.slice(0, 40)}*\n\n🔢 و*رقم هويتك* (أو الإقامة) — ١٠ أرقام؟`);
}
function handleCapId(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const id = validNationalId(b);
  if (!id) return send(phone, rid, null, 'text', 'رقم الهوية لازم *١٠ أرقام* ويبدأ بـ ١ أو ٢ 🙏\nمثال: 1023456789');
  saveSession(phone, 'cap_city', { ...session.data, reg: { ...session.data.reg, national_id: id } });
  return send(phone, rid, null, 'text', '📍 وش *مدينتك*؟');
}
function handleCapCity(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const city = String(b).trim();
  if (city.length < 2) return send(phone, rid, null, 'text', 'اكتب المدينة 🌸');
  const clean = city.slice(0, 40);
  saveSession(phone, 'cap_district', { ...session.data, reg: { ...session.data.reg, city: clean } });
  return send(phone, rid, null, 'text', `📍 ${clean}\n\nوبأي *حي* تشتغل أكثر؟ (مثال: حي النرجس — أو *تخطى*)`);
}
function handleCapDistrict(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const raw = String(b).trim();
  const skip = /^(تخطى|تخطي|بدون|لا|تجاوز|-|0)$/i.test(raw);
  if (!skip && raw.length < 2) return send(phone, rid, null, 'text', 'اكتب اسم الحي، أو *تخطى* 🌸');
  const district = skip ? null : raw.replace(/^حي\s+/,'').slice(0, 40);
  saveSession(phone, 'cap_vehicle', { ...session.data, reg: { ...session.data.reg, district } });
  return send(phone, rid, null, 'buttons', 'وش *وسيلة نقلك*؟', { buttons: [
    { id: 'veh:دراجة', title: '🏍 دراجة' },
    { id: 'veh:سيارة', title: '🚗 سيارة' },
    { id: 'veh:شاحنة صغيرة', title: '🚚 شاحنة' }
  ] });
}
async function handleCapVehicle(phone, rid, session, b, p) {
  const v = p && p.startsWith('veh:') ? p.slice(4) : String(b || '').trim();
  if (!v || v.length < 2) return send(phone, rid, null, 'text', 'اختر وسيلة النقل من الأزرار 👆');
  saveSession(phone, 'cap_deposit', { ...session.data, reg: { ...(session.data.reg || {}), vehicle: v.slice(0, 30) } });
  send(phone, rid, null, 'text', `💰 *تأمين الحساب: ٥٠٠ ر.س*\n\nمبلغ تأمين يُدفع مرة واحدة، ويُحفظ لك رصيد — وكل ما وصلت مبالغك المحصّلة للحدّ نوقف الاستقبال مؤقتاً حتى التسوية ✅`);
  return send(phone, rid, null, 'buttons', 'كيف تحب تكمل؟', { buttons: [
    { id: 'dep_pay', title: '💳 ادفع التأمين' },
    { id: 'dep_later', title: '⏳ أدفعه لاحقاً' }
  ] });
}

// خطوة التأمين ثم إرسال الطلب
async function handleCapDeposit(phone, rid, session, b, p) {
  const reg = session.data.reg || {};
  if (p === 'dep_later') return submitCaptainReg(phone, rid, session, { depositPaid: false });
  if (p === 'dep_paid') return submitCaptainReg(phone, rid, session, { depositPaid: false, claimed: true });
  if (p === 'dep_pay' && config.paymentMode === 'mock') {
    const amt = rls(Number(config.captainDeposit || 50000));
    send(phone, rid, null, 'text', `🧪 *وضع تجريبي:* تم دفع التأمين وهمياً ✅ — ${amt} ر.س`);
    return submitCaptainReg(phone, rid, session, { depositPaid: true });
  }
  if (p === 'dep_pay') {
    saveSession(phone, 'cap_deposit_wait', { ...session.data, reg });
    send(phone, rid, null, 'text', `💳 *تأمين الحساب ٥٠٠.٠٠ ر.س*\n\nحوّل المبلغ على حساب المنصة، وبعد التحويل اضغط *✅ تم التحويل* وأرفق الإيصال للإدارة.`);
    if (config.adminPhone) send(phone, rid, null, 'text', `📱 للتحويل أو الاستفسار: الإدارة على الرقم ${config.adminPhone}`);
    return send(phone, rid, null, 'buttons', 'بعد التحويل اضغط هنا 👇', { buttons: [{ id: 'dep_paid', title: '✅ تم التحويل' }, { id: 'dep_later', title: '⏳ لاحقاً' }] });
  }
  return send(phone, rid, null, 'buttons', 'اختر 👇', { buttons: [{ id: 'dep_pay', title: '💳 ادفع التأمين' }, { id: 'dep_later', title: '⏳ أدفعه لاحقاً' }] });
}
async function submitCaptainReg(phone, rid, session, { depositPaid = false, claimed = false } = {}) {
  const reg = session.data.reg || {};
  const v = reg.vehicle || 'دراجة';
  const r = q.run(`INSERT INTO business_registrations (kind, phone, business_name, city, district, owner_id, vehicle_type, deposit_paid, note, status)
    VALUES ('captain', ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')`, phone, reg.name || '', reg.city || null, reg.district || null, reg.national_id || null, v.slice(0, 30), depositPaid ? 1 : 0, claimed ? 'يقول إنه حوّل التأمين' : null);
  const row = q.get("SELECT * FROM business_registrations WHERE id=?", Number(r.lastInsertRowid));
  saveSession(phone, 'idle', { ...session.data, reg: null });
  const ok = await notifySupervisor(row);
  return send(phone, rid, null, 'text', ok
    ? `✅ *تم إرسال طلبك للإدارة*\n\n👤 ${reg.name}\n🔢 ${reg.national_id || ''}\n📍 ${reg.city}${reg.district ? ' — ' + reg.district : ''}\n🛵 ${v}\n\nبنبلغك بالاعتماد قريباً 🙏`
    : '✅ تم حفظ طلبك — بس رقم المشرف غير مضبوط.');
}

// ---------- مدير المطعم: مستلم تقرير المبيعات ----------
// نشاط صاحب الرسالة (من حسابات الأنشطة)
function ownerRestaurantId(phone) {
  const norm = validatePhone(phone);
  const r = q.get("SELECT restaurant_id FROM restaurant_users WHERE (phone=? OR phone=?) AND is_active=1 ORDER BY (role='owner') DESC, id LIMIT 1", norm, String(phone || ''));
  return r?.restaurant_id || null;
}
function startAddManager(phone, rid, session) {
  const rrid = ownerRestaurantId(phone);
  if (!rrid) return send(phone, rid, null, 'text', '📊 هذي الخدمة لأصحاب الأنشطة المسجّلين عندنا 🌸\n\nسجّل نشاطك أولاً بكتابة *تسجيل* وجاهزين نخدمك.');
  saveSession(phone, 'rep_name', { ...session.data, reg: null, rep: { restaurant_id: rrid } });
  return send(phone, rid, null, 'text', '👤 *إضافة مدير المطعم* — بيوصله *تقرير المبيعات اليومي* على واتساب (المجموع الختام · شبكة · كاش).\n\nوش *اسمه*؟');
}
function handleRepName(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const name = String(b).trim();
  if (name.length < 2) return send(phone, rid, null, 'text', 'اكتب اسمه 🌸');
  saveSession(phone, 'rep_id', { ...session.data, rep: { ...session.data.rep, name: name.slice(0, 40) } });
  return send(phone, rid, null, 'text', `👤 *${name.slice(0, 40)}*\n\n🔢 و*رقم هويته* (١٠ أرقام)؟`);
}
function handleRepId(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const id = validNationalId(b);
  if (!id) return send(phone, rid, null, 'text', 'رقم الهوية لازم *١٠ أرقام* ويبدأ بـ ١ أو ٢ 🙏\nمثال: 1023456789');
  saveSession(phone, 'rep_phone', { ...session.data, rep: { ...session.data.rep, national_id: id } });
  return send(phone, rid, null, 'text', 'وش *جواله*؟ (مثال: 0551234567)');
}
async function handleRepPhone(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const digits = String(b || '').replace(/[^\d]/g, '');
  if (digits.length < 9) return send(phone, rid, null, 'text', 'اكتب رقم جوال صحيح 🌸 مثال: 0551234567');
  const data = session.data || {};
  const rep = data.rep || {};
  const norm = validatePhone(digits);
  saveSession(phone, 'idle', { ...data, rep: null });
  const row = addRecipient(rep.restaurant_id, rep.name, norm, '23:30', rep.national_id);
  const ok = await notifySupervisorRecipient(row);
  return send(phone, rid, null, 'text', ok
    ? `✅ *وصلني طلبك وأرسلته لمشرف المنصة للاعتماد*\n\n👤 ${rep.name || ''}\n📱 ${norm}\n⏰ التقرير اليومي الساعة ١١:٣٠ مساءً\n\nأول ما يُعتمد بيوصله التقرير 🙏`
    : '✅ حفظت الطلب — لكن رقم مشرف المنصة غير مضبوط، كلّم الإدارة للاعتماد.');
}
// تقرير فوري بكلمة «تقرير»
async function sendReportNow(phone, rid, yesterday) {
  const rec = findRecipientByPhone(phone);
  const rrid = ownerRestaurantId(phone) || (rec?.status === 'approved' ? rec.restaurant_id : null);
  if (!rrid) {
    return send(phone, rid, null, 'text', '📊 خدمة تقارير المبيعات لأصحاب الأنشطة ومستلمي التقارير 🌸\n\n• سجّل نشاطك بكتابة *تسجيل*\n• أو أضف مدير المطعم بكتابة *مدير*');
  }
  const { localNow, shiftDate } = await import('./reporting.js');
  const target = yesterday ? shiftDate(localNow().date, -1) : localNow().date;
  const txt = buildDailyReport(rrid, target);
  return send(phone, rid, null, 'text', txt || 'ما قدرت أطلع التقرير الحين 🙏 جرّب بعد شوي');
}

// ---------- أصناف مقروءة من صورة (OCR) ----------
// تُدمج مع مسودة التسجيل الحالية (أثناء إدخال الأصناف أو المراجعة) ثم تُعرض للمراجعة
export async function handlePhotoItems(phone, restaurantId, items = []) {
  const rid = restaurantId;
  const session = getSession(phone);
  const state = session.state;
  if (!items || !items.length) {
    return send(phone, rid, null, 'text', '📷 وصلتني الصورة بس ما قدرت أقرأ منها أصناف واضحة 🙏\n\nجرّب صورة أوضح (إضاءة جيدة وبدون ميلان)، أو أرسل الأصناف *نصاً* أو 🎙 *صوتية*.');
  }
  if (state === 'reg_items' || state === 'reg_review') {
    const reg = { ...(session.data.reg || {}) };
    const list = [ ...(reg.items || []) ];
    let added = 0;
    for (const it of items) {
      const name = String(it?.name || '').trim().slice(0, 80);
      if (name.length < 2) continue;
      const category = it?.category ? String(it.category).trim().slice(0, 40) : null;
      if (list.some(x => x.name === name && (x.category || null) === category)) continue;
      list.push({ name, price: Number(it?.price) || 0, category });
      added += 1;
    }
    if (!added) return send(phone, rid, null, 'text', '📷 الأصناف اللي في الصورة مضافة عندك من قبل ✅');
    reg.items = list;
    send(phone, rid, null, 'text', `📷 قرأت *${added}* صنف من الصورة وأضفتها لأصنافك.`);
    return sendRegReview(phone, rid, { ...session.data, reg });
  }
  return send(phone, rid, null, 'text', '📷 وصلتني الصورة 🙏\n\nلو تبي *تسجّل نشاطك*: أرسل كلمة *تسجيل* ونمشي خطوة خطوة.\nولو تبي *تطلب*: أرسل *المنيو*.');
}

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

  // 0) تقييم الكابتن للعميل (بعد الإغلاق)
  if (p.startsWith('crate:')) {
    const { handleCaptainCustomerRating } = await import('./ratings.js');
    const msg = await handleCaptainCustomerRating(p, captain);
    if (msg) return send(captain.phone, null, null, 'text', msg);
  }
  if (/^(صورة|صوره|الصورة|ارسلت صورة|تم التسليم)$/.test(b)) {
    const { activeOrderForCaptain } = await import('./delivery.js');
    const act = activeOrderForCaptain(captain.id);
    if (!act) return send(captain.phone, null, null, 'text', 'لا يوجد طلب نشط لك حالياً 📭');
    return send(captain.phone, null, act.id, 'text', '📷 أرسل *صورة التسليم* هنا (صوّر الطلب عند باب العميل)، وبعدها أرسل رمز الاستلام.');
  }

  // 💰 تسعير التوصيل (مزاد): رقم 1-3 خانات
  const bidM = b.match(/^(?:سعري|السعر|سعر|bid)\s*[:：]?\s*(\d{1,3})$/i) || b.match(/^(\d{1,3})$/);
  if (bidM) {
    const amount = Number(bidM[1]) * 100;
    if (amount >= 300 && amount <= 30000) {
      const { bidOnOrder } = await import('./dispatch.js');
      const r = bidOnOrder(captain.id, amount);
      if (r.ok) return send(captain.phone, r.order.restaurant_id, r.order.id, 'text', `✅ سجّلت سعرك: *${(amount / 100).toFixed(2)} ر.س* للتوصيل\n⏳ بنعرضه على العميل — بنبلغك لو اختارك 🙏`);
      return send(captain.phone, null, null, 'text', '⚠️ ' + r.error);
    }
  }

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
    return send(captain.phone, null, activeQ.id, 'text', '📍 تم إبلاغ العميل بوصولك!\n\n📷 *الخطوة ١:* صوّر الطلب عند باب العميل وأرسل *الصورة* هنا (إلزامية لإغلاق الطلب).\n🔐 *الخطوة ٢:* خذ رمز الاستلام من العميل وأرسله هنا، وأنا أغلق الطلب.');
  }
  // 💰 رصيدي / التسوية
  if (['رصيدي', 'حسابي', 'المبالغ', 'settle_info', 'كيف أسدّد؟'].includes(b) || p === 'settle_info') {
    const c = q.get("SELECT * FROM captains WHERE id=?", captain.id);
    const cap = Number(c.deposit_amount || 50000);
    const wallet = Number(c.wallet_cash || 0);
    const pen = Number(c.penalty_total || 0);
    let t = `💰 *حسابك*\n\n🏦 التأمين: ${Number(c.deposit_paid) ? '✅ مدفوع' : '⏳ غير مدفوع'} (${rls(cap)} ر.س)\n📦 المبالغ المحصّلة بحوزتك: *${rls(wallet)} ر.س*\n⚠️ غرامات التأخير: ${rls(pen)} ر.س\n`;
    t += `\nالسقف: ${rls(cap)} ر.س — لو وصلت له يتم إيقاف الاستقبال حتى التسوية.`;
    if (Number(c.blocked)) t += `\n\n⛔ *حسابك موقوف حالياً* — ${c.blocked_reason || ''}\nتسوية المبالغ مع الإدارة لإعادة التفعيل.`;
    return send(captain.phone, null, null, 'text', t);
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
  const cust = q.get("SELECT id FROM customers WHERE phone=? OR phone=?", phone, validatePhone(phone));
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
