import { Router } from 'express';
import config from '../config.js';
import { q } from '../db.js';
import { markPaid, getPaymentByTxn } from '../services/payments.js';
import { onPaymentSuccess } from '../services/flow.js';

const router = Router();

// ويب هوك مويصر — تأكيد الدفع
router.post('/webhook/moyasar', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body || {};
    const invoice = body.data?.invoice || body.invoice || {};
    const id = invoice.id || body.id;
    const status = invoice.status || body.status;
    if (status === 'paid' && id) {
      const pay = getPaymentByTxn(id);
      if (pay) {
        markPaid(pay.id);
        if (pay.order_id) {
          q.run("UPDATE orders SET payment_status='paid' WHERE id=?", pay.order_id);
        } else if (pay.phone) {
          const rid = pay.restaurant_id;
          if (rid) await onPaymentSuccess(pay.phone, rid);
        }
      }
    }
  } catch (e) { console.error('moyasar webhook', e.message); }
});

// حالة دفع (للواجهة)
router.get('/order/:orderId', (req, res) => {
  const p = q.get("SELECT * FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1", req.params.orderId);
  res.json(p || { status: 'none' });
});

export default router;
