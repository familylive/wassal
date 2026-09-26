// 🛡️ محدّد معدل بسيط في الذاكرة (بلا مكتبات خارجية)
const buckets = new Map();

function makeLimiter({ windowMs, max, key, label }) {
  return (req, res, next) => {
    try {
      const id = (typeof key === 'function' ? key(req) : (req.ip || req.headers['x-forwarded-for'] || 'unknown')) + ':' + label;
      const now = Date.now();
      let b = buckets.get(id);
      if (!b || now - b.start > windowMs) { b = { start: now, count: 0 }; buckets.set(id, b); }
      b.count += 1;
      if (b.count > max) {
        const retry = Math.ceil((windowMs - (now - b.start)) / 1000);
        res.set('Retry-After', String(retry));
        return res.status(429).json({ error: `محاولات كثيرة — جرّب بعد ${retry} ثانية` });
      }
      if (buckets.size > 5000) {   // تنظيف دوري
        for (const [k, v] of buckets) if (now - v.start > windowMs) buckets.delete(k);
      }
      next();
    } catch (e) { next(); }
  };
}

// تسجيل الدخول: 10 محاولات كل 10 دقائق
export const loginLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 20, label: 'login' });
// الويب هوك: 240 طلباً في الدقيقة (ميتا تدفع دفعات)
export const webhookLimiter = makeLimiter({ windowMs: 60 * 1000, max: 240, label: 'webhook' });
// عام لأي مسار حساس
export const apiLimiter = makeLimiter({ windowMs: 60 * 1000, max: 300, label: 'api' });
