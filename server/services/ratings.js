// ---------- تقييم العميل (من الكباتن والمطاعم) + نسبته من ١٠٠٠ ----------
import { q } from '../db.js';
import { waSend } from './whatsapp.js';
import { validatePhone } from '../utils.js';

// تصنيف النسبة
export function scoreTier(score) {
  const s = Number(score) || 0;
  if (s >= 900) return { key: 'excellent', label: '🌟 ممتاز', advice: 'ننصح بالتعامل معه', color: 'green' };
  if (s >= 750) return { key: 'very_good', label: '⭐ جيد جدًا', advice: 'ننصح بالتعامل معه', color: 'green' };
  if (s >= 600) return { key: 'good', label: '👍 جيد', advice: 'تعامل عادي', color: 'amber' };
  if (s >= 400) return { key: 'fair', label: '⚠️ مقبول', advice: 'راقبه', color: 'amber' };
  return { key: 'weak', label: '⛔ ضعيف', advice: 'لا ننصح بالتعامل معه', color: 'red' };
}

// نسبة العميل: بلا تقييم = «جديد» (لا تُحسب تلقائياً)
export function customerScore(customerId = null, phone = null) {
  let cid = customerId;
  if (!cid && phone) {
    const c = q.get("SELECT id FROM customers WHERE phone=? OR phone=?", String(phone), validatePhone(phone));
    cid = c?.id || null;
  }
  if (!cid) return { count: 0, score: null, isNew: true, label: '🆕 عميل جديد', advice: 'بلا تقييم بعد' };
  const r = q.get("SELECT COUNT(*) c, COALESCE(AVG(score),0) avg FROM customer_ratings WHERE customer_id=?", cid);
  const count = Number(r.c) || 0;
  if (!count) return { count: 0, score: null, isNew: true, label: '🆕 عميل جديد', advice: 'بلا تقييم بعد' };
  const score = Math.round(Number(r.avg));
  const t = scoreTier(score);
  return { count, score, isNew: false, label: t.label, advice: t.advice, tier: t.key };
}

// سطر جاهز للعرض في الرسائل
export function customerScoreLine(customerId, phone) {
  const s = customerScore(customerId, phone);
  if (s.isNew) return '👤 العميل: 🆕 *جديد* — بلا تقييم بعد';
  return `👤 العميل: ${s.label} — *${s.score}/1000* (${s.count} تقييم) · ${s.advice}`;
}

export function addCustomerRating({ orderId, customerId, raterType = 'captain', raterId = null, score = 0, note = null }) {
  const s = Math.max(0, Math.min(1000, Number(score) || 0));
  q.run("INSERT INTO customer_ratings (order_id, customer_id, rater_type, rater_id, score, note) VALUES (?,?,?,?,?,?)",
    orderId || null, customerId || null, raterType, raterId, s, note);
  return customerScore(customerId);
}

// نص «كابتن جديد» للمطعم/العميل
export function captainScoreLine(captainId) {
  const c = q.get("SELECT rating_avg, rating_count FROM captains WHERE id=?", captainId);
  if (!c || !Number(c.rating_count)) return '🆕 كابتن جديد — بلا تقييم بعد';
  return `⭐ ${c.rating_avg}/5 (${c.rating_count} تقييم)`;
}

// ---------- مطالبة الكابتن بتقييم العميل (بعد إغلاق الطلب) ----------
export async function askCaptainToRateCustomer(captainPhone, order, captainId = null) {
  if (!order?.customer_id) return false;
  const c = q.get("SELECT name FROM customers WHERE id=?", order.customer_id);
  const rows = [
    { id: `crate:${order.id}:1000`, title: '😍 ممتاز', description: 'تعامل رائع' },
    { id: `crate:${order.id}:800`, title: '🙂 جيد جدًا', description: 'تعامل طيب' },
    { id: `crate:${order.id}:600`, title: '😐 مقبول', description: 'عادي' },
    { id: `crate:${order.id}:300`, title: '😞 لا أنصح', description: 'تعامل سيئ' }
  ];
  try {
    await waSend({
      phone: captainPhone, restaurantId: order.restaurant_id, orderId: order.id, participant: 'captain',
      type: 'list',
      body: `🙏 تم إغلاق الطلب ${order.order_no}.\n\nآخر شي: تقييمك للعميل *${c?.name || 'العميل'}* — تبي تتعامل معه مرة ثانية؟`,
      list: [{ title: 'تقييم العميل', rows }]
    });
    return true;
  } catch (e) { console.error('CAPTAIN_RATE_PROMPT_FAIL', e.message); return false; }
}

// استلام تقييم الكابتن للعميل
export async function handleCaptainCustomerRating(payload, captain) {
  const m = String(payload || '').match(/^crate:(\d+):(\d+)$/);
  if (!m) return null;
  const orderId = Number(m[1]);
  const score = Number(m[2]);
  const order = q.get("SELECT * FROM orders WHERE id=? AND captain_id=?", orderId, captain.id);
  if (!order) return 'ما لك علاقة بهذا الطلب 🙏';
  const ex = q.get("SELECT id FROM customer_ratings WHERE order_id=? AND rater_type='captain' AND rater_id=?", orderId, captain.id);
  if (ex) return 'سبق قيّمت هذا الطلب ✅ شكرًا لك';
  const res = addCustomerRating({ orderId, customerId: order.customer_id, raterType: 'captain', raterId: captain.id, score });
  const t = scoreTier(score);
  return res.isNew
    ? '✅ تم حفظ تقييمك — شكرًا لك 🙏'
    : `✅ تم حفظ تقييمك 🙏\nنسبة العميل الحين: ${res.label} — *${res.score}/1000*`;
}
