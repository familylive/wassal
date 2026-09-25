// ---------- 📣 إعلانات الأنشطة: طلب → تسعير → دفع → اعتماد → إرسال لعملاء المدينة ----------
import { q } from '../db.js';
import config from '../config.js';
import { waSend } from './whatsapp.js';

const rls = (h) => (Number(h || 0) / 100).toFixed(2);

export function getAdRequest(id) {
  return q.get("SELECT * FROM ad_requests WHERE id=?", Number(id));
}

export function createAdRequest(restaurantId, phone, city) {
  const r = q.run("INSERT INTO ad_requests (restaurant_id, phone, city, status) VALUES (?,?,?,'requested')", restaurantId, phone, city || null);
  return getAdRequest(Number(r.lastInsertRowid));
}

export function setAdPrice(id, priceHalalas) {
  q.run("UPDATE ad_requests SET price=?, status='priced', updated_at=datetime('now') WHERE id=?", Number(priceHalalas) || 0, Number(id));
  return getAdRequest(id);
}

export function setAdStatus(id, status, extra = {}) {
  const cols = ['status=?', 'updated_at=datetime(\'now\')'];
  const vals = [status];
  for (const k of ['content', 'image', 'supervisor_note', 'ad_id']) {
    if (extra[k] !== undefined) { cols.push(`${k}=?`); vals.push(extra[k]); }
  }
  vals.push(Number(id));
  q.run(`UPDATE ad_requests SET ${cols.join(', ')} WHERE id=?`, ...vals);
  return getAdRequest(id);
}

// إشعار مشرف المنصة بطلب إعلان جديد (لتحديد السعر)
export async function notifySupervisorNewAd(reqRow) {
  const to = config.adminPhone || '';
  if (!to) return false;
  const r = q.get("SELECT name_ar, city FROM restaurants WHERE id=?", reqRow.restaurant_id);
  try {
    await waSend({ phone: to, type: 'buttons', body:
      `📣 *طلب إعلان جديد*\n\n🏪 النشاط: *${r?.name_ar || '-'}*\n🏙 المدينة: ${reqRow.city || r?.city || '-'}\n📱 جواله: ${reqRow.phone}\n\n💰 اكتب *سعر الإعلان* بالريال (مثال: 300) وسنرسله للنشاط للموافقة.`,
      buttons: [{ id: `adprice:${reqRow.id}`, title: '💰 تحديد السعر' }] });
    return true;
  } catch (e) { console.error('AD_NOTIFY_FAIL', e.message); return false; }
}

// إشعار النشاط بالسعر (للموافقة)
export async function sendPriceToBusiness(reqRow) {
  const r = q.get("SELECT name_ar FROM restaurants WHERE id=?", reqRow.restaurant_id);
  const to = String(reqRow.phone || '').replace(/^\+/, '');
  try {
    await waSend({ phone: to, type: 'buttons', body:
      `💰 *سعر إعلانك*\n\n🏪 ${r?.name_ar || ''}\n🏙 يُرسل لعملاء مدينة: *${reqRow.city || '-'}*\n💵 السعر: *${rls(reqRow.price)} ر.س*\n\nموافق؟ (بعد الموافقة يوصلك رابط الدفع، وبعدها تكتب نص إعلانك وتُرسله للإدارة للاعتماد)`,
      buttons: [{ id: 'ad_yes', title: '✅ موافق' }, { id: 'ad_no', title: '❌ غير موافق' }] });
    return true;
  } catch (e) { console.error('AD_PRICE_SEND_FAIL', e.message); return false; }
}

// إرسال الإعلان للاعتماد النهائي
export async function sendToSupervisorForApproval(reqRow) {
  const to = config.adminPhone || '';
  if (!to) return false;
  const r = q.get("SELECT name_ar FROM restaurants WHERE id=?", reqRow.restaurant_id);
  try {
    await waSend({ phone: to, type: 'buttons', body:
      `📣 *إعلان بانتظار اعتمادك*\n\n🏪 ${r?.name_ar || ''}\n🏙 المدينة: ${reqRow.city || '-'}\n💵 المدفوع: ${rls(reqRow.price)} ر.س\n\n✍️ النص:\n${reqRow.content || ''}`,
      buttons: [{ id: `adok:${reqRow.id}`, title: '✅ اعتماد ونشر' }, { id: `adno:${reqRow.id}`, title: '❌ رفض' }] });
    return true;
  } catch (e) { console.error('AD_APPROVAL_SEND_FAIL', e.message); return false; }
}

// 🚀 نشر الإعلان: لكل عملاء المدينة المسجّلين فقط
export async function publishAd(reqRow) {
  const r = q.get("SELECT * FROM restaurants WHERE id=?", reqRow.restaurant_id);
  const city = reqRow.city || r?.city || null;
  const rows = city
    ? q.all(`SELECT DISTINCT c.phone AS phone FROM customers c JOIN customer_locations cl ON cl.customer_id=c.id WHERE cl.city=? AND c.phone IS NOT NULL`, city)
    : [];
  let sent = 0;
  for (const row of rows) {
    const cp = String(row.phone || '').replace(/^\+/, '');
    if (!cp) continue;
    try {
      await waSend({ phone: cp, restaurantId: reqRow.restaurant_id, type: 'buttons', body:
        `📣 *${r?.name_ar || ''}*\n\n${reqRow.content || ''}`,
        buttons: [{ id: 'rest:' + reqRow.restaurant_id, title: '🛒 اطلب الآن' }, { id: 'menu', title: '📂 المنيو' }] });
      sent += 1;
    } catch (e) { /* تجاهل */ }
  }
  // سجّل الإعلان في لوحة الإعلانات
  let adId = null;
  try {
    const ins = q.run("INSERT INTO ads_campaigns (title, restaurant_id, placement, is_active, impressions) VALUES (?,?,?,1,?)",
      String(reqRow.content || '').slice(0, 120), reqRow.restaurant_id, 'whatsapp', sent);
    adId = Number(ins.lastInsertRowid);
  } catch (e) { console.error('AD_CAMPAIGN_FAIL', e.message); }
  q.run("UPDATE ad_requests SET status='approved', sent_count=?, ad_id=?, updated_at=datetime('now') WHERE id=?", sent, adId, reqRow.id);
  return { sent, adId, city };
}

export function customersInCity(city) {
  if (!city) return 0;
  return Number(q.get(`SELECT COUNT(DISTINCT c.id) c FROM customers c JOIN customer_locations cl ON cl.customer_id=c.id WHERE cl.city=?`, city).c) || 0;
}
