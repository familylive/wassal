const TOKEN_KEY = 'wh_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const t = getToken();
  if (t) headers.Authorization = 'Bearer ' + t;
  const r = await fetch('/api' + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status === 401) { clearToken(); location.href = '/'; throw new Error('انتهت الجلسة'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'خطأ في الطلب');
  return data;
}
export const sar = (h) => (h / 100).toFixed(2);
export const statusAr = { new: '🆕 جديد', confirmed: '✔️ مؤكد', preparing: '👨‍🍳 تحضير', ready: '📦 جاهز', offered: '📢 عرض على كباتن', accepted: '🤝 كابتن قبل', transferred: '🛵 حوّل لكابتن', with_captain: '🛵 مع الكابتن', on_the_way: '🚀 في الطريق', arrived: '📍 وصل', delivered: '🎉 تم التسليم', cancelled: '❌ ملغي' };
export const payAr = { applepay: '🍎 Apple Pay', mada: '💳 مدى', card: '💳 بطاقة', cash: '💵 كاش', wallet: '👛 محفظة' };
