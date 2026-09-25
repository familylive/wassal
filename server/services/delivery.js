// ---------- صورة التسليم من الكابتن (شرط إغلاق الطلب) ----------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q } from '../db.js';
import { waSend } from './whatsapp.js';
import { validatePhone } from '../utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHOTO_DIR = path.join(__dirname, '..', 'uploads', 'deliveries');

export function activeOrderForCaptain(captainId) {
  return q.get(`SELECT * FROM orders WHERE captain_id=? AND status IN ('transferred','with_captain','on_the_way','arrived','accepted') ORDER BY id DESC LIMIT 1`, captainId);
}

export function hasDeliveryPhoto(order) {
  return Boolean(order?.delivery_photo || order?.delivery_photo_at);
}

// حفظ صورة التسليم الواردة من الكابتن
export async function saveDeliveryPhoto(captainPhone, mediaId) {
  const captain = q.get("SELECT * FROM captains WHERE phone=? OR phone=?", captainPhone, validatePhone(captainPhone));
  if (!captain) return { error: 'not-captain' };
  const order = activeOrderForCaptain(captain.id);
  if (!order) return { error: 'لا يوجد طلب نشط لك حالياً 📭' };
  const { downloadMedia } = await import('./vision.js');
  let file = null, url = null;
  try {
    const media = await downloadMedia(mediaId);
    if (media?.buffer?.length) {
      fs.mkdirSync(PHOTO_DIR, { recursive: true });
      const ext = String(media.mime || 'image/jpeg').includes('png') ? 'png' : 'jpg';
      const base = `${order.order_no || 'order'}-${order.id}.${ext}`;
      fs.writeFileSync(path.join(PHOTO_DIR, base), media.buffer);
      file = base;
      url = `/uploads/deliveries/${base}`;
    }
  } catch (e) { console.error('DELIVERY_PHOTO_SAVE_FAIL', e.message); }
  q.run("UPDATE orders SET delivery_photo=?, delivery_photo_at=datetime('now'), updated_at=datetime('now') WHERE id=?", file || 'received', order.id);
  // إبلاغ العميل بوصول صورة التسليم
  const customer = q.get("SELECT phone FROM customers WHERE id=?", order.customer_id);
  if (customer) waSend({ phone: customer.phone, restaurantId: order.restaurant_id, orderId: order.id, type: 'text', body: `📷 وصلت صورة تسليم طلبك ${order.order_no} من الكابتن.` }).catch(() => {});
  return { ok: true, order, url, file };
}
