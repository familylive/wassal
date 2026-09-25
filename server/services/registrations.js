// ---------- تسجيل الأنشطة والكباتن عبر واتساب ----------
// دورة العمل: مسودة في المحادثة → اعتماد صاحب النشاط → إشعار المشرف → اعتماد الإدارة → إنشاء النشاط/الكابتن وربطه بالجوال
import { q, tx } from '../db.js';
import config from '../config.js';
import { waSend } from './whatsapp.js';
import { validatePhone } from '../utils.js';
import bcrypt from 'bcryptjs';

const rls = (h) => (Number(h || 0) / 100).toFixed(2);

export function safeItems(json) {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

export function getRegistration(id) {
  return q.get("SELECT * FROM business_registrations WHERE id=?", Number(id));
}

// ---------- إشعار المشرف بطلب يحتاج اعتماد ----------
export async function notifySupervisor(reg) {
  const to = config.adminPhone || '';
  if (!to) { console.log('REG_NOTIFY_SKIPPED_NO_ADMIN_PHONE', reg.id); return false; }
  const isCap = reg.kind === 'captain';
  const typeRow = reg.business_type_id ? q.get("SELECT name_ar, icon FROM business_types WHERE id=?", reg.business_type_id) : null;
  let txt = isCap ? '🛵 *طلب تسجيل كابتن توصيل*\n\n' : '🆕 *طلب تسجيل نشاط جديد*\n\n';
  if (isCap) {
    txt += `👤 الاسم: *${reg.business_name || reg.owner_name || '-'}*\n🏙 المدينة: ${reg.city || '-'}\n🚗 المركبة: ${reg.vehicle_type || '-'}\n📱 الجوال: ${reg.phone}\n`;
  } else {
    const items = safeItems(reg.items_json);
    txt += `${typeRow ? typeRow.icon + ' ' : ''}النشاط: *${reg.business_name || '-'}*\n`;
    txt += `🏷 النوع: ${typeRow?.name_ar || '-'}\n🏙 المدينة: ${reg.city || '-'}\n📱 جوال المسؤول: ${reg.phone}\n`;
    txt += `🍽 الأصناف: *${items.length}*\n`;
    const sample = items.slice(0, 8).map(i => `• ${i.name}${i.price ? ' — ' + rls(i.price) + ' ر.س' : ' — بلا سعر'}`).join('\n');
    if (sample) txt += sample + (items.length > 8 ? `\n… و${items.length - 8} أصناف أخرى` : '');
  }
  txt += '\n\nهل تعتمد التسجيل؟';
  const pre = isCap ? 'cap' : 'biz';
  try {
    await waSend({ phone: to, type: 'buttons', body: txt, buttons: [
      { id: `${pre}_ok:${reg.id}`, title: '✅ اعتماد' },
      { id: `${pre}_no:${reg.id}`, title: '❌ رفض' }
    ] });
    return true;
  } catch (e) { console.error('REG_SUPERVISOR_NOTIFY_FAIL', e.message); return false; }
}

// ---------- اعتماد التسجيل => إنشاء النشاط/الكابتن ----------
export async function approveRegistration(id) {
  const reg = getRegistration(id);
  if (!reg) return { error: 'الطلب غير موجود' };
  if (reg.status === 'approved') return { error: 'معتمد مسبقاً', name: reg.business_name };
  if (reg.kind === 'captain') {
    const phone = validatePhone(reg.phone) || reg.phone;
    let cap = q.get("SELECT * FROM captains WHERE phone=? OR phone=?", reg.phone, phone);
    const pass = String(reg.phone || '').slice(-6) || '123456';
    if (!cap) {
      const r = q.run("INSERT INTO captains (name, phone, city, vehicle_type, password_hash, status) VALUES (?,?,?,?,?,?)",
        reg.business_name || reg.owner_name || 'كابتن', phone, reg.city || null, reg.vehicle_type || 'دراجة',
        bcrypt.hashSync(pass, 10), 'offline');
      cap = { id: Number(r.lastInsertRowid) };
    }
    q.run("UPDATE business_registrations SET status='approved', captain_id=?, updated_at=datetime('now') WHERE id=?", cap.id, id);
    await notifyApplicant(reg, `🎉 *تم اعتمادك كابتن توصيل!*\n\n👤 ${reg.business_name || ''}\n🛵 ${reg.vehicle_type || ''}\n\nبيجيك الطلبات هنا على واتساب — جهّز نفسك 🚀\n\nللدخول للوحة الكابتن:\n🔗 ${(config.publicUrl || '')}/captain\n👤 رقمك: ${reg.phone}\n🔑 كلمة المرور: ${pass}`);
    return { ok: true, kind: 'captain', captain_id: cap.id, name: reg.business_name };
  }
  // نشاط تجاري: مطعم / سوبر ماركت / صيدلية / أسرة منتجة
  const items = safeItems(reg.items_json);
  const phone = validatePhone(reg.phone) || reg.phone;
  const pass = String(reg.phone || '').slice(-6) || '123456';
  const newId = tx(() => {
    const r = q.run(`INSERT INTO restaurants (name_ar, phone, city, address, whatsapp_number, delivery_fee, min_order, avg_prep_time_min, is_active, business_type_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      reg.business_name || 'نشاط جديد', phone, reg.city || null, reg.city || null, null,
      1000, 2000, 25, 1, reg.business_type_id || null);
    const rid = Number(r.lastInsertRowid);
    let catId;
    const existingCat = q.get("SELECT id FROM categories WHERE restaurant_id=? AND name=?", rid, 'الأصناف');
    if (existingCat) catId = existingCat.id;
    else catId = Number(q.run("INSERT INTO categories (restaurant_id, name, icon, sort_order, is_active) VALUES (?,?,?,?,1)", rid, 'الأصناف', '🍽', 0).lastInsertRowid);
    for (const it of items) {
      q.run("INSERT INTO items (restaurant_id, category_id, name, price, is_available, is_popular, sort_order) VALUES (?,?,?,?,1,0,?)",
        rid, it.category_id || catId, String(it.name || '').slice(0, 80), Number(it.price) || 0, it.sort_order || 0);
    }
    const u = q.get("SELECT id FROM restaurant_users WHERE restaurant_id=? AND phone=?", rid, phone);
    if (!u) {
      q.run("INSERT INTO restaurant_users (restaurant_id, name, phone, password_hash, role) VALUES (?,?,?,?,?)",
        rid, reg.owner_name || reg.business_name || 'المسؤول', phone, bcrypt.hashSync(pass, 10), 'owner');
    }
    q.run("UPDATE business_registrations SET status='approved', restaurant_id=?, updated_at=datetime('now') WHERE id=?", rid, id);
    return rid;
  });
  await notifyApplicant(reg, `🎉 *تم اعتماد نشاطك!*\n\n🍽 ${reg.business_name}\n🏙 ${reg.city || ''}\n🍽 الأصناف: ${items.length}\n\nصار نشاطك ظاهر للعملاء ✅\n\nللدخول للوحة نشاطك:\n🔗 ${(config.publicUrl || '')}/restaurant\n👤 رقمك: ${reg.phone}\n🔑 كلمة المرور: ${pass}\n\nنصيحة: راجع الأصناف والأسعار من اللوحة وأضف صورك 🌟`);
  return { ok: true, kind: 'business', restaurant_id: newId, name: reg.business_name };
}

export async function rejectRegistration(id, note = '') {
  const reg = getRegistration(id);
  if (!reg) return { error: 'الطلب غير موجود' };
  q.run("UPDATE business_registrations SET status='rejected', note=?, updated_at=datetime('now') WHERE id=?", note, id);
  await notifyApplicant(reg, 'نعتذر 🙏 — لم يتم اعتماد طلب التسجيل حالياً.\n\nتقدر تعدّل بياناتك وتعيد الإرسال بكتابة *تسجيل* في أي وقت.');
  return { ok: true, name: reg.business_name };
}

export async function notifyApplicant(reg, text) {
  try { await waSend({ phone: reg.phone, type: 'text', body: text }); return true; }
  catch (e) { console.error('REG_NOTIFY_APPLICANT_FAIL', e.message); return false; }
}
