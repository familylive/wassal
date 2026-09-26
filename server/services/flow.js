import { q } from '../db.js';
import { waSend, waLogIn } from './whatsapp.js';
import { createOrder } from './orderService.js';
import { createPayment, markPaid } from './payments.js';
import { validatePhone, computeTier, TIERS, validNationalId } from '../utils.js';
import { resolveDelivery, ensureDefaultBranch } from './branches.js';
import { notifySupervisor, approveRegistration, rejectRegistration } from './registrations.js';
import { addRecipient, notifySupervisorRecipient, notifyOwnerRecipient, notifyOwnerTeamInfo, approveRecipient, rejectRecipient, findRecipientByPhone, buildDailyReport, parseReportHour, setRecipientHour, prettyHour, buildRangeReport, buildPlatformRangeReport, reportRange, sendPlatformReport } from './reporting.js';
import { roleAr, isCashierPhone, isOwnerPhone, restUserByPhone, ownerPhone, cashierPhone, addCashier, listUsers } from './restUsers.js';
import { PLEDGE_TEXT, PLEDGE_BUTTONS, createPledge, pledgeMessage, findPledge } from './pledge.js';
import { createAdRequest, getAdRequest, setAdPrice, setAdStatus, notifySupervisorNewAd, sendPriceToBusiness, sendToSupervisorForApproval, publishAd, customersInCity, allCustomers, createPlatformAd, saveAdImage } from './ads.js';
import config from '../config.js';

// ---------- session ----------
export function getSessionState(phone) {
  try { return getSession(phone)?.state || 'idle'; } catch (e) { return 'idle'; }
}

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
// 🧹 إزالة الأصناف اللي خلصت (أو تعديل كميتها للمتوفر) — يُنادى قبل المراجعة/الدفع
function pruneCart(phone, rid, cart) {
  if (!cart || !cart.items?.length) return { cart, notes: [] };
  const notes = [];
  const kept = [];
  for (const i of cart.items) {
    if (!i.item_id) { kept.push(i); continue; }
    const row = q.get("SELECT id, name, price, is_available, stock_qty FROM items WHERE id=?", i.item_id);
    if (!row || !row.is_available || row.stock_qty === 0) { notes.push(`⛔ *${i.name}* خلص — شلناه من طلبك`); continue; }
    if (row.stock_qty !== null && row.stock_qty !== undefined && Number(row.stock_qty) < Number(i.quantity)) {
      notes.push(`⚠️ *${i.name}* المتوفر ${row.stock_qty} فقط — عدّلنا الكمية`);
      kept.push({ ...i, price: row.price ?? i.price, quantity: Number(row.stock_qty) });
      continue;
    }
    kept.push({ ...i, price: row.price ?? i.price });
  }
  const newCart = { ...cart, items: kept };
  if (notes.length) {
    const session = getSession(phone);
    saveSession(phone, session.state, { ...session.data, cart: newCart });
  }
  return { cart: newCart, notes };
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
    send(phone, null, null, 'text', '📍 لتظهر لك *الأنشطة القريبة منك* أرسل موقعك الحالي.\n(في واتساب: زر 📎 ← الموقع)\nأو تصفّح الكل 👇');
    return send(phone, null, null, 'buttons', '', { buttons: [
      { id: 'send_location', title: '📍 إرسال الموقع' },
      { id: 'all_rests', title: '🏬 عرض كل الأنشطة' }
    ] });
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
    send(phone, null, null, 'text', '🚫 ما فيه نشاط يوصل لموقعك حالياً.\nتقدر ترسل موقعاً آخر أو تتصفّح كل الأنشطة وتطلب مباشرة.');
    return send(phone, null, null, 'buttons', '', { buttons: [
      { id: 'send_location', title: '📍 إرسال موقع آخر' },
      { id: 'all_rests', title: '🏬 عرض كل الأنشطة' }
    ] });
  }
  nearby.sort((a, b) => a.distKm - b.distKm);
  saveSession(phone, 'directory', { restList: nearby.map(r => r.id) });
  let t = `📍 *الأنشطة القريبة منك:*\n`;
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
// 🏬 عرض كل الأنشطة بغض النظر عن الموقع — لمن لا تغطيه الفروع أو لا يريد مشاركة موقعه
function showAllRestaurants(phone) {
  const rests = q.all("SELECT r.* FROM restaurants r WHERE r.is_active=1 ORDER BY r.rating_avg DESC, r.id");
  if (!rests.length) {
    saveSession(phone, 'directory', {});
    return send(phone, null, null, 'text', '🚫 ما فيه أنشطة مسجّلة حالياً 🙏');
  }
  saveSession(phone, 'directory', { restList: rests.map(r => r.id) });
  let t = '🏬 *كل الأنشطة:*\n';
  rests.slice(0, 10).forEach((r, i) => {
    t += `${i + 1}. ${r.name_ar}${r.city ? ' — ' + r.city : ''}${r.rating_avg ? ' ⭐' + r.rating_avg : ''}\n`;
  });
  send(phone, null, null, 'text', t);
  const rows = rests.slice(0, 10).map(r => ({
    id: 'rest:' + r.id,
    title: r.name_ar,
    description: `${r.city || ''}${r.rating_avg ? ' · ⭐ ' + r.rating_avg : ''}`.slice(0, 72)
  }));
  return send(phone, null, null, 'list', '🏬 *كل الأنشطة:* اختر اللي يعجبك 👇', { list: [{ title: '🏬 كل الأنشطة', rows }] });
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
  // 🏬 مخرج من حلقة «ما فيه نشاط يوصل لموقعك»
  if (p === 'all_rests' || /^(كل المطاعم|كل الأنشطة|كل الانشطة|عرض الكل|بدون موقع|تصفح الكل)$/.test(String(b || '').trim())) {
    return showAllRestaurants(phone);
  }
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
export async function handleIncoming({ phone, restaurantId, body = '', type = 'text', payload = null, lat = null, lng = null, imageUrl = null, mediaRef = null }) {
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
      // 💰 تسعير إعلان
      const am = p.match(/^adprice:(\d+)$/);
      if (am) {
        const req = getAdRequest(Number(am[1]));
        if (!req) return send(phone, rid, null, 'text', 'ما لقيت الطلب 🙏');
        saveSession(phone, 'ad_price', { adReqId: req.id });
        return send(phone, rid, null, 'text', `💰 اكتب *سعر الإعلان* بالريال لـ *${q.get("SELECT name_ar FROM restaurants WHERE id=?", req.restaurant_id)?.name_ar || ''}*\nمثال: 300`);
      }
      // 📣 اعتماد الإعلان
      const apm = p.match(/^ad(ok|no):(\d+)$/);
      if (apm) {
        const req = getAdRequest(Number(apm[2]));
        if (!req) return send(phone, rid, null, 'text', 'ما لقيت الإعلان 🙏');
        if (apm[1] === 'ok') {
          const r = await publishAd(req);
          const biz = q.get("SELECT name_ar FROM restaurants WHERE id=?", req.restaurant_id);
          send(phone, rid, null, 'text', `✅ *تم اعتماد الإعلان ونشره*\n🏪 ${biz?.name_ar || ''}\n🏙 ${r.city || ''}\n📤 أُرسل لـ *${r.sent}* عميل${r.city === '' ? '' : ' في المدينة'}`);
          try { await waSend({ phone: String(req.phone || '').replace(/^\+/, ''), type: 'text', body: `🎉 *تم نشر إعلانك!*\n🏪 الإدارة اعتمدته وأرسلناه لعملاء مدينة *${r.city || ''}* (${r.sent} عميل) ✅` }); } catch (e) {}
          return;
        }
        setAdStatus(req.id, 'rejected', { supervisor_note: 'رفض من الإدارة' });
        try { await waSend({ phone: String(req.phone || '').replace(/^\+/, ''), type: 'text', body: 'نعتذر 🙏 — لم يتم اعتماد الإعلان. تقدر تعدّل النص وترسله مرة ثانية.' }); } catch (e) {}
        return send(phone, rid, null, 'text', '❌ تم رفض الإعلان');
      }
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

  const bt = String(b || '').trim();

  // ===== 📜 بوابة التعهد: كل مستخدم مسجّل (عميل · مالك · كاشير · مدير · كابتن) لازم يوقّع قبل أي خدمة =====
  const isSupervisorPhone = config.adminPhone && validatePhone(phone) === validatePhone(config.adminPhone);
  // (نتخطى البوابة أثناء التعهد نفسه وأثناء خطوات تسجيل العميل — لأنها تنتهي بالتعهد)
  if (!isSupervisorPhone && !['pledge', 'ask_nid', 'ask_dob'].includes(state)) {
    const need = pledgeNeeded(phone);
    if (need && !findPledge(need.kind, phone)) {
      return askPledge(phone, rid, { ...need, next: 'resume', resumeState: state, data: { ...data } });
    }
  }

  // ===== 📊 التقارير: المشرف العام · أصحاب الأنشطة · مستلمو التقارير =====
  // «تقرير» = اليوم · «تقرير يومي/أسبوعي/شهري/سنوي» · «تقرير الشهر الماضي» · «تقرير أمس»
  {
    const kind = reportKindFromText(bt);
    if (kind) {
      const sup = config.adminPhone && validatePhone(phone) === validatePhone(config.adminPhone);
      if (sup) return sendSupervisorReport(phone, rid, kind);
      if (kind === 'day' || kind === 'yesterday') return sendReportNow(phone, rid, kind === 'yesterday');
      return sendReportRangeNow(phone, rid, kind);
    }
  }
  if (p === 'pad_all' || p === 'pad_city') { const sess = getSession(phone); return handlePlatformAdAudience(phone, rid, { ...session, data: sess.data || {} }, p); }
  if (p === 'ad_yes' || p === 'ad_no') { const sess = getSession(phone); return handleAdDecision(phone, rid, { ...session, data: { ...(sess.data || {}), adReqId: sess.data?.adReqId } }, p); }
  // 🚫 الكاشير: ممنوع من تسجيل نشاط/كابتن/إضافة مدير — الطلبات ومتابعتها فقط
  const WANT_JOIN = /^(انضمام|انضم)/.test(b) || /^تسجيل\s*(كابتن|مندوب|نشاط|مطعم|بقالة)/.test(b)
    || /^(مدير|أضف مدير|إضافة مدير|كاشير|أضف كاشير|إضافة كاشير|مستخدمين)$/.test(b);
  if (WANT_JOIN && isCashierPhone(phone)) {
    const u = restUserByPhone(phone);
    const r = q.get("SELECT name_ar FROM restaurants WHERE id=?", u.restaurant_id);
    return send(phone, rid, null, 'text', `🚫 *هذي الميزة لصاحب النشاط (المالك) فقط*\n\nأنت مسجّل عندنا كـ *الكاشير* في *${r?.name_ar || ''}* 🧾\nومهمتك: استلام الطلبات ومتابعتها ✅\n\n_(لو تحتاج صلاحية إضافية، كلّم صاحب النشاط)_`);
  }
  if (/^(مدير|مدير المطعم|أضف مدير|اضف مدير|إضافة مدير|اضافة مدير)$/.test(bt)) return startAddManager(phone, rid, session);
  // 🏪 أزرار إشعار الطلب (استلمت / جاهز) + كلماتها
  if (p && /^ord(ok|ready):\d+$/.test(String(p))) return handleOrderActionFromOwner(phone, rid, p);
  if (p && /^rowner_(ok|no):\d+$/.test(String(p))) return handleOwnerRecipientAction(phone, rid, p);
  if (p === 'add_cashier') return startAddCashier(phone, rid, session);
  if (p === 'add_manager') return startAddManager(phone, rid, session);
  if (/^(جاهز|استلمت|تم الاستلام)$/.test(bt) && ownerRestaurantId(phone)) return handleOrderActionFromOwner(phone, rid, null, b);
  // 🍽 إدارة المنيو من واتساب (صاحب النشاط)
  if (/^(أصنافي|اصنافي|منيو نشاطي|تحديث المنيو|الموجود|المتوفر)$/.test(bt)) return sendMenuManage(phone, rid);
  if (ownerRestaurantId(phone)) {
    const handled = handleMenuManageCommand(phone, rid, bt);
    if (handled) return handled;
  }
  // 🆔 رقم النشاط (لصاحب النشاط أو مديره)
  if (/^(رقم النشاط|رقم المطعم|رقم المتجر|رقمي|رقم حسابي|معرف النشاط)$/.test(bt)) return sendBusinessNumber(phone, rid);
  // 🔔 وقت التقرير اليومي
  if (/^(وقت التقرير|وقت الرسالة|وقت التقرير اليومي|غير وقت التقرير|غيير وقت التقرير)$/.test(bt)) return startChangeReportHour(phone, rid);
  // 📣 طلب إعلان من النشاط
  if (/^(عرض|اعلان|إعلان|أعلن|اعلن|أعلن عندكم|طلب اعلان|طلب إعلان)$/.test(bt)) return startAdRequestFlow(phone, rid, session);

  // ===== انضمام (نشاط / كابتن / مدير) — والعميل «تسجيل» = إنشاء حسابه =====
  // 🧾 إضافة كاشير (صاحب النشاط فقط)
  if (/^(كاشير|أضف كاشير|اضف كاشير|إضافة كاشير|اضافة كاشير|كاشير جديد)$/.test(b)) return startAddCashier(phone, rid, session);
  // 👥 مستخدمو النشاط
  if (/^(مستخدمين|المستخدمين|فريقي|فريق العمل)$/.test(b)) return sendTeam(phone, rid);
  if (/^(انضمام|انضم)\s*(كابتن|مندوب|توصيل)$/.test(b) || /^تسجيل\s*(كابتن|مندوب)$/.test(b)) return startCaptainReg(phone, rid, session);
  if (/^(انضمام|انضم)\s*(مدير|مدير النشاط|مشرف النشاط|مسؤول النشاط)$/.test(b)) return startManagerJoin(phone, rid, session);
  if (/^(انضمام|انضم)$/.test(b) || /^انضمام\s*(نشاط|مطعم|بقالة|سوبر\s?ماركت|صيدلية|أسرة منتجة|اسر منتجة|متجر|محل)$/.test(b)
      || /^تسجيل\s+(نشاط|مطعم|بقالة|سوبر\s?ماركت|صيدلية|أسرة منتجة|اسر منتجة)$/.test(b)) return startBusinessReg(phone, rid, session);
  // 👤 العميل: «تسجيل» = تسجيل حساب العميل (اسم + موقع)
  if (/^(تسجيل|تسجيل حساب|تسجيل عميل|حساب جديد|تسجيل جديد)$/.test(b) && !/^(reg_|cap_|rep_|ad_|pad_)/.test(state)) return startCustomerSignup(phone, rid, customer, session);

  // ترحيب طبيعي للعميل المعروف — وإن كانت رسالته فيها طلب واضح نكمل معالجته
  if (customer.name && state === 'idle' && (b || p) && needsGreeting(phone)) {
    const isClearRequest = !!findItemByName(rid, b) || wantsSameAsBefore(b) ||
      ['menu','القائمة','المنيو','قائمة الطعام'].includes(String(b).toLowerCase());
    sendGreeting(phone, rid, customer);
    if (!isClearRequest) return;
  }

  // أول زيارة: نطلب اسم العميل ثم نعرض له كل المطاعم
  // (نتخطى هذا أثناء تسجيل نشاط/كابتن حتى لا يخطف مسار الاسم جلسة التسجيل)
  const IN_REG_FLOW = ['reg_type', 'reg_name', 'reg_city', 'reg_district', 'reg_postal', 'reg_owner', 'reg_owner_id', 'reg_items', 'reg_prices', 'reg_review', 'reg_subscribe', 'cap_name', 'cap_id', 'cap_city', 'cap_district', 'cap_vehicle', 'cap_deposit', 'cap_deposit_wait', 'rep_name', 'rep_id', 'rep_phone', 'ad_price', 'ad_content', 'ad_decision', 'ad_waitpay', 'pad_content', 'pad_audience', 'pad_city', 'mgr_pick', 'mgr_name', 'mgr_id', 'mgr_biz', 'mgr_hour', 'rep_hour', 'hour_pick', 'hour_change', 'cash_name', 'cash_phone', 'cash_hour', 'reg_shift', 'reg_s1f', 'reg_s1t', 'reg_s2f', 'reg_s2t', 'reg_lic', 'reg_cr', 'reg_health', 'reg_hdoc', 'cap_reqs', 'cap_color', 'cap_plate', 'cap_license', 'cap_criminal', 'cap_iddoc', 'cap_pledge',
    'reg_id_doc', 'pledge', 'mgr_iddoc', 'mgr_pledge', 'cash_iddoc', 'ask_nid', 'ask_dob', 'reg_entity', 'reg_flno', 'reg_fldoc', 'reg_fldate', 'reg_licdate', 'reg_crdate', 'reg_docs', 'reg_location', 'preorder_date', 'preorder_time', 'final_confirm'].includes(state);
  if (!IN_REG_FLOW && !customer.name && state !== 'ask_name') {
    saveSession(phone, 'ask_name', { ...data, pendingState: 'directory' });
    return send(phone, rid, null, 'text', `السلام عليكم ورحمة الله 🌸\nكيف حالك؟ عساك طيب 😊\n\nأنا *واتس هم* — خدمة الطلبات والتوصيل 🍽️🛵\nأطلب لك من أنشطة كثيرة وأوصله لبابك\n\nوش *اسمك الكريم*؟\n\n_(🏪 عندك نشاط؟ أرسل *انضمام* · 🛵 كابتن توصيل؟ أرسل *انضمام كابتن* · 👤 مدير نشاط؟ أرسل *انضمام مدير*)_`);
  }
  if (!IN_REG_FLOW && state === 'ask_name') {
    if (b.length < 2) return send(phone, rid, null, 'text', 'عطني اسمك الكريم 🌸 عشان أكمل طلبك');
    q.run("UPDATE customers SET name=? WHERE id=?", b.slice(0, 40), customer.id);
    saveSession(phone, 'ask_nid', { ...data, custName: b.slice(0, 40) });
    send(phone, rid, null, 'text', `هلا *${b.slice(0, 40)}* 🌸 الله يحييك ويسعدك!`);
    return send(phone, rid, null, 'text', '🆔 *رقم هويتك الوطنية* أو *الإقامة*؟ (١٠ أرقام — بدون صورة)\n_(لأمان الجميع وتوثيق التعامل)_');
  }
  // 👤 تسجيل العميل: الهوية → تاريخ الميلاد → التعهد
  if (state === 'ask_nid') {
    const nid = validNationalId(b);
    if (!nid) return send(phone, rid, null, 'text', 'رقم الهوية/الإقامة لازم *١٠ أرقام* ويبدأ بـ ١ أو ٢ 🙏\nمثال: 1023456789');
    saveSession(phone, 'ask_dob', { ...data, custNid: nid });
    return send(phone, rid, null, 'text', '🎂 و*تاريخ ميلادك*؟ (مثال: 1998-05-20 أو 1415/05/20)');
  }
  if (state === 'ask_dob') {
    const dob = parseBirthDate(b);
    if (!dob) return send(phone, rid, null, 'text', 'اكتب التاريخ بالشكل: *1998-05-20* أو *20/5/1998* 🙏');
    // 👤 العميل: يكفي رقم الهوية/الإقامة وتاريخ الميلاد — نعطيه رقم تفعيل بدون تعهد
    const code = String(Math.floor(100000 + Math.random() * 900000));
    q.run("UPDATE customers SET national_id=?, birth_date=?, activation_code=?, pledged_at=datetime('now') WHERE id=?", data.custNid || null, dob, code, customer.id);
    send(phone, rid, null, 'text', `✅ *تم تسجيلك* — شكراً لك 🌸\n\n🆔 الهوية: ${data.custNid || ''}\n🎂 الميلاد: ${dob}\n🔢 *رقم التفعيل:* *${code}*`);
    return finishCustomerSignup(phone, rid);
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
    case 'reg_location': return handleRegLocation(phone, rid, session, b, type, lat, lng);
    case 'reg_owner': return handleRegOwner(phone, rid, session, b);
    case 'reg_owner_id': return handleRegOwnerId(phone, rid, session, b);
    case 'reg_items': return handleRegItems(phone, rid, session, b);
    case 'reg_id_doc': return handleRegIdDoc(phone, rid, session, b, mediaRef);
    case 'pledge': return handlePledgeAccept(phone, rid, session, b, p);
    case 'mgr_iddoc': return handleMgrIdDoc(phone, rid, session, b, mediaRef);
    case 'cap_iddoc': return handleCapIdDoc(phone, rid, session, b, mediaRef);
    case 'cash_iddoc': return handleCashIdDoc(phone, rid, session, b, mediaRef);
    case 'final_confirm': return handleFinalConfirm(phone, rid, customer, session, b, p);
    case 'preorder_date': return handlePreorderDate(phone, rid, session, b, p);
    case 'preorder_time': return handlePreorderTime(phone, rid, customer, session, b, p);
    case 'reg_shift': return handleRegShift(phone, rid, session, b, p);
    case 'reg_s1f': {
      const two = session.data.reg?.shifts === 2;
      const indiv = isIndividual(session.data.reg || {});
      const r = parseTimeRange(b);
      if (r) return applyShiftRange(phone, rid, session, r, {
        fromKey: 's1_from', toKey: two ? 's1_to' : 'close_hour',
        nextState: two ? 'reg_s2f' : (indiv ? 'reg_flno' : 'reg_lic'),
        nextQuestion: two ? '✅ الفترة الأولى: *{t}*\n\n🕐 *الفترة الثانية* — متى تبدأ؟'
          : '✅ يقفل *{t}*\n\n' + (indiv ? '📄 *وثيقة العمل الحر* _(لأن النشاط فرد)_ — اكتب *رقم الوثيقة*' : '🏛 *رخصة البلدية* — اكتب *رقم الرخصة*')
      });
      return handleRegShiftTime(phone, rid, session, b, 's1_from', 'reg_s1t', '✅ من {t} — ومتى *يقفل* النشاط؟');
    }
    case 'reg_s1t': {
      const two = session.data.reg?.shifts === 2;
      const indiv = isIndividual(session.data.reg || {});
      return handleRegShiftTime(phone, rid, session, b, two ? 's1_to' : 'close_hour', two ? 'reg_s2f' : (indiv ? 'reg_flno' : 'reg_lic'),
        two ? '✅ الفترة الأولى تنتهي {t}\n\n🕐 *الفترة الثانية* — متى تبدأ؟'
            : '✅ يقفل {t}\n\n' + (indiv ? '📄 *وثيقة العمل الحر* _(لأن النشاط فرد)_ — اكتب *رقم الوثيقة*' : '🏛 *رخصة البلدية* — اكتب *رقم الرخصة*'));
    }
    case 'reg_s2f': {
      const indiv2 = isIndividual(session.data.reg || {});
      const r2 = parseTimeRange(b);
      if (r2) return applyShiftRange(phone, rid, session, r2, {
        fromKey: 's2_from', toKey: 's2_to',
        nextState: indiv2 ? 'reg_flno' : 'reg_lic',
        nextQuestion: '✅ تنتهي الفترة الثانية: *{t}*\n\n' + (indiv2 ? '📄 *وثيقة العمل الحر* — اكتب *رقم الوثيقة*' : '🏛 *رخصة البلدية* — اكتب *رقم الرخصة*')
      });
      return handleRegShiftTime(phone, rid, session, b, 's2_from', 'reg_s2t', '✅ تبدأ {t} — ومتى *تنتهي الفترة الثانية*؟');
    }
    case 'reg_s2t': return handleRegShiftTime(phone, rid, session, b, 's2_to', isIndividual(session.data.reg || {}) ? 'reg_flno' : 'reg_lic', '✅ تنتهي {t}\n\n' + (isIndividual(session.data.reg || {}) ? '📄 *وثيقة العمل الحر* — نطلبها لأن النشاط *فرد*' : '🏛 *رخصة البلدية* — اكتب *رقم الرخصة*'));
    case 'reg_entity': return handleRegEntity(phone, rid, session, b, p);
    case 'reg_flno': return handleRegFreelanceNo(phone, rid, session, b);
    case 'reg_fldate': return handleRegFreelanceDate(phone, rid, session, b);
    case 'reg_docs': return handleRegDocsStart(phone, rid, session);
    case 'reg_lic': return handleRegMunicipal(phone, rid, session, b);
    case 'reg_licdate': return handleRegMunicipalDate(phone, rid, session, b);
    case 'reg_cr': return handleRegCR(phone, rid, session, b);
    case 'reg_crdate': return handleRegCRDate(phone, rid, session, b);
    // بقايا جلسات قديمة (قبل إزالة رفع الملفات): نكملها بدل ما تعلق
    case 'reg_fldoc': return handleRegFreelanceDate(phone, rid, session, b);
    case 'reg_health': return sendRegReview(phone, rid, session.data);
    case 'reg_hdoc': return sendRegReview(phone, rid, session.data);
    case 'reg_prices': return handleRegPrices(phone, rid, session, b);
    case 'reg_review': return handleRegReview(phone, rid, session, b, p);
    case 'reg_subscribe': return handleRegSubscribe(phone, rid, session, b, p);
    case 'cap_reqs': return handleCapReqs(phone, rid, session, b, p);
    case 'cap_color': return handleCapColor(phone, rid, session, b);
    case 'cap_plate': return handleCapPlate(phone, rid, session, b);
    // بقايا جلسات قديمة (قبل إزالة رخصة القيادة وخلو السوابق): نكملها من خطوة صورة الهوية
    case 'cap_license': return handleCapIdDoc(phone, rid, session, b, mediaRef);
    case 'cap_criminal': return handleCapIdDoc(phone, rid, session, b, mediaRef);
    case 'cap_name': return handleCapName(phone, rid, session, b);
    case 'cap_id': return handleCapId(phone, rid, session, b);
    case 'cap_city': return handleCapCity(phone, rid, session, b);
    case 'cap_district': return handleCapDistrict(phone, rid, session, b);
    case 'cap_vehicle': return handleCapVehicle(phone, rid, session, b, p);
    case 'cap_deposit': return handleCapDeposit(phone, rid, session, b, p);
    case 'cap_deposit_wait': return handleCapDeposit(phone, rid, session, b, p);
    case 'cash_name': return handleCashName(phone, rid, session, b);
    case 'cash_phone': return handleCashPhone(phone, rid, session, b);
    case 'cash_hour': return handleCashHour(phone, rid, session, b, p);
    case 'mgr_name': return handleMgrName(phone, rid, session, b);
    case 'mgr_id': return handleMgrId(phone, rid, session, b);
    case 'mgr_biz': return handleMgrBiz(phone, rid, session, b, p);
    case 'mgr_hour': return handleMgrHour(phone, rid, session, b, p);
    case 'rep_hour': return handleRepHour(phone, rid, session, b, p);
    case 'hour_pick': return handleHourPick(phone, rid, session, b, p);
    case 'hour_change': return handleHourChange(phone, rid, session, b, p);
    case 'mgr_pick': return handleMgrPick(phone, rid, session, b, p);
    case 'rep_name': return handleRepName(phone, rid, session, b);
    case 'rep_id': return handleRepId(phone, rid, session, b);
    case 'ad_price': return handleAdPrice(phone, rid, session, b);
    case 'ad_content': return handleAdContent(phone, rid, session, b);
    case 'ad_waitpay': return handleAdWaitPay(phone, rid, session, p);
    case 'pad_content': return handlePlatformAdContent(phone, rid, session, b, imageUrl);
    case 'pad_audience': return handlePlatformAdAudience(phone, rid, session, p);
    case 'pad_city': return handlePlatformAdCity(phone, rid, session, b);
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
    case 'ad_decision': return handleAdDecision(phone, rid, session, p);
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
    const stk = (i.stock_qty === null || i.stock_qty === undefined) ? '' : ` · متبقي ${i.stock_qty}`;
    num += `${ex ? '✅' : '▫️'} ${idx + 1}. ${i.name} — ${rls(i.price)} ر.س${stk}${ex ? `  (×${ex.quantity})` : ''}\n`;
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
      const stk2 = (i.stock_qty === null || i.stock_qty === undefined) ? '' : ` · متبقي ${i.stock_qty}`;
      t += `${ex ? '✅' : '▫️'} ${map.length}. ${i.name} — ${rls(i.price)} ر.س${stk2}${ex ? `  (×${ex.quantity})` : ''}\n`;
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
  // ⛔ الصنف خلص؟ ما نضيفه
  if (!item.is_available || item.stock_qty === 0) {
    return send(phone, rid, null, 'text', `⛔ نعتذر — *${item.name}* خلص حالياً 🙏\nاختر صنف ثاني أو اسأل النشاط عن البديل.`);
  }
  const ex = cart.items.find(i => i.item_id === itemId);
  const wanted = (ex ? ex.quantity : 0) + 1;
  if (item.stock_qty !== null && item.stock_qty !== undefined && wanted > Number(item.stock_qty)) {
    return send(phone, rid, null, 'text', `⚠️ المتوفر من *${item.name}* ${item.stock_qty} فقط — ما نقدر نزيد 🙏`);
  }
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
  const pruned = pruneCart(phone, rid, session.data.cart);
  if (pruned.notes?.length) send(phone, rid, null, 'text', pruned.notes.join('\n'));
  const cart = pruned.cart;
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
    return askDeliveryTimeStart(phone, rid);
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
    return askDeliveryTimeStart(phone, rid);
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
    return askDeliveryTimeStart(phone, rid);
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
  return askDeliveryTimeStart(phone, rid);
}

function saveLocation(customerId, lat, lng, data, p, branch = null) {
  const isDefault = q.get("SELECT COUNT(*) AS c FROM customer_locations WHERE customer_id=?", customerId).c === 0 ? 1 : 0;
  const na = (p && p.startsWith('loc:')) ? p.slice(4) : null;
  const r = q.run("INSERT INTO customer_locations (customer_id, label, national_address, lat, lng, is_default, city) VALUES (?,?,?,?,?,?,?)",
    customerId, isDefault ? 'المنزل' : (data.nextLabel || 'موقع جديد'), na, lat, lng, isDefault, branch?.city || null);
  const saved = q.get("SELECT * FROM customer_locations WHERE id=?", r.lastInsertRowid);
  if (branch) { saved.branch_id = branch.id; saved.branch_name = branch.name; saved.branch = branch; }
  return saved;
}

// 🏠 هل النشاط أسرة منتجة؟ (الطلب المسبق قبلها بيوم)
function isHomeProducer(rid) {
  try {
    const r = q.get("SELECT r.*, b.name_ar AS bt_name FROM restaurants r LEFT JOIN business_types b ON b.id=r.business_type_id WHERE r.id=?", rid);
    return /منتجة|أسر|منزلي/.test(String(r?.bt_name || '')) || String(r?.entity_type || '') === 'أسرة منتجة';
  } catch (e) { return false; }
}
// 🕐 بداية اختيار الوقت: الأسر المنتجة → تاريخ (بكرة أو بعده) · الباقي → فوري
function askDeliveryTimeStart(phone, rid) {
  if (isHomeProducer(rid)) {
    saveSession(phone, 'preorder_date', { ...(getSession(phone).data || {}) });
    send(phone, rid, null, 'text', '🏠 *هذا النشاط أُسر منتجة — والطلب مسبق قبلها بيوم* 🗓️\n\nمتى تحب يجهزون طلبك؟');
    return send(phone, rid, null, 'buttons', 'اختر اليوم 👇', { buttons: [
      { id: 'pdate:1', title: '🗓️ بكرة' },
      { id: 'pdate:2', title: '🗓️ بعد بكرة' }
    ] });
  }
  return askDeliveryTimeStart(phone, rid);
}
function handlePreorderDate(phone, rid, session, b, p) {
  const d = String(p || '').startsWith('pdate:') ? Number(String(p).slice(6)) : Number(String(b || '').replace(/[^\d]/g, ''));
  if (![1, 2, 3].includes(d)) return send(phone, rid, null, 'text', 'اختر *١* بكرة أو *٢* بعد بكرة 🗓️ (أو اكتب 3 لثلاثة أيام)');
  const t = new Date(Date.now() + 3 * 3600 * 1000 + d * 86400000);
  const dateStr = t.toISOString().slice(0, 10);
  const dayAr = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'][t.getUTCDay()];
  saveSession(phone, 'preorder_time', { ...session.data, preorder: { date: dateStr, label: `${dayAr} ${dateStr}` } });
  send(phone, rid, null, 'text', `🗓️ *${dayAr} ${dateStr}* ✅`);
  return send(phone, rid, null, 'buttons', '🕐 متى تحب يوصل؟', { buttons: [
    { id: 'ptime:12:00', title: '🕛 الظهر 12:00' },
    { id: 'ptime:17:00', title: '🕔 العصر 5:00' },
    { id: 'ptime:20:00', title: '🌙 الليل 8:00' }
  ] });
}
async function handlePreorderTime(phone, rid, customer, session, b, p) {
  const raw = String(p || '').startsWith('ptime:') ? String(p).slice(6) : String(b || '').trim();
  const t = /^\d{1,2}:\d{2}$/.test(raw) ? raw.padStart(5, '0') : parseReportHour(raw, { morning: true });
  if (!t) return send(phone, rid, null, 'text', 'اكتب الوقت: 12:00 أو 5 عصراً أو 8 مساءً');
  const pre = session.data.preorder || {};
  const data = { ...session.data, preorder: { ...pre, time: t } };
  return askFinalConfirm(phone, rid, data);
}
// 🧾 ملخص نهائي قبل الإرسال + اعتماد العميل
function buildFinalSummary(phone, rid, data) {
  const session = getSession(phone);
  const pruned = pruneCart(phone, rid, session.data.cart);
  const cart = pruned.cart || { items: [] };
  const rest = q.get("SELECT name_ar FROM restaurants WHERE id=?", rid);
  const branch = data.address?.branch || null;
  const t = cartTotals(rid, cart, branch);
  const pre = data.preorder || session.data.preorder || null;
  const isPickup = !!cart.pickup;
  let s = `🧾 *ملخص طلبك — راجعه قبل الإرسال*\n\n🏪 *${rest?.name_ar || ''}*\n━━━━━━━━━━━━━━\n`;
  for (const i of cart.items) s += `• ${i.name} ×${i.quantity} — ${rls(i.price * i.quantity)} ر.س\n`;
  s += '━━━━━━━━━━━━━━\n';
  if (t.discount) s += `🎁 الخصم: -${rls(t.discount)} ر.س\n`;
  s += `🚚 التوصيل: ${isPickup ? 'استلام من النشاط' : (t.delivery_fee ? rls(t.delivery_fee) + ' ر.س' : 'مجاني')}\n`;
  s += `💰 *الإجمالي: ${rls(t.total)} ر.س*\n`;
  s += `💳 الدفع: ${data.paymentMethod === 'cash' ? '💵 كاش عند الاستلام' : (PAY_METHOD_AR[data.paymentMethod] || data.paymentMethod || '-')}\n`;
  if (pre?.date) s += `📅 *طلب مسبق:* ${pre.label || pre.date} الساعة *${pre.time || ''}*\n`;
  else s += `🕐 الوقت: خلال ~${data.estDeliveryMin || 30} دقيقة\n`;
  if (!isPickup) s += `📍 ${data.address?.national_address || data.address?.label || ''}\n`;
  s += `\n_اضغط ✅ «إرسال الطلب» وننفذه لك._`;
  return { text: s, pruned, totals: t, cart };
}
function askFinalConfirm(phone, rid, data) {
  const { text, pruned } = buildFinalSummary(phone, rid, data);
  if (pruned.notes?.length) send(phone, rid, null, 'text', pruned.notes.join('\n'));
  saveSession(phone, 'final_confirm', { ...data });
  return send(phone, rid, null, 'buttons', text.slice(0, 1000), { buttons: [
    { id: 'fc_send', title: '✅ إرسال الطلب' },
    { id: 'fc_edit', title: '✏️ تعديل السلة' },
    { id: 'fc_cancel', title: '❌ إلغاء' }
  ] });
}
async function handleFinalConfirm(phone, rid, customer, session, b, p) {
  const data = session.data || {};
  if (p === 'fc_cancel' || /^(الغاء|إلغاء|كنسل)$/.test(String(b || '').trim())) {
    return handleCancelRequest(phone, rid, customer, data);
  }
  if (p === 'fc_edit') { saveSession(phone, 'cart', data); return showCart(phone, rid, customer); }
  const ok = p === 'fc_send' || /^(ارسال|إرسال|اعتماد|تأكيد|تاكيد|تم|اوكي|أوكي|موافق)$/.test(String(b || '').trim());
  if (!ok) return askFinalConfirm(phone, rid, data);
  if (data.preorder?.date) {
    const pre = data.preorder;
    const rest = q.get("SELECT * FROM restaurants WHERE id=?", rid);
    const cart = getSession(phone).data.cart || { items: [] };
    const totals = cartTotals(rid, cart, data.address?.branch || null);
    const order = createOrder({ restaurant: rest, customer, cart, totals, paymentMethod: data.paymentMethod || 'cash',
      address: data.address || pickupAddress(rid), estDeliveryMin: 30, branch: data.address?.branch || null,
      orderType: cart.pickup ? 'pickup' : 'delivery', scheduledFor: pre.date, scheduledTime: pre.time, isPreorder: true });
    saveSession(phone, 'idle', {});
    send(phone, rid, order.id, 'text', `✅ *تم إرسال طلبك المسبق ${order.order_no}* 🗓️\n\n🏪 ${rest.name_ar}\n📅 *${pre.label || pre.date}* الساعة *${pre.time}*\n💰 الإجمالي: ${rls(totals.total)} ر.س\n\n🔔 نعرض الطلب على الكباتن *يوم التسليم* ونبلغك 👍`);
    if (config.adminPhone) waSend({ phone: config.adminPhone, type: 'text', body: `🏠 طلب مسبق جديد ${order.order_no} — ${rest.name_ar}\n📅 ${pre.label || pre.date} ${pre.time}` }).catch(() => {});
    return;
  }
  const cart = getSession(phone).data.cart || {};
  if (cart.pickup) return placeOrder(phone, rid, customer, { ...data, orderType: 'pickup', address: data.address || pickupAddress(rid) });
  return startDeliveryBidding(phone, rid, customer, data);
}

function askTime(phone, rid) {
  send(phone, rid, null, 'text', '🕐 متى تحب يوصل طلبك؟');
  return send(phone, rid, null, 'buttons', '', { buttons: [
    { id: 'time:30', title: '⚡ أسرع وقت (~30 د)' }, { id: 'time:45', title: '🕐 خلال 45 دقيقة' }, { id: 'time:90', title: '🕑 خلال ساعة ونصف' }
  ] });
}
function handleDeliveryTime(phone, rid, customer, data, p) {
  const est = String(p || '').startsWith('time:') ? Number(String(p).split(':')[1]) : 30;
  return askFinalConfirm(phone, rid, { ...data, estDeliveryMin: est });
}

// ---------- 🚕 مزاد سعر التوصيل ----------
const BID_WINDOW_SECONDS = Number(process.env.BID_WINDOW_SECONDS || 90);
const vehicleAr = (v) => v === 'سيارة' ? '🚗 سيارة' : v === 'شاحنة صغيرة' ? '🚚 شاحنة' : '🏍 دراجة';

// العميل أكمل بياناته → ننشئ الطلب ونعرضه على الكباتن لتحديد السعر
async function startDeliveryBidding(phone, rid, customer, data) {
  const session = getSession(phone);
  const pruned = pruneCart(phone, rid, session.data.cart);
  if (pruned.notes?.length) send(phone, rid, null, 'text', pruned.notes.join('\n'));
  const cart = pruned.cart;
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
// 🧹 استئناف إغلاق المزايدات التي ضاع مؤقّتها
// نافذة التسعير (٩٠ ثانية) تُغلق بـsetTimeout في الذاكرة، فإذا أُعيد تشغيل السيرفر
// (نشر جديد · نوم الخدمة · انقطاع) يضيع المؤقّت ويبقى الطلب معلّقًا بلا إغلاق.
// هذا الفحص يلتقطها ويستأنف ما كان المؤقّت سيفعله: إعادة البث حتى ٤ محاولات ثم تبليغ الإدارة.
export async function sweepStaleBiddings() {
  try {
    const rows = q.all(`SELECT o.id FROM orders o
        WHERE o.chosen_captain_id IS NULL
          AND o.status IN ('new','confirmed','preparing','ready','offered')
          AND o.bid_until IS NOT NULL
          AND o.bid_until <= datetime('now','-30 seconds')
          AND NOT EXISTS (SELECT 1 FROM captain_offers co WHERE co.order_id=o.id AND co.bid_amount IS NOT NULL)
        ORDER BY o.id LIMIT 50`);
    for (const r of rows) {
      try { await closeBidding(r.id); }
      catch (e) { console.error('BID_SWEEP_CLOSE_FAIL', r.id, e.message); }
    }
    if (rows.length) console.log('BID_SWEEP_CLOSED', rows.length);
    return rows.length;
  } catch (e) {
    console.error('BID_SWEEP_FAIL', e.message);
    return 0;
  }
}

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
  const pruned0 = pruneCart(phone, rid, session.data.cart);
  if (pruned0.notes?.length) send(phone, rid, null, 'text', pruned0.notes.join('\n'));
  const cart = pruned0.cart;
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

// 🔑 كلمات التخطي في خطوات المستندات (كانت محذوفة بالخطأ في تعديل سابق)
const DOC_SKIP = /^(تخطى|تخطي|بدون|لا يوجد|ما عندي|لاحقاً|لاحقا|بعدين|موجود|تجاوز)$/;

// 🪪 الهوية وجهان: الأمامي ثم الخلفي — لكل الأدوار (مالك · كابتن · مدير · كاشير)
function sendIdPrompt(phone, rid, back, label = 'صورة هويتك الوطنية') {
  if (back) return send(phone, rid, null, 'text', '📄 *الوجه الخلفي للهوية*\n\n📎 أرسل صورة واضحة للخلف\n_(أو اكتب *تخطى* لتجاوزه)_');
  return send(phone, rid, null, 'text', `🪪 *${label}* (أو الإقامة)\n\n📎 أرسل صورة واضحة *للوجه الأمامي*\n_(أو اكتب *تخطى*)_`);
}
const idNeedRetry = (back) => back
  ? '📎 أرسل صورة *الوجه الخلفي*، أو اكتب *تخطى* 🙏'
  : '📎 أرسل صورة *الوجه الأمامي*، أو اكتب *تخطى* 🙏';

// 🪪 استقبال صورة هوية (أمامي ثم خلفي) — يرجّع true إذا اكتملت الخطوة
// المتغير container هو الكائن الحاوي (reg / mgr / cash)
function collectIdSide(container, mediaRef) {
  if (mediaRef) {
    if (!container.id_doc) { container.id_doc = mediaRef; return false; }
    container.id_doc_back = container.id_doc_back || mediaRef;
    return true;
  }
  return true; // تخطّى (DOC_SKIP) — نكمّل
}

function cancelReg(phone, rid, session) {
  saveSession(phone, 'idle', { ...session.data, reg: null });
  return send(phone, rid, null, 'text', 'تم إلغاء التسجيل 👍\nاكتب *انضمام* متى ما تحب تبدّي من جديد.');
}

// ---- تسجيل نشاط ----
function startBusinessReg(phone, rid, session) {
  const types = q.all("SELECT * FROM business_types WHERE is_active=1 ORDER BY sort_order, id");
  saveSession(phone, 'reg_type', { ...session.data, reg: { phone } });
  if (!types.length) return send(phone, rid, null, 'text', 'خدمة الانضمام غير متاحة حالياً 🙏');
  let t = '🏪 *انضمام نشاط جديد*\n\nوش نوع نشاطك؟ أرسل الرقم:\n';
  types.forEach((x, i) => { t += `${i + 1}. ${x.icon} ${x.name_ar}\n`; });
  t += '\n_(لإلغاء التسجيل في أي وقت اكتب: إلغاء)_';
  send(phone, rid, null, 'text', t);
  return send(phone, rid, null, 'list', 'اختر نوع النشاط 👇', { list: [{ title: 'أنواع الأنشطة', rows: types.map(x => ({ id: 'btype:' + x.id, title: String(x.name_ar).slice(0, 24), description: '' })) }] });
}

const fmtH = (h) => { if (!h) return '-'; const [a, b] = String(h).split(':'); let x = Number(a); const ap = x >= 12 ? 'م' : 'ص'; if (x === 0) x = 12; else if (x > 12) x -= 12; return `${x}:${b} ${ap}`; };
const isRestaurantType = (typeId) => {
  const t = q.get("SELECT name_ar FROM business_types WHERE id=?", Number(typeId));
  return /مطعم|مطاعم|كافي|مقهى/.test(String(t?.name_ar || ''));
};

function handleRegType(phone, rid, session, b, p) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const types = q.all("SELECT * FROM business_types WHERE is_active=1 ORDER BY sort_order, id");
  let t = null;
  if (p && p.startsWith('btype:')) t = types.find(x => x.id === Number(p.split(':')[1]));
  else { const n = parseInt(String(b).trim(), 10); if (n >= 1 && n <= types.length) t = types[n - 1]; }
  if (!t) return startBusinessReg(phone, rid, session);
  saveSession(phone, 'reg_entity', { ...session.data, reg: { ...(session.data.reg || { phone }), type_id: t.id, type_name: t.name_ar, icon: t.icon } });
  return send(phone, rid, null, 'buttons', `${t.icon} تمام — *${t.name_ar}*\n\nالنشاط *فرد* أو *مؤسسة* أو *شركة*؟`, { buttons: [
    { id: 'ent:فرد', title: '👤 فرد' },
    { id: 'ent:مؤسسة', title: '🏢 مؤسسة' },
    { id: 'ent:شركة', title: '🏛 شركة' }
  ] });
}
function handleRegEntity(phone, rid, session, b, p) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const v = (p && String(p).startsWith('ent:') ? String(p).slice(4) : String(b || '').trim());
  const ent = /فرد/.test(v) ? 'فرد' : /مؤسس/.test(v) ? 'مؤسسة' : /شرك/.test(v) ? 'شركة' : null;
  if (!ent) return send(phone, rid, null, 'text', 'اختر: *فرد* أو *مؤسسة* أو *شركة* 🙏');
  saveSession(phone, 'reg_name', { ...session.data, reg: { ...session.data.reg, entity_type: ent } });
  const extra = ent === 'فرد' ? '\n_(الفرد: نطلب منك *وثيقة العمل الحر* فقط)_' : '\n_(نطلب رخصة البلدية والسجل التجاري)_';
  return send(phone, rid, null, 'text', `🏷 *${ent}*${extra}\n\nوش *اسم النشاط*؟`);
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
  saveSession(phone, 'reg_location', { ...session.data, reg: { ...session.data.reg, postal: code ? code.slice(0, 12) : null } });
  send(phone, rid, null, 'text', `${code ? '🔢 ' + code + '\n\n' : ''}📍 *أرسل موقع النشاط* — بدون موقع ما يظهر نشاطك للعملاء القريبين منك.\n(في واتساب: زر 📎 ← الموقع)\n\n_(أو اكتب *تخطى* — ويكون النشاط مخفيًا حتى تحدد الإحداثيات من لوحة التحكم)_`);
  return send(phone, rid, null, 'buttons', '', { buttons: [{ id: 'send_location_reg', title: '📍 إرسال موقع النشاط' }] });
}

// 📍 موقع النشاط (إحداثيات) — أساس ظهور النشاط للعملاء القريبين
function handleRegLocation(phone, rid, session, b, type, lat, lng) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const reg = { ...(session.data.reg || {}) };
  const askOwner = () => send(phone, rid, null, 'text', '👤 وش *اسم المسؤول* عن النشاط؟ (الاسم الكامل)');
  if (type === 'location' && lat != null && lng != null) {
    reg.lat = Number(lat); reg.lng = Number(lng);
    saveSession(phone, 'reg_owner', { ...session.data, reg });
    send(phone, rid, null, 'text', `📍 تم استلام موقع النشاط ✅\n(${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)})`);
    return askOwner();
  }
  if (DOC_SKIP.test(String(b || '').trim())) {
    saveSession(phone, 'reg_owner', { ...session.data, reg });
    return askOwner();
  }
  return send(phone, rid, null, 'buttons', '📍 أرسل موقع النشاط عشان يطلع للعملاء القريبين منك.\n(في واتساب: زر 📎 ← الموقع)', { buttons: [{ id: 'send_location_reg', title: '📍 إرسال موقع النشاط' }] });
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
  saveSession(phone, 'reg_id_doc', { ...session.data, reg: { ...session.data.reg, owner_id: id } });
  return send(phone, rid, null, 'text', '🪪 *صورة هويتك الوطنية* (أو الإقامة)\n\n📎 أرسل صورة واضحة للوجه والخلف\n_(أو اكتب *تخطى*)_');
}
async function handleRegIdDoc(phone, rid, session, b, mediaRef) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const reg = { ...(session.data.reg || {}) };
  if (mediaRef || DOC_SKIP.test(String(b || '').trim())) {
    if (!collectIdSide(reg, mediaRef)) {
      saveSession(phone, 'reg_id_doc', { ...session.data, reg });
      return sendIdPrompt(phone, rid, true);
    }
  } else return send(phone, rid, null, 'text', idNeedRetry(!!reg.id_doc));
  saveSession(phone, 'reg_items', { ...session.data, reg });
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
  if (withPrice === items.length) return askShifts(phone, rid, next);
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
  return askShifts(phone, rid, next);
}

// ================= 🕐 دوام النشاط والفترات + المستندات =================
function askShifts(phone, rid, data) {
  saveSession(phone, 'reg_shift', data);
  return send(phone, rid, null, 'buttons', '🕐 *دوام النشاط*\n\nالعمل *فترة واحدة* أو *فترتان* في اليوم؟', { buttons: [
    { id: 'shift:1', title: '1️⃣ فترة واحدة' },
    { id: 'shift:2', title: '2️⃣ فترتان' }
  ] });
}
function handleRegShift(phone, rid, session, b, p) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const raw = (p && String(p).startsWith('shift:')) ? String(p).slice(6) : String(b).replace(/[^\d١٢]/g, '');
  const n = raw === '2' || raw === '٢' ? 2 : (raw === '1' || raw === '١' ? 1 : null);
  if (!n) return send(phone, rid, null, 'text', 'اختر *١* فترة واحدة أو *٢* فترتان 🙏');
  const reg = { ...(session.data.reg || {}), shifts: n };
  saveSession(phone, 'reg_s1f', { ...session.data, reg });
  return send(phone, rid, null, 'text', n === 1
    ? '🕐 متى *يفتح* النشاط؟ (مثال: 8 صباحاً · 9:00 · 16:00)\n_(أو أرسل الفترة كاملة: من 8 صباحاً إلى 8 مساءً)_'
    : '🕐 *الفترة الأولى* — متى تبدأ؟ (مثال: 8 صباحاً)\n_(أو أرسل الفترة كاملة: من 8 صباحاً إلى 12 ظهراً)_');
}
// ⏰ قراءة فترة كاملة في رسالة واحدة: «من 8 صباحاً إلى 8 مساءً» · «من 9:00 الى 17:00» · «8 - 20»
function parseTimeRange(input) {
  const t = String(input || '').trim()
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ');
  if (!t) return null;
  const alt = 'إلى|الى|إلي|الي|حتى|لحد|لغاية|to';
  let m = t.match(new RegExp(`^(?:من\\s+)?(.+?)\\s+(?:${alt})\\s+(.+)$`, 'i'));
  if (!m) m = t.match(/^(?:من\s+)?(.+?)\s*-\s*(.+)$/);
  if (!m) return null;
  const from = parseReportHour(m[1], { morning: true });
  const to = parseReportHour(m[2], { morning: true });
  return (from && to) ? { from, to } : null;
}

// تطبيق فترة كاملة: نحفظ البداية والنهاية ونتجاوز سؤال النهاية
function applyShiftRange(phone, rid, session, range, { fromKey, toKey, nextState, nextQuestion }) {
  const reg = { ...(session.data.reg || {}), [fromKey]: range.from, [toKey]: range.to };
  saveSession(phone, nextState, { ...session.data, reg });
  return send(phone, rid, null, 'text', String(nextQuestion || '').replace('{t}', fmtH(range.to)));
}

const TIME_HINT = '⏰ ما فهمت الوقت 🙏\n\nاكتبه مثل: *8 صباحاً* · *9:00* · *16:30*\nأو أرسل الفترة كاملة: *من 8 صباحاً إلى 8 مساءً*';

function handleRegShiftTime(phone, rid, session, b, key, nextState, question) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const h = parseReportHour(b, { morning: true });
  if (!h) return send(phone, rid, null, 'text', TIME_HINT);
  const reg = { ...(session.data.reg || {}), [key]: h };
  saveSession(phone, nextState, { ...session.data, reg });
  return send(phone, rid, null, 'text', question.replace('{t}', fmtH(h)));
}

// 🔢 رقم مستند: ٤ خانات على الأقل ويحتوي رقمين على الأقل
const DOC_NO_OK = (s) => { const t = String(s || '').trim(); return t.length >= 4 && (t.match(/\d/g) || []).length >= 2; };
// 📅 تاريخ إصدار مستند: يقبل 2025-03-15 · 15/3/2025 · 15-03-2025
function parseDocDate(x) {
  const t = String(x || '').replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).trim();
  let m = t.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; }
  return null;
}
// 📅 قراءة تاريخ الإصدار -> { skip } أو { date } أو { err }
function readDocDate(b) {
  const raw = String(b || '').trim();
  if (DOC_SKIP.test(raw)) return { skip: true, date: null };
  const d = parseDocDate(raw);
  return d ? { skip: false, date: d } : { err: true };
}
const DOC_DATE_HINT = 'اكتب تاريخ الإصدار بصيغة *2025-03-15* أو *15/3/2025* 🙏 (أو *تخطى*)';

// 🚪 بداية مرحلة بيانات المستندات (رقم + تاريخ إصدار — بدون رفع ملفات):
// فرد/أسر منتجة -> رقم وثيقة العمل الحر · مؤسسة/شركة -> رقم رخصة البلدية + رقم السجل التجاري
function handleRegDocsStart(phone, rid, session) {
  const reg = { ...(session.data.reg || {}) };
  if (isIndividual(reg)) return askFreelance(phone, rid, session);
  saveSession(phone, 'reg_lic', { ...session.data });
  return send(phone, rid, null, 'text', '🏛 *رخصة البلدية*\n\nاكتب *رقم الرخصة*');
}
// 👤 الفرد/الأسر المنتجة: وثيقة العمل الحر (رقم + تاريخ إصدار)
async function askFreelance(phone, rid, session) {
  saveSession(phone, 'reg_flno', { ...session.data });
  return send(phone, rid, null, 'text', '📄 *وثيقة العمل الحر*\n\nاكتب *رقم الوثيقة*');
}
async function handleRegFreelanceNo(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const raw = String(b || '').trim();
  if (DOC_SKIP.test(raw)) return afterRegDocs(phone, rid, { ...session.data });
  if (!DOC_NO_OK(raw)) return send(phone, rid, null, 'text', 'اكتب رقم وثيقة العمل الحر 🙏 (أو *تخطى*)');
  saveSession(phone, 'reg_fldate', { ...session.data, reg: { ...session.data.reg, freelance_no: raw.slice(0, 40) } });
  return send(phone, rid, null, 'text', `✅ رقم الوثيقة: *${raw.slice(0, 40)}*\n\n📅 متى *تاريخ إصدارها*؟ (مثال: 2025-03-15)`);
}
async function handleRegFreelanceDate(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const r = readDocDate(b);
  if (r.err) return send(phone, rid, null, 'text', DOC_DATE_HINT);
  return afterRegDocs(phone, rid, { ...session.data, reg: { ...session.data.reg, freelance_issued_at: r.date } });
}
// 🏛 رخصة البلدية: رقم + تاريخ إصدار
async function handleRegMunicipal(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const reg = { ...(session.data.reg || {}) };
  const raw = String(b || '').trim();
  if (DOC_SKIP.test(raw)) { saveSession(phone, 'reg_licdate', { ...session.data, reg }); return send(phone, rid, null, 'text', '📅 *تاريخ إصدار الرخصة*؟ _(أو *تخطى*)_'); }
  if (!DOC_NO_OK(raw)) return send(phone, rid, null, 'text', 'اكتب *رقم رخصة البلدية* 🙏 (أو *تخطى*)');
  saveSession(phone, 'reg_licdate', { ...session.data, reg: { ...reg, municipal_no: raw.slice(0, 40) } });
  return send(phone, rid, null, 'text', `✅ رقم الرخصة: *${raw.slice(0, 40)}*\n\n📅 متى *تاريخ إصدارها*؟ (مثال: 2025-03-15)`);
}
async function handleRegMunicipalDate(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const r = readDocDate(b);
  if (r.err) return send(phone, rid, null, 'text', DOC_DATE_HINT);
  saveSession(phone, 'reg_cr', { ...session.data, reg: { ...session.data.reg, municipal_issued_at: r.date } });
  return send(phone, rid, null, 'text', '📄 *السجل التجاري*\n\nاكتب *رقم السجل التجاري*');
}
// 📄 السجل التجاري: رقم + تاريخ إصدار
async function handleRegCR(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const reg = { ...(session.data.reg || {}) };
  const raw = String(b || '').trim();
  if (DOC_SKIP.test(raw)) return sendRegReview(phone, rid, { ...session.data, reg });
  if (!DOC_NO_OK(raw)) return send(phone, rid, null, 'text', 'اكتب *رقم السجل التجاري* 🙏 (أو *تخطى*)');
  saveSession(phone, 'reg_crdate', { ...session.data, reg: { ...reg, cr_no: raw.slice(0, 40) } });
  return send(phone, rid, null, 'text', `✅ رقم السجل: *${raw.slice(0, 40)}*\n\n📅 متى *تاريخ إصداره*؟ (مثال: 2025-03-15)`);
}
async function handleRegCRDate(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const r = readDocDate(b);
  if (r.err) return send(phone, rid, null, 'text', DOC_DATE_HINT);
  return afterRegDocs(phone, rid, { ...session.data, reg: { ...session.data.reg, cr_issued_at: r.date } });
}
// بعد بيانات المستندات: إلى المراجعة مباشرة (أُزيلت خطوة الشهادات الصحية من طلب التسجيل)
function afterRegDocs(phone, rid, data) {
  return sendRegReview(phone, rid, data);
}
function isIndividual(reg) {
  return reg.entity_type === 'فرد' || /أسر منتجة|اسر منتجة|منزل/.test(String(reg.type_name || ''));
}

function sendRegReview(phone, rid, data) {
  const reg = data.reg || {};
  const items = reg.items || [];
  let t = '📋 *مراجعة طلب الانضمام*\n\n';
  t += `🏷 النوع: ${reg.icon || ''} ${reg.type_name || ''}\n🍽 الاسم: *${reg.name || ''}*\n📍 المدينة: ${reg.city || ''}\n🏘 الحي: ${reg.district || '—'}${reg.owner ? `\n👤 المسؤول: ${reg.owner}${reg.owner_id ? ' — هوية ' + reg.owner_id : ''}` : ''}${reg.postal ? `\n🔢 الرمز البريدي: ${reg.postal}` : ''}\n📱 الجوال: ${reg.phone}\n\n`;
  t += `*الأصناف (${items.length}):*\n`;
  t += items.slice(0, 12).map((i, idx) => `${idx + 1}. ${i.name}${i.price ? ' — ' + rls(i.price) + ' ر.س' : ' — ❓ بلا سعر'}`).join('\n');
  if (items.length > 12) t += `\n… و${items.length - 12} غيرها`;
  if (reg.shifts) {
    const sh = reg.shifts === 2
      ? `فترتان: ${fmtH(reg.s1_from)} – ${fmtH(reg.s1_to)} · ${fmtH(reg.s2_from)} – ${fmtH(reg.s2_to)}`
      : `فترة واحدة: ${fmtH(reg.s1_from)} – ${fmtH(reg.close_hour)}`;
    t += `\n\n🕐 الدوام: ${sh}`;
  }
  t += `\n🏷 الكيان: *${reg.entity_type || '-'}*`;
  if (isIndividual(reg)) {
    t += `\n📄 وثيقة العمل الحر: ${reg.freelance_no ? 'رقم ' + reg.freelance_no : '⚠️ بلا رقم'}${reg.freelance_issued_at ? ' · تاريخ الإصدار: ' + reg.freelance_issued_at : ''}`;
  } else {
    t += `\n🏛 رخصة البلدية: ${reg.municipal_no ? 'رقم ' + reg.municipal_no : '⚠️ بلا رقم'}${reg.municipal_issued_at ? ' · تاريخ الإصدار: ' + reg.municipal_issued_at : ''}`;
    t += `\n📄 السجل التجاري: ${reg.cr_no ? 'رقم ' + reg.cr_no : '⚠️ بلا رقم'}${reg.cr_issued_at ? ' · تاريخ الإصدار: ' + reg.cr_issued_at : ''}`;
  }
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
    const reg0 = session.data.reg || {};
    return askPledge(phone, rid, { kind: 'owner', name: reg0.owner || null, national_id: reg0.owner_id || null, doc: reg0.id_doc || null, doc_back: reg0.id_doc_back || null, next: 'reg_subscribe_now', data: session.data });
  }
  if (p === 'reg_pledged_ok') {
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
    const r = q.run(`INSERT INTO business_registrations (kind, phone, business_name, business_type_id, city, district, postal_code, owner_name, owner_id, id_doc, id_doc_back, items_json, subscription_paid, note, status,
        open_hour, close_hour, shifts, s1_from, s1_to, s2_from, s2_to, entity_type,
        municipal_no, municipal_issued_at, cr_no, cr_issued_at, freelance_no, freelance_issued_at,
        municipal_doc, cr_doc, freelance_doc, health_count, health_docs, lat, lng)
      VALUES ('business', ?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending_review', ?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?,?)`,
      phone, reg.name || '', reg.type_id || null, reg.city || null, reg.district || null, reg.postal || null, reg.owner || null, reg.owner_id || null, reg.id_doc || null, reg.id_doc_back || null, JSON.stringify(items), subscriptionPaid ? 1 : 0, claimed ? 'يقول إنه حوّل الاشتراك' : null,
      reg.s1_from || null, (reg.shifts === 2 ? reg.s2_to : reg.close_hour) || null, reg.shifts || 1,
      reg.s1_from || null, reg.s1_to || null, reg.s2_from || null, reg.s2_to || null, reg.entity_type || null,
      reg.municipal_no || null, reg.municipal_issued_at || null, reg.cr_no || null, reg.cr_issued_at || null, reg.freelance_no || null, reg.freelance_issued_at || null,
      reg.municipal_doc || null, reg.cr_doc || null, reg.freelance_doc || null, reg.health_count || null, reg.health_docs || null,
      reg.lat || null, reg.lng || null);
    const row = q.get("SELECT * FROM business_registrations WHERE id=?", Number(r.lastInsertRowid));
    saveSession(phone, 'idle', { ...session.data, reg: null });
    const ok = await notifySupervisor(row);
    return send(phone, rid, null, 'text', ok
      ? `🎉 *تم إرسال طلبك للإدارة!*\n\n🍽 ${reg.name}\n🍽 الأصناف: ${items.length}\n📍 ${[reg.city, reg.district, reg.postal].filter(Boolean).join(' — ')}\n👤 ${reg.owner || ''}\n\nبنراجعه ونبلغك بالاعتماد قريباً 🙏`
      : '✅ تم حفظ طلبك.\n\n⚠️ رقم المشرف غير مضبوط — كلّم الإدارة للاعتماد.');
  }
}

// ---- تسجيل كابتن ----
const CAP_REQS = `🛵 *انضمام كابتن توصيل — واتس هم*\n\n📋 *جهّز هذي الطلبات قبل ما تبدأ:*\n1️⃣ *اسمك* و*رقم هويتك* (١٠ أرقام)\n2️⃣ *مدينتك* والحي اللي تشتغل فيه\n3️⃣ *وسيلة النقل* ولون المركبة و*رقم اللوحة*\n4️⃣ *صورة هويتك* 🪪 (أو الإقامة)\n5️⃣ *تأمين الحساب* ٥٠٠ ر.س (يُحفظ رصيداً لك)\n\n⚠️ الطلب الناقص ما يُعتمد.\n\nجاهز؟ نبدأ خطوة خطوة 👇`;

function startCaptainReg(phone, rid, session) {
  if (isCaptainPhone(phone)) return send(phone, rid, null, 'text', 'أنت مسجّل عندنا كابتن توصيل ✅ — بيجيك الطلبات هنا.');
  saveSession(phone, 'cap_reqs', { ...session.data, reg: { phone, kind: 'captain' } });
  send(phone, rid, null, 'text', CAP_REQS);
  return send(phone, rid, null, 'buttons', 'جاهز نبدأ؟', { buttons: [
    { id: 'cap_go', title: '✅ جاهز — نبدأ' },
    { id: 'cap_cancel', title: '❌ لاحقاً' }
  ] });
}
function handleCapReqs(phone, rid, session, b, p) {
  if (p === 'cap_cancel' || REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  if (p === 'cap_go' || /^(جاهز|نبدأ|ابدأ|يلا|متابعة|ok|اوكي)$/i.test(String(b || '').trim())) {
    saveSession(phone, 'cap_name', { ...session.data, reg: { ...(session.data.reg || {}), phone, kind: 'captain' } });
    return send(phone, rid, null, 'text', '🛵 *انضمام كابتن توصيل*\n\nوش *اسمك*؟');
  }
  return send(phone, rid, null, 'buttons', 'اضغط ✅ «جاهز — نبدأ» 👇', { buttons: [
    { id: 'cap_go', title: '✅ جاهز — نبدأ' }, { id: 'cap_cancel', title: '❌ لاحقاً' }
  ] });
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
  saveSession(phone, 'cap_color', { ...session.data, reg: { ...(session.data.reg || {}), vehicle: v.slice(0, 30) } });
  return send(phone, rid, null, 'text', `🚗 وسيلة النقل: *${v}*\n\n🎨 وش *لون المركبة*؟`);
}

// 🎨 لون المركبة → 🔢 رقم اللوحة → 🪪 صورة الهوية → التعهد → التأمين
function handleCapColor(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const c = String(b || '').trim();
  if (c.length < 2) return send(phone, rid, null, 'text', 'اكتب لون المركبة 🎨 (مثال: أبيض)');
  saveSession(phone, 'cap_plate', { ...session.data, reg: { ...session.data.reg, vehicle_color: c.slice(0, 30) } });
  return send(phone, rid, null, 'text', '🔢 و*رقم اللوحة*؟ (مثال: أ ب ج 1234)');
}
function handleCapPlate(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const pl = String(b || '').trim();
  if (pl.length < 3) return send(phone, rid, null, 'text', 'اكتب رقم اللوحة 🔢 (مثال: أ ب ج 1234)');
  saveSession(phone, 'cap_iddoc', { ...session.data, reg: { ...session.data.reg, vehicle_plate: pl.slice(0, 30) } });
  return sendIdPrompt(phone, rid, false);
}
async function handleCapIdDoc(phone, rid, session, b, mediaRef) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const reg = { ...(session.data.reg || {}) };
  if (mediaRef || DOC_SKIP.test(String(b || '').trim())) {
    if (!collectIdSide(reg, mediaRef)) {
      saveSession(phone, 'cap_iddoc', { ...session.data, reg });
      return sendIdPrompt(phone, rid, true);
    }
  } else return send(phone, rid, null, 'text', idNeedRetry(!!reg.id_doc));
  saveSession(phone, 'cap_pledge', { ...session.data, reg });
  return askPledge(phone, rid, { kind: 'captain', name: reg.name || null, national_id: reg.national_id || null, doc: reg.id_doc || null, doc_back: reg.id_doc_back || null, next: 'cap_deposit_now', data: { ...session.data, reg } });
}

// 💰 خطوة تأمين الحساب (تُستدعى بعد التعهد كذلك)
function sendCapDeposit(phone, rid, data) {
  saveSession(phone, 'cap_deposit', data);
  send(phone, rid, null, 'text', `💰 *تأمين الحساب: ${rls(Number(config.captainDeposit || 50000))} ر.س*\n\nمبلغ تأمين يُدفع مرة واحدة، ويُحفظ لك رصيد — وكل ما وصلت مبالغك المحصّلة للحدّ نوقف الاستقبال مؤقتاً حتى التسوية ✅`);
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
  const r = q.run(`INSERT INTO business_registrations (kind, phone, business_name, city, district, owner_id, id_doc, id_doc_back, vehicle_type, vehicle_plate, vehicle_color, license_doc, criminal_doc, deposit_paid, note, status)
    VALUES ('captain', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')`,
    phone, reg.name || '', reg.city || null, reg.district || null, reg.national_id || null, reg.id_doc || null, reg.id_doc_back || null, v.slice(0, 30),
    reg.vehicle_plate || null, reg.vehicle_color || null, reg.license_doc || null, reg.criminal_doc || null,
    depositPaid ? 1 : 0, claimed ? 'يقول إنه حوّل التأمين' : null);
  const row = q.get("SELECT * FROM business_registrations WHERE id=?", Number(r.lastInsertRowid));
  saveSession(phone, 'idle', { ...session.data, reg: null });
  const ok = await notifySupervisor(row);
  return send(phone, rid, null, 'text', ok
    ? `✅ *تم إرسال طلب انضمامك للإدارة*\n\n👤 ${reg.name}\n🔢 ${reg.national_id || ''}\n📍 ${reg.city}${reg.district ? ' — ' + reg.district : ''}\n🛵 ${v}\n\nبنبلغك بالاعتماد قريباً 🙏`
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
  if (!rrid) return send(phone, rid, null, 'text', '📊 هذي الخدمة لأصحاب الأنشطة المسجّلين عندنا 🌸\n\nسجّل نشاطك أولاً بكتابة *انضمام* وجاهزين نخدمك.');
  saveSession(phone, 'rep_name', { ...session.data, reg: null, rep: { restaurant_id: rrid } });
  return send(phone, rid, null, 'text', '👤 *إضافة مدير المطعم* — بيوصله *تقرير المبيعات اليومي* على واتساب (المجموع الختام · شبكة · كاش).\n\nوش *اسمه*؟');
}
// 👤 إكمال تسجيل العميل بعد التعهد (الموقع ثم عرض الأنشطة)
function finishCustomerSignup(phone, rid) {
  const loc = getCustomerLocation(phone);
  if (!loc || loc.lat == null || loc.lng == null) {
    saveSession(phone, 'signup_location', {});
    send(phone, rid, null, 'text', '📍 *خطوة أخيرة:* أرسل موقعك الحالي\nعشان نعرض لك *أقرب الأنشطة* ونحسب التوصيل بدقة ✅');
    return send(phone, rid, null, 'buttons', 'في واتساب: زر 📎 ← الموقع 👇', { buttons: [{ id: 'send_location', title: '📍 إرسال الموقع' }] });
  }
  return showRestaurants(phone);
}
// 🎂 تحويل تاريخ الميلاد
function parseBirthDate(x) {
  const t = String(x || '').replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).trim();
  let m = t.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  m = t.match(/^(\d{8})$/);
  if (m) return `${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)}`;
  m = t.match(/^(\d{6})$/);
  if (m) return `19${m[1].slice(4,6)}-${m[1].slice(2,4)}-${m[1].slice(0,2)}`;
  return null;
}

// 👤 تسجيل حساب العميل (اسم + موقع) — ما يحتاج أكثر
function startCustomerSignup(phone, rid, customer, session) {
  const loc = getCustomerLocation(phone);
  if (customer.name && loc && loc.lat != null) {
    send(phone, rid, null, 'text', `✅ *حسابك مسجّل عندنا باسم ${customer.name}* 🌸\n📍 موقعك محفوظ:\n${loc.national_address || loc.label || ''}`);
    return showRestaurants(phone);
  }
  if (customer.name) {
    saveSession(phone, 'signup_location', { ...session.data });
    send(phone, rid, null, 'text', `هلا *${customer.name}* 🌸 باقي بس *موقعك* 📍`);
    return send(phone, rid, null, 'buttons', 'في واتساب: زر 📎 ← الموقع 👇', { buttons: [{ id: 'send_location', title: '📍 إرسال الموقع' }] });
  }
  saveSession(phone, 'ask_name', { ...session.data, pendingState: 'directory' });
  return send(phone, rid, null, 'text', `👤 *تسجيل حساب العميل*\n\nما تحتاج أي أوراق — بس *اسمك* و*موقعك* ✅\n\nوش *اسمك الكريم*؟`);
}

// 📜 هل هذا الرقم مستخدم مسجّل ما وقّع التعهد بعد؟ (كابتن · مالك · كاشير · مدير · عميل)
function pledgeNeeded(phone) {
  try {
    if (isCaptainPhone(phone)) {
      const c = q.get("SELECT * FROM captains WHERE phone=? OR phone=?", validatePhone(phone), String(phone || ''));
      return { kind: 'captain', name: c?.name || null, national_id: c?.national_id || null, doc: c?.id_doc || null, doc_back: c?.id_doc_back || null };
    }
    const ru = restUserByPhone(phone);
    if (ru) return { kind: ru.role === 'cashier' ? 'cashier' : 'owner', name: ru.name || null, national_id: ru.national_id || null, doc: ru.id_doc || null, doc_back: ru.id_doc_back || null, restaurant_id: ru.restaurant_id };
    const rec = findRecipientByPhone(validatePhone(phone));
    if (rec && rec.status === 'approved') return { kind: 'manager', name: rec.name || null, national_id: rec.national_id || null, birth_date: rec.birth_date || null, doc: rec.id_doc || null, doc_back: rec.id_doc_back || null, restaurant_id: rec.restaurant_id };
    // 🙋 العميل: يكفيه رقم الهوية وتاريخ الميلاد — ما نطلب منه تعهداً
    return null;
  } catch (e) { console.error('PLEDGE_CHECK_FAIL', e.message); }
  return null;
}

// 📜 إرسال التعهد ثم تسجيله وإعطاء رقم التفعيل — pending = { kind, next, data, ... }
function askPledge(phone, rid, pending = {}) {
  saveSession(phone, 'pledge', { ...(pending.data || {}), pledge: pending });
  send(phone, rid, null, 'text', PLEDGE_TEXT);
  return send(phone, rid, null, 'buttons', 'للموافقة اضغط 👇', { buttons: PLEDGE_BUTTONS });
}
async function handlePledgeAccept(phone, rid, session, b, p) {
  const pending = session.data.pledge || {};
  const yes = p === 'pledge_ok' || /^(اوافق|أوافق|موافق|اقبل|أقبل|تم|نعم|agree)$/.test(String(b || '').trim());
  if (!yes) return send(phone, rid, null, 'buttons', 'لازم توافق على التعهد عشان نكمّل 🙏', { buttons: PLEDGE_BUTTONS });
  const info = {
    kind: pending.kind || 'customer',
    phone: validatePhone(phone) || phone,
    name: pending.name || null,
    national_id: pending.national_id || null,
    birth_date: pending.birth_date || null,
    doc: pending.doc || null,
    doc_back: pending.doc_back || null,
    restaurant_id: pending.restaurant_id || null
  };
  const { code } = createPledge(info);
  // حدّث سجلات المستخدم برقم التفعيل
  try {
    if (info.kind === 'customer') q.run("UPDATE customers SET national_id=COALESCE(?,national_id), birth_date=COALESCE(?,birth_date), activation_code=?, pledged_at=datetime('now') WHERE phone=? OR phone=?", info.national_id, info.birth_date, code, info.phone, '+' + info.phone);
    if (info.kind === 'owner' || info.kind === 'cashier') q.run("UPDATE restaurant_users SET national_id=COALESCE(?,national_id), id_doc=COALESCE(?,id_doc), id_doc_back=COALESCE(?,id_doc_back) WHERE phone=? OR phone=?", info.national_id, info.doc, info.doc_back, info.phone, '+' + info.phone);
    if (info.kind === 'captain') q.run("UPDATE captains SET national_id=COALESCE(?,national_id), id_doc=COALESCE(?,id_doc), id_doc_back=COALESCE(?,id_doc_back) WHERE phone=? OR phone=?", info.national_id, info.doc, info.doc_back, info.phone, '+' + info.phone);
    if (info.kind === 'manager') q.run("UPDATE report_recipients SET national_id=COALESCE(?,national_id), birth_date=COALESCE(?,birth_date), id_doc=COALESCE(?,id_doc), id_doc_back=COALESCE(?,id_doc_back) WHERE phone=? OR phone=?", info.national_id, info.birth_date, info.doc, info.doc_back, info.phone, '+' + info.phone);
  } catch (e) { console.error('PLEDGE_UPDATE_FAIL', e.message); }
  await send(phone, rid, null, 'text', pledgeMessage(code));
  const next = pending.next || 'done';
  // متابعة الدورة
  if (next === 'customer_done') return finishCustomerSignup(phone, rid);
  if (next === 'reg_review') return sendRegReview(phone, rid, { ...(session.data.reg ? session.data : pending.data || {}) });
  if (next === 'cap_submit') { saveSession(phone, 'cap_deposit', { ...pending.data }); return sendCapDeposit(phone, rid, pending.data); }
  if (next === 'manager_done') return finishManagerJoinAfterPledge(phone, rid, pending, code);
  if (next === 'reg_subscribe_now') {
    saveSession(phone, 'reg_subscribe', pending.data || session.data);
    const sub = Math.round(Number(config.businessSubscription || 100000) / 100);
    send(phone, rid, null, 'text', `💳 *اشتراك النشاط السنوي: ${sub.toFixed(2)} ر.س*\n\nمبلغ اشتراك سنوي يُدفع للمنصة عند التسجيل ✅`);
    return send(phone, rid, null, 'buttons', 'كيف تحب تكمل؟', { buttons: [
      { id: 'sub_pay', title: '💳 ادفع الاشتراك' }, { id: 'sub_later', title: '⏳ أدفعه لاحقاً' }
    ] });
  }
  if (next === 'cap_deposit_now') return sendCapDeposit(phone, rid, pending.data || session.data);
  if (next === 'resume') {
    const back = pending.resumeState;
    if (back && back !== 'idle') {
      saveSession(phone, back, pending.data || {});
      if (back === 'cash_iddoc') return send(phone, rid, null, 'text', '📎 كمّل من مكانك: أرسل *صورة هويتك أو إقامتك*');
      if (back === 'cap_iddoc' || back === 'reg_id_doc' || back === 'mgr_iddoc') return send(phone, rid, null, 'text', '📎 كمّل من مكانك: أرسل *صورة الهوية*');
      return send(phone, rid, null, 'text', '✅ تم — كمّل من مكانك 👇');
    }
    saveSession(phone, 'idle', pending.data || {});
    if (pending.kind === 'captain') {
      const cap = q.get("SELECT * FROM captains WHERE phone=? OR phone=?", validatePhone(phone), String(phone || ''));
      return send(phone, rid, null, 'text', `🛵 أهلاً كابتن *${cap?.name || ''}* — بيجيك الطلبات هنا على واتساب ✅\nاكتب *رصيدي* لمعرفة حسابك · *طلباتي* لطلباتك النشطة`);
    }
    return mainMenu(phone, rid);
  }
  return mainMenu(phone, rid);
}

// ⏰ سؤال وقت التقرير اليومي (مشترك)
const HOUR_OPTIONS = [
  { id: 'rhour:23:30', title: '🌙 ١١:٣٠ مساءً' },
  { id: 'rhour:21:00', title: '🕘 ٩:٠٠ مساءً' },
  { id: 'rhour:00:00', title: '🕛 ١٢:٠٠ منتصف الليل' }
];
function askReportHour(phone, rid, extra = '', current = null) {
  return send(phone, rid, null, 'buttons',
    `⏰ *وقت التقرير اليومي*\n\n${extra ? extra + '\n\n' : ''}أي ساعة تبيه يوصلك؟${current ? `\n(الحالي: *${prettyHour(current)}*)` : ''}\n_(أو اكتب الوقت: 10:30 · 9 مساءً · 7 صباحاً)_`,
    { buttons: HOUR_OPTIONS });
}

// 🏪 انضمام مدير النشاط: اسمه → هويته → رقم النشاط (أو اسمه) → يتربط ويروح للاعتماد
function findRestaurant(key) {
  const k = String(key || '').trim();
  const n = Number(k.replace(/[^\d]/g, ''));
  if (n && /^\s*#?\s*\d+\s*$/.test(k)) {
    const byId = q.get("SELECT * FROM restaurants WHERE id=?", n);
    if (byId) return byId;
  }
  return q.get("SELECT * FROM restaurants WHERE name_ar LIKE ? OR IFNULL(name_en,'') LIKE ? ORDER BY id LIMIT 1", `%${k}%`, `%${k}%`);
}
function startManagerJoin(phone, rid, session) {
  const me = validatePhone(phone);
  const mine = findRecipientByPhone(me);
  if (mine && mine.status === 'approved') {
    const r = q.get("SELECT name_ar FROM restaurants WHERE id=?", mine.restaurant_id);
    return send(phone, rid, null, 'text', `✅ *أنت مضاف أصلاً* كمستلم تقارير لـ *${r?.name_ar || ''}*\nاكتب *تقرير* ويوصلك تقرير اليوم 📊`);
  }
  saveSession(phone, 'mgr_name', { ...session.data, mgr: { phone: me } });
  return send(phone, rid, null, 'text', '🏪 *انضمام مدير نشاط*\n\nبيوصلك *تقرير المبيعات اليومي* مختوم 📊\n\nوش *اسمك*؟');
}
function handleMgrName(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const name = String(b || '').trim();
  if (name.length < 2) return send(phone, rid, null, 'text', 'اكتب اسمك 🌸');
  saveSession(phone, 'mgr_id', { ...session.data, mgr: { ...session.data.mgr, name: name.slice(0, 40) } });
  return send(phone, rid, null, 'text', '🔢 و*رقم هويتك* (١٠ أرقام)؟');
}
function handleMgrId(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const nid = validNationalId(b);
  if (!nid) return send(phone, rid, null, 'text', 'رقم الهوية لازم *١٠ أرقام* ويبدأ بـ ١ أو ٢ 🙏\nمثال: 1023456789');
  saveSession(phone, 'mgr_iddoc', { ...session.data, mgr: { ...session.data.mgr, national_id: nid } });
  return send(phone, rid, null, 'text', `✅ *${session.data.mgr?.name || ''}* · 🔢 ${nid}\n\n🪪 *صورة هويتك* (أو الإقامة)\n📎 أرسل صورة واضحة\n_(أو اكتب *تخطى*)_`);
}
// رقم النشاط → ربط + إرسال للاعتماد
async function handleMgrBiz(phone, rid, session, b, p) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const mgr = { ...(session.data.mgr || {}) };
  let rest = null;
  if (p && String(p).startsWith('mgrbiz:')) rest = q.get("SELECT * FROM restaurants WHERE id=?", Number(String(p).slice(7)));
  else rest = findRestaurant(b);
  if (!rest) {
    const rests = q.all("SELECT id, name_ar, city FROM restaurants ORDER BY id LIMIT 10");
    if (!rests.length) { saveSession(phone, 'idle', { mgr: null }); return send(phone, rid, null, 'text', '🏪 ما فيه أنشطة مسجّلة حالياً 🙏\nأرسل *انضمام* لتسجيل نشاطك، وبعدها نضيفك مدير عليه.'); }
    saveSession(phone, 'mgr_pick', { ...session.data });
    send(phone, rid, null, 'text', 'ما لقيت نشاط بهذا الرقم 🙏 اختر النشاط من القائمة 👇');
    return send(phone, rid, null, 'list', 'الأنشطة المسجّلة', { list: [{ title: 'الأنشطة المسجّلة', rows: rests.map(r => ({ id: 'mgrbiz:' + r.id, title: `#${r.id} ${String(r.name_ar).slice(0, 20)}`, description: String(r.city || '').slice(0, 60) })) }] });
  }
  saveSession(phone, 'mgr_hour', { ...session.data, mgr: { ...mgr, restaurant_id: rest.id, restaurant_name: rest.name_ar } });
  return askReportHour(phone, rid, `🏪 *${rest.name_ar}* (#${rest.id}) ✅`);
}
async function handleMgrHour(phone, rid, session, b, p) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const hour = (p && String(p).startsWith('rhour:')) ? String(p).slice(6) : parseReportHour(b);
  if (!hour) return send(phone, rid, null, 'text', '⏰ اكتب الوقت بهذي الصيغة: 10:30 أو 9 مساءً أو 7 صباحاً');
  const mgr = { ...(session.data.mgr || {}), hour };
  return finishManagerJoin(phone, rid, session, mgr, { id: mgr.restaurant_id, name_ar: mgr.restaurant_name });
}
function handleMgrPick(phone, rid, session, b, p) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  return handleMgrBiz(phone, rid, session, b, p);
}
async function finishManagerJoin(phone, rid, session, mgr, rest) {
  // 📜 تعهد + رقم تفعيل قبل الربط
  saveSession(phone, 'mgr_pledge', { ...session.data, mgr: { ...mgr, restaurant_id: rest.id, restaurant_name: rest.name_ar } });
  return askPledge(phone, rid, { kind: 'manager', name: mgr.name || null, national_id: mgr.national_id || null, birth_date: mgr.birth_date || null, doc: mgr.id_doc || null, doc_back: mgr.id_doc_back || null, restaurant_id: rest.id, next: 'manager_done', data: { mgr: { ...mgr, restaurant_id: rest.id, restaurant_name: rest.name_ar } } });
}
// 🪪 صورة هوية المدير قبل التعهد
async function handleMgrIdDoc(phone, rid, session, b, mediaRef) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const mgr = { ...(session.data.mgr || {}) };
  if (mediaRef || DOC_SKIP.test(String(b || '').trim())) {
    if (!collectIdSide(mgr, mediaRef)) {
      saveSession(phone, 'mgr_iddoc', { ...session.data, mgr });
      return sendIdPrompt(phone, rid, true, 'صورة هويتك أو إقامتك');
    }
  } else return send(phone, rid, null, 'text', idNeedRetry(!!mgr.id_doc));
  saveSession(phone, 'mgr_biz', { ...session.data, mgr });
  const have = q.get("SELECT COUNT(*) c FROM restaurants").c;
  return send(phone, rid, null, 'text', `🏪 الحين أرسل *رقم النشاط* اللي تديره${have ? '' : '\n_(أو اكتب اسم النشاط)_'}`);
}
// بعد التعهد: الربط + إشعار صاحب النشاط
async function finishManagerJoinAfterPledge(phone, rid, pending, code) {
  const mgr = pending?.data?.mgr || {};
  const rest = { id: mgr.restaurant_id, name_ar: mgr.restaurant_name };
  const row = addRecipient(rest.id, mgr.name, mgr.phone, mgr.hour || '23:30', mgr.national_id);
  if (mgr.id_doc || mgr.id_doc_back) { try { q.run("UPDATE report_recipients SET id_doc=COALESCE(?,id_doc), id_doc_back=COALESCE(?,id_doc_back) WHERE id=?", mgr.id_doc || null, mgr.id_doc_back || null, row.id); } catch (e) {} }
  saveSession(phone, 'idle', {});
  const sent = await notifyOwnerRecipient(row);
  if (!sent) await notifySupervisorRecipient(row);
  if (config.adminPhone) waSend({ phone: config.adminPhone, type: 'text', body: `📊 طلب انضمام مدير (بانتظار اعتماد صاحب النشاط)\n🏪 ${rest.name_ar} (#${rest.id})\n👤 ${mgr.name || ''} · 📱 ${mgr.phone}\n🔢 التعهد/التفعيل: ${code}` }).catch(() => {});
  return send(phone, rid, null, 'text', sent
    ? `✅ *تم الربط وأرسلناه لصاحب النشاط للاعتماد*\n\n🏪 النشاط: *${rest.name_ar}* (#${rest.id})\n👤 ${mgr.name || ''}\n📱 ${mgr.phone}\n⏰ وقت التقرير: *${prettyHour(row.report_hour)}*`
    : '✅ *تم الربط* — بيوصلك تقرير المبيعات اليومي 📊');
}

async function _finishManagerJoin_old(phone, rid, session, mgr, rest) {
  saveSession(phone, 'idle', { ...session.data, mgr: null });
  const row = addRecipient(rest.id, mgr.name, mgr.phone, mgr.hour || '23:30', mgr.national_id);
  // ✅ الاعتماد من *صاحب النشاط* عبر جواله (وإن ما له جوال → ترجع للإدارة)
  const sent = await notifyOwnerRecipient(row);
  if (!sent) await notifySupervisorRecipient(row);
  if (config.adminPhone) waSend({ phone: config.adminPhone, type: 'text', body: `📊 طلب انضمام مدير (بانتظار اعتماد صاحب النشاط)\n🏪 ${rest.name_ar} (#${rest.id})\n👤 ${mgr.name || ''} · 📱 ${mgr.phone} · ⏰ ${prettyHour(row.report_hour)}` }).catch(() => {});
  return send(phone, rid, null, 'text', sent
    ? `✅ *تم الربط وأرسلناه لصاحب النشاط للاعتماد*\n\n🏪 النشاط: *${rest.name_ar}* (#${rest.id})\n👤 ${mgr.name || ''}\n🔢 ${mgr.national_id}\n📱 ${mgr.phone}\n⏰ وقت التقرير: *${prettyHour(row.report_hour)}*\n\nأول ما يعتمد بيوصلك تقرير المبيعات اليومي 📊`
    : '✅ *تم الربط* — بيوصلك تقرير المبيعات اليومي 📊');
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
  saveSession(phone, 'rep_hour', { ...data, rep: { ...rep, phone: norm } });
  const rest = q.get("SELECT name_ar FROM restaurants WHERE id=?", rep.restaurant_id);
  return askReportHour(phone, rid, `👤 *${rep.name || ''}* · 📱 ${norm}\n🏪 ${rest?.name_ar || ''}`);
}
// ⏰ اختيار وقت التقرير عند إضافة المدير من صاحب النشاط
async function handleRepHour(phone, rid, session, b, p) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const hour = (p && String(p).startsWith('rhour:')) ? String(p).slice(6) : parseReportHour(b);
  if (!hour) return send(phone, rid, null, 'text', '⏰ اكتب الوقت: 10:30 أو 9 مساءً');
  const rep2 = session.data.rep || {};
  saveSession(phone, 'idle', { ...session.data, rep: null });
  const row = addRecipient(rep2.restaurant_id, rep2.name, rep2.phone, hour, rep2.national_id);
  await approveRecipient(row.id);   // ✅ صاحب النشاط هو المعتمد — بلا اعتماد الإدارة
  const r = q.get("SELECT name_ar FROM restaurants WHERE id=?", rep2.restaurant_id);
  if (config.adminPhone) waSend({ phone: config.adminPhone, type: 'text', body: `📊 أضاف *${r?.name_ar || ''}* (#${rep2.restaurant_id}) مديراً للتقارير:\n👤 ${rep2.name || ''} · 📱 ${rep2.phone} · ⏰ ${prettyHour(hour)}` }).catch(() => {});
  return send(phone, rid, null, 'text', `✅ *تم إضافة المدير ${rep2.name || ''}*\n📱 ${rep2.phone}\n⏰ بيوصله تقرير المبيعات اليومي الساعة *${prettyHour(hour)}*\n\n_(تبيّن لي: اكتب *مستخدمين*)_`);
}
// 🔔 تغيير وقت التقرير لاحقاً (لمستلم التقرير أو لصاحب النشاط)
function startChangeReportHour(phone, rid) {
  const me = validatePhone(phone);
  const rrid = ownerRestaurantId(phone);
  const rec = findRecipientByPhone(me);
  if (rec && rec.status === 'approved') {
    saveSession(phone, 'hour_change', { hourTarget: rec.id });
    const r = q.get("SELECT name_ar FROM restaurants WHERE id=?", rec.restaurant_id);
    return askReportHour(phone, rid, `🏪 ${r?.name_ar || ''}`, rec.report_hour);
  }
  if (rrid) {
    const rows = q.all("SELECT * FROM report_recipients WHERE restaurant_id=? AND status='approved' ORDER BY id", rrid);
    if (!rows.length) return send(phone, rid, null, 'text', '🔔 ما فيه مستلم تقرير معتمد بعد ⏰\nأضف مدير النشاط بكتابة *مدير*، أول خطوة نحدد معك وقت التقرير.\nوللعلم: تقرير الإدارة المجمّع يوصل يومياً بوقته المحدد ✅');
    if (rows.length === 1) {
      saveSession(phone, 'hour_change', { hourTarget: rows[0].id });
      return askReportHour(phone, rid, `👤 ${rows[0].name || ''} · 🏪 ${q.get("SELECT name_ar FROM restaurants WHERE id=?", rrid)?.name_ar || ''}`, rows[0].report_hour);
    }
    saveSession(phone, 'hour_pick', { hourRows: rows.map(r => r.id) });
    send(phone, rid, null, 'text', '🔔 وقت تقرير مين؟ اختر:');
    return send(phone, rid, null, 'list', 'مستلمو التقارير', { list: [{ title: 'المستلمون', rows: rows.slice(0, 10).map((r, i) => ({ id: 'hourfor:' + r.id, title: String(r.name || ('مستلم ' + (i + 1))).slice(0, 24), description: `${prettyHour(r.report_hour)}` })) }] });
  }
  return send(phone, rid, null, 'text', '🔔 خدمة وقت التقرير لأصحاب الأنشطة ومستلمي التقارير 🌸\n\n• سجّل نشاطك: *انضمام*\n• وإذا أنت مدير: *انضمام مدير*');
}
function handleHourPick(phone, rid, session, b, p) {
  const ids = session.data.hourRows || [];
  let id = null;
  if (p && String(p).startsWith('hourfor:')) id = Number(String(p).slice(8));
  else if (b && ids.includes(Number(String(b).trim()))) id = Number(String(b).trim());
  if (!id) return send(phone, rid, null, 'text', 'اختر من القائمة 👇');
  const row = q.get("SELECT * FROM report_recipients WHERE id=?", id);
  if (!row) return send(phone, rid, null, 'text', 'اختر من القائمة 👇');
  saveSession(phone, 'hour_change', { hourTarget: row.id });
  return askReportHour(phone, rid, `👤 ${row.name || ''}`, row.report_hour);
}
function handleHourChange(phone, rid, session, b, p) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const hour = (p && String(p).startsWith('rhour:')) ? String(p).slice(6) : parseReportHour(b);
  if (!hour) return send(phone, rid, null, 'text', '⏰ اكتب الوقت: 10:30 أو 9 مساءً أو 7 صباحاً');
  const id = session.data.hourTarget;
  const row = id ? setRecipientHour(id, hour) : null;
  saveSession(phone, 'idle', { ...session.data, hourTarget: null, hourRows: null });
  if (!row) return send(phone, rid, null, 'text', 'ما لقيت المستلم 🙏');
  if (config.adminPhone) waSend({ phone: config.adminPhone, type: 'text', body: `🔔 تغيّر وقت التقرير اليومي لـ *${row.name || ''}* → *${prettyHour(row.report_hour)}*` }).catch(() => {});
  return send(phone, rid, null, 'text', `✅ *تم* — بيوصلك تقرير المبيعات اليومي الساعة *${prettyHour(row.report_hour)}* ⏰\n\n_(تبديل الوقت بأي وقت: اكتب *وقت التقرير*)_`);
}
// تقرير فوري بكلمة «تقرير»
async function sendReportNow(phone, rid, yesterday) {
  const rec = findRecipientByPhone(phone);
  const rrid = ownerRestaurantId(phone) || (rec?.status === 'approved' ? rec.restaurant_id : null);
  if (!rrid) {
    return send(phone, rid, null, 'text', '📊 خدمة تقارير المبيعات لأصحاب الأنشطة ومستلمي التقارير 🌸\n\n• سجّل نشاطك بكتابة *انضمام*\n• وإذا أنت مدير نشاط: *انضمام مدير*');
  }
  const { localNow, shiftDate } = await import('./reporting.js');
  const target = yesterday ? shiftDate(localNow().date, -1) : localNow().date;
  const txt = buildDailyReport(rrid, target);
  return send(phone, rid, null, 'text', txt || 'ما قدرت أطلع التقرير الحين 🙏 جرّب بعد شوي');
}

// 🔤 تحويل «تقرير أسبوعي/شهري/سنوي/الشهر الماضي» إلى نوع المدى
function reportKindFromText(text) {
  const t = String(text || '').trim()
    .replace(/[أإآٱ]/g, 'ا').replace(/[ةه]/g, 'ه')
    .replace(/[\u064B-\u0652\u0670]/g, '').replace(/\s+/g, ' ');
  if (!/^تقرير(\s|$)/.test(t)) return null;
  const rest = t.replace(/^تقرير\s*/, '').trim();
  if (!rest || /^(اليوم|يومي|يوميه|مبيعات|مبيعاتي)$/.test(rest)) return 'day';
  if (/^(امس|البارح|بارح)$/.test(rest)) return 'yesterday';
  const past = /(ماضي|ماضيه|سابق|اللي فات)/.test(rest);
  if (/(اسبوع|7 ايام|سبعه ايام)/.test(rest)) return past ? 'lastweek' : 'week';
  if (/(شهر|شهري|30 يوم|ثلاثين يوم)/.test(rest)) return past ? 'lastmonth' : 'month';
  if (/(سنه|سنوي|سنه كامله|عام|12 شهر)/.test(rest)) return past ? 'lastyear' : 'year';
  return null;
}

// 🏛 تقرير المشرف العام على المنصة: يومي (نص + PDF) أو مدى (أسبوعي · شهري · سنوي)
async function sendSupervisorReport(phone, rid, kind) {
  const range = reportRange(kind);
  if (kind === 'day' || kind === 'yesterday') {
    const r = await sendPlatformReport(range.to, { force: true });
    if (r && r.error) return send(phone, rid, null, 'text', '⚠️ ' + r.error);
    return;
  }
  return send(phone, rid, null, 'text', buildPlatformRangeReport(kind));
}

// 🗓 تقرير مدى لنشاط (أسبوعي · شهري · سنوي) — لصاحب النشاط ومستلمي التقارير
function sendReportRangeNow(phone, rid, kind) {
  const rec = findRecipientByPhone(phone);
  const rrid = ownerRestaurantId(phone) || (rec?.status === 'approved' ? rec.restaurant_id : null);
  if (!rrid) {
    return send(phone, rid, null, 'text', '📊 *تقارير المبيعات* 🌸\n\n• صاحب نشاط أو مدير؟ اكتب *انضمام* أو *انضمام مدير*\n• مشرف المنصة؟ اكتب *تقرير شهري*\n\n_(وبعد التسجيل: *تقرير* · *تقرير أسبوعي* · *تقرير شهري* · *تقرير سنوي*)_');
  }
  const txt = buildRangeReport(rrid, kind);
  return send(phone, rid, null, 'text', txt || 'ما قدرت أطلع التقرير الحين 🙏 جرّب بعد شوي');
}

// 🧾 إضافة كاشير (يستلم الطلبات ويتابعها) — من جوال صاحب النشاط (المالك)
function startAddCashier(phone, rid, session) {
  const rrid = ownerRestaurantId(phone);
  if (!rrid) return send(phone, rid, null, 'text', '🧾 إضافة الكاشير متاحة لصاحب النشاط (المالك) 🌸\n\nسجّل نشاطك بكتابة *انضمام* وبعد الاعتماد تقدر تضيف كاشير.');
  const me = validatePhone(phone);
  saveSession(phone, 'cash_name', { ...session.data, cash: { restaurant_id: rrid }, });
  return send(phone, rid, null, 'text', `🧾 *إضافة كاشير*\n\nالكاشير هو اللي *توصله الطلبات* على واتساب ويتابعها ✅\n_(ويقدر يدخل لوحة النشاط — لكن *ما يقدر* يسجّل نشاط أو يضيف مدير)_\n\nوش *اسمه*؟`);
}
// ⏰ وقت تقرير الكاشير → ثم إنشاء الحساب + إضافته كمستلم تقرير
async function handleCashHour(phone, rid, session, b, p) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const hour = (p && String(p).startsWith('rhour:')) ? String(p).slice(6) : parseReportHour(b);
  if (!hour) return send(phone, rid, null, 'text', '⏰ اكتب الوقت: 10:30 أو 9 مساءً أو 12 منتصف الليل');
  const cash = { ...(session.data.cash || {}), hour };
  saveSession(phone, 'cash_iddoc', { ...session.data, cash });
  return sendIdPrompt(phone, rid, false, 'صورة هوية الكاشير');
}

// 🧾 بعد هوية الكاشير: إنشاء الحساب وربطه بتقرير المبيعات
async function handleCashIdDoc(phone, rid, session, b, mediaRef) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const cash = { ...(session.data.cash || {}) };
  if (mediaRef || DOC_SKIP.test(String(b || '').trim())) {
    if (!collectIdSide(cash, mediaRef)) {
      saveSession(phone, 'cash_iddoc', { ...session.data, cash });
      return sendIdPrompt(phone, rid, true, 'صورة هوية الكاشير');
    }
  } else return send(phone, rid, null, 'text', idNeedRetry(!!cash.id_doc));
  return finishCashierAdd(phone, rid, session, cash);
}

async function finishCashierAdd(phone, rid, session, cash) {
  saveSession(phone, 'idle', { ...session.data, cash: null });
  const norm = cash.phone;
  const { user, created, password } = addCashier({ restaurant_id: cash.restaurant_id, name: cash.name, phone: norm });
  // 🪪 حفظ هوية الكاشير (أمامي + خلفي)
  if (cash.id_doc || cash.id_doc_back) {
    try { q.run("UPDATE restaurant_users SET id_doc=COALESCE(?,id_doc), id_doc_back=COALESCE(?,id_doc_back) WHERE phone=? OR phone=?", cash.id_doc || null, cash.id_doc_back || null, norm, '+' + norm); }
    catch (e) { console.error('CASHIER_ID_DOC_FAIL', e.message); }
  }
  const rest = q.get("SELECT name_ar FROM restaurants WHERE id=?", cash.restaurant_id);
  // 📊 يضاف كمستلم تقرير المبيعات (لتسليم المبالغ نهاية اليوم)
  let recOk = false;
  try {
    const rec = addRecipient(cash.restaurant_id, `🧾 الكاشير — ${cash.name || ''}`.slice(0, 40), norm, hour, null);
    q.run("UPDATE report_recipients SET status='approved', updated_at=datetime('now') WHERE id=?", rec.id);
    recOk = true;
  } catch (e) { console.error('CASHIER_REPORT_FAIL', e.message); }
  try {
    await waSend({ phone: norm, restaurantId: cash.restaurant_id, type: 'text', body:
      `🧾 *مرحباً ${cash.name}*\n\nأنت مسجّل كـ *الكاشير* في *${rest?.name_ar || ''}* ✅\n\n📦 *الطلبات بتوصلك هنا على واتساب* — اضغط «✅ استلمت» و«📦 جاهز» لمتابعتها.\n📊 *وتقرير المبيعات اليومي* بيوصلك الساعة *${prettyHour(hour)}* لتسليم المبالغ نهاية اليوم 💵\n\n🔑 لوحة النشاط:${(config.publicUrl || '')}/restaurant\n👤 دخولك: ${norm}\n🔑 كلمة المرور: ${created ? password : '(نفس كلمتك السابقة)'}` });
  } catch (e) { console.error('CASHIER_WELCOME_FAIL', e.message); }
  await notifyOwnerTeamInfo(cash.restaurant_id, `🧾 *الكاشير* — ${cash.name} · ${norm}\n📦 الطلبات صارت توصله ويتابعها ✅\n📊 تقرير المبيعات الساعة ${prettyHour(hour)}`);
  if (config.adminPhone) waSend({ phone: config.adminPhone, type: 'text', body: `🧾 أضاف *${rest?.name_ar || ''}* (#${cash.restaurant_id}) كاشيراً جديداً:\n👤 ${cash.name}\n📱 ${norm}\n⏰ تقريره: ${prettyHour(hour)}` }).catch(() => {});
  return send(phone, rid, null, 'text', `✅ *تم إضافة الكاشير ${cash.name}*\n📱 ${norm}\n🔑 كلمة مروره: *${created ? password : '(نفس كلمته السابقة)'}*\n📊 تقرير المبيعات يوصله الساعة *${prettyHour(hour)}*${recOk ? '' : ' ⚠️ (تعذّر ربطه بتقرير المبيعات)'}\n\n📦 من الآن *الطلبات توصله على واتساب* ويتابعها ✅\n_(تبيّن لي: اكتب *مستخدمين*)_`);
}
function handleCashName(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const name = String(b || '').trim();
  if (name.length < 2) return send(phone, rid, null, 'text', 'اكتب الاسم 🌸');
  saveSession(phone, 'cash_phone', { ...session.data, cash: { ...session.data.cash, name: name.slice(0, 40) } });
  return send(phone, rid, null, 'text', 'وش *جواله*؟ (مثال: 0551234567)');
}
async function handleCashPhone(phone, rid, session, b) {
  if (REG_CANCEL.test(b)) return cancelReg(phone, rid, session);
  const digits = String(b || '').replace(/[^\d]/g, '');
  if (digits.length < 9) return send(phone, rid, null, 'text', 'اكتب رقم جوال صحيح 🌸 مثال: 0551234567');
  const cash = { ...(session.data.cash || {}) };
  const norm = validatePhone(digits);
  saveSession(phone, 'cash_hour', { ...session.data, cash: { ...cash, phone: norm } });
  return askReportHour(phone, rid, `🧾 *${cash.name || 'الكاشير'}* · 📱 ${norm}\n_(تقرير *المبالغ* لتسليم نهاية اليوم)_`);
  const { user, created, password } = addCashier({ restaurant_id: cash.restaurant_id, name: cash.name, phone: norm });
  const rest = q.get("SELECT name_ar FROM restaurants WHERE id=?", cash.restaurant_id);
  // ترحيب الكاشير على واتسابه
  try {
    await waSend({ phone: norm, restaurantId: cash.restaurant_id, type: 'text', body:
      `🧾 *مرحباً ${cash.name}*\n\nأنت مسجّل كـ *الكاشير* في *${rest?.name_ar || ''}* ✅\n\n📦 *الطلبات بتوصلك هنا على واتساب* — اضغط «✅ استلمت» و«📦 جاهز» لمتابعتها.\n\n🔑 لوحة النشاط:${(config.publicUrl || '')}/restaurant\n👤 دخولك: ${norm}\n🔑 كلمة المرور: ${created ? password : '(نفس كلمتك السابقة)'}` });
  } catch (e) { console.error('CASHIER_WELCOME_FAIL', e.message); }
  // إشعار صاحب النشاط (تأكيد) + إشعار الإدارة (للعلم فقط — بلا اعتماد)
  await notifyOwnerTeamInfo(cash.restaurant_id, `🧾 *الكاشير* — ${cash.name} · ${norm}\n📦 الطلبات صارت توصله ويتابعها ✅`);
  if (config.adminPhone) waSend({ phone: config.adminPhone, type: 'text', body: `🧾 أضاف *${rest?.name_ar || ''}* (#${cash.restaurant_id}) كاشيراً جديداً:\n👤 ${cash.name}\n📱 ${norm}\n_(الطلبات صارت توصله)_` }).catch(() => {});
  return send(phone, rid, null, 'text', `✅ *تم إضافة الكاشير ${cash.name}*\n📱 ${norm}\n🔑 كلمة مروره: *${created ? password : '(نفس كلمته السابقة)'}*\n\n📦 من الآن *الطلبات توصله على واتساب* ويتابعها ✅\n_(تبيّن لي: اكتب *مستخدمين*)_`);
}
// 👥 مستخدمو النشاط
function sendTeam(phone, rid) {
  const rrid = ownerRestaurantId(phone) || (restUserByPhone(phone)?.restaurant_id ?? null);
  if (!rrid) return send(phone, rid, null, 'text', '👥 هذي الخدمة لأصحاب الأنشطة 🌸');
  const users = listUsers(rrid);
  const recs = q.all("SELECT * FROM report_recipients WHERE restaurant_id=? AND status='approved'", rrid);
  const rest = q.get("SELECT name_ar FROM restaurants WHERE id=?", rrid);
  let t = `👥 *فريق نشاطك* — ${rest?.name_ar || ''} (#${rrid})\n━━━━━━━━━━━━━━\n`;
  for (const u of users) t += `• ${roleAr(u.role)} — ${u.name || ''} · ${u.phone || ''}\n`;
  const mgrRecs = recs.filter(r => !/الكاشير/.test(String(r.name || '')));
  if (mgrRecs.length) t += `\n📊 *مستلمو التقارير:*\n` + mgrRecs.map(r => `• ${r.name || ''} · ${r.phone} · ⏰ ${fmtH(r.report_hour)}`).join('\n') + '\n';
  const cashRec = recs.find(r => /الكاشير/.test(String(r.name || '')));
  t += `\n🧾 الكاشير: ${cashierPhone(rrid) ? '✅ ' + cashierPhone(rrid) : '❌ ما فيه كاشير بعد — اكتب *كاشير*'}${cashRec ? ` · ⏰ تقريره ${fmtH(cashRec.report_hour)}` : ''}\n`;
  t += `📦 مستلم الطلبات الآن: ${ordersPhoneLabel(rrid)}`;
  return send(phone, rid, null, 'text', t);
}
function ordersPhoneLabel(rid) {
  const c = cashierPhone(rid);
  if (c) return `🧾 الكاشير ${c}`;
  const o = ownerPhone(rid);
  return o ? `👤 صاحب النشاط ${o}` : '⚠️ غير محدد';
}

// 🍽 إدارة المنيو من واتساب (لصاحب النشاط): عرض الأصناف · إيقاف · إرجاع · كمية
function sendMenuManage(phone, rid) {
  const rrid = ownerRestaurantId(phone);
  if (!rrid) return send(phone, rid, null, 'text', '🍽 إدارة المنيو لأصحاب الأنشطة 🌸\n\nسجّل نشاطك بكتابة *انضمام*');
  const items = q.all("SELECT * FROM items WHERE restaurant_id=? ORDER BY sort_order, id", rrid);
  if (!items.length) return send(phone, rid, null, 'text', 'ما فيه أصناف بعد 🙏');
  let t = `🍽 *منيو نشاطك* (${items.length} صنف)\n━━━━━━━━━━━━━━\n`;
  items.forEach((it, idx) => {
    const stock = it.stock_qty === null || it.stock_qty === undefined ? '∞' : it.stock_qty;
    t += `${idx + 1}. ${it.name} — ${rls(it.price)} ر.س ${it.is_available ? `· متوفر (${stock})` : '· ⛔ غير متوفر'}\n`;
  });
  t += `\n📋 *أوامر سريعة* (اكتب الرقم):\n• *وقف 3* = خلص صنف ٣ (يختفي من العملاء)\n• *رجّع 3* = رجّعه متوفراً\n• *كمية 3 5* = حدّد المتوفر ٥ فقط`;
  return send(phone, rid, null, 'text', t);
}
function handleMenuManageCommand(phone, rid, b) {
  const rrid = ownerRestaurantId(phone);
  if (!rrid) return null;
  const items = q.all("SELECT * FROM items WHERE restaurant_id=? ORDER BY sort_order, id", rrid);
  if (!items.length) return null;
  const pick = (n) => items[Number(n) - 1];
  let m = b.match(/^(?:وقف|حذف|خلص|انتهى|نفد)\s*(\d{1,3})$/);
  if (m) {
    const it = pick(m[1]);
    if (!it) return send(phone, rid, null, 'text', 'رقم الصنف غير صحيح 🙏');
    q.run("UPDATE items SET is_available=0, stock_qty=0 WHERE id=?", it.id);
    if (config.adminPhone) waSend({ phone: config.adminPhone, type: 'text', body: `⛔ ${q.get("SELECT name_ar FROM restaurants WHERE id=?", rrid)?.name_ar || ''}: أوقف صنف *${it.name}* (خلص)` }).catch(() => {});
    return send(phone, rid, null, 'text', `⛔ *${it.name}* صار غير متوفر — اختفى من قائمة العملاء ✅\n\n_(اكتب *أصنافي* لعرض المنيو)_`);
  }
  m = b.match(/^(?:رجّع|رجع|متوفر)\s*(\d{1,3})$/);
  if (m) {
    const it = pick(m[1]);
    if (!it) return send(phone, rid, null, 'text', 'رقم الصنف غير صحيح 🙏');
    q.run("UPDATE items SET is_available=1, stock_qty=NULL WHERE id=?", it.id);
    return send(phone, rid, null, 'text', `✅ *${it.name}* رجع متوفراً (بلا حد) ✅`);
  }
  m = b.match(/^كمية\s*(\d{1,3})\s*(\d{1,4})$/);
  if (m) {
    const it = pick(m[1]);
    if (!it) return send(phone, rid, null, 'text', 'رقم الصنف غير صحيح 🙏');
    const qty = Number(m[2]);
    q.run("UPDATE items SET stock_qty=?, is_available=? WHERE id=?", qty, qty > 0 ? 1 : 0, it.id);
    return send(phone, rid, null, 'text', `✅ *${it.name}* — المتوفر الآن: *${qty}* ${qty > 0 ? '' : '(غير متوفر)'}`);
  }
  return null;
}

// 🆔 إرسال رقم النشاط لصاحبه أو مديره (ليعطيه للمدير ليسجّل، أو ليكتبه المدير)
function sendBusinessNumber(phone, rid) {
  const rrid = ownerRestaurantId(phone);
  const rec = findRecipientByPhone(validatePhone(phone));
  const id = rrid || (rec?.status === 'approved' ? rec.restaurant_id : null);
  if (!id) return send(phone, rid, null, 'text', '🆔 رقم النشاط يظهر لصاحب النشاط أو مديره المسجّل 🌸\n\n• سجّل نشاطك بكتابة *انضمام*\n• وإذا أنت مدير: *انضمام مدير*');
  const r = q.get("SELECT id, name_ar, city FROM restaurants WHERE id=?", id);
  const isManager = !rrid && rec;
  return send(phone, rid, null, 'text', isManager
    ? `🆔 *رقم النشاط: #${r.id}*\n🏪 ${r.name_ar}${r.city ? ' — ' + r.city : ''}\n\n✅ أنت مرتبط بهذا النشاط — اكتب *تقرير* ويوصلك تقرير اليوم 📊`
    : `🆔 *رقم نشاطك: #${r.id}*\n🏪 ${r.name_ar}${r.city ? ' — ' + r.city : ''}\n\n📋 *ارسله لمدير النشاط* ليكتب:\n*انضمام مدير* → اسمه → هويته → رقم النشاط *${r.id}*\n\nوبعد اعتماد الإدارة بيوصله تقرير المبيعات اليومي 📊`);
}

// 🏪 صاحب النشاط: تأكيد الطلب / الطلب جاهز من أزرار إشعار الطلب
// 👤 اعتماد صاحب النشاط لمديره (من أزرار رسالته)
async function handleOwnerRecipientAction(phone, rid, p) {
  const m = String(p || '').match(/^rowner_(ok|no):(\d+)$/);
  if (!m) return null;
  const id = Number(m[2]);
  const row = q.get("SELECT * FROM report_recipients WHERE id=?", id);
  if (!row) return send(phone, rid, null, 'text', 'ما لقيت الطلب 🙏');
  const isAdmin = config.adminPhone && validatePhone(phone) === validatePhone(config.adminPhone);
  const rrid = ownerRestaurantId(phone);
  if (!isAdmin && rrid !== row.restaurant_id) return send(phone, rid, null, 'text', '🚫 هذا الاعتماد لصاحب النشاط (المالك) فقط');
  if (m[1] === 'ok') {
    const r = await approveRecipient(id);
    if (r.error && r.error !== 'معتمد مسبقاً') return send(phone, rid, null, 'text', r.error);
    try { await waSend({ phone: row.phone, type: 'text', body: `✅ *اعتمدك صاحب النشاط* كمستلم تقرير مبيعات 📊` }); } catch (e) {}
    return send(phone, rid, null, 'text', `✅ *تم اعتماد ${row.name || ''}* — بيوصله التقرير اليومي الساعة *${prettyHour(row.report_hour)}* 📊`);
  }
  await rejectRecipient(id, 'رفض صاحب النشاط');
  return send(phone, rid, null, 'text', `❌ *تم رفض ${row.name || ''}* — وما بيوصله أي تقرير.`);
}

async function handleOrderActionFromOwner(phone, rid, p, b = '') {
  const m = String(p || '').match(/^ord(ok|ready):(\d+)$/);
  let orderId = m ? Number(m[2]) : null;
  const mine = ownerRestaurantId(phone);
  if (!mine) return send(phone, rid, null, 'text', 'هذي الخدمة لأصحاب الأنشطة المسجّلين 🌸');
  if (!orderId && /^(جاهز|استلمت|تم الاستلام)$/.test(String(b || '').trim())) {
    const o = q.get("SELECT id, status FROM orders WHERE restaurant_id=? AND status IN ('new','confirmed','preparing') ORDER BY id DESC LIMIT 1", mine);
    if (!o) return send(phone, rid, null, 'text', 'ما فيه طلب نشط حالياً 📭');
    orderId = o.id;
  }
  if (!orderId) return null;
  const order = q.get("SELECT * FROM orders WHERE id=? AND restaurant_id=?", orderId, mine);
  if (!order) return send(phone, rid, null, 'text', 'ما لقيت طلبك 🙏');
  const { setStatus } = await import('./orderService.js');
  const want = (m?.[1] === 'ready') || /^(جاهز)$/.test(String(b || '').trim()) ? 'ready' : 'confirmed';
  const r = setStatus(order.id, want, 'restaurant');
  if (r?.error) return send(phone, rid, null, 'text', r.error);
  return send(phone, rid, null, 'text', want === 'ready'
    ? `📦 *تم* — بلّغنا العميل أن الطلب ${order.order_no} جاهز ✅`
    : `✅ *تم* — بلّغنا العميل أنك استلمت الطلب ${order.order_no} وجاري التحضير 👨‍🍳`);
}

// ---------- 📣 إعلانات الأنشطة ----------
async function startAdRequestFlow(phone, rid, session) {
  // 📣 إعلان باسم المنصة من جوال الإدارة
  if (config.adminPhone && (phone === config.adminPhone || validatePhone(phone) === validatePhone(config.adminPhone))) {
    saveSession(phone, 'pad_content', { ...session.data, padImage: null });
    send(phone, rid, null, 'text', `📣 *إعلان المنصة*\n\nاكتب نص الإعلان اللي يوصل للعملاء ✍️\n(أو *أرسل صورة* وأنا أستخدمها مع نصك)`);
    return send(phone, rid, null, 'text', 'مثال: 🎉 خصم 20% لأول 100 طلب من كل المطاعم — اطلب الآن!');
  }
  const rrid = ownerRestaurantId(phone);
  if (!rrid) return send(phone, rid, null, 'text', '📣 خدمة الإعلانات لأصحاب الأنشطة المسجّلين 🌸\nسجّل نشاطك بكتابة *انضمام* أولاً.');
  const rest = q.get("SELECT * FROM restaurants WHERE id=?", rrid);
  const already = q.get("SELECT * FROM ad_requests WHERE restaurant_id=? AND status IN ('requested','priced','paid','content','pending_approval') ORDER BY id DESC LIMIT 1", rrid);
  if (already) return send(phone, rid, null, 'text', `📣 عندك طلب إعلان قائم (${adStatusAr(already.status)}) — بنكمل عليه مع الإدارة 🙏`);
  const req = createAdRequest(rrid, phone, rest?.city || null);
  saveSession(phone, 'idle', { ...session.data, adReqId: req.id });
  send(phone, rid, null, 'text', `📣 *طلب إعلان*\n\n🏪 ${rest?.name_ar || ''}\n🏙 سيُرسل لعملاء مدينة: *${req.city || '-'}* (${customersInCity(req.city)} عميل مسجّل)\n\nأرسلنا طلبك للإدارة لتحديد السعر، وبنبلغك بالعرض 💰`);
  const ok = await notifySupervisorNewAd(req);
  if (!ok) return send(phone, rid, null, 'text', '⚠️ تعذّر إبلاغ الإدارة — كلّمنا لاحقاً 🙏');
  return;
}
function adStatusAr(s) {
  return { requested: 'بانتظار التسعير', priced: 'بانتظار موافقتك', paid: 'مدفوع — بانتظار النص', content: 'اكتب النص', pending_approval: 'بانتظار اعتماد الإدارة', approved: 'منشور ✅', rejected: 'مرفوض', declined: 'اعتذرت' }[s] || s;
}
// 📣 الإدارة: نص إعلان المنصة (أو صورته)
async function handlePlatformAdContent(phone, rid, session, b, imageUrl = null) {
  if (imageUrl) {
    saveSession(phone, 'pad_content', { ...session.data, padImage: imageUrl });
    return send(phone, rid, null, 'text', '✅ وصلتني الصورة 📷\nالحين اكتب *نص الإعلان* اللي يطلع معها:');
  }
  const text = String(b || '').trim();
  if (text.length < 3) return send(phone, rid, null, 'text', 'اكتب نص الإعلان ✍️');
  saveSession(phone, 'pad_audience', { ...session.data, padText: text });
  return send(phone, rid, null, 'buttons', `📣 *جاهز للنشر*\n\n${text.slice(0, 300)}\n\nلمين نرسله؟`, { buttons: [
    { id: 'pad_all', title: '🌍 كل العملاء' }, { id: 'pad_city', title: '🏙 مدينة معينة' }
  ] });
}
async function handlePlatformAdAudience(phone, rid, session, p) {
  const data = session.data || {};
  if (p !== 'pad_all' && p !== 'pad_city') return null;
  if (p === 'pad_city') {
    saveSession(phone, 'pad_city', { ...data });
    return send(phone, rid, null, 'text', '🏙 اكتب اسم المدينة اللي نرسل لها (مثال: أبها) — أو اكتب *كل* للجميع');
  }
  return publishPlatformAd(phone, rid, { ...data, city: null });
}
async function handlePlatformAdCity(phone, rid, session, b) {
  const city = String(b || '').trim();
  if (!city) return send(phone, rid, null, 'text', 'اكتب اسم المدينة 🏙');
  if (/^(كل|الكل|الجميع|الجميع)$/.test(city)) return publishPlatformAd(phone, rid, { ...session.data, city: null });
  const n = customersInCity(city);
  if (n === 0) return send(phone, rid, null, 'text', `⚠️ ما فيه عملاء مسجّلين في *${city}* حالياً.\nاكتب *كل* لإرساله لكل العملاء، أو اكتب مدينة ثانية.`);
  return publishPlatformAd(phone, rid, { ...session.data, city });
}
async function publishPlatformAd(phone, rid, data) {
  const req = createPlatformAd({ phone, content: data.padText || '', image: data.padImage || null, city: data.city || null });
  saveSession(phone, 'idle', {});
  const r = await publishAd(req);
  const who = r.city ? `عملاء مدينة *${r.city}*` : 'كل العملاء';
  return send(phone, rid, null, 'text', `✅ *تم نشر الإعلان* إلى ${who}\n📤 أُرسل لـ *${r.sent}* عميل\n\n💰 لتسجيل سعر الإعلان: الكنترول → 📣 الإعلانات → «سجّل السعر».`);
}

// المشرف يحدد السعر
async function handleAdPrice(phone, rid, session, b) {
  const req = getAdRequest(session.data.adReqId);
  const n = Number(String(b || '').replace(/[^\d.]/g, ''));
  if (!req || !n || n <= 0) return send(phone, rid, null, 'text', 'اكتب السعر بالريال (مثال: 300) 💰');
  const row = setAdPrice(req.id, Math.round(n * 100));
  saveSession(phone, 'idle', { ...session.data, adReqId: null });
  // جهّز جلسة النشاط لاستقبال موافقته
  const bizPhone = String(row.phone || '').replace(/^\+/, '');
  const bs = getSession(bizPhone);
  saveSession(bizPhone, 'ad_decision', { ...bs.data, adReqId: row.id });
  await sendPriceToBusiness(row);
  return send(phone, rid, null, 'text', `✅ أرسلنا السعر (${rls(row.price)} ر.س) للنشاط للموافقة\nبنبلغك أول ما يوافق ويدفع 🙏`);
}
// النشاط يكتب نص الإعلان
async function handleAdContent(phone, rid, session, b) {
  const req = getAdRequest(session.data.adReqId);
  if (!req) { saveSession(phone, 'idle', {}); return mainMenu(phone, rid); }
  const text = String(b || '').trim();
  if (text.length < 5) return send(phone, rid, null, 'text', 'اكتب نص الإعلان (5 أحرف على الأقل) ✍️');
  const row = setAdStatus(req.id, 'pending_approval', { content: text.slice(0, 600) });
  saveSession(phone, 'idle', { ...session.data, adReqId: null });
  await sendToSupervisorForApproval(row);
  return send(phone, rid, null, 'text', `✅ *وصلنا إعلانك وأرسلناه للإدارة للاعتماد*\n\n✍️ ${text.slice(0, 200)}\n\nبنبلغك أول ما يُنشر لعملاء مدينة *${row.city || ''}* 🙏`);
}
// موافقة النشاط على السعر / عدمها
async function handleAdDecision(phone, rid, session, p) {
  const req = getAdRequest(session.data.adReqId || q.get("SELECT id FROM ad_requests WHERE phone=? OR phone=? ORDER BY id DESC LIMIT 1", phone, validatePhone(phone))?.id);
  if (!req) return send(phone, rid, null, 'text', 'ما لقيت طلب الإعلان 🙏 اكتب *إعلان* للبدء من جديد.');
  if (p === 'ad_no') {
    setAdStatus(req.id, 'declined', { supervisor_note: 'النشاط لم يوافق على السعر' });
    saveSession(phone, 'idle', {});
    if (config.adminPhone) waSend({ phone: config.adminPhone, type: 'text', body: `❌ النشاط رفض سعر الإعلان (${rls(req.price)} ر.س)` }).catch(() => {});
    return send(phone, rid, null, 'text', 'تمام 🙏 — أبلغنا الإدارة. تقدر تطلب إعلان مرة ثانية بأي وقت بكتابة *إعلان*.');
  }
  // موافقة → الدفع
  if (config.paymentMode === 'mock') {
    setAdStatus(req.id, 'paid');
    saveSession(phone, 'ad_content', { ...session.data, adReqId: req.id });
    send(phone, rid, null, 'text', `🧪 *وضع تجريبي:* تم دفع ${rls(req.price)} ر.س وهمياً ✅`);
    return send(phone, rid, null, 'text', '✍️ *اكتب نص إعلانك* (اللي تبيه يوصل للعملاء) وأرسله هنا:');
  }
  const { createPayment } = await import('./payments.js');
  const rest = q.get("SELECT name_ar FROM restaurants WHERE id=?", req.restaurant_id);
  const pay = await createPayment({ total: req.price, order_no: 'AD-' + req.id, restaurant_name: rest?.name_ar || '' }, 'card', { phone, restaurant_id: req.restaurant_id });
  saveSession(phone, 'ad_waitpay', { ...session.data, adReqId: req.id, paymentId: pay.payment_id || null });
  send(phone, rid, null, 'text', `💰 *المطلوب لتفعيل إعلانك: ${rls(req.price)} ر.س*\nاضغط الرابط وادفع:`);
  send(phone, rid, null, 'text', pay.payment_url || '');
  return send(phone, rid, null, 'buttons', 'بعد الدفع اضغط هنا 👇', { buttons: [{ id: 'ad_paid', title: '✅ تم الدفع' }] });
}
// تأكيد دفع الإعلان (الوضع الحقيقي)
async function handleAdWaitPay(phone, rid, session, p) {
  const req = getAdRequest(session.data.adReqId);
  if (!req) { saveSession(phone, 'idle', {}); return mainMenu(phone, rid); }
  setAdStatus(req.id, 'paid');
  saveSession(phone, 'ad_content', { ...session.data, adReqId: req.id });
  return send(phone, rid, null, 'text', '✅ تم الدفع — ✍️ *اكتب نص إعلانك* وأرسله هنا:');
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
  return send(phone, rid, null, 'text', '📷 وصلتني الصورة 🙏\n\nلو تبي *تسجّل نشاطك*: أرسل كلمة *انضمام* ونمشي خطوة خطوة.\nولو تبي *تطلب*: أرسل *المنيو*.');
}

export function isCaptainPhone(phone) {
  return !!q.get("SELECT id FROM captains WHERE phone=? OR phone=?", phone, validatePhone(phone));
}

export async function handleCaptainIncoming({ phone, body = '', payload = null }) {
  // 📜 بوابة التعهد للكابتن (وقبول التعهد)
  try {
    const cap = q.get("SELECT * FROM captains WHERE phone=? OR phone=?", validatePhone(phone), String(phone || ''));
    if (cap) {
      const sess = getSession(phone);
      if (sess.state === 'pledge') return handlePledgeAccept(phone, null, sess, body, payload);
      if (!findPledge('captain', phone)) {
        return askPledge(phone, null, { kind: 'captain', name: cap.name, national_id: cap.national_id, doc: cap.id_doc, doc_back: cap.id_doc_back, next: 'resume', resumeState: 'idle', data: (sess.data || {}) });
      }
    }
  } catch (e) { console.error('CAP_PLEDGE_GATE_FAIL', e.message); }
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
