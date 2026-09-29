// 🖨 إيصال الطلب الحراري — مقاس طابعات الكاشير (80mm افتراضيًا · 58mm اختياري) — بدون ختم
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { q } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, '..', 'assets');
const OUT_DIR = path.join(__dirname, '..', 'uploads', 'receipts');
const SITE = 'www.telyham.com';   // 🌐 دومين المنصة

let ready = false, logoImg = null;
async function ensureAssets() {
  if (!ready) {
    try { GlobalFonts.registerFromPath(path.join(ASSETS, 'Cairo.ttf'), 'Cairo'); } catch (e) { console.error('FONT_REGISTER_FAIL', e.message); }
    ready = true;
  }
  if (!logoImg) { try { logoImg = await loadImage(path.join(ASSETS, 'logo.png')); } catch (e) { /* بدون شعار */ } }
  return logoImg;
}

const money = (h) => (Number(h || 0) / 100).toFixed(2);
const localPhone = (x) => { const d = String(x || '').replace(/\D/g, ''); return d.startsWith('966') ? '0' + d.slice(3) : d; };
const two = (n) => String(n).padStart(2, '0');

// مقاس الورق: 80mm = 576px · 58mm = 384px (عند 203dpi) — يقبل تعديلًا من الإعدادات
export function receiptWidthPx(mm) {
  const m = Number(mm) || 80;
  return m <= 60 ? 384 : 576;
}
export function receiptWidthMm() {
  try {
    const v = q.get("SELECT value FROM app_settings WHERE key='RECEIPT_WIDTH_MM'")?.value;
    const n = Number(v);
    if (n >= 40 && n <= 120) return n;
  } catch (e) { /* */ }
  return Number(process.env.RECEIPT_WIDTH_MM || 80);
}

// 🧾 رسم الإيصال (أسود على أبيض — مناسب للطباعة الحرارية)
export async function renderOrderReceiptPng(order, opts = {}) {
  const logo = await ensureAssets();
  const W = receiptWidthPx(opts.widthMm || receiptWidthMm());
  const pad = Math.round(W * 0.045);
  const rest = q.get("SELECT * FROM restaurants WHERE id=?", order.restaurant_id);
  const cust = order.customer_id ? q.get("SELECT name, phone FROM customers WHERE id=?", order.customer_id) : null;
  const cap = order.captain_id ? q.get("SELECT name, phone FROM captains WHERE id=?", order.captain_id) : null;
  let items = [];
  try { items = JSON.parse(order.items_json || '[]'); } catch (e) { items = []; }
  const pct = Number(order.menu_discount_pct || 0);
  const money0 = (v) => money(v);

  const canvas = createCanvas(W, 1000);
  const c = canvas.getContext('2d');
  const F = (sz, b = false) => `${b ? 'bold ' : ''}${sz}px Cairo`;
  const line = (y, dashed = false) => {
    c.strokeStyle = '#000'; c.lineWidth = dashed ? 1 : 1.5;
    if (dashed) c.setLineDash([4, 4]); else c.setLineDash([]);
    c.beginPath(); c.moveTo(pad, y); c.lineTo(W - pad, y); c.stroke();
    c.setLineDash([]);
  };
  // نص يمين (RTL) أو يسار
  const t = (txt, y, sz = 20, { bold = false, right = true, x = null, color = '#000' } = {}) => {
    c.font = F(sz, bold); c.fillStyle = color;
    c.direction = 'rtl'; c.textAlign = right ? 'right' : 'left';
    c.fillText(String(txt), right ? (x || W - pad) : (x || pad), y);
  };
  // سطر بجانبين: يمين + يسار (للأصناف والأسعار)
  const row = (rtxt, ltxt, y, sz = 20, bold = false) => {
    c.font = F(sz, bold); c.fillStyle = '#000';
    c.direction = 'rtl'; c.textAlign = 'right'; c.fillText(String(rtxt), W - pad, y);
    c.direction = 'ltr'; c.textAlign = 'left'; c.fillText(String(ltxt), pad, y);
  };

  let y = pad + 26;
  // الترويسة: تلي هم + الشعار
  const lr = Math.round(W * 0.055);
  if (logo) { try { c.drawImage(logo, W - pad - lr * 2, y - lr - 6, lr * 2, lr * 2); } catch (e) { /* */ } }
  t('تلي هم', y, 24, { bold: true, x: W - pad - lr * 2 - 10 });
  t('منصة الطلبات والتوصيل', y + 24, 15, { x: W - pad - lr * 2 - 10, color: '#333' });
  y += lr * 2 + 6;
  t('إيصال طلب — غير مختوم', y, 17, { bold: true, x: (W - pad) / 2 + pad / 2, right: false });
  y += 22;
  line(y, true); y += 26;

  // 📱 جوال العميل أول شي
  t(`📱 جوال العميل: ${cust?.phone ? localPhone(cust.phone) : '—'}`, y, 24, { bold: true }); y += 26;
  if (cust?.name) { t(`👤 ${cust.name}`, y, 18); y += 22; }
  if (order.national_address || order.address_label) { t(`📍 ${order.national_address || order.address_label}`, y, 16, { color: '#222' }); y += 20; }
  y += 4; line(y, true); y += 26;

  // بيانات النشاط والطلب
  t(`🏪 ${rest?.name_ar || ''}`, y, 20, { bold: true }); y += 24;
  if (rest?.phone) { t(`☎ ${localPhone(rest.phone)}`, y, 17); y += 20; }
  if (order.branch_name) { t(`🏬 ${order.branch_name}`, y, 16); y += 20; }
  row(`رقم الطلب: ${order.order_no || ''}`, `#${order.id}`, y, 17, true); y += 22;
  const dt = String(order.created_at || '').slice(0, 16);
  row(`${dt ? dt.replace(' ', ' — ') : ''}`, order.order_type === 'pickup' ? 'استلام' : 'توصيل', y, 15); y += 20;
  if (order.delivery_code) { t(`🔐 رمز الاستلام: ${order.delivery_code}`, y, 19, { bold: true }); y += 22; }
  line(y, true); y += 26;

  // الأصناف
  t('الأصناف', y, 19, { bold: true }); y += 24;
  for (const it of items.slice(0, 20)) {
    const qty = Number(it.quantity || 1), pr = Number(it.price || 0), gross = qty * pr;
    const net = pct ? Math.round(gross * (100 - pct) / 100) : gross;
    t(`${it.name || ''}`.slice(0, 34), y, 19); y += 21;
    row(`${qty} × ${money0(pr)}`, pct ? `${money(net)}` : `${money(gross)}`, y, 17, false); y += 22;
    if (pct) { t(`(السعر الأصلي ${money(gross)})`, y, 14, { color: '#444' }); y += 18; }
  }
  if (items.length > 20) { t(`+ ${items.length - 20} أصناف أخرى`, y, 15, { color: '#444' }); y += 20; }
  y += 6; line(y, true); y += 28;

  // المجاميع
  row('المجموع', `${money(order.subtotal)} ر.س`, y, 20); y += 24;
  if (Number(order.menu_discount) || Number(order.discount)) {
    const d = Number(order.menu_discount || 0) + Number(order.discount || 0);
    const lbl = order.menu_discount_label ? `${order.menu_discount_label} ` : '';
    row(`الخصم ${lbl}${pct ? `(${pct}%)` : ''}`, `- ${money(d)} ر.س`, y, 19, true); y += 24;
  }
  if (Number(order.delivery_fee)) { row('التوصيل', `${money(order.delivery_fee)} ر.س`, y, 18); y += 22; }
  c.fillStyle = '#000'; c.fillRect(pad, y - 12, W - pad * 2, 34);
  c.font = F(24, true); c.fillStyle = '#fff'; c.direction = 'rtl'; c.textAlign = 'right';
  c.fillText('الإجمالي', W - pad - 8, y + 12);
  c.direction = 'ltr'; c.textAlign = 'left';
  c.fillText(`${money(order.total)} ر.س`, pad + 8, y + 12);
  y += 46;
  t(`💳 ${order.payment_method === 'cash' ? 'كاش عند التسليم' : 'مدفوع إلكترونيًا'}`, y, 17); y += 24;
  if (cap?.name) { t(`🛵 الكابتن: ${cap.name} — ${localPhone(cap.phone)}`, y, 15); y += 20; }
  y += 6; line(y, true); y += 24;
  t('شكرًا لطلبك 🌸', y, 18, { bold: true, x: (W - pad) / 2 + pad / 2, right: false, color: '#000' }); y += 22;
  t(SITE, y, 13, { x: (W - pad) / 2 + pad / 2, right: false, color: '#333' }); y += 24;

  const H = Math.max(320, Math.ceil(y + pad * 0.6));
  const out = createCanvas(W, H);
  const oc = out.getContext('2d');
  oc.fillStyle = '#fff'; oc.fillRect(0, 0, W, H);
  oc.drawImage(canvas, 0, 0);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = `receipt-${String(order.order_no || order.id).replace(/[^\w-]/g, '')}-${crypto.randomBytes(3).toString('hex')}.png`;
  const full = path.join(OUT_DIR, file);
  fs.writeFileSync(full, out.toBuffer('image/png'));
  return { pngFile: full, file, url: `/uploads/receipts/${file}`, width: W, height: H, mm: opts.widthMm || receiptWidthMm() };
}

// 📤 توليد الإيصال وإرساله للعميل (صورة غير مختومة)
export async function sendReceiptToCustomer(orderId) {
  const order = q.get("SELECT * FROM orders WHERE id=?", orderId);
  if (!order) return { error: 'طلب غير موجود' };
  const cust = order.customer_id ? q.get("SELECT phone, name FROM customers WHERE id=?", order.customer_id) : null;
  if (!cust?.phone) return { error: 'لا يوجد جوال للعميل' };
  const r = await renderOrderReceiptPng(order);
  const { waSend } = await import('./whatsapp.js');
  await waSend({ phone: cust.phone, restaurantId: order.restaurant_id, orderId, type: 'image', image: r.url,
    body: `🧾 *إيصال طلبك ${order.order_no}*\n💰 الإجمالي: ${money(order.total)} ر.س${Number(order.menu_discount) ? `\n🏷 الخصم: -${money(Number(order.menu_discount) + Number(order.discount || 0))} ر.س` : ''}` });
  return { ok: true, ...r };
}
