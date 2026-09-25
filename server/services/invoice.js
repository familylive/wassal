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
const money = (h) => Number(h || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
