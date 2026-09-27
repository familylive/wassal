// ---------- كشف حساب العميل (PNG + PDF): كل طلباته + المجموع النهائي + المدفوع + تفصيل الأقسام ----------
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { q } from '../db.js';
import { pngToPdf } from './invoice.js';
import { localNow, prettyDate } from './reporting.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, '..', 'assets');
const OUT_DIR = path.join(__dirname, '..', 'uploads', 'invoices');
const SITE = 'whats-ham.onrender.com';

const rls = (h) => (Number(h || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let ready = false; let logoImg = null; let stampLogoImg = null;
async function ensureAssets() {
  if (!ready) {
    try { GlobalFonts.registerFromPath(path.join(ASSETS, 'Cairo.ttf'), 'Cairo'); } catch (e) { console.error('FONT_REGISTER_FAIL', e.message); }
    ready = true;
  }
  if (!logoImg) { try { logoImg = await loadImage(path.join(ASSETS, 'logo.png')); } catch (e) { console.error('LOGO_LOAD_FAIL', e.message); } }
  if (!stampLogoImg) {
    try { stampLogoImg = await loadImage(path.join(ASSETS, 'logo-stamp.png')); }
    catch (e) { stampLogoImg = logoImg; }
  }
  return logoImg;
}

// ---------- بيانات الكشف ----------
export function customerOrdersSummary(customerId, limit = 300) {
  const rows = q.all(`SELECT o.id, o.order_no, o.total, o.payment_status, o.status, o.created_at, o.order_type,
      o.restaurant_id, r.name_ar AS restaurant_name, COALESCE(bt.name_ar, 'أخرى') AS category, COALESCE(bt.icon, '🏪') AS icon
    FROM orders o
    LEFT JOIN restaurants r ON r.id = o.restaurant_id
    LEFT JOIN business_types bt ON bt.id = r.business_type_id
    WHERE o.customer_id = ? AND COALESCE(o.order_no,'') != 'DRAFT'
    ORDER BY o.id DESC LIMIT ?`, customerId, limit);

  const byCat = {};
  let total = 0, paid = 0, orders = 0;
  for (const o of rows) {
    if (String(o.status) === 'cancelled') continue;
    const t = Number(o.total || 0);
    orders += 1; total += t;
    if (String(o.payment_status) === 'paid') paid += t;
    const k = o.category || 'أخرى';
    if (!byCat[k]) byCat[k] = { icon: o.icon || '🏪', count: 0, total: 0 };
    byCat[k].count += 1; byCat[k].total += t;
  }
  return { rows, byCat, total, paid, unpaid: Math.max(0, total - paid), orders };
}

export function statementNo(customerId, dateStr) {
  return `STMT-${String(dateStr || '').replace(/-/g, '')}-${String(customerId).padStart(4, '0')}`;
}

// ---------- الرسم ----------
export async function renderCustomerStatementPng(customerId) {
  const logo = await ensureAssets();
  const c0 = q.get("SELECT * FROM customers WHERE id=?", customerId);
  if (!c0) return null;
  const s = customerOrdersSummary(customerId);
  const { date: today, hhmm } = localNow();
  const no = statementNo(customerId, today);

  const W = 1000, H = 1414;
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');
  const GREEN = '#229ED9', DARK = '#17212B', GREY = '#5b6b7c', LINE = '#dce8f2', LIGHT = '#F2F8FC';
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);

  const R = 850;
  const ar = (text, font, color, y, x = R, align = 'right') => {
    c.font = font; c.fillStyle = color; c.direction = 'rtl'; c.textAlign = align;
    c.fillText(String(text ?? ''), x, y);
  };
  const en = (text, font, color, y, x, align = 'left') => {
    c.font = font; c.fillStyle = color; c.direction = 'ltr'; c.textAlign = align;
    c.fillText(String(text ?? ''), x, y);
  };

  // ترويسة
  c.fillStyle = GREEN; c.fillRect(0, 0, W, 12);
  c.fillStyle = LIGHT; c.fillRect(0, 12, W, 168);
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

  en('CUSTOMER STATEMENT', 'bold 20px Cairo', GREEN, 60, 60);
  ar('كشف حساب العميل', 'bold 32px Cairo', DARK, 96, 60, 'left');
  ar(`رقم الكشف: ${no}`, '23px Cairo', GREY, 132, 60, 'left');
  ar(`تاريخ الإصدار: ${today} — ${prettyDate(today)} · ${hhmm}`, '21px Cairo', GREY, 162, 60, 'left');

  let y = 220;
  // بيانات العميل
  c.fillStyle = LIGHT; c.fillRect(50, y, W - 100, 110);
  c.fillStyle = GREEN; c.fillRect(50, y, 6, 110);
  ar(`👤 ${c0.name || 'عميل'}`, 'bold 30px Cairo', DARK, y + 44);
  ar(`📱 ${c0.phone || '-'}   🏅 الفئة: ${c0.tier || 'برونزي'}`, '22px Cairo', GREY, y + 78);
  ar(`🧮 عدد الطلبات: ${s.orders}   🎁 نقاط الولاء: ${Number(c0.points_balance || 0)}`, '22px Cairo', GREY, y + 104);
  en(`ID: ${c0.id}`, '22px Cairo', GREY, y + 44, 72);
  y += 146;

  // جدول الطلبات
  ar('الطلبات السابقة', 'bold 27px Cairo', DARK, y + 6);
  en(`(${s.rows.length})`, 'bold 22px Cairo', GREY, y + 6, 78, 'left');
  y += 22;
  c.fillStyle = '#E3F2FB'; c.fillRect(50, y, W - 100, 42);
  ar('الطلب', 'bold 20px Cairo', DARK, y + 28, 850);
  ar('التاريخ', 'bold 20px Cairo', DARK, y + 28, 700);
  ar('النشاط / القسم', 'bold 20px Cairo', DARK, y + 28, 560);
  ar('الحالة', 'bold 20px Cairo', DARK, y + 28, 260);
  en('TOTAL', 'bold 20px Cairo', DARK, y + 28, 66, 'left');
  y += 42;

  const STATUS_AR = { new: 'جديد', confirmed: 'مؤكد', preparing: 'يُحضّر', ready: 'جاهز', offered: 'معروض', accepted: 'مقبول', transferred: 'مع كابتن', with_captain: 'مع الكابتن', on_the_way: 'في الطريق', arrived: 'وصل', delivered: 'سُلّم', cancelled: 'ملغي' };
  const list = s.rows.slice(0, 24);
  let i = 0;
  for (const o of list) {
    const rowH = 38;
    if (i % 2 === 1) { c.fillStyle = '#F8FBFD'; c.fillRect(50, y, W - 100, rowH); }
    const cancelled = String(o.status) === 'cancelled';
    const dt = String(o.created_at || '').slice(0, 10);
    ar(String(o.order_no || ('#' + o.id)), 'bold 19px Cairo', cancelled ? '#9aa7b3' : DARK, y + 26, 850);
    en(dt, '19px Cairo', GREY, y + 26, 700, 'right');
    ar(`${o.icon || ''} ${String(o.restaurant_name || '').slice(0, 20)} — ${o.category}`, '18px Cairo', GREY, y + 26, 560);
    ar(STATUS_AR[o.status] || o.status || '', '19px Cairo', cancelled ? '#c0392b' : GREEN, y + 26, 260);
    const paidMark = String(o.payment_status) === 'paid' ? '' : ' ⏳';
    en(rls(o.total) + paidMark, 'bold 19px Cairo', cancelled ? '#9aa7b3' : DARK, y + 26, 66, 'left');
    c.strokeStyle = LINE; c.beginPath(); c.moveTo(50, y + rowH); c.lineTo(W - 50, y + rowH); c.stroke();
    y += rowH; i++;
    if (y > H - 470) break;
  }
  if (s.rows.length > list.length) { ar(`+ ${s.rows.length - list.length} طلب أقدم`, '19px Cairo', GREY, y + 26); y += 34; }
  y += 22;

  // صندوق المجموع النهائي (مختوم)
  const boxH = 132;
  c.fillStyle = '#17212B'; c.fillRect(50, y, W - 100, boxH);
  ar('المجموع النهائي', 'bold 30px Cairo', '#ffffff', y + 48, 850);
  en(`${rls(s.total)} SAR`, 'bold 40px Cairo', '#8ED8F8', y + 52, 70, 'left');
  ar(`المدفوع: ${rls(s.paid)} ر.س   ·   المتبقي: ${rls(s.unpaid)} ر.س`, '23px Cairo', '#CFE9F6', y + 96, 850);
  en(`PAID ${rls(s.paid)}  /  DUE ${rls(s.unpaid)}`, '20px Cairo', '#CFE9F6', y + 98, 70, 'left');
  y += boxH + 34;

  // تفصيل حسب الأقسام
  ar('التفصيل حسب الأقسام', 'bold 26px Cairo', DARK, y + 6);
  y += 24;
  for (const [name, v] of Object.entries(s.byCat)) {
    c.fillStyle = LIGHT; c.fillRect(50, y, W - 100, 40);
    ar(`${v.icon} ${name}`, 'bold 21px Cairo', DARK, y + 27, 830);
    ar(`${v.count} طلب`, '20px Cairo', GREY, y + 27, 400);
    en(rls(v.total), 'bold 21px Cairo', GREEN, y + 27, 66, 'left');
    y += 44;
    if (y > H - 260) break;
  }

  // ختم معتمد: الشعار الرسمي داخل الختم + تاريخ ووقت الإصدار
  const stampW = 470, stampH = 245;
  const sx = 70 + stampW / 2, sy = H - 350;
  c.save();
  c.translate(sx, sy); c.rotate(-12 * Math.PI / 180); c.globalAlpha = 0.8;
  c.strokeStyle = '#1B7FB8'; c.lineWidth = 5;
  const rx = -stampW / 2, ry = -stampH / 2;
  const rr = (x, y2, w, h, rad) => { c.beginPath(); c.moveTo(x + rad, y2); c.lineTo(x + w - rad, y2); c.quadraticCurveTo(x + w, y2, x + w, y2 + rad); c.lineTo(x + w, y2 + h - rad); c.quadraticCurveTo(x + w, y2 + h, x + w - rad, y2 + h); c.lineTo(x + rad, y2 + h); c.quadraticCurveTo(x, y2 + h, x, y2 + h - rad); c.lineTo(x, y2 + rad); c.quadraticCurveTo(x, y2, x + rad, y2); c.closePath(); };
  rr(rx, ry, stampW, stampH, 16); c.stroke();
  c.lineWidth = 2; rr(rx + 10, ry + 10, stampW - 20, stampH - 20, 12); c.stroke();
  // الشعار الرسمي داخل الختم
  if (stampLogoImg || logo) {
    const img = stampLogoImg || logo;
    c.save();
    c.beginPath(); c.arc(rx + 70, ry + 78, 50, 0, Math.PI * 2); c.closePath();
    c.fillStyle = '#ffffff'; c.fill();
    c.globalAlpha = 1; c.lineWidth = 3; c.strokeStyle = '#1B7FB8'; c.stroke();
    c.beginPath(); c.arc(rx + 70, ry + 78, 46, 0, Math.PI * 2); c.clip();
    c.drawImage(img, rx + 24, ry + 32, 92, 92); c.restore();
  }
  c.globalAlpha = 0.85; c.direction = 'rtl'; c.textAlign = 'right'; c.fillStyle = '#1B7FB8';
  c.font = 'bold 26px Cairo'; c.fillText('واتس هم', rx + stampW - 24, ry + 56);
  c.font = 'bold 24px Cairo'; c.fillText('كشف حساب العميل', rx + stampW - 24, ry + 106);
  c.font = 'bold 20px Cairo'; c.fillText(`تاريخ ووقت الإصدار: ${today} — ${hhmm}`, rx + stampW - 24, ry + 152);
  c.font = 'bold 19px Cairo'; c.fillText(`رقم الكشف: ${no}`, rx + stampW - 24, ry + 196);
  c.restore();
  c.globalAlpha = 1;

  c.strokeStyle = LINE; c.beginPath(); c.moveTo(50, H - 150); c.lineTo(W - 50, H - 150); c.stroke();
  ar('كشف إلكتروني صادر من منصة واتس هم', '22px Cairo', GREY, H - 110);
  ar(`تاريخ الإصدار: ${today} · ${hhmm} — للاستفسار: ${SITE}`, '20px Cairo', GREY, H - 78);
  ar('المبالغ بالريال السعودي (SAR) — يُحدَّث الكشف آلياً', '18px Cairo', '#8a97a4', H - 48);

  return { png: canvas.toBuffer('image/png'), no, summary: s, customer: c0 };
}

export async function buildCustomerStatementFiles(customerId) {
  const out = await renderCustomerStatementPng(customerId);
  if (!out) return null;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = `stmt-${customerId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const pngFile = path.join(OUT_DIR, `${base}.png`);
  const pdfFile = path.join(OUT_DIR, `${base}.pdf`);
  fs.writeFileSync(pngFile, out.png);
  try { fs.writeFileSync(pdfFile, await pngToPdf(out.png, `Statement ${out.no}`)); } catch (e) { console.error('STMT_PDF_FAIL', e.message); }
  return { pngFile, pdfFile, base, no: out.no, summary: out.summary };
}

export async function sendCustomerStatement(customerId, { phone, restaurantId = null } = {}) {
  const files = await buildCustomerStatementFiles(customerId);
  if (!files) return { error: 'تعذّر إنشاء الكشف' };
  const cfg = (await import('../config.js')).default;
  const url = `${cfg.publicUrl}/uploads/invoices/${files.base}.pdf`;
  const { waSend } = await import('./whatsapp.js');
  const s = files.summary;
  if (phone) {
    await waSend({ phone, restaurantId, type: 'document',
      document: { link: url, filename: `Wassal-Statement-${files.no}.pdf` },
      body: `🧾 *كشف حسابك — ${files.no}*\n💰 المجموع النهائي: ${rls(s.total)} ر.س\n✅ المدفوع: ${rls(s.paid)} ر.س · ⏳ المتبقي: ${rls(s.unpaid)} ر.س\n📦 عدد الطلبات: ${s.orders}` }).catch(e => console.error('STMT_SEND_FAIL', e.message));
  }
  return { ok: true, url, no: files.no, summary: s };
}
