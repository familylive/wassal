// ---------- حساب الكابتن: التأمين · المبالغ المحصّلة · الغرامات · الإيقاف التلقائي ----------
import { q } from '../db.js';
import config from '../config.js';
import { waSend } from './whatsapp.js';

const rls = (h) => (Number(h || 0) / 100).toFixed(2);
export const DEFAULT_DEPOSIT = Number(process.env.CAPTAIN_DEPOSIT || 50000);      // ٥٠٠ ر.س
export const LATE_PENALTY_PER_QUARTER = Number(process.env.LATE_PENALTY || 500);   // ٥ ر.س لكل ربع ساعة

export function ledger(captainId, type, amount, { orderId = null, note = null } = {}) {
  q.run("INSERT INTO captain_transactions (captain_id, order_id, type, amount, note) VALUES (?,?,?,?,?)",
    captainId, orderId, type, Number(amount) || 0, note);
}

export function captainAccount(captainId) {
  const c = q.get("SELECT * FROM captains WHERE id=?", captainId);
  if (!c) return null;
  const tx = q.all("SELECT * FROM captain_transactions WHERE captain_id=? ORDER BY id DESC LIMIT 30", captainId);
  const owed = Math.max(0, Number(c.wallet_cash || 0) - Number(c.penalty_total || 0));
  return {
    id: c.id, name: c.name, phone: c.phone,
    deposit: Number(c.deposit_amount || DEFAULT_DEPOSIT),
    depositPaid: Boolean(c.deposit_paid),
    wallet: Number(c.wallet_cash || 0),
    penalties: Number(c.penalty_total || 0),
    owed,
    blocked: Boolean(c.blocked),
    blockedReason: c.blocked_reason || null,
    transactions: tx
  };
}

// تسجيل دفع التأمين
export function markDepositPaid(captainId, amount = null, note = 'تأمين الحساب') {
  const c = q.get("SELECT * FROM captains WHERE id=?", captainId);
  if (!c) return { error: 'الكابتن غير موجود' };
  const amt = Number(amount || c.deposit_amount || DEFAULT_DEPOSIT);
  q.run("UPDATE captains SET deposit_paid=1, deposit_paid_at=datetime('now'), blocked=0, blocked_reason=NULL, deposit_balance=COALESCE(deposit_balance,0)+? WHERE id=?", amt, captainId);
  ledger(captainId, 'deposit', amt, { note });
  return { ok: true, amount: amt };
}

// إضافة مبلغ محصّل (كاش) وحساب الإيقاف التلقائي
export async function addCollectedCash(captainId, order) {
  const c = q.get("SELECT * FROM captains WHERE id=?", captainId);
  if (!c) return;
  const amt = Number(order.total) || 0;
  q.run("UPDATE captains SET wallet_cash=COALESCE(wallet_cash,0)+? WHERE id=?", amt, captainId);
  ledger(captainId, 'cash_collect', amt, { orderId: order.id, note: `تحصيل كاش — طلب ${order.order_no}` });
  return checkCaptainLimit(captainId);
}

// ⛔ السقف: إذا وصلت المبالغ المحصّلة حدّ التأمين → إيقاف تلقائي حتى التسوية
export async function checkCaptainLimit(captainId) {
  const c = q.get("SELECT * FROM captains WHERE id=?", captainId);
  if (!c || c.blocked) return false;
  const limit = Number(c.deposit_amount || DEFAULT_DEPOSIT);
  const wallet = Number(c.wallet_cash || 0);
  const penalties = Number(c.penalty_total || 0);
  if (wallet - penalties < limit) return false;
  q.run("UPDATE captains SET blocked=1, blocked_reason=?, status='offline' WHERE id=?",
    `وصلت مبالغك المحصّلة ${rls(wallet)} ر.س`, captainId);
  ledger(captainId, 'block', 0, { note: 'إيقاف تلقائي — بلوغ سقف التأمين' });
  try {
    await waSend({ phone: c.phone, type: 'buttons', body:
      `⛔ *تم إيقاف استقبال الطلبات مؤقتاً*\n\n📦 المبالغ اللي بحوزتك وصلت *${rls(wallet)} ر.س* (حدّ التأمين).\n\nسدّد المبالغ وأكمل التوصيل 👇`,
      buttons: [{ id: 'settle_info', title: '💵 كيف أسدّد؟' }] });
  } catch (e) { console.error('CAPTAIN_BLOCK_NOTIFY_FAIL', e.message); }
  try {
    if (config.adminPhone) await waSend({ phone: config.adminPhone, type: 'text', body:
      `⛔ *كابتن موقوف تلقائياً*\n👤 ${c.name}\n📱 ${c.phone}\n💰 المبالغ بحوزته: ${rls(wallet)} ر.س\n🏷 الغرامات: ${rls(penalties)} ر.س` });
  } catch (e) { /* */ }
  return true;
}

// تسوية المبالغ (يحصّلها المشرف) → إعادة التفعيل
export function settleCaptain(captainId, amount = null, note = 'تسوية المبالغ') {
  const c = q.get("SELECT * FROM captains WHERE id=?", captainId);
  if (!c) return { error: 'الكابتن غير موجود' };
  const wallet = Number(c.wallet_cash || 0);
  const penalties = Number(c.penalty_total || 0);
  const owed = Math.max(0, wallet - penalties);
  const paid = amount == null ? owed : Math.max(0, Number(amount) || 0);
  q.run("UPDATE captains SET wallet_cash=0, penalty_total=0, blocked=0, blocked_reason=NULL, status='available' WHERE id=?", captainId);
  ledger(captainId, 'settle', paid, { note: `${note}${penalties ? ` (خصم غرامات ${rls(penalties)})` : ''}` });
  return { ok: true, settled: paid, penalties };
}

// ---------- ⏱ غرامة التأخير: ٥ ر.س لكل ربع ساعة ----------
export function setPromisedTime(orderId, minutes) {
  const m = Number(minutes) || 30;
  q.run("UPDATE orders SET promised_at=datetime('now', '+' || ? || ' minutes') WHERE id=?", m, orderId);
  return q.get("SELECT promised_at FROM orders WHERE id=?", orderId)?.promised_at || null;
}

// فحص الطلبات المتأخرة وتطبيق الغرامة (تُستدعى من المجدول)
export async function checkLateDeliveries() {
  const rows = q.all(`SELECT * FROM orders
    WHERE captain_id IS NOT NULL AND promised_at IS NOT NULL
      AND status IN ('transferred','with_captain','on_the_way','arrived')
      AND datetime('now') > promised_at`);
  let applied = 0;
  for (const o of rows) {
    const mins = Number(q.get("SELECT CAST((julianday('now') - julianday(?)) * 24 * 60 AS INTEGER) AS m", o.promised_at).m) || 0;
    const quarters = Math.floor(Math.max(0, mins) / 15) + 1;          // أول ربع ساعة يُحسب فوراً عند التأخير
    const done = Number(o.penalty_quarters || 0);
    if (quarters <= done) continue;
    const deltaQ = quarters - done;
    const delta = deltaQ * LATE_PENALTY_PER_QUARTER;
    q.run("UPDATE orders SET penalty_quarters=?, penalty_total=COALESCE(penalty_total,0)+? WHERE id=?", quarters, delta, o.id);
    q.run("UPDATE captains SET penalty_total=COALESCE(penalty_total,0)+? WHERE id=?", delta, o.captain_id);
    ledger(o.captain_id, 'penalty', delta, { orderId: o.id, note: `تأخير ${mins} دقيقة — ${deltaQ} × ${rls(LATE_PENALTY_PER_QUARTER)} ر.س` });
    applied += 1;
    const cap = q.get("SELECT phone, name FROM captains WHERE id=?", o.captain_id);
    if (cap) waSend({ phone: cap.phone, restaurantId: o.restaurant_id, orderId: o.id, type: 'text', participant: 'captain',
      body: `⚠️ *غرامة تأخير*\n📦 الطلب ${o.order_no}\n⏱ متأخر ${mins} دقيقة عن الوقت المتوقع\n💰 الغرامة: *${rls(delta)} ر.س* (٥ ر.س لكل ربع ساعة)\nإجمالي غراماتك: ${rls(Number(q.get("SELECT penalty_total p FROM captains WHERE id=?", o.captain_id)?.p || 0))} ر.س` }).catch(() => {});
    try {
      const { checkCaptainLimit } = await import('./captainAccount.js');
      await checkCaptainLimit(o.captain_id);
    } catch (e) { /* */ }
  }
  return applied;
}

// ---------- 🏛 عمولات المنصة (من النشاط + من الكابتن) ----------
export async function applyCommissions(order) {
  const cfg = (await import('../config.js')).default;
  const pctBiz = Number(cfg.commissionBusinessPercent || 0);
  const pctCap = Number(cfg.commissionCaptainPercent || 0);
  const baseBiz = Math.max(0, Number(order.subtotal || 0) - Number(order.discount || 0));
  const cb = Math.round(baseBiz * pctBiz / 100);
  const cc = order.captain_id ? Math.round(Number(order.delivery_fee || 0) * pctCap / 100) : 0;
  q.run("UPDATE orders SET commission_business=?, commission_captain=? WHERE id=?", cb, cc, order.id);
  if (order.captain_id && cc > 0) {
    q.run("UPDATE captains SET commission_due=COALESCE(commission_due,0)+?, deposit_balance=COALESCE(deposit_balance,0)-? WHERE id=?", cc, cc, order.captain_id);
    ledger(order.captain_id, 'commission', -cc, { orderId: order.id, note: `عمولة المنصة ${pctCap}% من سعر التوصيل` });
    await checkDepositBalance(order.captain_id);
  }
  return { business: cb, captain: cc };
}

// رصيد تأمين الكابتن انتهى؟ → إيقاف حتى يسدّد من جديد
export async function checkDepositBalance(captainId) {
  const c = q.get("SELECT * FROM captains WHERE id=?", captainId);
  if (!c || Number(c.blocked)) return false;
  if (!Number(c.deposit_paid)) return false;                 // بلا تأمين أصلاً
  if (Number(c.deposit_balance || 0) > 0) return false;
  q.run("UPDATE captains SET blocked=1, blocked_reason=?, status='offline' WHERE id=?",
    'انتهى رصيد التأمين (عمولات المنصة)', captainId);
  ledger(captainId, 'block', 0, { note: 'إيقاف — انتهاء رصيد التأمين بالعمولات' });
  try {
    await waSend({ phone: c.phone, type: 'text', body:
      `⛔ *توقف استقبال الطلبات*\n\nانتهى رصيد تأمينك (٥٠٠ ر.س) بسبب عمولات المنصة.\nجدّد التأمين وأكمل التوصيل 💳` });
  } catch (e) { /* */ }
  try {
    if (config.adminPhone) await waSend({ phone: config.adminPhone, type: 'text', body:
      `⛔ *كابتن موقوف — انتهى رصيد التأمين*\n👤 ${c.name} · 📱 ${c.phone}\n🏛 إجمالي عمولات المنصة عليه: ${rls(c.commission_due)} ر.س` });
  } catch (e) { /* */ }
  return true;
}
