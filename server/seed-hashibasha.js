import bcrypt from 'bcryptjs';
import { q, tx } from './db.js';
import { readFileSync } from 'node:fs';

const branches = JSON.parse(readFileSync(new URL('./data/hashibasha/hb_branches_final.json', import.meta.url), 'utf8'));
const menu = JSON.parse(readFileSync(new URL('./data/hashibasha/hb_menu.json', import.meta.url), 'utf8'));
const IMG = (fn) => '/uploads/hashibasha/' + fn;
const H = (p) => bcrypt.hashSync(p, 10);

tx(() => {
  // ===== المطعم الرئيسي =====
  let rest = q.get("SELECT id FROM restaurants WHERE name_ar='حاشي باشا'");
  if (!rest) {
    const r = q.run(`INSERT INTO restaurants (name_ar, name_en, phone, whatsapp_number, city, address, lat, lng, delivery_fee, min_order, avg_prep_time_min, logo, cover, instagram, twitter, is_active)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      'حاشي باشا', 'Hashi Basha', '920005157', '+966558458677', 'الرياض', 'سلسلة مطاعم أكل سعودي تقليدي — 150+ فرعاً في المملكة', 24.7136, 46.6753,
      1000, 2000, 30, IMG('hashi-basha.png'), IMG('Hashi-basha0214.jpg'), 'instagram.com/hashibasha', 'x.com/HashiBasha', 1);
    rest = { id: Number(r.lastInsertRowid) };
    if (!q.get("SELECT id FROM restaurant_users WHERE restaurant_id=?", rest.id))
      q.run("INSERT INTO restaurant_users (restaurant_id, name, phone, email, password_hash, role) VALUES (?,?,?,?,?,?)",
        rest.id, 'إدارة حاشي باشا', '0555024240', 'hashibasha@wassal.app', H('hashibasha123'), 'owner');
    console.log('🏪 المطعم الرئيسي: حاشي باشا (id=' + rest.id + ')');
  } else {
    console.log('⚠️ حاشي باشا موجود مسبقاً — نتخطى إنشاء المطعم');
  }
  const rid = rest.id;
  // ضمان وجود حساب المالك دائماً
  const owner = q.get("SELECT id FROM restaurant_users WHERE restaurant_id=? AND branch_id IS NULL", rid);
  if (!owner)
    q.run("INSERT INTO restaurant_users (restaurant_id, name, phone, email, password_hash, role) VALUES (?,?,?,?,?,?)",
      rid, 'إدارة حاشي باشا', '0555024240', 'hashibasha@wassal.app', H('hashibasha123'), 'owner');

  // ===== الفروع (146) =====
  let nB = 0;
  for (const b of branches) {
    const dup = q.get("SELECT id FROM branches WHERE restaurant_id=? AND name=? AND COALESCE(city,'')=COALESCE(?,'')", rid, b.name, b.city || null);
    if (dup) continue;
    const coords = q.get("SELECT id FROM branches WHERE restaurant_id=?", rid) ? null : null;
    q.run(`INSERT INTO branches (restaurant_id, name, city, address, lat, lng, delivery_radius_km, delivery_fee, min_order, phone, is_active)
      VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
      rid, b.name, b.city || null, b.address || null, b.lat || null, b.lng || null,
      15, 1000, 2000, b.phone ? '0' + b.phone : null);
    nB++;
  }
  console.log('🏢 الفروع المضافة: ' + nB + ' (الإجمالي: ' + q.get("SELECT COUNT(*) c FROM branches WHERE restaurant_id=?", rid).c + ')');

  // ===== الأقسام والأصناف مع الصور =====
  let nI = 0;
  for (const cat of menu) {
    const c = q.get("SELECT id FROM categories WHERE restaurant_id=? AND name=?", rid, cat.name);
    const cid = c ? c.id : Number(q.run("INSERT INTO categories (restaurant_id, name, icon, sort_order) VALUES (?,?,?,?)", rid, cat.name, '🍽', 0).lastInsertRowid);
    for (const it of cat.items) {
      const dup = q.get("SELECT id FROM items WHERE restaurant_id=? AND name=?", rid, it.name);
      if (dup) continue;
      const cal = it.cal ? `سعرات حرارية ${it.cal}` : null;
      q.run(`INSERT INTO items (restaurant_id, category_id, name, description, price, image, is_available, is_popular, prep_time_min, sort_order)
        VALUES (?,?,?,?,?,?,1,?,?,0)`,
        rid, cid, it.name, cal, Math.round(it.price * 100), it.img ? IMG(it.img.split('/').pop()) : null,
        it.name.includes('كبسة') || it.name.includes('حاشي') ? 1 : 0, 20);
      nI++;
    }
  }
  console.log('🍽 الأصناف المضافة: ' + nI + ' (الإجمالي: ' + q.get("SELECT COUNT(*) c FROM items WHERE restaurant_id=?", rid).c + ')');

  // ===== حسابات مدراء الفروع (للاختبار) =====
  const testBranches = q.all("SELECT * FROM branches WHERE restaurant_id=? AND (city LIKE '%الرياض%' OR name LIKE '%اشبيلية%' OR name LIKE '%السليمانية%' OR name LIKE '%العليا%' OR name LIKE '%الملقا%') ORDER BY id LIMIT 5", rid);
  testBranches.forEach((b, i) => {
    const ph = '055' + String(1000000 + i * 111111).slice(-7);
    const exists = q.get("SELECT id FROM restaurant_users WHERE phone=?", ph);
    if (!exists)
      q.run("INSERT INTO restaurant_users (restaurant_id, branch_id, name, phone, password_hash, role) VALUES (?,?,?,?,?,?)",
        rid, b.id, 'مدير ' + b.name, ph, H('branch123'), 'manager');
  });
  console.log('👤 حسابات مدراء فروع للاختبار: ' + testBranches.length);

  console.log('✅ تم تسجيل حاشي باشا بنجاح');
  console.log('   دخول المطعم الرئيسي: hashibasha@wassal.app / hashibasha123 (أو 0555024240)');
  console.log('   دخول مدير فرع: 0551000000 / branch123');
});
