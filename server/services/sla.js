// ⏱️ نظام المهل والغرامات
// • الكاشير/النشاط: 20 دقيقة من تأكيد الطلب حتى تسليمه لكابتن (with_captain) — وإلا 5 ر.س لكل 10 دقائق تأخير.
// • الكابتن: 25 دقيقة من استلام الطلب من المحل حتى التسليم للعميل — وإلا 5 ر.س لكل 10 دقائق (تُحتسب على حسابه/تأمينه).
import { q } from '../db.js';
import { waSend } from './whatsapp.js';

const FEE_PER_10MIN = 500;   // 5.00 ر.س بالهللات
export const CASHIER_SLA_MIN = 20;
export const CAPTAIN_SLA_MIN = 25;

const adminPhone = () => {
  try { const c = q.get("SELECT value FROM app_settings WHERE key='ADMIN_PHONE'"); return c?.value || null; } catch (e) { return null; }
};
const money = (h) => (Number(h || 0) / 100).toFixed(2);

export function startCashierSla(orderId) {
  try { q.run("UPDATE orders SET cashier_deadline=datetime('now','+20 minutes'), late_fee_cashier=0, cashier_late_notified=0 WHERE id=?", orderId); } catch (e) {}
}
export function startCaptainSla(orderId) {
  try { q.run("UPDATE orders SET captain_deadline=datetime('now','+25 minutes'), late_fee_captain=0, captain_late_notified=0, cashier_deadline=NULL WHERE id=?", orderId); } catch (e) {}
}

export async function runSlaChecks() {
  let n = 0;
  try {
    // ١) تأخير النشاط (لم يسلّم الطلب للكابتن خلال 20 دقيقة)
    const lateCashier = q.all(`SELECT * FROM orders
      WHERE cashier_deadline IS NOT NULL AND captain_id IS NULL
        AND status IN ('confirmed','preparing','ready')
        AND datetime('now') > cashier_deadline LIMIT 20`);
    for (const o of lateCashier) {
      const mins = Math.max(0, Math.floor((Date.now() - Date.parse(String(o.cashier_deadline).replace(' ', 'T') + 'Z')) / 60000));
      const fee = (Math.floor(mins / 10) + 1) * FEE_PER_10MIN;
      q.run("UPDATE orders SET late_fee_cashier=? WHERE id=?", fee, o.id);
      if (!Number(o.cashier_late_notified)) {
        q.run("UPDATE orders SET cashier_late_notified=1 WHERE id=?", o.id);
        const r = q.get("SELECT name_ar, phone FROM restaurants WHERE id=?", o.restaurant_id);
        if (r?.phone) waSend({ phone: r.phone, restaurantId: o.restaurant_id, orderId: o.id, type: 'text',
          body: `⚠️ *تأخير في تسليم الطلب للكابتن*\n📦 ${o.order_no}\n⏱️ تجاوزت ${CASHIER_SLA_MIN} دقيقة — الغرامة الحالية: *${money(fee)} ر.س* (5 ر.س لكل 10 دقائق)\n👉 سلّم الطلب للكابتن بأسرع وقت.` }).catch(() => {});
        const ap = adminPhone();
        if (ap) waSend({ phone: ap, type: 'text', body: `⚠️ *غرامة تأخير — النشاط*\n🏪 ${r?.name_ar || ''} (#${o.restaurant_id})\n📦 ${o.order_no}\n⏱️ متأخر ${mins} دقيقة · الغرامة *${money(fee)} ر.س*` }).catch(() => {});
        n += 1;
      }
    }
    // ٢) تأخير الكابتن (لم يسلّم للعميل خلال 25 دقيقة من الاستلام)
    const lateCap = q.all(`SELECT * FROM orders
      WHERE captain_deadline IS NOT NULL AND captain_id IS NOT NULL
        AND status IN ('with_captain','on_the_way','arrived')
        AND datetime('now') > captain_deadline LIMIT 20`);
    for (const o of lateCap) {
      const mins = Math.max(0, Math.floor((Date.now() - Date.parse(String(o.captain_deadline).replace(' ', 'T') + 'Z')) / 60000));
      const fee = (Math.floor(mins / 10) + 1) * FEE_PER_10MIN;
      q.run("UPDATE orders SET late_fee_captain=? WHERE id=?", fee, o.id);
      if (!Number(o.captain_late_notified)) {
        q.run("UPDATE orders SET captain_late_notified=1 WHERE id=?", o.id);
        const c = q.get("SELECT * FROM captains WHERE id=?", o.captain_id);
        try { q.run("UPDATE captains SET penalty_total=COALESCE(penalty_total,0)+? WHERE id=?", fee, o.captain_id); } catch (e) {}
        if (c?.phone) waSend({ phone: c.phone, restaurantId: o.restaurant_id, orderId: o.id, type: 'text',
          body: `⚠️ *تأخير في التسليم*\n📦 ${o.order_no}\n⏱️ تجاوزت ${CAPTAIN_SLA_MIN} دقيقة — الغرامة *${money(fee)} ر.س* تُخصم من تأمينك (5 ر.س لكل 10 دقائق)\n👉 وصّل الطلب للعميل فورًا.` }).catch(() => {});
        const ap = adminPhone();
        if (ap) waSend({ phone: ap, type: 'text', body: `⚠️ *غرامة تأخير — كابتن*\n🛵 ${c?.name || ''} — ${c?.phone || ''}\n📦 ${o.order_no}\n⏱️ متأخر ${mins} دقيقة · الغرامة *${money(fee)} ر.س* (تُخصم من التأمين)` }).catch(() => {});
        n += 1;
      }
    }
  } catch (e) { console.error('SLA_CHECK_FAIL', e.message); }
  if (n) console.log('SLA_PENALTIES', n);
  return n;
}
