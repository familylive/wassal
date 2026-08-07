import axios from 'axios';
import config from '../config.js';
import { q } from '../db.js';

// ---------- Moyasar (Apple Pay / Mada / Credit Card) ----------
async function createMoyasarPayment({ order, method, callbackUrl }) {
  const sourceType = method === 'applepay' ? 'applepay' : method === 'mada' ? 'mada' : 'creditcard';
  const body = {
    amount: order.total,
    currency: 'SAR',
    description: `طلب ${order.order_no} - ${order.restaurant_name || ''}`,
    callback_url: callbackUrl,
    source: { type: sourceType }
  };
  const auth = 'Basic ' + Buffer.from(config.moyasar.secretKey + ':').toString('base64');
  const r = await axios.post('https://api.moyasar.com/v1/invoices', body, { headers: { Authorization: auth } });
  return { gateway: 'moyasar', transaction_id: String(r.data.id), payment_url: r.data.url };
}

// ---------- create payment ----------
export async function createPayment(order, method, ctx = {}) {
  const mode = config.paymentMode;
  if (mode === 'moyasar' && config.moyasar.secretKey) {
    const res = await createMoyasarPayment({ order, method, callbackUrl: `${config.publicUrl}/api/payments/webhook/moyasar` });
    q.run("INSERT INTO payments (order_id, restaurant_id, phone, gateway, transaction_id, amount, status, method) VALUES (?,?,?,?,?,?,?,?)",
      order.id ?? null, ctx.restaurant_id||null, ctx.phone||null, res.gateway, res.transaction_id, order.total, 'pending', method);
    return { ...res, status: 'pending' };
  }
  // mock — auto-paid after 2.5s
  const p = q.run("INSERT INTO payments (order_id, restaurant_id, phone, gateway, transaction_id, amount, status, method) VALUES (?,?,?,?,?,?,?,?)",
    order.id ?? null, ctx.restaurant_id||null, ctx.phone||null, 'mock', 'mock_' + Date.now(), order.total, 'pending', method);
  const pid = p.lastInsertRowid;
  setTimeout(() => markPaid(pid), 2500);
  return { gateway: 'mock', payment_id: pid, status: 'pending', payment_url: null };
}

export function getPaymentByTxn(txnId) {
  return q.get("SELECT * FROM payments WHERE transaction_id=? ORDER BY id DESC LIMIT 1", txnId);
}
export function markPaid(paymentId) {
  const p = q.get("SELECT * FROM payments WHERE id = ?", paymentId);
  if (!p || p.status === 'paid') return p;
  q.run("UPDATE payments SET status='paid' WHERE id = ?", paymentId);
  if (p.order_id) {
    q.run("UPDATE orders SET payment_status='paid', updated_at=datetime('now') WHERE id = ?", p.order_id);
  }
  return { ...p, status: 'paid' };
}

export function payByOrderId(orderId) {
  const p = q.get("SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1", orderId);
  if (p && p.status === 'pending') return markPaid(p.id);
  return p;
}
