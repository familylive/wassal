// ---------- تقارير المبيعات اليومية + مستلمو التقارير ----------
// صاحب النشاط يضيف مدير المطعم من المحادثة → إشعار مشرف المنصة → اعتماد → تقرير يومي على واتساب
import { q } from '../db.js';
import config from '../config.js';
import { waSend } from './whatsapp.js';
import { validatePhone } from '../utils.js';

const rls = (h) => (Number(h || 0) / 100).toFixed(2);
const money = (h) => (Number(h || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n = (v) => Number(v || 0);

// الرياض = UTC+3 (قابل للتغيير عبر REPORT_TZ_OFFSET_MIN)
const TZ_OFFSET_MIN = Number(process.env.REPORT_TZ_OFFSET_MIN || 180);

export function localNow() {
  const d = new Date(Date.now() + TZ_OFFSET_MIN * 60000);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), hhmm: iso.slice(11, 16) };
}
export function shiftDate(dateStr, days = -1) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function prettyDate(dateStr) {
  const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const d = new Date(dateStr + 'T00:00:00Z');
  const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

const METHOD_LABEL = { cash: '💵 كاش', mada: '💳 مدى', card: '💳 بطاقة', applepay: '🍎 Apple Pay' };

// ملخص مبيعات يوم كامل لنشاط
export function dailyStats(restaurantId, dateStr) {
  const day = { restaurantId, dateStr };
  const where = "restaurant_id=? AND date(created_at)=?";
  const orders = n(q.get(`SELECT COUNT(*) c FROM orders WHERE ${where}`, restaurantId, dateStr).c);
  const delivered = n(q.get(`SELECT COUNT(*) c FROM orders WHERE ${where} AND status='delivered'`, restaurantId, dateStr).c);
  const cancelled = n(q.get(`SELECT COUNT(*) c FROM orders WHERE ${where} AND status='cancelled'`, restaurantId, dateStr).c);
  const agg = q.get(`SELECT COUNT(*) c, COALESCE(SUM(total),0) total, COALESCE(SUM(delivery_fee),0) fee, COALESCE(SUM(discount),0) disc, COALESCE(SUM(subtotal),0) sub
    FROM orders WHERE ${where} AND status!='cancelled'`, restaurantId, dateStr);
  const byMethod = q.all(`SELECT payment_method m, COUNT(*) c, COALESCE(SUM(total),0) s
    FROM orders WHERE ${where} AND status!='cancelled' GROUP BY payment_method ORDER BY s DESC`, restaurantId, dateStr);
  // الأكثر مبيعاً (من أصناف الطلبات غير الملغاة)
  const rows = q.all(`SELECT items_json FROM orders WHERE ${where} AND status!='cancelled'`, restaurantId, dateStr);
  const tally = new Map();
  for (const r of rows) {
    let items = [];
    try { items = JSON.parse(r.items_json || '[]'); } catch { items = []; }
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const name = String(it?.name || '').trim();
      if (!name) continue;
      const qty = n(it?.quantity ?? it?.qty ?? 1) || 1;
      const price = n(it?.price);
      const cur = tally.get(name) || { qty: 0, sales: 0 };
      cur.qty += qty;
      cur.sales += price * qty;
      tally.set(name, cur);
    }
  }
  const top = [...tally.entries()].sort((a, b) => b[1].qty - a[1].qty).slice(0, 20).map(([name, v]) => ({ name, qty: v.qty, sales: v.sales }));
  return {
    ...day,
    orders, delivered, cancelled,
    salesCount: n(agg.c), salesTotal: n(agg.total), fees: n(agg.fee), discount: n(agg.disc), subtotal: n(agg.sub),
    methods: byMethod.map(x => ({ method: x.m || 'card', count: n(x.c), total: n(x.s) })),
    top
  };
}

const isElectronic = (m) => m !== 'cash';

// نص التقرير (جاهز للإرسال)
export function buildDailyReport(restaurantId, dateStr) {
  const r = q.get("SELECT r.*, (SELECT title FROM ads_campaigns a WHERE a.restaurant_id=r.id LIMIT 1) ad FROM restaurants r WHERE r.id=?", restaurantId);
  if (!r) return null;
  const s = dailyStats(restaurantId, dateStr);
  const bt = r.business_type_id ? q.get("SELECT icon FROM business_types WHERE id=?", r.business_type_id) : null;
  let t = `📊 *تقرير مبيعات ${prettyDate(dateStr)}*\n${bt?.icon || '🏪'} *${r.name_ar}*${r.city ? ' — ' + r.city : ''}\n`;
  t += '━━━━━━━━━━━━━━━━\n';
  if (!s.orders) {
    t += '📦 لا توجد طلبات في هذا اليوم.\n\n🙏 نتمنى لك يوماً موفقاً';
    return t;
  }
  t += `📦 الطلبات: *${s.orders}*\n`;
  t += `✅ مكتملة: ${s.delivered}`;
  if (s.cancelled) t += ` · ❌ ملغاة: ${s.cancelled}`;
  t += '\n';
  // التفصيل حسب طريقة الدفع
  const cash = s.methods.filter(x => !isElectronic(x.method));
  const net = s.methods.filter(x => isElectronic(x.method));
  const sum = (arr) => arr.reduce((a, b) => ({ count: a.count + b.count, total: a.total + b.total }), { count: 0, total: 0 });
  const cashTot = sum(cash), netTot = sum(net);
  t += '\n━━━━━━━━━━━━━━━━\n';
  const netDetail = net.map(x => `${METHOD_LABEL[x.method]?.replace(/^\S+\s/, '') || x.method} ${x.count}`).join(' · ');
  t += `💳 *شبكة*${netDetail ? ` (${netDetail})` : ''}\n• ${netTot.count} طلب — ${rls(netTot.total)} ر.س\n`;
  t += `\n💵 *كاش*\n• ${cashTot.count} طلب — ${rls(cashTot.total)} ر.س\n`;
  t += '\n━━━━━━━━━━━━━━━━\n';
  if (s.discount) t += `🏷 الخصومات: -${rls(s.discount)} ر.س\n`;
  if (s.fees) t += `🛵 رسوم التوصيل: ${rls(s.fees)} ر.س\n`;
  t += `💰 *المجموع الختام: ${rls(s.salesTotal)} ر.س*\n`;
  if (s.salesCount > s.delivered) t += `⏳ طلبات جارية/غير مكتملة: ${s.salesCount - s.delivered}\n`;
  if (s.top.length) {
    t += '\n🔥 *الأكثر مبيعاً*\n';
    t += s.top.slice(0, 5).map((x, i) => `${i + 1}. ${x.name} ×${x.qty}`).join('\n') + '\n';
  }
  t += '\n🙏 يعطيك العافية';
  return t;
}

export async function sendReportTo(phone, restaurantId, dateStr) {
  const text = buildDailyReport(restaurantId, dateStr);
  if (!text) return false;
  let ok = false;
  try { await waSend({ phone, type: 'text', body: text }); ok = true; }
  catch (e) { console.error('REPORT_SEND_FAIL', e.message); }
  // 📄 الفاتورة المختومة كمرفق PDF
  try {
    const { buildInvoiceFiles } = await import('./invoice.js');
    const inv = await buildInvoiceFiles(restaurantId, dateStr);
    if (inv) {
      const link = `${String(config.publicUrl || '').replace(/\/$/, '')}/uploads/invoices/${inv.base}.pdf`;
      await waSend({
        phone, type: 'document',
        body: `📄 *فاتورة مبيعات ${inv.invoice.no}*\n${inv.restaurant?.name_ar || ''} — ${dateStr}\nالمجموع الختام: ${(Number(inv.stats.salesTotal || 0) / 100).toFixed(2)} ر.س`,
        document: { link, filename: `${inv.invoice.no}.pdf` }
      });
      ok = ok || true;
    }
  } catch (e) { console.error('INVOICE_SEND_FAIL', e.message); }
  return ok;
}

// ---------- مستلمو التقارير ----------
export function recipientsOf(restaurantId) {
  return q.all("SELECT * FROM report_recipients WHERE restaurant_id=? ORDER BY id", restaurantId);
}
export function findRecipientByPhone(phone) {
  const norm = validatePhone(phone);
  return q.get("SELECT * FROM report_recipients WHERE phone=? OR phone=? ORDER BY (status='approved') DESC, id DESC LIMIT 1", String(phone || ''), norm);
}
export function addRecipient(restaurantId, name, phoneRaw, hour = '23:30', nationalId = null) {
  const phone = validatePhone(phoneRaw);
  const nid = nationalId ? String(nationalId).replace(/[^\d]/g, '') : null;
  const dup = q.get("SELECT * FROM report_recipients WHERE restaurant_id=? AND phone=?", restaurantId, phone);
  if (dup) {
    q.run("UPDATE report_recipients SET name=COALESCE(?,name), national_id=COALESCE(?,national_id), status='approved', report_hour=COALESCE(?,report_hour), updated_at=datetime('now') WHERE id=?", name || null, nid, hour || null, dup.id);
    return q.get("SELECT * FROM report_recipients WHERE id=?", dup.id);
  }
  const r = q.run("INSERT INTO report_recipients (restaurant_id, name, national_id, phone, status, report_hour) VALUES (?,?,?,?,'pending',?)",
    restaurantId, name || null, nid, phone, hour || '23:30');
  return q.get("SELECT * FROM report_recipients WHERE id=?", Number(r.lastInsertRowid));
}

// إشعار مشرف المنصة لاعتماد مستلم التقرير
export async function notifySupervisorRecipient(row) {
  const to = config.adminPhone || '';
  if (!to) { console.log('REPORT_NOTIFY_SKIPPED_NO_ADMIN_PHONE', row?.id); return false; }
  const r = q.get("SELECT name_ar FROM restaurants WHERE id=?", row.restaurant_id);
  const txt = `📊 *طلب إضافة مستلم تقرير مبيعات*\n\n`
    + `🏪 النشاط: *${r?.name_ar || '-'}*\n`
    + `👤 مدير المطعم: ${row.name || '-'}\n`
    + `🔢 هويته: ${row.national_id || '⚠️ غير مسجّلة'}\n`
    + `📱 جواله: ${row.phone}\n`
    + `⏰ وقت التقرير اليومي: ${row.report_hour || '23:30'}\n\n`
    + 'هل تعتمد إضافته؟ (بيوصله تقرير المبيعات اليومي)';
  try {
    await waSend({ phone: to, type: 'buttons', body: txt, buttons: [
      { id: `rp_ok:${row.id}`, title: '✅ اعتماد' },
      { id: `rp_no:${row.id}`, title: '❌ رفض' }
    ] });
    return true;
  } catch (e) { console.error('REPORT_SUPERVISOR_NOTIFY_FAIL', e.message); return false; }
}

export async function approveRecipient(id) {
  const row = q.get("SELECT * FROM report_recipients WHERE id=?", Number(id));
  if (!row) return { error: 'الطلب غير موجود' };
  if (row.status === 'approved') return { error: 'معتمد مسبقاً', name: row.name };
  q.run("UPDATE report_recipients SET status='approved', updated_at=datetime('now') WHERE id=?", row.id);
  const r = q.get("SELECT name_ar FROM restaurants WHERE id=?", row.restaurant_id);
  try {
    await waSend({ phone: row.phone, type: 'text', body:
      `🎉 *تم اعتمادك مستلم تقرير مبيعات*\n\n🏪 ${r?.name_ar || ''}\n⏰ بيوصلك التقرير اليومي الساعة ${row.report_hour || '23:30'}\n\n💡 تكتب كلمة *تقرير* بأي وقت ويرسلك تقرير اليوم فوراً\nوتكتب *تقرير أمس* لتقرير اليوم السابق` });
  } catch (e) { console.error('REPORT_WELCOME_FAIL', e.message); }
  return { ok: true, name: row.name, phone: row.phone, restaurant: r?.name_ar };
}

export async function rejectRecipient(id, note = '') {
  const row = q.get("SELECT * FROM report_recipients WHERE id=?", Number(id));
  if (!row) return { error: 'الطلب غير موجود' };
  q.run("UPDATE report_recipients SET status='rejected', note=?, updated_at=datetime('now') WHERE id=?", note, row.id);
  const r = q.get("SELECT name_ar FROM restaurants WHERE id=?", row.restaurant_id);
  try {
    await waSend({ phone: row.phone, type: 'text', body: `نعتذر 🙏 — لم يتم اعتماد إضافة تقرير مبيعات *${r?.name_ar || ''}* حالياً.` });
  } catch (e) { /* تجاهل */ }
  return { ok: true, name: row.name };
}

// ---------- 🏛 تقرير الإدارة المجمّع لكل العمليات ----------
export const PLATFORM_SHARE_PERCENT = Number(process.env.PLATFORM_SHARE_PERCENT || 10);

// مبيعات يوم واحد مجمّعة حسب نوع النشاط
export function platformStats(dateStr) {
  const rows = q.all(`SELECT COALESCE(b.id, 0) AS type_id, COALESCE(b.name_ar, 'غير مصنّف') AS type_name, COALESCE(b.icon, '🏬') AS icon,
      COUNT(*) AS orders, COALESCE(SUM(o.total),0) AS total
    FROM orders o
    LEFT JOIN restaurants r ON r.id = o.restaurant_id
    LEFT JOIN business_types b ON b.id = r.business_type_id
    WHERE date(o.created_at)=? AND o.status!='cancelled'
    GROUP BY type_id ORDER BY total DESC`, dateStr);
  const all = q.get("SELECT COUNT(*) c FROM orders WHERE date(created_at)=?", dateStr);
  const delivered = q.get("SELECT COUNT(*) c FROM orders WHERE date(created_at)=? AND status='delivered'", dateStr);
  const cancelled = q.get("SELECT COUNT(*) c FROM orders WHERE date(created_at)=? AND status='cancelled'", dateStr);
  const agg = q.get(`SELECT COUNT(*) c, COALESCE(SUM(total),0) total, COALESCE(SUM(delivery_fee),0) fee, COALESCE(SUM(discount),0) disc,
      COALESCE(SUM(CASE WHEN payment_method='cash' THEN total ELSE 0 END),0) cash,
      COALESCE(SUM(CASE WHEN payment_method!='cash' THEN total ELSE 0 END),0) net
    FROM orders WHERE date(created_at)=? AND status!='cancelled'`, dateStr);
  const pickup = q.get("SELECT COUNT(*) c FROM orders WHERE date(created_at)=? AND status!='cancelled' AND order_type='pickup'", dateStr);
  const commissions = q.get("SELECT COALESCE(SUM(commission_business),0) cb, COALESCE(SUM(commission_captain),0) cc FROM orders WHERE date(created_at)=? AND status='delivered'", dateStr);
  const types = rows.map(r => ({ ...r, orders: Number(r.orders) || 0, total: Number(r.total) || 0 }));
  const total = Number(agg.total) || 0;
  return {
    dateStr, types,
    orders: Number(all.c) || 0,
    delivered: Number(delivered.c) || 0,
    cancelled: Number(cancelled.c) || 0,
    salesCount: Number(agg.c) || 0,
    total, fee: Number(agg.fee) || 0, discount: Number(agg.disc) || 0,
    cash: Number(agg.cash) || 0, net: Number(agg.net) || 0,
    pickup: Number(pickup?.c) || 0,
    commissionBusiness: Number(commissions?.cb) || 0,
    commissionCaptain: Number(commissions?.cc) || 0,
    share: (Number(commissions?.cb) || 0) + (Number(commissions?.cc) || 0),
    sharePercent: PLATFORM_SHARE_PERCENT
  };
}

export function buildPlatformReport(dateStr) {
  const s = platformStats(dateStr);
  let t = `🏛 *تقرير الإدارة المجمّع*\n📅 ${prettyDate(dateStr)}\n━━━━━━━━━━━━━━━━\n`;
  if (!s.salesCount && !s.orders) {
    t += '📦 لا توجد عمليات في هذا اليوم.';
    return t;
  }
  t += '📊 *مبيعات الأنشطة*\n';
  for (const x of s.types) t += `${x.icon} ${x.type_name} — ${x.orders} طلب · *${money(x.total)}* ر.س\n`;
  if (!s.types.length) t += '_لا مبيعات_\n';
  t += '━━━━━━━━━━━━━━━━\n';
  t += `📦 إجمالي الطلبات: *${s.orders}*\n`;
  t += `✅ مكتملة: ${s.delivered}`;
  if (s.cancelled) t += ` · ❌ ملغاة: ${s.cancelled}`;
  t += '\n';
  if (s.pickup) t += `🏪 استلام من الفرع: ${s.pickup} طلب\n`;
  t += `💳 شبكة: ${money(s.net)} ر.س · 💵 كاش: ${money(s.cash)} ر.س\n`;
  t += `🏛 عمولات المنصة: من الأنشطة ${money(s.commissionBusiness)} + من الكباتن ${money(s.commissionCaptain)} ر.س\n`;
  if (s.discount) t += `🏷 الخصومات: -${money(s.discount)} ر.س\n`;
  if (s.fee) t += `🛵 رسوم التوصيل: ${money(s.fee)} ر.س\n`;
  t += '━━━━━━━━━━━━━━━━\n';
  t += `💰 *المجموع الختامي: ${money(s.total)} ر.س*\n`;
  t += `🏛 *حصة المنصة: ${money(s.share)} ر.س*`;
  return t;
}

// إرسال تقرير الإدارة (مرة واحدة لكل يوم)
export async function sendPlatformReport(dateStr, { force = false } = {}) {
  const to = config.adminPhone || '';
  if (!to) { console.log('PLATFORM_REPORT_SKIP_NO_ADMIN_PHONE'); return { error: 'رقم المشرف غير مضبوط' }; }
  const ex = q.get("SELECT * FROM platform_reports WHERE date=?", dateStr);
  if (ex && !force) return { skipped: true, date: dateStr };
  const s = platformStats(dateStr);
  const text = buildPlatformReport(dateStr);
  let ok = false;
  try { await waSend({ phone: to, type: 'text', body: text }); ok = true; }
  catch (e) { console.error('PLATFORM_REPORT_SEND_FAIL', e.message); }
  // 📄 نسخة مختومة بصيغة PDF (ختم المنصة)
  try {
    const { buildPlatformReportFiles } = await import('./invoice.js');
    const f = await buildPlatformReportFiles(dateStr, s);
    const link = `${String(config.publicUrl || '').replace(/\/$/, '')}/uploads/invoices/${f.base}.pdf`;
    await waSend({
      phone: to, type: 'document',
      body: `📄 *تقرير الإدارة المجمّع ${f.no}*\n${dateStr} — المجموع الختامي: ${money(s.total)} ر.س · حصة المنصة: ${money(s.share)} ر.س`,
      document: { link, filename: `${f.no}.pdf` }
    });
  } catch (e) { console.error('PLATFORM_REPORT_PDF_FAIL', e.message); }
  if (ex) q.run("UPDATE platform_reports SET total=?, orders_count=?, sent_to=?, sent_at=datetime('now') WHERE id=?", s.total, s.orders, to, ex.id);
  else q.run("INSERT INTO platform_reports (date, total, orders_count, sent_to) VALUES (?,?,?,?)", dateStr, s.total, s.orders, to);
  console.log('PLATFORM_REPORT_SENT', { date: dateStr, to, total: s.total, share: s.share });
  return { ok, date: dateStr, stats: s, text };
}

// ساعة تقرير الإدارة (افتراضي 12 منتصف الليل)
export const PLATFORM_REPORT_HOUR = String(process.env.PLATFORM_REPORT_HOUR || '00:00').slice(0, 5);

// ---------- الإرسال المجدول (مع تعويض لو كان السيرفر نائماً) ----------
export async function runDueReports() {
  const { date, hhmm } = localNow();
  // 🏛 تقرير الإدارة المجمّع
  try {
    const hour = PLATFORM_REPORT_HOUR;
    if (hhmm >= hour) {
      const target = hour >= '12:00' ? date : shiftDate(date, -1);
      const already = q.get("SELECT id FROM platform_reports WHERE date=?", target);
      if (!already) await sendPlatformReport(target);
    }
  } catch (e) { console.error('PLATFORM_REPORT_LOOP_FAIL', e.message); }
  const rows = q.all("SELECT * FROM report_recipients WHERE status='approved' ORDER BY id");
  let sent = 0;
  for (const row of rows) {
    const hour = String(row.report_hour || '23:30').slice(0, 5);
    if (hhmm < hour) continue;                                  // لسه ما جاء الوقت
    const target = hour >= '12:00' ? date : shiftDate(date, -1); // تقرير مبكر = لليوم السابق
    if (row.last_sent_date === target) continue;                 // أُرسل من قبل
    const ok = await sendReportTo(row.phone, row.restaurant_id, target);
    if (ok) {
      q.run("UPDATE report_recipients SET last_sent_date=?, updated_at=datetime('now') WHERE id=?", target, row.id);
      console.log('REPORT_SENT', { id: row.id, restaurant: row.restaurant_id, date: target, to: row.phone });
      sent += 1;
    }
  }
  return sent;
}
