// ---------- كشف فواتير الكابتن (PNG + PDF): كل الطلبات التي وصّلها — يومي/أسبوعي/شهري/سنوي ----------
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { q } from '../db.js';
import { pngToPdf } from './invoice.js';
import { localNow, prettyDate, reportRange, reportRangePeriod } from './reporting.js';

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
  if (!stampLogoImg) { try { stampLogoImg = await loadImage(path.join(ASSETS, 'logo-stamp.png')); } catch (e) { stampLogoImg = logoImg; } }
  return logoImg;
}

const KIND_AR = { day: 'اليوم', week: 'آخر ٧ أيام', month: 'هذا الشهر', year: 'هذا العام', yesterday: 'أمس', lastweek: 'الأسبوع الماضي', lastmonth: 'الشهر الماضي', lastyear: 'العام الماضي' };

// ---------- بيانات كشف الكابتن ----------
export function captainDeliveriesSummary(captainId, kind = 'month') {
  const range = reportRange(kind);
  const rows = q.all(`SELECT o.id, o.order_no, o.total, o.delivery_fee, o.payment_method, o.payment_status,
      o.created_at, o.delivered_at, o.status,
      r.name_ar AS restaurant_name, c.name AS customer_name
    FROM orders o
    LEFT JOIN restaurants r ON r.id = o.restaurant_id
    LEFT JOIN customers c ON c.id = o.customer_id
    WHERE o.captain_id = ? AND o.status = 'delivered'
      AND date(o.created_at) BETWEEN ? AND ?
    ORDER BY o.id DESC LIMIT 400`, captainId, range.from, range.to);

  let total = 0, freeCount = 0, cashCount = 0, cashTotal = 0;
  for (const o of rows) {
    const fee = Number(o.delivery_fee || 0);
    total += fee;
    if (fee === 0) freeCount += 1;
    if (String(o.payment_method) === 'cash') { cashCount += 1; cashTotal += Number(o.total || 0); }
  }
  return { range, rows, count: rows.length, total, freeCount, cashCount, cashTotal };
}

export function captainStatementNo(captainId, kind, dateStr) {
  return `CAP-${String(kind).slice(0, 5).toUpperCase()}-${String(dateStr).replace(/-/g, '')}-${String(captainId).padStart(4, '0')}`;
}

// ---------- الرسم ----------
export async function renderCaptainStatementPng(captainId, kind = 'month') {
  const stampLogo = await ensureAssets();
  const cap = q.get("SELECT * FROM captains WHERE id=?", captainId);
  if (!cap) return null;
  const s = captainDeliveriesSummary(captainId, kind);
  const { date: today, hhmm } = localNow();
  const no = captainStatementNo(captainId, kind, today);

  const W = 1000, H = 1414;
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');
  const GREEN = '#229ED9', DARK = '#17212B', GREY = '#5b7083', LINE = '#dce8f2', LIGHT = '#F2F8FC';
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
  c.beginPath(); c.arc(lx, ly, lr, 0, Math.PI * 2); c.closePath(); c.fillStyle = '#ffffff'; c.fill();
  c.lineWidth = 3; c.strokeStyle = GREEN; c.stroke();
  if (logoImg) { c.save(); c.beginPath(); c.arc(lx, ly, lr - 4, 0, Math.PI * 2); c.closePath(); c.clip(); c.drawImage(logoImg, lx - lr + 4, ly - lr + 4, (lr - 4) * 2, (lr - 4) * 2); c.restore(); }
  c.restore();
  ar('تلي هم', 'bold 40px Cairo', DARK, 78, lx - 70);
  ar('منصة الطلبات والتوصيل', '24px Cairo', GREY, 116, lx - 70);
  en('Tele Ham', 'bold 22px Cairo', GREEN, 150, lx - 70, 'right');

  en('CAPTAIN INVOICES', 'bold 20px Cairo', GREEN, 60, 60);
  ar('فواتير الكابتن', 'bold 32px Cairo', DARK, 96, 60, 'left');
  ar(`رقم الكشف: ${no}`, '23px Cairo', GREY, 132, 60, 'left');
  ar(`الفترة: ${KIND_AR[kind] || kind} (${reportRangePeriod(s.range)})`, '22px Cairo', GREY, 156, 60, 'left');
  ar(`تاريخ الإصدار: ${today} — ${hhmm}`, '20px Cairo', GREY, 180, 60, 'left');

  let y = 224;
  // بيانات الكابتن
  c.fillStyle = LIGHT; c.fillRect(50, y, W - 100, 104);
  c.fillStyle = GREEN; c.fillRect(50, y, 6, 104);
  ar(`🛵 ${cap.name || 'كابتن'}`, 'bold 30px Cairo', DARK, y + 44);
  ar(`📱 ${cap.phone || '-'}   🏙 ${cap.city || '-'}${cap.district ? ' — ' + cap.district : ''}`, '22px Cairo', GREY, y + 78);
  ar(`🚗 ${cap.vehicle_type || '-'}${cap.vehicle_plate ? ' · ' + cap.vehicle_plate : ''}`, '21px Cairo', GREY, y + 102);
  en(`ID: ${cap.id}`, '22px Cairo', GREY, y + 44, 72);
  y += 140;

  // جدول الفواتير
  ar('الطلبات التي وصّلتها', 'bold 27px Cairo', DARK, y + 6);
  en(`(${s.count})`, 'bold 22px Cairo', GREY, y + 6, 78, 'left');
  y += 22;
  c.fillStyle = '#E3F2FB'; c.fillRect(50, y, W - 100, 42);
  ar('الطلب', 'bold 20px Cairo', DARK, y + 28, 850);
  ar('التاريخ', 'bold 20px Cairo', DARK, y + 28, 700);
  ar('النشاط', 'bold 20px Cairo', DARK, y + 28, 520);
  ar('العميل', 'bold 20px Cairo', DARK, y + 28, 330);
  ar('مبلغ التوصيل', 'bold 20px Cairo', DARK, y + 28, 140);
  y += 42;

  if (!s.rows.length) {
    ar('لا توجد توصيلات في هذه الفترة', '24px Cairo', GREY, y + 40);
    y += 70;
  }
  let i = 0;
  for (const o of s.rows) {
    if (y > H - 430) { ar(`+ ${s.rows.length - i} طلب أقدم`, '20px Cairo', GREY, y + 26); y += 40; break; }
    const rowH = 40;
    if (i % 2 === 1) { c.fillStyle = '#F8FBFD'; c.fillRect(50, y, W - 100, rowH); }
    const dt = String(o.delivered_at || o.created_at || '').slice(0, 10);
    const fee = Number(o.delivery_fee || 0);
    ar(String(o.order_no || ('#' + o.id)), 'bold 19px Cairo', DARK, y + 27, 850);
    en(dt, '18px Cairo', GREY, y + 27, 700, 'right');
    ar(String(o.restaurant_name || '—').slice(0, 18), '18px Cairo', GREY, y + 27, 520);
    ar(String(o.customer_name || '—').slice(0, 16), '18px Cairo', GREY, y + 27, 330);
    if (fee > 0) en(rls(fee), 'bold 19px Cairo', DARK, y + 27, 140, 'right');
    else ar('مجاني', 'bold 19px Cairo', '#0b7a3b', y + 27, 140);
    c.strokeStyle = LINE; c.beginPath(); c.moveTo(50, y + rowH); c.lineTo(W - 50, y + rowH); c.stroke();
    y += rowH; i++;
  }
  y += 24;

  // صندوق الإجمالي
  c.fillStyle = DARK; c.fillRect(50, y, W - 100, 120);
  ar('إجمالي مبالغ التوصيل', 'bold 28px Cairo', '#ffffff', y + 46, 850);
  en(`${rls(s.total)} SAR`, 'bold 38px Cairo', '#8ED8F8', y + 50, 70, 'left');
  ar(`عدد التوصيلات: ${s.count}   ·   مجاني: ${s.freeCount}   ·   توصيل كاش: ${s.cashCount} (${rls(s.cashTotal)} ر.س)`, '21px Cairo', '#CFE9F6', y + 92);
  y += 146;

  // إحصاءات سريعة
  ar(`🏁 متوسط التوصيلة: ${s.count ? rls(Math.round(s.total / s.count)) : '0.00'} ر.س`, '23px Cairo', GREY, y + 10);
  y += 40;

  // ختم
  const stampW = 470, stampH = 245;
  const sx = 70 + stampW / 2, sy = H - 350;
  c.save();
  c.translate(sx, sy); c.rotate(-12 * Math.PI / 180); c.globalAlpha = 0.8;
  c.strokeStyle = '#1B7FB8'; c.lineWidth = 5;
  const rx = -stampW / 2, ry = -stampH / 2;
  const rr = (x, y2, w, h, rad) => { c.beginPath(); c.moveTo(x + rad, y2); c.lineTo(x + w - rad, y2); c.quadraticCurveTo(x + w, y2, x + w, y2 + rad); c.lineTo(x + w, y2 + h - rad); c.quadraticCurveTo(x + w, y2 + h, x + w - rad, y2 + h); c.lineTo(x + rad, y2 + h); c.quadraticCurveTo(x, y2 + h, x, y2 + h - rad); c.lineTo(x, y2 + rad); c.quadraticCurveTo(x, y2, x + rad, y2); c.closePath(); };
  rr(rx, ry, stampW, stampH, 16); c.stroke();
  c.lineWidth = 2; rr(rx + 10, ry + 10, stampW - 20, stampH - 20, 12); c.stroke();
  if (stampLogo) {
    c.save();
    c.beginPath(); c.arc(rx + 70, ry + 78, 50, 0, Math.PI * 2); c.closePath();
    c.fillStyle = '#ffffff'; c.fill(); c.globalAlpha = 1;
    c.lineWidth = 3; c.strokeStyle = '#1B7FB8'; c.stroke();
    c.beginPath(); c.arc(rx + 70, ry + 78, 46, 0, Math.PI * 2); c.clip();
    c.drawImage(stampLogo, rx + 24, ry + 32, 92, 92); c.restore();
  }
  c.globalAlpha = 0.85; c.direction = 'rtl'; c.textAlign = 'right'; c.fillStyle = '#1B7FB8';
  c.font = 'bold 26px Cairo'; c.fillText('تلي هم', rx + stampW - 24, ry + 56);
  c.font = 'bold 24px Cairo'; c.fillText('فواتير الكابتن', rx + stampW - 24, ry + 106);
  c.font = 'bold 20px Cairo'; c.fillText(`تاريخ ووقت الإصدار: ${today} — ${hhmm}`, rx + stampW - 24, ry + 152);
  c.font = 'bold 19px Cairo'; c.fillText(`رقم الكشف: ${no}`, rx + stampW - 24, ry + 196);
  c.restore();
  c.globalAlpha = 1;

  c.strokeStyle = LINE; c.beginPath(); c.moveTo(50, H - 150); c.lineTo(W - 50, H - 150); c.stroke();
  ar('كشف إلكتروني صادر من منصة تلي هم — Tele Ham', '22px Cairo', GREY, H - 110);
  ar(`تاريخ الإصدار: ${today} · ${hhmm} — ${SITE}`, '20px Cairo', GREY, H - 78);
  ar('المبالغ بالريال السعودي (SAR) — «مجاني» تعني بلا رسوم توصيل', '18px Cairo', '#8a97a4', H - 48);

  return { png: canvas.toBuffer('image/png'), no, summary: s, captain: cap };
}

export async function buildCaptainStatementFiles(captainId, kind = 'month') {
  const out = await renderCaptainStatementPng(captainId, kind);
  if (!out) return null;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = `cap-${captainId}-${kind}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const pngFile = path.join(OUT_DIR, `${base}.png`);
  const pdfFile = path.join(OUT_DIR, `${base}.pdf`);
  fs.writeFileSync(pngFile, out.png);
  try { fs.writeFileSync(pdfFile, await pngToPdf(out.png, `Captain ${out.no}`)); } catch (e) { console.error('CAP_PDF_FAIL', e.message); }
  return { pngFile, pdfFile, base, no: out.no, summary: out.summary };
}

export async function sendCaptainStatement(captainId, kind = 'month', { phone } = {}) {
  const files = await buildCaptainStatementFiles(captainId, kind);
  if (!files) return { error: 'تعذّر إنشاء الكشف' };
  const cfg = (await import('../config.js')).default;
  const url = `${cfg.publicUrl}/uploads/invoices/${files.base}.pdf`;
  const { waSend } = await import('./whatsapp.js');
  const s = files.summary;
  if (phone) {
    await waSend({ phone, type: 'document',
      document: { link: url, filename: `TeleHam-Captain-${files.no}.pdf` },
      body: `🧾 *فواتيري — ${KIND_AR[kind] || kind}*\n🛵 عدد التوصيلات: ${s.count}\n💰 إجمالي مبالغ التوصيل: ${rls(s.total)} ر.س\n🎁 بلا رسوم: ${s.freeCount}` }).catch(e => console.error('CAP_STMT_SEND_FAIL', e.message));
  }
  return { ok: true, url, no: files.no, summary: s };
}
