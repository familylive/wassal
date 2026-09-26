// ---------- فاتورة/تقرير مبيعات مرسوم (PNG + PDF) مع ختم «معتمد» وشعار المنصة ----------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import PDFDocument from 'pdfkit';
import { q } from '../db.js';
import { dailyStats, localNow, prettyDate, shiftDate } from './reporting.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, '..', 'assets');
const OUT_DIR = path.join(__dirname, '..', 'uploads', 'invoices');
const SITE = 'whats-ham.onrender.com';
const NATIONAL = 'وصل — Wassal Order';

const rls = (h) => (Number(h || 0) / 100).toFixed(2);
const money = (h) => (Number(h || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let ready = false;
let logoImg = null;
async function ensureAssets() {
  if (!ready) {
    try { GlobalFonts.registerFromPath(path.join(ASSETS, 'Cairo.ttf'), 'Cairo'); } catch (e) { console.error('FONT_REGISTER_FAIL', e.message); }
    ready = true;
  }
  if (!logoImg) { try { logoImg = await loadImage(path.join(ASSETS, 'logo.png')); } catch (e) { console.error('LOGO_LOAD_FAIL', e.message); } }
  return logoImg;
}

// ---------- رقم الفاتورة (ثابت لكل نشاط/يوم) ----------
export function invoiceNumber(restaurantId, dateStr) {
  const ex = q.get("SELECT no FROM invoices WHERE restaurant_id=? AND date=?", restaurantId, dateStr);
  if (ex?.no) return ex.no;
  const cnt = Number(q.get("SELECT COUNT(*) c FROM invoices WHERE date=?", dateStr).c) + 1;
  return `INV-${dateStr.replace(/-/g, '')}-${String(cnt).padStart(3, '0')}`;
}
export function ensureInvoiceRow(restaurantId, dateStr, stats, extra = {}) {
  const no = invoiceNumber(restaurantId, dateStr);
  const ex = q.get("SELECT id FROM invoices WHERE restaurant_id=? AND date=?", restaurantId, dateStr);
  if (ex) {
    q.run("UPDATE invoices SET total=?, orders_count=?, file=COALESCE(?,file), updated_at=datetime('now') WHERE id=?",
      stats?.salesTotal || 0, stats?.orders || 0, extra.file || null, ex.id);
    return q.get("SELECT * FROM invoices WHERE id=?", ex.id);
  }
  const r = q.run("INSERT INTO invoices (restaurant_id, date, no, total, orders_count, file) VALUES (?,?,?,?,?,?)",
    restaurantId, dateStr, no, stats?.salesTotal || 0, stats?.orders || 0, extra.file || null);
  return q.get("SELECT * FROM invoices WHERE id=?", Number(r.lastInsertRowid));
}

// تاريخ عربي مختصر للختم
function stampDate(dateStr) {
  const { hhmm } = localNow();
  return `${dateStr} — ${hhmm}`;
}

// ---------- الرسم على Canvas ----------
export async function renderInvoicePng(restaurantId, dateStr) {
  const logo = await ensureAssets();
  const r = q.get("SELECT * FROM restaurants WHERE id=?", restaurantId);
  if (!r) return null;
  const s = dailyStats(restaurantId, dateStr);
  const bt = r.business_type_id ? q.get("SELECT icon, name_ar FROM business_types WHERE id=?", r.business_type_id) : null;
  const inv = ensureInvoiceRow(restaurantId, dateStr, s);
  const { date: today, hhmm } = localNow();

  const W = 1000, H = 1414;
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');
  const GREEN = '#1FA855', DARK = '#0B2545', GREY = '#5b6b7c', LINE = '#e3e8ee', LIGHT = '#f5f8fa';

  // خلفية
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);

  const R = 850;           // الحافة اليمنى للنص العربي (RTL)
  const ar = (text, font, color, y, x = R, align = 'right') => {
    c.font = font; c.fillStyle = color; c.direction = 'rtl'; c.textAlign = align;
    c.fillText(String(text), x, y);
  };
  const en = (text, font, color, y, x, align = 'left') => {
    c.font = font; c.fillStyle = color; c.direction = 'ltr'; c.textAlign = align;
    c.fillText(String(text), x, y);
  };

  // ===== ترويسة =====
  c.fillStyle = GREEN; c.fillRect(0, 0, W, 12);
  c.fillStyle = LIGHT; c.fillRect(0, 12, W, 168);
  // الشعار داخل دائرة
  const lx = 830, ly = 96, lr = 52;
  c.save();
  c.beginPath(); c.arc(lx, ly, lr, 0, Math.PI * 2); c.closePath();
  c.fillStyle = '#ffffff'; c.fill();
  c.lineWidth = 3; c.strokeStyle = GREEN; c.stroke();
  if (logo) { c.save(); c.beginPath(); c.arc(lx, ly, lr - 4, 0, Math.PI * 2); c.closePath(); c.clip(); c.drawImage(logo, lx - lr + 4, ly - lr + 4, (lr - 4) * 2, (lr - 4) * 2); c.restore(); }
  c.restore();
  ar('واتس هم', 'bold 40px Cairo', DARK, 78, lx - 70);
  ar('منصة الطلبات والتوصيل', '24px Cairo', GREY, 116, lx - 70);
  en('Wassal Order', 'bold 22px Cairo', GREEN, 150, lx - 70, 'right');

  // جهة اليسار: الفاتورة
  en('SALES INVOICE', 'bold 22px Cairo', GREEN, 62, 60);
  ar('فاتورة مبيعات — تقرير يومي', 'bold 30px Cairo', DARK, 96, 60, 'left');
  ar(`رقم الفاتورة: ${inv.no}`, '24px Cairo', GREY, 132, 60, 'left');
  ar(`التاريخ: ${dateStr} — ${prettyDate(dateStr)}`, '22px Cairo', GREY, 162, 60, 'left');

  let y = 220;

  // ===== بيانات النشاط =====
  c.fillStyle = LIGHT; c.fillRect(50, y, W - 100, 116);
  c.fillStyle = GREEN; c.fillRect(50, y, 6, 116);
  ar(`${bt?.icon || '🏪'} ${r.name_ar}`, 'bold 32px Cairo', DARK, y + 44);
  ar(`${bt?.name_ar || ''}${r.city ? ' — ' + r.city : ''}${r.address && r.address !== r.city ? ' · ' + r.address : ''}`, '23px Cairo', GREY, y + 80);
  ar(`جوال النشاط: ${r.phone || '-'}`, '22px Cairo', GREY, y + 108);
  en(`ID: ${r.id}`, '22px Cairo', GREY, y + 44, 72);
  y += 150;

  // ===== الأصناف (مجمّعة) =====
  ar('الأصناف المبيعة (مجمّعة)', 'bold 27px Cairo', DARK, y + 8);
  y += 28;
  // رأس الجدول
  c.fillStyle = '#e8f5ee'; c.fillRect(50, y, W - 100, 46);
  ar('الصنف', 'bold 24px Cairo', DARK, y + 32, W - 80);
  ar('الكمية', 'bold 24px Cairo', DARK, y + 32, 330);
  ar('الإجمالي (ر.س)', 'bold 24px Cairo', DARK, y + 32, 150);
  y += 46;
  const top = (s.top || []);
  const maxRows = 16;
  const shown = top.slice(0, maxRows);
  if (!shown.length) {
    ar('لا توجد مبيعات في هذا اليوم', '24px Cairo', GREY, y + 36);
    y += 60;
  }
  for (const it of shown) {
    c.fillStyle = '#ffffff'; c.fillRect(50, y, W - 100, 44);
    c.strokeStyle = LINE; c.lineWidth = 1; c.beginPath(); c.moveTo(50, y + 44); c.lineTo(W - 50, y + 44); c.stroke();
    ar(String(it.name).slice(0, 34), '24px Cairo', '#22303c', y + 30, W - 80);
    ar(String(it.qty), 'bold 24px Cairo', DARK, y + 30, 330);
    const amt = it.sales != null ? it.sales : null;
    ar(amt != null ? money(amt) : '—', '24px Cairo', '#22303c', y + 30, 150);
    y += 44;
  }
  if (top.length > maxRows) { ar(`+ ${top.length - maxRows} أصناف أخرى`, '22px Cairo', GREY, y + 26); y += 40; }
  y += 18;

  // ===== ملخص الدفع =====
  const cash = s.methods.filter(x => x.method === 'cash').reduce((a, b) => ({ count: a.count + b.count, total: a.total + b.total }), { count: 0, total: 0 });
  const net = s.methods.filter(x => x.method !== 'cash').reduce((a, b) => ({ count: a.count + b.count, total: a.total + b.total }), { count: 0, total: 0 });
  c.fillStyle = LIGHT; c.fillRect(50, y, W - 100, 54);
  ar(`عدد الطلبات: ${s.orders}  ·  مكتملة: ${s.delivered}${s.cancelled ? `  ·  ملغاة: ${s.cancelled}` : ''}`, 'bold 24px Cairo', DARK, y + 36);
  y += 74;
  ar(`💳 شبكة (${s.methods.filter(x => x.method !== 'cash').map(x => `${x.method === 'mada' ? 'مدى' : x.method === 'card' ? 'بطاقة' : 'Apple Pay'} ${x.count}`).join(' · ') || 'لا شيء'}) — ${money(net.total)} ر.س`, '26px Cairo', '#22303c', y + 20);
  y += 48;
  ar(`💵 كاش — ${money(cash.total)} ر.س`, '26px Cairo', '#22303c', y + 20);
  y += 52;

  // ===== المجاميع =====
  c.strokeStyle = LINE; c.beginPath(); c.moveTo(50, y); c.lineTo(W - 50, y); c.stroke();
  y += 34;
  const gross = s.subtotal;
  ar(`إجمالي الأصناف: ${money(gross)} ر.س`, '25px Cairo', GREY, y); y += 38;
  if (s.discount) { ar(`الخصومات: -${money(s.discount)} ر.س`, '25px Cairo', GREY, y); y += 38; }
  if (s.fees) { ar(`رسوم التوصيل: ${money(s.fees)} ر.س`, '25px Cairo', GREY, y); y += 38; }
  y += 6;
  c.fillStyle = GREEN; c.fillRect(50, y, W - 100, 74);
  ar('المجموع الختام', 'bold 32px Cairo', '#ffffff', y + 48, W - 80);
  ar(`${money(s.salesTotal)} ر.س`, 'bold 36px Cairo', '#ffffff', y + 50, 120, 'left');
  y += 74;

  // ===== الختم المائل =====
  const stampW = 400, stampH = 225;
  const sy = Math.min(Math.max(y + 128, H - 330), H - 128);
  const sx = 70 + stampW / 2;
  c.save();
  c.translate(sx, sy);
  c.rotate(-13 * Math.PI / 180);
  c.globalAlpha = 0.68;
  c.strokeStyle = '#c0392b'; c.lineWidth = 5;
  const rx = -stampW / 2, ry = -stampH / 2;
  const rr = (x, y2, w, h, rad) => { c.beginPath(); c.moveTo(x + rad, y2); c.lineTo(x + w - rad, y2); c.quadraticCurveTo(x + w, y2, x + w, y2 + rad); c.lineTo(x + w, y2 + h - rad); c.quadraticCurveTo(x + w, y2 + h, x + w - rad, y2 + h); c.lineTo(x + rad, y2 + h); c.quadraticCurveTo(x, y2 + h, x, y2 + h - rad); c.lineTo(x, y2 + rad); c.quadraticCurveTo(x, y2, x + rad, y2); c.closePath(); };
  rr(rx, ry, stampW, stampH, 16); c.stroke();
  c.lineWidth = 2; rr(rx + 10, ry + 10, stampW - 20, stampH - 20, 12); c.stroke();
  // الشعار داخل الختم
  if (logo) {
    c.save();
    c.beginPath(); c.arc(rx + 58, ry + 56, 34, 0, Math.PI * 2); c.closePath();
    c.fillStyle = '#ffffff'; c.fill();
    c.lineWidth = 3; c.strokeStyle = '#c0392b'; c.stroke();
    c.beginPath(); c.arc(rx + 58, ry + 56, 30, 0, Math.PI * 2); c.clip();
    c.globalAlpha = 1; c.drawImage(logo, rx + 28, ry + 26, 60, 60); c.restore();
  }
  c.globalAlpha = 0.85;
  c.direction = 'rtl'; c.textAlign = 'right'; c.fillStyle = '#c0392b';
  c.font = 'bold 26px Cairo'; c.fillText('واتس هم', rx + stampW - 22, ry + 54);
  c.font = 'bold 36px Cairo'; c.fillText('معتمد', rx + stampW - 22, ry + 106);
  c.font = '21px Cairo'; c.fillText('موقع إلكتروني', rx + stampW - 22, ry + 136);
  c.font = 'bold 20px Cairo'; c.fillText('Wassal Order', rx + stampW - 22, ry + 166);
  c.font = '18px Cairo'; c.fillText(`${inv.no}`, rx + stampW - 22, ry + 194);
  c.font = '17px Cairo'; c.fillText(`${stampDate(dateStr)}`, rx + stampW - 22, ry + 217);
  c.restore();
  c.globalAlpha = 1;

  // ===== تذييل =====
  c.strokeStyle = LINE; c.beginPath(); c.moveTo(50, H - 150); c.lineTo(W - 50, H - 150); c.stroke();
  ar(`فاتورة إلكترونية صادرة من منصة واتس هم — ${NATIONAL}`, '22px Cairo', GREY, H - 110);
  ar(`للاستفسار: ${SITE}`, '21px Cairo', GREY, H - 78);
  ar(`تم الإنشاء آلياً بتاريخ ${today} الساعة ${hhmm} (توقيت السعودية)`, '19px Cairo', '#8a97a4', H - 48);

  return { png: canvas.toBuffer('image/png'), invoice: inv, stats: s, restaurant: r };
}

// ---------- 🧾 فاتورة الطلب (تُرسل للعميل بعد الإغلاق) ----------
// رقم الفاتورة = رقم الطلب (يبدأ من 5590)
export function orderInvoiceNo(order) {
  const digits = String(order?.order_no || '').replace(/[^\d]/g, '');
  if (digits) return Number(digits);
  const mx = Number(q.get("SELECT MAX(CAST(REPLACE(order_no,'#','') AS INTEGER)) m FROM orders WHERE order_no GLOB '#[0-9]*'")?.m || 0);
  return Math.max(5590, mx + 1);
}

export async function renderOrderInvoicePng(order) {
  const logo = await ensureAssets();
  const r = q.get("SELECT * FROM restaurants WHERE id=?", order.restaurant_id);
  const cust = q.get("SELECT name, phone FROM customers WHERE id=?", order.customer_id);
  const cap = order.captain_id ? q.get("SELECT name, phone FROM captains WHERE id=?", order.captain_id) : null;
  let rate = null;
  try { rate = q.get("SELECT score FROM customer_ratings WHERE order_id=? AND rater_type='captain' ORDER BY id DESC LIMIT 1", order.id); } catch (e) {}
  let orderRate = null;
  try { const cr = q.get("SELECT score FROM order_ratings WHERE order_id=? ORDER BY id DESC LIMIT 1", order.id); if (cr) orderRate = { avg: Number(cr.score) }; } catch (e) {}
  const invNo = orderInvoiceNo(order);
  let items = [];
  try { items = JSON.parse(order.items_json || '[]'); } catch (e) {}
  const isPickup = order.order_type === 'pickup';
  const riyadh = (x) => {
    const t = String(x || '').replace('T', ' ').slice(0, 19);
    if (!t) return '';
    const d = new Date((t.includes('Z') ? t : t.replace(' ', 'T') + 'Z'));
    if (isNaN(d.getTime())) return t.slice(0, 16);
    const r = new Date(d.getTime() + 3 * 3600 * 1000);
    return `${r.toISOString().slice(0, 10)} ${r.toISOString().slice(11, 16)}`;
  };
  const dt = riyadh(order.delivered_at || order.created_at);

  const W = 1000, H = 1414;
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');
  const GREEN = '#1FA855', DARK = '#0B2545', GREY = '#5b6b7c', LINE = '#e3e8ee', LIGHT = '#f5f8fa';
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);
  const R = 850;
  const ar = (t, font, color, y, x = R, align = 'right') => { c.font = font; c.fillStyle = color; c.direction = 'rtl'; c.textAlign = align; c.fillText(String(t), x, y); };
  const en = (t, font, color, y, x, align = 'left') => { c.font = font; c.fillStyle = color; c.direction = 'ltr'; c.textAlign = align; c.fillText(String(t), x, y); };

  // ترويسة
  c.fillStyle = GREEN; c.fillRect(0, 0, W, 12);
  c.fillStyle = LIGHT; c.fillRect(0, 12, W, 178);
  const lx = 830, ly = 100, lr = 54;
  c.save();
  c.beginPath(); c.arc(lx, ly, lr, 0, Math.PI * 2); c.closePath(); c.fillStyle = '#ffffff'; c.fill();
  c.lineWidth = 3; c.strokeStyle = GREEN; c.stroke();
  if (logo) { c.save(); c.beginPath(); c.arc(lx, ly, lr - 4, 0, Math.PI * 2); c.closePath(); c.clip(); c.drawImage(logo, lx - lr + 4, ly - lr + 4, (lr - 4) * 2, (lr - 4) * 2); c.restore(); }
  c.restore();
  ar('واتس هم', 'bold 40px Cairo', DARK, 80, lx - 74);
  ar('منصة الطلبات والتوصيل', '24px Cairo', GREY, 118, lx - 74);
  en('Wassal Order', 'bold 22px Cairo', GREEN, 152, lx - 74, 'right');
  ar('فاتورة ضريبية مبسطة / إيصال', 'bold 30px Cairo', DARK, 78, 60, 'left');
  ar(`رقم الفاتورة: ${invNo}`, 'bold 26px Cairo', DARK, 116, 60, 'left');
  ar(`التاريخ: ${dt}`, '23px Cairo', GREY, 150, 60, 'left');
  ar(`رقم الطلب: ${order.order_no || ''}`, '23px Cairo', GREY, 178, 60, 'left');

  let y = 226;
  // اسم النشاط (على الفاتورة)
  c.fillStyle = LIGHT; c.fillRect(50, y, W - 100, 116);
  c.fillStyle = GREEN; c.fillRect(50, y, 6, 116);
  ar(`${r?.name_ar || ''}`, 'bold 36px Cairo', DARK, y + 48);
  ar(`${r?.city || ''}${r?.address && r.address !== r.city ? ' · ' + r.address : ''}`, '23px Cairo', GREY, y + 84);
  ar(`جوال النشاط: ${r?.phone || '-'}`, '22px Cairo', GREY, y + 112);
  en(`BUSINESS #${r?.id || ''}`, '21px Cairo', GREY, y + 48, 72);
  y += 150;

  // بيانات العميل والطلب
  c.fillStyle = '#ffffff'; c.fillRect(50, y, W - 100, 96); c.strokeStyle = LINE; c.strokeRect(50, y, W - 100, 96);
  ar(`👤 العميل: ${cust?.name || ''}  ·  📱 ${cust?.phone || ''}`, '24px Cairo', '#22303c', y + 40);
  ar(`${isPickup ? '🏪 استلام من النشاط' : '🛵 توصيل'}  ·  💳 ${order.payment_method === 'cash' ? 'كاش عند الاستلام' : (order.payment_method === 'mada' ? 'مدى' : order.payment_method === 'card' ? 'بطاقة' : 'Apple Pay')}`, '24px Cairo', '#22303c', y + 76);
  if (cap) ar(`🛵 الكابتن: ${cap.name || ''}`, '22px Cairo', GREY, y + 76, 140, 'left');
  y += 120;

  // جدول الأصناف
  ar('تفاصيل الأصناف', 'bold 27px Cairo', DARK, y + 6);
  y += 26;
  c.fillStyle = '#e8f5ee'; c.fillRect(50, y, W - 100, 46);
  ar('الصنف', 'bold 24px Cairo', DARK, y + 32, W - 80);
  ar('الكمية', 'bold 24px Cairo', DARK, y + 32, 330);
  ar('السعر', 'bold 24px Cairo', DARK, y + 32, 220);
  ar('الإجمالي (ر.س)', 'bold 24px Cairo', DARK, y + 32, 130);
  y += 46;
  let subtotalCalc = 0;
  for (const it of items.slice(0, 14)) {
    const qty = Number(it.quantity || 1), pr = Number(it.price || 0);
    subtotalCalc += qty * pr;
    c.fillStyle = '#ffffff'; c.fillRect(50, y, W - 100, 44);
    c.strokeStyle = LINE; c.lineWidth = 1; c.beginPath(); c.moveTo(50, y + 44); c.lineTo(W - 50, y + 44); c.stroke();
    ar(String(it.name || '').slice(0, 30), '24px Cairo', '#22303c', y + 30, W - 80);
    ar(String(qty), 'bold 24px Cairo', DARK, y + 30, 330);
    ar(money(pr), '24px Cairo', '#22303c', y + 30, 220);
    ar(money(qty * pr), 'bold 24px Cairo', DARK, y + 30, 130);
    y += 44;
  }
  if (items.length > 14) { ar(`+ ${items.length - 14} أصناف أخرى`, '22px Cairo', GREY, y + 26); y += 40; }
  y += 20;

  // المجاميع
  c.strokeStyle = LINE; c.beginPath(); c.moveTo(50, y); c.lineTo(W - 50, y); c.stroke();
  y += 36;
  ar(`إجمالي الأصناف: ${money(order.subtotal || subtotalCalc)} ر.س`, '25px Cairo', GREY, y); y += 40;
  if (Number(order.discount)) { ar(`الخصم: -${money(order.discount)} ر.س`, '25px Cairo', GREY, y); y += 40; }
  ar(`${isPickup ? 'التوصيل: استلام من النشاط' : `مبلغ التوصيل: ${money(order.delivery_fee)} ر.س`}`, '25px Cairo', GREY, y); y += 44;
  c.fillStyle = GREEN; c.fillRect(50, y, W - 100, 78);
  ar('المجموع النهائي', 'bold 32px Cairo', '#ffffff', y + 50, W - 80);
  ar(`${money(order.total)} ر.س`, 'bold 36px Cairo', '#ffffff', y + 52, 120, 'left');
  y += 96;
  ar(`${Number(order.is_preorder) ? '📅 طلب مسبق: ' + (order.scheduled_for || '') + ' ' + (order.scheduled_time || '') : ''}`, '23px Cairo', GREY, y);
  if (orderRate?.avg || orderRate?.restaurant) {
    const arr = [orderRate.restaurant, orderRate.speed, orderRate.captain, orderRate.avg].filter(x => x != null).map(Number);
    const m = arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    if (m) { ar(`⭐ تقييم العميل للطلب: ${m.toFixed(1)}/5`, '23px Cairo', GREY, y + 34); y += 34; }
  }
  if (rate?.score) { ar(`🛵 تقييم الكابتن للعميل: ${Math.round(Number(rate.score) / 200)}/5`, '23px Cairo', GREY, y + 34); y += 34; }

  // ===== الختم: معتمد من منصة واتس هم + اسم النشاط + الرقم والتاريخ =====
  const stampW = 440, stampH = 260;
  const sy = Math.min(Math.max(y + 130, H - 360), H - 150);
  const sx = 70 + stampW / 2;
  c.save();
  c.translate(sx, sy);
  c.rotate(-12 * Math.PI / 180);
  c.globalAlpha = 0.7;
  c.strokeStyle = '#c0392b'; c.lineWidth = 5;
  const rx = -stampW / 2, ry = -stampH / 2;
  const rr = (x, y2, w, h, rad) => { c.beginPath(); c.moveTo(x + rad, y2); c.lineTo(x + w - rad, y2); c.quadraticCurveTo(x + w, y2, x + w, y2 + rad); c.lineTo(x + w, y2 + h - rad); c.quadraticCurveTo(x + w, y2 + h, x + w - rad, y2 + h); c.lineTo(x + rad, y2 + h); c.quadraticCurveTo(x, y2 + h, x, y2 + h - rad); c.lineTo(x, y2 + rad); c.quadraticCurveTo(x, y2, x + rad, y2); c.closePath(); };
  rr(rx, ry, stampW, stampH, 16); c.stroke();
  c.lineWidth = 2; rr(rx + 10, ry + 10, stampW - 20, stampH - 20, 12); c.stroke();
  if (logo) {
    c.save();
    c.beginPath(); c.arc(rx + 60, ry + 58, 36, 0, Math.PI * 2); c.closePath(); c.fillStyle = '#ffffff'; c.fill();
    c.lineWidth = 3; c.strokeStyle = '#c0392b'; c.stroke();
    c.beginPath(); c.arc(rx + 60, ry + 58, 32, 0, Math.PI * 2); c.clip();
    c.globalAlpha = 1; c.drawImage(logo, rx + 28, ry + 26, 64, 64); c.restore();
  }
  c.globalAlpha = 0.85;
  c.direction = 'rtl'; c.textAlign = 'right'; c.fillStyle = '#c0392b';
  c.font = 'bold 26px Cairo'; c.fillText('واتس هم', rx + stampW - 22, ry + 52);
  c.font = 'bold 32px Cairo'; c.fillText('معتمد من منصة واتس هم', rx + stampW - 22, ry + 100);
  c.font = 'bold 24px Cairo'; c.fillText(String(r?.name_ar || '').slice(0, 26), rx + stampW - 22, ry + 140);
  c.font = '20px Cairo'; c.fillText('موقع إلكتروني · Wassal Order', rx + stampW - 22, ry + 176);
  c.font = 'bold 20px Cairo'; c.fillText(`فاتورة رقم ${invNo}`, rx + stampW - 22, ry + 210);
  c.font = '18px Cairo'; c.fillText(`${dt}`, rx + stampW - 22, ry + 238);
  c.restore();
  c.globalAlpha = 1;

  // تذييل
  c.strokeStyle = LINE; c.beginPath(); c.moveTo(50, H - 150); c.lineTo(W - 50, H - 150); c.stroke();
  ar(`فاتورة إلكترونية صادرة من منصة واتس هم — ${NATIONAL}`, '22px Cairo', GREY, H - 110);
  ar(`حقوق المنصة محفوظة لشركة Whatsham · للاستفسار: ${SITE}`, '21px Cairo', GREY, H - 78);
  ar(`أُنشئت آلياً بعد إغلاق الطلب — ${localNow().date}`, '19px Cairo', '#8a97a4', H - 48);

  return { png: canvas.toBuffer('image/png'), invNo, restaurant: r };
}

export async function buildOrderInvoiceFiles(order) {
  const out = await renderOrderInvoicePng(order);
  if (!out) return null;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = `order-${String(order.order_no || order.id).replace(/[^\w-]/g, '')}-${order.id}-${(await import('node:crypto')).randomBytes(4).toString('hex')}`;
  const pngFile = path.join(OUT_DIR, `${base}.png`);
  const pdfFile = path.join(OUT_DIR, `${base}.pdf`);
  fs.writeFileSync(pngFile, out.png);
  try { fs.writeFileSync(pdfFile, await pngToPdf(out.png, `Invoice ${out.invNo}`)); } catch (e) { console.error('ORDER_INV_PDF_FAIL', e.message); }
  q.run("UPDATE orders SET invoice_no=?, invoice_file=? WHERE id=?", out.invNo, `order-${order.id}.pdf`, order.id);
  return { pngFile, pdfFile, invNo: out.invNo, base };
}

// 📤 إرسال فاتورة الطلب للعميل (وللنشاط نسخة)
export async function sendOrderInvoice(orderId) {
  const order = q.get("SELECT * FROM orders WHERE id=?", Number(orderId));
  if (!order) return { error: 'طلب غير موجود' };
  const files = await buildOrderInvoiceFiles(order);
  if (!files) return { error: 'تعذّر إنشاء الفاتورة' };
  const cfg = (await import('../config.js')).default;
  const url = `${cfg.publicUrl}/uploads/invoices/${files.base}.pdf`;
  const { waSend } = await import('./whatsapp.js');
  const cust = q.get("SELECT phone FROM customers WHERE id=?", order.customer_id);
  if (cust?.phone) {
    await waSend({ phone: cust.phone, restaurantId: order.restaurant_id, orderId: order.id, type: 'document',
      document: { link: url, filename: `Wassal-${files.invNo}.pdf` },
      body: `🧾 *فاتورة طلبك ${order.order_no}*\n💰 المجموع النهائي: ${rls(order.total)} ر.س\n_(فاتورة مختومة من منصة واتس هم)_` }).catch(e => console.error('INV_SEND_CUST_FAIL', e.message));
  }
  // نسخة للنشاط (المالك/الكاشير)
  try {
    const { ordersPhone } = await import('./restUsers.js');
    const to = ordersPhone(order.restaurant_id);
    if (to) await waSend({ phone: to, restaurantId: order.restaurant_id, orderId: order.id, type: 'document',
      document: { link: url, filename: `Wassal-${files.invNo}.pdf` },
      body: `🧾 *فاتورة الطلب ${order.order_no}* — ${rls(order.total)} ر.س\n_(نسخة النشاط)_` });
  } catch (e) { console.error('INV_SEND_BIZ_FAIL', e.message); }
  return { ok: true, invNo: files.invNo, url };
}

// ---------- تحويل الصورة إلى PDF ----------
export function pngToPdf(pngBuffer, title = 'invoice') {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: title, Author: 'Wassal Order' } });
      const chunks = [];
      doc.on('data', (d) => chunks.push(d));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.image(pngBuffer, 0, 0, { width: 595.28, height: 841.89 });
      doc.end();
    } catch (e) { reject(e); }
  });
}

// ---------- توليد الفاتورة وحفظها وإرجاع روابطها ----------
export async function buildInvoiceFiles(restaurantId, dateStr) {
  const out = await renderInvoicePng(restaurantId, dateStr);
  if (!out) return null;
  const pdf = await pngToPdf(out.png, out.invoice.no);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = `${out.invoice.no}-r${restaurantId}`;
  const pngPath = path.join(OUT_DIR, `${base}.png`);
  const pdfPath = path.join(OUT_DIR, `${base}.pdf`);
  try { fs.writeFileSync(pngPath, out.png); fs.writeFileSync(pdfPath, pdf); } catch (e) { console.error('INVOICE_WRITE_FAIL', e.message); }
  try { q.run("UPDATE invoices SET file=?, total=?, orders_count=?, updated_at=datetime('now') WHERE id=?", `${base}.pdf`, out.stats.salesTotal, out.stats.orders, out.invoice.id); } catch { /* */ }
  return { ...out, pdf, pngPath, pdfPath, base };
}

// ---------- 🏛 تقرير الإدارة المجمّع (مختوم) ----------
export async function renderPlatformReportPng(dateStr, stats) {
  const logo = await ensureAssets();
  const s = stats || (await import('./reporting.js')).platformStats(dateStr);
  const no = `RPT-${String(dateStr).replace(/-/g, '')}`;
  const { date: today, hhmm } = localNow();

  const W = 1000, H = 1414;
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');
  const GREEN = '#1FA855', DARK = '#0B2545', GREY = '#5b6b7c', LINE = '#e3e8ee', LIGHT = '#f5f8fa';
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);
  const R = 850;
  const ar = (text, font, color, y, x = R, align = 'right') => { c.font = font; c.fillStyle = color; c.direction = 'rtl'; c.textAlign = align; c.fillText(String(text), x, y); };
  const en = (text, font, color, y, x, align = 'left') => { c.font = font; c.fillStyle = color; c.direction = 'ltr'; c.textAlign = align; c.fillText(String(text), x, y); };

  c.fillStyle = GREEN; c.fillRect(0, 0, W, 12);
  c.fillStyle = LIGHT; c.fillRect(0, 12, W, 168);
  const lx = 830, ly = 96, lr = 52;
  c.save();
  c.beginPath(); c.arc(lx, ly, lr, 0, Math.PI * 2); c.closePath(); c.fillStyle = '#fff'; c.fill();
  c.lineWidth = 3; c.strokeStyle = GREEN; c.stroke();
  if (logo) { c.save(); c.beginPath(); c.arc(lx, ly, lr - 4, 0, Math.PI * 2); c.closePath(); c.clip(); c.drawImage(logo, lx - lr + 4, ly - lr + 4, (lr - 4) * 2, (lr - 4) * 2); c.restore(); }
  c.restore();
  ar('واتس هم', 'bold 40px Cairo', DARK, 78, lx - 70);
  ar('منصة الطلبات والتوصيل', '24px Cairo', GREY, 116, lx - 70);
  en('Wassal Order', 'bold 22px Cairo', GREEN, 150, lx - 70, 'right');
  en('PLATFORM REPORT', 'bold 22px Cairo', GREEN, 62, 60);
  ar('تقرير الإدارة المجمّع', 'bold 30px Cairo', DARK, 96, 60, 'left');
  ar(`رقم التقرير: ${no}`, '24px Cairo', GREY, 132, 60, 'left');
  ar(`التاريخ: ${dateStr} — ${prettyDate(dateStr)}`, '22px Cairo', GREY, 162, 60, 'left');

  let y = 220;
  c.fillStyle = LIGHT; c.fillRect(50, y, W - 100, 96);
  c.fillStyle = GREEN; c.fillRect(50, y, 6, 96);
  ar('ملخص اليوم', 'bold 28px Cairo', DARK, y + 40);
  ar(`إجمالي الطلبات: ${s.orders}   ·   مكتملة: ${s.delivered}${s.cancelled ? `   ·   ملغاة: ${s.cancelled}` : ''}${s.pickup ? `   ·   استلام: ${s.pickup}` : ''}`, '24px Cairo', GREY, y + 76);
  y += 130;

  ar('مبيعات الأنشطة', 'bold 27px Cairo', DARK, y + 8);
  y += 28;
  c.fillStyle = '#e8f5ee'; c.fillRect(50, y, W - 100, 46);
  ar('نوع النشاط', 'bold 24px Cairo', DARK, y + 32, W - 80);
  ar('عدد الطلبات', 'bold 24px Cairo', DARK, y + 32, 330);
  ar('المبلغ (ر.س)', 'bold 24px Cairo', DARK, y + 32, 150);
  y += 46;
  const types = (s.types || []).slice(0, 14);
  if (!types.length) { ar('لا مبيعات في هذا اليوم', '24px Cairo', GREY, y + 36); y += 60; }
  for (const t of types) {
    c.strokeStyle = LINE; c.lineWidth = 1; c.beginPath(); c.moveTo(50, y + 44); c.lineTo(W - 50, y + 44); c.stroke();
    ar(`${t.icon || '🏬'} ${t.type_name}`, '24px Cairo', '#22303c', y + 30, W - 80);
    ar(String(t.orders), 'bold 24px Cairo', DARK, y + 30, 330);
    ar(money(t.total), 'bold 24px Cairo', '#22303c', y + 30, 150);
    y += 44;
  }
  y += 20;

  ar(`💳 شبكة: ${money(s.net)} ر.س   ·   💵 كاش: ${money(s.cash)} ر.س`, '25px Cairo', '#22303c', y + 18); y += 42;
  if (s.commissionBusiness != null) { ar(`🏛 عمولات المنصة: من الأنشطة ${money(s.commissionBusiness)} + من الكباتن ${money(s.commissionCaptain)} ر.س`, '23px Cairo', '#22303c', y + 16); y += 38; }
  if (s.discount) { ar(`🏷 الخصومات: -${money(s.discount)} ر.س`, '24px Cairo', GREY, y + 16); y += 36; }
  if (s.fee) { ar(`🛵 رسوم التوصيل: ${money(s.fee)} ر.س`, '24px Cairo', GREY, y + 16); y += 36; }
  y += 10;
  c.fillStyle = GREEN; c.fillRect(50, y, W - 100, 70);
  ar('المجموع الختامي', 'bold 30px Cairo', '#ffffff', y + 46, W - 80);
  ar(`${money(s.total)} ر.س`, 'bold 34px Cairo', '#ffffff', y + 47, 120, 'left');
  y += 70;
  c.fillStyle = DARK; c.fillRect(50, y, W - 100, 66);
  ar('حصة المنصة', 'bold 28px Cairo', '#ffffff', y + 44, W - 80);
  ar(`${money(s.share)} ر.س`, 'bold 32px Cairo', '#ffffff', y + 45, 120, 'left');
  y += 66;

  // الختم
  const stampW = 400, stampH = 225;
  const sy = Math.min(Math.max(y + 128, H - 330), H - 128);
  const sx = 70 + stampW / 2;
  c.save();
  c.translate(sx, sy);
  c.rotate(-13 * Math.PI / 180);
  c.globalAlpha = 0.68;
  c.strokeStyle = '#c0392b'; c.lineWidth = 5;
  const rx = -stampW / 2, ry = -stampH / 2;
  const rr = (x, y2, w, h, rad) => { c.beginPath(); c.moveTo(x + rad, y2); c.lineTo(x + w - rad, y2); c.quadraticCurveTo(x + w, y2, x + w, y2 + rad); c.lineTo(x + w, y2 + h - rad); c.quadraticCurveTo(x + w, y2 + h, x + w - rad, y2 + h); c.lineTo(x + rad, y2 + h); c.quadraticCurveTo(x, y2 + h, x, y2 + h - rad); c.lineTo(x, y2 + rad); c.quadraticCurveTo(x, y2, x + rad, y2); c.closePath(); };
  rr(rx, ry, stampW, stampH, 16); c.stroke();
  c.lineWidth = 2; rr(rx + 10, ry + 10, stampW - 20, stampH - 20, 12); c.stroke();
  if (logo) {
    c.save();
    c.beginPath(); c.arc(rx + 58, ry + 56, 34, 0, Math.PI * 2); c.closePath(); c.fillStyle = '#ffffff'; c.fill();
    c.lineWidth = 3; c.strokeStyle = '#c0392b'; c.stroke();
    c.beginPath(); c.arc(rx + 58, ry + 56, 30, 0, Math.PI * 2); c.clip();
    c.globalAlpha = 1; c.drawImage(logo, rx + 28, ry + 26, 60, 60); c.restore();
  }
  c.globalAlpha = 0.85;
  c.direction = 'rtl'; c.textAlign = 'right'; c.fillStyle = '#c0392b';
  c.font = 'bold 26px Cairo'; c.fillText('واتس هم', rx + stampW - 22, ry + 54);
  c.font = 'bold 36px Cairo'; c.fillText('معتمد', rx + stampW - 22, ry + 106);
  c.font = '21px Cairo'; c.fillText('موقع إلكتروني', rx + stampW - 22, ry + 136);
  c.font = 'bold 20px Cairo'; c.fillText('Wassal Order', rx + stampW - 22, ry + 166);
  c.font = '18px Cairo'; c.fillText(no, rx + stampW - 22, ry + 194);
  c.font = '17px Cairo'; c.fillText(`${dateStr} — ${hhmm}`, rx + stampW - 22, ry + 217);
  c.restore();
  c.globalAlpha = 1;

  c.strokeStyle = LINE; c.beginPath(); c.moveTo(50, H - 150); c.lineTo(W - 50, H - 150); c.stroke();
  ar(`تقرير إلكتروني صادر من منصة واتس هم — ${NATIONAL}`, '22px Cairo', GREY, H - 110);
  ar(`للاستفسار: ${SITE}`, '21px Cairo', GREY, H - 78);
  ar(`تم الإنشاء آلياً بتاريخ ${today} الساعة ${hhmm} (توقيت السعودية)`, '19px Cairo', '#8a97a4', H - 48);

  return { png: canvas.toBuffer('image/png'), no, stats: s };
}

// ملفّات تقرير الإدارة (PNG + PDF)
export async function buildPlatformReportFiles(dateStr, stats) {
  const out = await renderPlatformReportPng(dateStr, stats);
  const pdf = await pngToPdf(out.png, out.no);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = `${out.no}`;
  try { fs.writeFileSync(path.join(OUT_DIR, `${base}.png`), out.png); fs.writeFileSync(path.join(OUT_DIR, `${base}.pdf`), pdf); } catch (e) { console.error('PLATFORM_REPORT_WRITE_FAIL', e.message); }
  return { ...out, pdf, base };
}
