import bcrypt from 'bcryptjs';
import { q, tx } from './db.js';

const H = (p) => bcrypt.hashSync(p, 10);

tx(() => {
  // ---------- أدمن ----------
  if (!q.get("SELECT id FROM admins LIMIT 1"))
    q.run("INSERT INTO admins (name, email, password_hash) VALUES (?,?,?)", 'مدير المنصة', 'admin@wassal.app', H('admin123'));

  // ---------- مطاعم ----------
  const mkRest = (name, phone, pw, opts = {}) => {
    let r = q.get("SELECT id FROM restaurants WHERE name_ar=?", name);
    if (!r) {
      const ins = q.run(`INSERT INTO restaurants (name_ar, name_en, phone, whatsapp_number, city, address, lat, lng, delivery_fee, min_order, avg_prep_time_min, logo, cover, is_active)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        name, opts.name_en || null, phone, opts.whatsapp || phone, opts.city || 'الرياض', opts.address || 'حي العليا', opts.lat || 24.7136, opts.lng || 46.6753,
        opts.delivery_fee ?? 1000, opts.min_order ?? 3000, opts.avg_prep ?? 25, null, null, 1);
      r = { id: Number(ins.lastInsertRowid) };
      const u = q.get("SELECT id FROM restaurant_users WHERE restaurant_id=?", r.id);
      if (!u) q.run("INSERT INTO restaurant_users (restaurant_id, name, phone, email, password_hash, role) VALUES (?,?,?,?,?,?)", r.id, name, phone, opts.email || null, H(pw), 'owner');
    }
    return r.id;
  };

  const shawarma = mkRest('مطعم شاورما الضيافة', '0551000001', 'rest1', { delivery_fee: 1500, min_order: 2500, avg_prep: 20, city: 'الرياض' });
  const pizza = mkRest('بيتزا نابولي', '0551000002', 'rest2', { delivery_fee: 1200, min_order: 3000, avg_prep: 30, city: 'الرياض' });
  const burger = mkRest('برجر الشيف', '0551000003', 'rest3', { delivery_fee: 1000, min_order: 2000, avg_prep: 25, city: 'جدة' });

  // ---------- الفروع (نطاق التوصيل) ----------
  const mkBranch = (rid, name, city, lat, lng, radiusKm, fee) => {
    if (!q.get("SELECT id FROM branches WHERE restaurant_id=? AND name=?", rid, name))
      q.run("INSERT INTO branches (restaurant_id, name, city, address, lat, lng, delivery_radius_km, delivery_fee, min_order) VALUES (?,?,?,?,?,?,?,?,?)",
        rid, name, city, city === 'الرياض' ? 'حي العليا' : 'حي الروضة', lat, lng, radiusKm, fee, 3000);
  };
  mkBranch(shawarma, 'فرع العليا', 'الرياض', 24.7136, 46.6753, 15, 1500);
  mkBranch(shawarma, 'فرع النرجس', 'الرياض', 24.8103, 46.6903, 12, 1000);
  mkBranch(pizza, 'فرع الملقا', 'الرياض', 24.7623, 46.6648, 10, 1200);
  mkBranch(burger, 'فرع الروضة', 'جدة', 21.5433, 39.1728, 15, 1000);

  // ---------- منيو شاورما ----------
  const mkCat = (rid, name, icon, sort) => {
    const c = q.run("INSERT INTO categories (restaurant_id, name, icon, sort_order) VALUES (?,?,?,?)", rid, name, icon, sort);
    return Number(c.lastInsertRowid);
  };
  const mkItem = (rid, cid, name, desc, price, opts = {}) => {
    const it = q.run(`INSERT INTO items (restaurant_id, category_id, name, description, price, is_available, is_popular, prep_time_min, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?)`, rid, cid, name, desc || null, price, opts.av ?? 1, opts.pop || 0, opts.prep ?? 15, opts.sort ?? 0);
    return Number(it.lastInsertRowid);
  };

  if (!q.get("SELECT id FROM categories WHERE restaurant_id=? LIMIT 1", shawarma)) {
    const c1 = mkCat(shawarma, 'شاورما', '🌯', 1);
    const c2 = mkCat(shawarma, 'مشويات', '🍢', 2);
    const c3 = mkCat(shawarma, 'مقبلات ومشروبات', '🥤', 3);
    mkItem(shawarma, c1, 'شاورما عربي', 'لحم مع خضار وطحينة', 1400, { pop: 1, prep: 12 });
    mkItem(shawarma, c1, 'شاورما دجاج', 'دجاج مع بطاطس وثوم', 1200, { pop: 1, prep: 10 });
    mkItem(shawarma, c1, 'شاورما عربي عائلي', 'ساندويتش كبير يكفي شخصين', 2400, { prep: 15 });
    mkItem(shawarma, c2, 'ريش غنم', 'ريش متبلة على الفحم', 3500, { prep: 25 });
    mkItem(shawarma, c2, 'كباب لحم', 'كباب طازج مع خبز', 2800, { prep: 20 });
    mkItem(shawarma, c3, 'حمص', 'حمص بطحينة وزيت زيتون', 800, {});
    mkItem(shawarma, c3, 'بطاطس مقلي', 'بطاطس مقرمشة', 600, {});
    mkItem(shawarma, c3, 'بيبسي', 'علبة 330 مل', 400, {});
    q.run(`INSERT INTO offers (restaurant_id, title, description, type, value, min_order, is_active) VALUES (?,?,?,?,?,?,?)`,
      shawarma, 'خصم 15% على طلبات +50 ر.س', 'خصم فوري على طلباتك فوق 50 ريال', 'percent', 15, 5000, 1);
    q.run(`INSERT INTO offers (restaurant_id, title, description, type, value, min_order, is_active) VALUES (?,?,?,?,?,?,?)`,
      shawarma, 'شاورما + مشروب بخصم 20%', 'وجبة اقتصادية', 'percent', 20, 0, 1);
  }

  // ---------- منيو بيتزا ----------
  if (!q.get("SELECT id FROM categories WHERE restaurant_id=? LIMIT 1", pizza)) {
    const c1 = mkCat(pizza, 'بيتزا', '🍕', 1);
    const c2 = mkCat(pizza, 'سلطات', '🥗', 2);
    mkItem(pizza, c1, 'بيتزا مارغريتا', 'صلصة طماطم وجبن موزاريلا', 2200, { pop: 1, prep: 20 });
    mkItem(pizza, c1, 'بيتزا دجاج باربكيو', 'دجاج مشوي وصوص باربكيو', 2800, { pop: 1, prep: 25 });
    mkItem(pizza, c1, 'بيتزا خضار', 'فلفل وزيتون وذرة', 2400, { prep: 20 });
    mkItem(pizza, c2, 'سلطة سيزر', 'خس ودجاج وجبن بارميزان', 1500, {});
    q.run(`INSERT INTO offers (restaurant_id, title, description, type, value, min_order, is_active) VALUES (?,?,?,?,?,?,?)`,
      pizza, 'بيتزا كبيرة + مشروب بـ 35 ر.س', 'عرض الوجبة', 'percent', 25, 3500, 1);
  }

  // ---------- منيو برجر ----------
  if (!q.get("SELECT id FROM categories WHERE restaurant_id=? LIMIT 1", burger)) {
    const c1 = mkCat(burger, 'برجر', '🍔', 1);
    mkItem(burger, c1, 'برجر لحم كلاسيك', 'لحم بقري 100% مع جبن', 1900, { pop: 1, prep: 15 });
    mkItem(burger, c1, 'برجر دجاج مقرمش', 'دجاج مقرمش مع صوص خاص', 1600, { prep: 15 });
    mkItem(burger, c1, 'برجر مزدوج', 'طبقتين لحم مع جبن مضاعف', 2600, { pop: 1, prep: 20 });
    mkItem(burger, c1, 'وجبة برجر مع بطاطس ومشروب', 'وجبة كاملة', 2800, { prep: 20 });
    q.run(`INSERT INTO offers (restaurant_id, title, description, type, value, min_order, is_active) VALUES (?,?,?,?,?,?,?)`,
      burger, 'برجر كلاسيك بخصم 10%', 'لأول طلب', 'percent', 10, 0, 1);
  }

  // ---------- كوبون ----------
  if (!q.get("SELECT id FROM coupons LIMIT 1"))
    q.run("INSERT INTO coupons (code, restaurant_id, type, value, min_order, is_active) VALUES (?,?,?,?,?,?)", 'WELCOME10', shawarma, 'percent', 10, 3000, 1);

  // ---------- كباتن ----------
  const mkCaptain = (name, phone, pw, vehicle) => {
    if (!q.get("SELECT id FROM captains WHERE phone=?", phone))
      q.run("INSERT INTO captains (name, phone, password_hash, vehicle_type, city, status) VALUES (?,?,?,?,?,?)", name, phone, H(pw), vehicle, 'الرياض', 'available');
  };
  mkCaptain('أحمد السالم', '0561111111', 'captain123', 'دراجة');
  mkCaptain('خالد العمري', '0562222222', 'captain123', 'سيارة');
  mkCaptain('سعد القحطاني', '0563333333', 'captain123', 'دراجة');

  // ---------- عميل تجريبي بعنوان وطني ----------
  let cust = q.get("SELECT id FROM customers WHERE phone='+966500000001'");
  if (!cust) {
    const c = q.run("INSERT INTO customers (phone, name, tier, points_balance, total_orders) VALUES (?,?,?,?,?)", '+966500000001', 'محمد العتيبي', 'برونزي', 0, 0);
    cust = { id: Number(c.lastInsertRowid) };
    q.run(`INSERT INTO customer_locations (customer_id, label, national_address, lat, lng, is_default) VALUES (?,?,?,?,?,?)`,
      cust.id, 'المنزل', 'الرياض، حي النرجس، طريق الملك عبدالعزيز، مبنى 1234', 24.8103, 46.6903, 1);
  }

  // ---------- إعلان ----------
  if (!q.get("SELECT id FROM ads_campaigns LIMIT 1"))
    q.run("INSERT INTO ads_campaigns (title, restaurant_id, placement, budget, is_active) VALUES (?,?,?,?,?)", 'جرب بيتزا نابولي — عرض 25%', pizza, 'whatsapp', 50000, 1);

  console.log('✅ البيانات التجريبية جاهزة');
  console.log('   أدمن:    admin@wassal.app / admin123');
  console.log('   مطعم 1:  0551000001 / rest1   (شاورما الضيافة)');
  console.log('   مطعم 2:  0551000002 / rest2   (بيتزا نابولي)');
  console.log('   كباتن:   0561111111 / captain123  (و 0562222222، 0563333333)');
  console.log('   عميل تجريبي: 0500000001 (محمد العتيبي)');
});
