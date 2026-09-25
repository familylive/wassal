import { q } from './db.js';

export const ORDER_STATUSES = {
  new: 'طلب جديد', confirmed: 'تم التأكيد', preparing: 'قيد التحضير',
  ready: 'جاهز للتسليم', offered: 'عُرض على الكباتن', accepted: 'قبول الكابتن',
  transferred: 'تم التحويل للكابتن', with_captain: 'مع الكابتن',
  on_the_way: 'في الطريق إليك', arrived: 'وصل الطلب', delivered: 'تم التسليم',
  cancelled: 'ملغي'
};
export const PAYMENT_METHODS = {
  applepay: 'Apple Pay', mada: 'مدى', card: 'بطاقة ائتمانية', wallet: 'محفظة', cash: 'كاش عند الاستلام'
};
export const TIERS = [
  { name: 'برونزي', min_points: 0, discount_pct: 0 },
  { name: 'فضي', min_points: 500, discount_pct: 3 },
  { name: 'ذهبي', min_points: 1500, discount_pct: 5 },
  { name: 'بلاتيني', min_points: 4000, discount_pct: 8 },
];

export const sar = (halalas) => (halalas / 100).toFixed(2);
export const riyals = (amountSar) => Math.round(Number(amountSar) * 100);

export function computeTier(points) {
  let t = TIERS[0];
  for (const tier of TIERS) if (points >= tier.min_points) t = tier;
  return t;
}

export const ORDER_NO_START = 5590;   // 🧾 ترقيم الطلبات يبدأ من 5590
export function nextOrderNo() {
  // نأخذ أكبر رقم طلب فعلي ونتجاهل أي قيمة غير رقمية (حماية من #NaN)
  const row = q.get("SELECT MAX(CAST(REPLACE(order_no, '#', '') AS INTEGER)) AS m FROM orders WHERE order_no GLOB '#[0-9]*'");
  const mx = Number(row?.m) || 0;
  const n = Math.max(ORDER_NO_START, mx + 1);
  return `#${n}`;
}

export function now() { return new Date().toISOString(); }

export const uid = () => Math.random().toString(36).slice(2, 10);

export function validatePhone(p) {
  let s = String(p || '').replace(/[^\d]/g, '');
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('966')) s = '+' + s;
  else if (s.startsWith('0')) s = '+966' + s.slice(1);
  else if (!s.startsWith('+')) s = '+966' + s;
  return s;
}

// رقم الهوية/الإقامة السعودية: ١٠ أرقام تبدأ بـ ١ (مواطن) أو ٢ (مقيم)
export function validNationalId(v) {
  const s = String(v || '').replace(/[^\d]/g, '');
  return /^[12]\d{9}$/.test(s) ? s : null;
}
export function maskId(v) {
  const s = String(v || '');
  return s.length === 10 ? s.slice(0, 3) + '****' + s.slice(-2) : (s || '-');
}

export function humanTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('ar-SA', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}
