import jwt from 'jsonwebtoken';
import config from '../config.js';
import { q } from '../db.js';

export function signToken(user) {
  return jwt.sign(user, config.jwtSecret, { expiresIn: '30d' });
}

export function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try { req.user = jwt.verify(token, config.jwtSecret); next(); }
  catch { return res.status(401).json({ error: 'انتهت الجلسة' }); }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'لا تملك صلاحية' });
    next();
  };
}
