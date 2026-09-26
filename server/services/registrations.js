// ---------- تسجيل الأنشطة والكباتن عبر واتساب ----------
// دورة العمل: مسودة في المحادثة → اعتماد صاحب النشاط → إشعار المشرف → اعتماد الإدارة → إنشاء النشاط/الكابتن وربطه بالجوال
import { q, tx, nextRestaurantId } from '../db.js';
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
const hr = (h) => { if (!h) return '-'; const [a, b] = String(h).split(':'); let x = Number(a); const ap = x >= 12 ? 'م' : 'ص'; if (x === 0) x = 12; else if (x > 12) x -= 12; return `${x}:${b} ${ap}`; };

export async function notifySupervisor(reg) {
  const to = config.adminPhone || '';
  if (!to) { console.log('REG_NOTIFY_SKIPPED_NO_ADMIN_PHONE', reg.id); return false; }
  const isCap = reg.kind === 'captain';
  const typeRow = reg.business_type_id ? q.get("SELECT name_ar, icon FROM business_types WHERE id=?", reg.business_type_id) : null;
  let txt = isCap ? '🛵 *طلب تسجيل كابتن توصيل*\n\n' : '🆕 *طلب تسجيل نشاط جديد*\n\n';
  if (isCap) {
    txt += `👤 الاسم: *${reg.business_name || reg.owner_name || '-'}*\n🔢 الهوية: ${reg.owner_id || reg.national_id || '⚠️ غير مسجّلة'}\n🏙 المدينة: ${reg.city || '-'}${reg.district ? ' — ' + reg.district : ''}\n`
      + `🚗 المركبة: ${reg.vehicle_type || '-'}${reg.vehicle_color ? ' · 🎨 ' + reg.vehicle_color : ''}${reg.vehicle_plate ? ' · 🔢 ' + reg.vehicle_plate : ''}\n`
      + `💰 التأمين (٥٠٠ ر.س): ${Number(reg.deposit_paid || 0) ? '✅ مدفوع' : '⏳ غير مدفوع'}${reg.note ? ` (${reg.note})` : ''}\n📱 الجوال: ${reg.phone}\n`;
  } else {
    const items = safeItems(reg.items_json);
    txt += `${typeRow ? typeRow.icon + ' ' : ''}النشاط: *${reg.business_name || '-'}*\n`;
    txt += `🏷 النوع: ${typeRow?.name_ar || '-'}\n💳 الاشتراك (١٠٠٠ ر.س): ${Number(reg.subscription_paid || 0) ? '✅ مدفوع' : '⏳ غير مدفوع'}\n👤 المسؤول: ${reg.owner_name || '-'}${reg.owner_id ? ` — هوية ${reg.owner_id}` : ' — ⚠️ بلا هوية'}\n📍 العنوان: ${[reg.city, reg.district, reg.postal_code].filter(Boolean).join(' — ') || '-'}\n📱 جوال المسؤول: ${reg.phone}\n`;
    const sh = (reg.shifts === 2)
      ? `فترتان: ${hr(reg.s1_from)}–${hr(reg.s1_to)} · ${hr(reg.s2_from)}–${hr(reg.s2_to)}`
      : (reg.s1_from || reg.close_hour ? `فترة واحدة: ${hr(reg.s1_from)}–${hr(reg.close_hour)}` : '⚠️ غير محدّد');
    txt += `🏷 الكيان: *${reg.entity_type || '-'}*\n`;
    if (reg.entity_type === 'فرد' || /منتجة/.test(String(typeRow?.name_ar || ''))) txt += `📄 وثيقة العمل الحر: ${reg.freelance_no ? 'رقم ' + reg.freelance_no : '⚠️ بلا رقم'} ${reg.freelance_doc ? '— ✅ مرفقة' : '— ⚠️ غير مرفقة'}\n`;
    else txt += `🏛 رخصة البلدية: ${reg.municipal_doc ? '✅' : '⚠️ غير مرفقة'} · 📄 السجل التجاري: ${reg.cr_doc ? '✅' : '⚠️ غير مرفق'}\n`;
    txt += `🕐 الدوام: ${sh}${reg.health_count ? ` · 👨‍🍳 الشهادات الصحية: ${reg.health_count} عامل ${reg.health_docs ? '✅' : '⚠️ غير مرفقة'}` : ''}\n`;
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
      const paidDeposit = Number(reg.deposit_paid || 0) ? 1 : 0;
      const r = q.run("INSERT INTO captains (name, phone, city, district, national_id, vehicle_type, vehicle_plate, vehicle_color, license_doc, criminal_doc, id_doc, id_doc_back, password_hash, status, deposit_paid, blocked, blocked_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        reg.business_name || reg.owner_name || 'كابتن', phone, reg.city || null, reg.district || null, reg.owner_id || reg.national_id || null, reg.vehicle_type || 'دراجة',
        reg.vehicle_plate || null, reg.vehicle_color || null, reg.license_doc || null, reg.criminal_doc || null,
        reg.id_doc || null, reg.id_doc_back || null,
        bcrypt.hashSync(pass, 10), 'offline', paidDeposit, paidDeposit ? 0 : 1, paidDeposit ? null : 'بانتظار تأمين الحساب (٥٠٠ ر.س)');
      cap = { id: Number(r.lastInsertRowid) };
    }
    q.run("UPDATE business_registrations SET status='approved', captain_id=?, updated_at=datetime('now') WHERE id=?", cap.id, id);
    await notifyApplicant(reg, `🎉 *تم اعتمادك كابتن توصيل!*\n\n👤 ${reg.business_name || ''}\n📍 ${reg.city || ''}${reg.district ? ' — ' + reg.district : ''}\n🛵 ${reg.vehicle_type || ''}\n\nبيجيك الطلبات هنا على واتساب — جهّز نفسك 🚀\n\nللدخول للوحة الكابتن:\n🔗 ${(config.publicUrl || '')}/captain\n👤 رقمك: ${reg.phone}\n🔑 كلمة المرور: ${pass}`);
    return { ok: true, kind: 'captain', captain_id: cap.id, name: reg.business_name };
  }
  // نشاط تجاري: مطعم / سوبر ماركت / صيدلية / أسرة منتجة
  const items = safeItems(reg.items_json);
  const phone = validatePhone(reg.phone) || reg.phone;
  const pass = String(reg.phone || '').slice(-6) || '123456';
  const newId = tx(() => {
    const addr = [reg.city, reg.district, reg.postal_code].filter(Boolean).join(' — ') || null;
    const subPaid = Number(reg.subscription_paid || 0) ? 1 : 0;
    const newRestId = nextRestaurantId();   // 🆔 الترقيم يبدأ من 1001
    q.run(`INSERT INTO restaurants (id, name_ar, phone, city, address, whatsapp_number, delivery_fee, min_order, avg_prep_time_min, is_active, business_type_id, subscription_paid, subscription_paid_at,
        open_hour, close_hour, shifts, s1_from, s1_to, s2_from, s2_to, entity_type,
        municipal_no, municipal_issued_at, cr_no, cr_issued_at, freelance_no, freelance_issued_at,
        municipal_doc, cr_doc, freelance_doc, health_count, health_docs, lat, lng)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newRestId, reg.business_name || 'نشاط جديد', phone, reg.city || null, addr, null,
      1000, 2000, 25, 1, reg.business_type_id || null, subPaid, subPaid ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
      reg.s1_from || null, (reg.shifts === 2 ? reg.s2_to : reg.close_hour) || null, reg.shifts || 1, reg.s1_from || null, reg.s1_to || null, reg.s2_from || null, reg.s2_to || null, reg.entity_type || null,
      reg.municipal_no || null, reg.municipal_issued_at || null, reg.cr_no || null, reg.cr_issued_at || null, reg.freelance_no || null, reg.freelance_issued_at || null,
      reg.municipal_doc || null, reg.cr_doc || null, reg.freelance_doc || null, reg.health_count || null, reg.health_docs || null,
      reg.lat || null, reg.lng || null);
    const rid = newRestId;
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
      q.run("INSERT INTO restaurant_users (restaurant_id, name, phone, national_id, id_doc, id_doc_back, password_hash, role) VALUES (?,?,?,?,?,?,?,?)",
        rid, 'صاحب النشاط (المالك)', phone, reg.owner_id || null, reg.id_doc || null, reg.id_doc_back || null, bcrypt.hashSync(pass, 10), 'owner');
    }
    q.run("UPDATE business_registrations SET status='approved', restaurant_id=?, updated_at=datetime('now') WHERE id=?", rid, id);
    return rid;
  });
  // 📊 صاحب النشاط يستلم تقرير المبيعات اليومي تلقائياً (وبوقت يقدر يغيّره)
  try {
    const { addRecipient } = await import('./reporting.js');
    const ownerRec = addRecipient(newId, 'صاحب النشاط (المالك)', phone, '23:30', reg.owner_id || null);
    q.run("UPDATE report_recipients SET status='approved', updated_at=datetime('now') WHERE id=?", ownerRec.id);
  } catch (e) { console.error('OWNER_REPORT_ADD_FAIL', e.message); }

  await notifyApplicant(reg, `🎉 *تم اعتماد نشاطك!*\n\n🍽 ${reg.business_name}\n👤 ${reg.owner_name || ''}\n📍 ${[reg.city, reg.district, reg.postal_code].filter(Boolean).join(' — ')}\n🍽 الأصناف: ${items.length}\n\nصار نشاطك ظاهر للعملاء ✅\n\n🆔 *رقم نشاطك: #${newId}*\n\n🔑 *بيانات لوحتك:*\n👤 صاحب النشاط (المالك) — رقمك: ${reg.phone}\n🔑 كلمة المرور: ${pass}\n🔗 ${(config.publicUrl || '')}/restaurant\n\n• 🍽 *تحديث المنيو*: اكتب *أصنافي* → «وقف رقم الصنف» لو خلص (يختفي من العملاء) · «كمية رقم كمية» للمتوفر
• أضف *كاشير* (يستلم الطلبات ويتابعها): اكتب *كاشير*\n• أضف *مدير* (يوصله تقرير المبيعات): اكتب *مدير*\n📊 *وأنت كذلك يوصلك تقرير المبيعات اليومي* على هذا الرقم الساعة ١١:٣٠ م — غيّر وقته بكتابة *وقت التقرير*\n• أو أعطِ رقم نشاطك لمن تريد — يسجّل بنفسه بكتابة *انضمام مدير*`);
  // 🧾/👤 عرض خيارات الفريق بعد الاعتماد مباشرة
  try {
    const { waSend } = await import('./whatsapp.js');
    await waSend({ phone: phone, restaurantId: newId, type: 'buttons', body: 'تحب نضيف فريقك الحين؟ 👇',
      buttons: [{ id: 'add_cashier', title: '🧾 إضافة كاشير' }, { id: 'add_manager', title: '👤 إضافة مدير' }] });
  } catch (e) { console.error('TEAM_PROMPT_FAIL', e.message); }
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
