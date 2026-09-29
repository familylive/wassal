// 🟠🟢 حالة استقبال الطلبات للنشاط — مصدر واحد يستخدمه البوت واللوحة
import { q } from '../db.js';
import { validatePhone } from '../utils.js';

const localPhone = (x) => { const d = String(x || '').replace(/\D/g, ''); return d.startsWith('966') ? '0' + d.slice(3) : d; };

// الحالة الحالية: مغلق (orders_paused) · مشغول (busy_until بالمستقبل) · مفتوح
export function restaurantStatus(rid) {
  const r = q.get("SELECT id, name_ar, orders_paused, open_hour, busy_until, busy_by, busy_by_phone FROM restaurants WHERE id=?", rid);
  if (!r) return null;
  let busy = false, minutesLeft = 0;
  if (r.busy_until) {
    const until = new Date(String(r.busy_until).replace(' ', 'T') + 'Z').getTime();
    if (until > Date.now()) { busy = true; minutesLeft = Math.max(1, Math.round((until - Date.now()) / 60000)); }
  }
  const paused = Number(r.orders_paused) === 1;
  return {
    id: r.id, name: r.name_ar, paused, busy, minutesLeft,
    busyUntil: busy ? r.busy_until : null, busyBy: busy ? (r.busy_by || null) : null, busyByPhone: busy ? (r.busy_by_phone || null) : null,
    state: paused ? 'closed' : busy ? 'busy' : 'open', openHour: r.open_hour || null
  };
}

// 🟠 تشغيل «مشغول» لمدة دقائق (افتراضي 60) — ويبلّغ صاحب النشاط باسم من فعّلها ورقمه
export async function setBusy(rid, { minutes = 60, byName = null, byPhone = null, notify = true } = {}) {
  const mins = Math.min(600, Math.max(5, Math.round(Number(minutes) || 60)));
  q.run(`UPDATE restaurants SET busy_until=datetime('now','+${mins} minutes'), busy_by=?, busy_by_phone=? WHERE id=?`,
    byName || null, byPhone ? validatePhone(byPhone) : null, rid);
  const st = restaurantStatus(rid);
  if (notify) {
    try {
      const owner = q.get("SELECT phone FROM restaurant_users WHERE restaurant_id=? AND role='owner' AND is_active=1 ORDER BY id LIMIT 1", rid)
        || q.get("SELECT phone FROM restaurants WHERE id=?", rid);
      if (owner?.phone && (!byPhone || validatePhone(owner.phone) !== validatePhone(byPhone))) {
        const { waSend } = await import('./whatsapp.js');
        await waSend({ phone: owner.phone, restaurantId: rid, type: 'text',
          body: `🟠 *حالة النشاط: مشغول (زحمة)*\n🏪 ${st?.name || ''}\n👤 ${byName || 'الكاشير'} — 📱 ${localPhone(byPhone)}\n⏱️ حتى ~${String(st?.busyUntil || '').slice(11, 16)} (${mins} دقيقة)\n\n🚫 العملاء يشوفون: «النشاط مشغول الآن — عاود الطلب لاحقًا».` }).catch(() => {});
      }
    } catch (e) { console.error('BUSY_NOTIFY_OWNER_FAIL', e.message); }
  }
  return st;
}

// 🟢 إلغاء «مشغول»
export function clearBusy(rid) {
  q.run("UPDATE restaurants SET busy_until=NULL, busy_by=NULL, busy_by_phone=NULL WHERE id=?", rid);
  return restaurantStatus(rid);
}

// 🔒 إغلاق / 🟢 فتح الاستقبال
export function setPaused(rid, paused) {
  if (paused) q.run("UPDATE restaurants SET orders_paused=1, paused_at=datetime('now') WHERE id=?", rid);
  else q.run("UPDATE restaurants SET orders_paused=0, paused_at=NULL, busy_until=NULL, busy_by=NULL, busy_by_phone=NULL WHERE id=?", rid);
  return restaurantStatus(rid);
}
