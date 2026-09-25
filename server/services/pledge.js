// 📜 التعهد ورقم التفعيل — لجميع مستخدمي المنصة (عميل · مالك · مدير · كاشير · كابتن)
import { q } from '../db.js';

export const PLEDGE_TEXT = `📜 *تعهد*
أتعهد باحترام الأنظمة داخل *المملكة العربية السعودية* وخارجها، والتعامل مع منصة *واتس هم* ومنسوبيها بكل احترام.
وأنا *مسؤول أمام الجهات الحكومية* عند الإساءة للمنصة أو منسوبيها.
ومنصة *واتس هم* وحقوقها *المالية والفكرية* مسجّلة لشركة *Whatsham*.
هل توافق؟`;

export const PLEDGE_BUTTONS = [{ id: 'pledge_ok', title: '✅ أوافق على التعهد' }];

// إنشاء سجل تعهد + توليد رقم تفعيل
export function createPledge({ kind, phone, name = null, national_id = null, birth_date = null, doc = null, restaurant_id = null }) {
  const norm = String(phone || '').replace(/^\+/, '');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const dup = q.get("SELECT id FROM agreements WHERE phone=? AND kind=?", norm, kind);
  if (dup) {
    q.run("UPDATE agreements SET name=COALESCE(?,name), national_id=COALESCE(?,national_id), birth_date=COALESCE(?,birth_date), doc=COALESCE(?,doc), restaurant_id=COALESCE(?,restaurant_id), code=?, accepted_at=datetime('now') WHERE id=?",
      name, national_id, birth_date, doc, restaurant_id, code, dup.id);
    return { code, id: dup.id, isNew: false };
  }
  const r = q.run("INSERT INTO agreements (kind, phone, name, national_id, birth_date, doc, restaurant_id, code, accepted_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))",
    kind, norm, name, national_id, birth_date, doc, restaurant_id, code);
  return { code, id: Number(r.lastInsertRowid), isNew: true };
}

export function findPledge(kind, phone) {
  return q.get("SELECT * FROM agreements WHERE kind=? AND phone=?", kind, String(phone || '').replace(/^\+/, ''));
}

export const pledgeMessage = (code) => `✅ *تم تسجيل تعهدك — شكراً لك* 🌸\n\n🔢 *رقم التفعيل:* *${code}*\n_(احفظه — وهو إقرارك بقبول التعهد، مسجّل بتاريخ اليوم)_\n\nومنصة *واتس هم* وحقوقها المالية والفكرية مسجّلة لشركة *Whatsham* ✅`;

export const dayAr = () => {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`;
};
