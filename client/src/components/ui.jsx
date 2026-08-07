import React from 'react';
import { sar, statusAr, payAr } from '../api.js';

export const Card = ({ title, children, action }) => (
  <div className="card">
    {title && <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
      <b style={{ fontSize: 15 }}>{title}</b>{action}</div>}
    {children}
  </div>
);

export const Stat = ({ n, l, color }) => <div className="stat"><div className="n" style={{ color: color || 'var(--green2)' }}>{n}</div><div className="l">{l}</div></div>;

export const Badge = ({ s }) => {
  const map = { delivered: 'b-green', cancelled: 'b-red', new: 'b-blue', offered: 'b-amber', accepted: 'b-purple', transferred: 'b-purple', arrived: 'b-amber', on_the_way: 'b-blue', preparing: 'b-amber', ready: 'b-green', confirmed: 'b-blue', with_captain: 'b-purple' };
  return <span className={`badge ${map[s] || 'b-gray'}`}>{statusAr[s] || s}</span>;
};

export const Pay = ({ m }) => <span className="badge b-gray">{payAr[m] || m}</span>;

export const Modal = ({ title, onClose, children, wide }) => (
  <div className="modal" onClick={onClose}>
    <div className="box" style={{ width: wide ? 'min(760px,94vw)' : undefined }} onClick={e => e.stopPropagation()}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h3>{title}</h3><button className="btn ghost sm" onClick={onClose}>✕</button>
      </div>
      {children}
    </div>
  </div>
);

export const Fld = ({ label, children }) => <div className="fld"><label>{label}</label>{children}</div>;

export const Money = ({ h }) => <b>{sar(h)} ر.س</b>;

export const OrdersTable = ({ orders, onOpen, showRestaurant }) => (
  <table>
    <thead><tr>
      <th>الطلب</th><th>العميل</th>{showRestaurant && <th>المطعم</th>}<th>الإجمالي</th><th>الدفع</th><th>الحالة</th><th>الوقت</th>
    </tr></thead>
    <tbody>
      {orders.map(o => (
        <tr key={o.id} onClick={() => onOpen(o)} style={{ cursor: 'pointer' }}>
          <td><b>{o.order_no}</b></td>
          <td>{o.customer_name || '-'}</td>
          {showRestaurant && <td>{o.restaurant_name}</td>}
          <td><Money h={o.total} /></td>
          <td><Pay m={o.payment_method} /></td>
          <td><Badge s={o.status} /></td>
          <td style={{ color: 'var(--mut)', fontSize: 12 }}>{o.created_at?.slice(0, 16)}</td>
        </tr>
      ))}
      {!orders.length && <tr><td colSpan={7} className="empty">لا توجد طلبات</td></tr>}
    </tbody>
  </table>
);

export const StatusButtons = ({ order, onStatus, busy }) => {
  const next = {
    new: ['confirmed'], confirmed: ['preparing'], preparing: ['ready'],
    with_captain: ['on_the_way'], on_the_way: ['arrived'], arrived: ['delivered']
  };
  const opts = next[order.status] || [];
  if (!opts.length) return null;
  return <div className="row">
    {opts.map(s => <button key={s} className="btn sm" disabled={busy} onClick={() => onStatus(s)}>{statusAr[s]}</button>)}
  </div>;
};
