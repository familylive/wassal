-- منصة وصل — SQLite schema (money in HALALAS: 1 SAR = 100)

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  logo TEXT,
  cover TEXT,
  phone TEXT,
  whatsapp_number TEXT,
  city TEXT,
  address TEXT,
  lat REAL,
  lng REAL,
  delivery_fee INTEGER DEFAULT 1000,
  min_order INTEGER DEFAULT 3000,
  avg_prep_time_min INTEGER DEFAULT 25,
  is_active INTEGER DEFAULT 1,
  rating_avg REAL DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  orders_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS restaurant_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  branch_id INTEGER REFERENCES branches(id),
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'owner',
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  image TEXT,
  is_available INTEGER DEFAULT 1,
  is_popular INTEGER DEFAULT 0,
  prep_time_min INTEGER DEFAULT 15,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT DEFAULT 'percent',
  value INTEGER DEFAULT 0,
  min_order INTEGER DEFAULT 0,
  bundle_item_ids TEXT,
  starts_at TEXT,
  ends_at TEXT,
  is_active INTEGER DEFAULT 1,
  image TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ads_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE SET NULL,
  image TEXT,
  placement TEXT DEFAULT 'home',
  starts_at TEXT,
  ends_at TEXT,
  budget INTEGER DEFAULT 0,
  spent INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  tier TEXT DEFAULT 'برونزي',
  points_balance INTEGER DEFAULT 0,
  total_points_earned INTEGER DEFAULT 0,
  total_orders INTEGER DEFAULT 0,
  total_spent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customer_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label TEXT DEFAULT 'المنزل',
  national_address TEXT,
  lat REAL,
  lng REAL,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS captains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  email TEXT,
  password_hash TEXT NOT NULL,
  vehicle_type TEXT DEFAULT 'دراجة',
  vehicle_plate TEXT,
  city TEXT,
  lat REAL,
  lng REAL,
  status TEXT DEFAULT 'offline',
  rating_avg REAL DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  deliveries_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  customer_id INTEGER REFERENCES customers(id),
  captain_id INTEGER REFERENCES captains(id),
  items_json TEXT NOT NULL,
  subtotal INTEGER DEFAULT 0,
  discount INTEGER DEFAULT 0,
  delivery_fee INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  payment_method TEXT DEFAULT 'card',
  payment_status TEXT DEFAULT 'pending',
  status TEXT DEFAULT 'new',
  address_label TEXT,
  national_address TEXT,
  lat REAL,
  lng REAL,
  est_delivery_min INTEGER DEFAULT 30,
  branch_id INTEGER,
  branch_name TEXT,
  delivery_code TEXT,
  cancel_reason TEXT,
  cancel_note TEXT,
  cancel_requested_at TEXT,
  notes TEXT,
  rating_restaurant INTEGER,
  rating_speed INTEGER,
  rating_captain INTEGER,
  rating_comment TEXT,
  arrived_at TEXT,
  delivered_at TEXT,
  rated_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  message TEXT,
  actor_type TEXT,
  actor_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  phone TEXT,
  participant_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  channel TEXT DEFAULT 'whatsapp',
  message_type TEXT DEFAULT 'text',
  body TEXT,
  payload_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS captain_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  captain_id INTEGER NOT NULL REFERENCES captains(id),
  status TEXT DEFAULT 'offered',
  offered_at TEXT DEFAULT (datetime('now')),
  responded_at TEXT,
  transferred_at TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id),
  restaurant_id INTEGER,
  phone TEXT,
  gateway TEXT DEFAULT 'mock',
  transaction_id TEXT,
  amount INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  method TEXT DEFAULT 'card',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loyalty_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  points_per_riyal INTEGER DEFAULT 1,
  redeem_points_per_riyal INTEGER DEFAULT 100,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS loyalty_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  min_points INTEGER DEFAULT 0,
  discount_pct INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id),
  points INTEGER NOT NULL,
  type TEXT DEFAULT 'earn',
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
  type TEXT DEFAULT 'percent',
  value INTEGER DEFAULT 0,
  min_order INTEGER DEFAULT 0,
  max_uses INTEGER DEFAULT 0,
  uses INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  phone TEXT PRIMARY KEY,
  restaurant_id INTEGER DEFAULT 0,
  state TEXT DEFAULT 'idle',
  data_json TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- الفروع ونطاق التوصيل (الزوم)
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  city TEXT,
  address TEXT,
  lat REAL,
  lng REAL,
  delivery_radius_km REAL DEFAULT 15,
  delivery_fee INTEGER DEFAULT 1000,
  min_order INTEGER DEFAULT 3000,
  phone TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
