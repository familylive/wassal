// ⏰ مهام دورية: تقرير الكابتن اليومي 23:30 · تذكير العملاء بالعروض 19:00
import { q } from '../db.js';
import { localNow, shiftDate } from './reporting.js';

const getSetting = (key) => q.get("SELECT value FROM app_settings WHERE key=?", key)?.value || null;
const setSetting = (key, value) => q.run(
  "INSERT INTO app_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, String(value));

export function prettyHour12(hhmm) {
  const s = String(hhmm || '').slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(s)) return s;
  const [h, m] = s.split(':').map(Number);
  const period = h >= 12 ? 'مساءً' : 'صباحاً';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, '0')} ${period}`;
}

const offerLine = (o) => {
  const v = Number(o.value || 0);
  const desc = o.type === 'percent' ? `خصم ${v}%`
    : o.type === 'amount' ? `خصم ${(v / 100).toFixed(2)} ر.س`
    : o.type === 'delivery' ? 'توصيل مجاني'
    : o.type === 'bundle' ? 'عرض مجمّع'
    : 'عرض خاص';
  return { id: o.id, title: `${o.icon || '🎁'} ${o.title}`, description: `${desc} · ${o.name_ar || ''}` };
};

export async function activeOffers(limit = 10) {
  try {
    return q.all(`SELECT o.*, r.name_ar,
        (SELECT icon FROM business_types b WHERE b.id = r.business_type_id) AS icon
      FROM offers o JOIN restaurants r ON r.id = o.restaurant_id
      WHERE o.is_active = 1 AND COALESCE(r.is_active,1) = 1
        AND (o.ends_at IS NULL OR o.ends_at >= datetime('now'))
        AND (o.starts_at IS NULL OR o.starts_at <= datetime('now'))
      ORDER BY o.id DESC LIMIT ?`, limit);
  } catch (e) { console.error('ACTIVE_OFFERS_FAIL', e.message); return []; }
}

// 🛵 تقرير الكابتن اليومي (23:30) — كشف PDF لكل كابتن عنده توصيلات اليوم
export async function runCaptainDailyReports(hour = '23:30') {
  try {
    const { date, hhmm } = localNow();
    if (hhmm < hour) return 0;
    if (getSetting('captain_daily_report_date') === date) return 0;
    setSetting('captain_daily_report_date', date);
    const rows = q.all(`SELECT DISTINCT captain_id FROM orders
      WHERE captain_id IS NOT NULL AND status='delivered' AND date(created_at)=?`, date);
    let n = 0;
    for (const r of rows) {
      const cap = q.get("SELECT id, phone, name FROM captains WHERE id=?", r.captain_id);
      if (!cap?.phone) continue;
      try {
        const { sendCaptainStatement } = await import('./captainStatement.js');
        await sendCaptainStatement(cap.id, 'day', { phone: cap.phone });
        n += 1;
      } catch (e) { console.error('CAPTAIN_DAILY_SEND_FAIL', e.message); }
    }
    if (n) console.log('CAPTAIN_DAILY_REPORTS', n);
    return n;
  } catch (e) { console.error('CAPTAIN_DAILY_REPORTS_FAIL', e.message); return 0; }
}

// 👋 تذكير العملاء غير النشطين + عرض كل عروض المنصة (مرة يوميًا بعد 19:00، ولكل عميل مرة كل 5 أيام)
export async function runCustomerReminders(hour = '19:00', inactiveDays = 5, cooldownDays = 5, maxPerRun = 80) {
  try {
    const { date, hhmm } = localNow();
    if (hhmm < hour) return 0;
    if (getSetting('reminders_last_run') === date) return 0;
    setSetting('reminders_last_run', date);

    const offers = await activeOffers(8);
    if (!offers.length) return 0;

    const rows = q.all(`SELECT c.id, c.phone, c.name,
        (SELECT MAX(o.created_at) FROM orders o WHERE o.customer_id = c.id AND COALESCE(o.order_no,'')!='DRAFT') AS last_order,
        (SELECT value FROM app_settings s WHERE s.key = 'cust_reminder_' || c.id) AS last_reminder
      FROM customers c WHERE c.phone IS NOT NULL LIMIT 500`);
    let n = 0;
    for (const c of rows) {
      if (n >= maxPerRun) break;
      const last = c.last_order ? String(c.last_order).slice(0, 10) : null;
      const inactive = !last || Date.parse(last + 'T00:00:00Z') < Date.now() - inactiveDays * 86400000;
      if (!inactive) continue;
      const lr = c.last_reminder ? String(c.last_reminder).slice(0, 10) : null;
      if (lr && Date.parse(lr + 'T00:00:00Z') > Date.now() - cooldownDays * 86400000) continue;

      const who = c.name ? `*${c.name}*` : 'عميلنا';
      const body = `👋 هلا ${who} — ما شفناك من فترة 😊\nاشتقنا لك! وعندنا *عروض على المنصة* تنتظرك 🎁\n\n👇 اختر العرض اللي يعجبك ونوصّلك طلبك:`;
      try {
        const { waSend } = await import('./whatsapp.js');
        await waSend({ phone: c.phone, type: 'list', body, list: [{ title: '🔥 العروض المتاحة', rows: offers.map(offerLine) }] });
        setSetting(`cust_reminder_${c.id}`, date);
        n += 1;
      } catch (e) { console.error('CUSTOMER_REMINDER_FAIL', e.message); }
    }
    if (n) console.log('CUSTOMER_REMINDERS', n);
    return n;
  } catch (e) { console.error('CUSTOMER_REMINDERS_FAIL', e.message); return 0; }
}

export async function runReminderJobs() {
  try { await runCaptainDailyReports(); } catch (e) {}
  try { await runCustomerReminders(); } catch (e) {}
}
