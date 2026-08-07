import { q } from '../db.js';

export function ensureDefaultBranch(restaurantId) {
  const r = q.get("SELECT * FROM restaurants WHERE id=?", restaurantId);
  if (!r) return null;
  const exists = q.get("SELECT id FROM branches WHERE restaurant_id=?", restaurantId);
  if (exists) return exists;
  const ins = q.run(`INSERT INTO branches (restaurant_id, name, city, address, lat, lng, delivery_radius_km, delivery_fee, min_order, phone)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    restaurantId, 'الفرع الرئيسي', r.city || null, r.address || null, r.lat || null, r.lng || null, 15, r.delivery_fee || 1000, r.min_order || 3000, r.phone || null);
  return q.get("SELECT * FROM branches WHERE id=?", Number(ins.lastInsertRowid));
}

// مسافة هافرسين (كم)
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// أقرب فرع + هل الموقع داخل نطاق التوصيل؟
export function resolveDelivery(restaurantId, lat, lng) {
  const branches = q.all("SELECT * FROM branches WHERE restaurant_id=? AND is_active=1", restaurantId);
  if (!branches.length) return { ok: false, reason: 'no_branches' };
  let best = null;
  for (const b of branches) {
    if (b.lat == null || b.lng == null) continue;
    const d = haversineKm(lat, lng, b.lat, b.lng);
    if (!best || d < best.distanceKm) best = { branch: b, distanceKm: d };
  }
  if (!best) return { ok: false, reason: 'no_coords' };
  const radius = best.branch.delivery_radius_km || 15;
  return { ok: best.distanceKm <= radius, reason: best.distanceKm <= radius ? 'in_range' : 'out_of_range', ...best };
}
