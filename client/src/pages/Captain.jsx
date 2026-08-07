import React, { useEffect, useState } from 'react';
import { api, sar } from '../api.js';
import { useApp, notify } from '../App.jsx';
import { Card, Stat, Modal, Badge, Money, Pay } from '../components/ui.jsx';

const TABS = ['dashboard', 'orders', 'chats'];
const TAB_AR = { dashboard: '📊 الوضع', orders: '📦 طلباتي', chats: '💬 المحادثات' };

export default function Captain() {
  const { user, socket, logout, notify } = useApp();
  const [tab, setTab] = useState('dashboard');
  const [me, setMe] = useState(null);
  const [offers, setOffers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [sel, setSel] = useState(null);
  const cid = user.captain_id;

  const load = async () => {
    try {
      const [m, o, os] = await Promise.all([
        api('/captains/' + cid), api('/captains/' + cid + '/offers'), api('/orders')
      ]);
      setMe(Array.isArray(m) ? m[0] : m); setOffers(o); setOrders(os);
    } catch (e) {}
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!socket) return;
    const f = () => { load(); notify('🔔 تحديث'); };
    socket.on('order:offer', f); socket.on('order:assigned', f); socket.on('order:update', f);
    return () => { socket.off('order:offer', f); socket.off('order:assigned', f); socket.off('order:update', f); };
  }, [socket]);

  const setStatus = async (status) => {
    await api('/captains/' + cid + '/status', { method: 'POST', body: { status } });
    setMe({ ...me, status }); notify('تم تحديث الحالة');
  };

  return (
    <>
      <div className="sidebar">
        <div className="logo"><img src="/logo.png" alt="" style={{ width: 54, height: 54, borderRadius: '50%', verticalAlign: 'middle', marginLeft: 8 }} />واتس هم<small>لوحة الكابتن — {user.name}</small></div>
        <nav>{TABS.map(t => <a key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{TAB_AR[t]}</a>)}</nav>
        <div className="foot">
          <div style={{ marginBottom: 10 }} className="row">
            <button className={`btn sm ${me?.status === 'available' ? '' : 'ghost'}`} style={me?.status === 'available' ? { background: 'var(--green3)', color: '#063' } : {}} onClick={() => setStatus('available')}>🟢 متاح</button>
            <button className={`btn sm ${me?.status === 'busy' ? '' : 'ghost'}`} onClick={() => setStatus('busy')}>🟠 مشغول</button>
            <button className={`btn sm ${me?.status === 'offline' ? '' : 'ghost'}`} onClick={() => setStatus('offline')}>⚪ غير متصل</button>
          </div>
        </div>
      </div>
      <div className="main">
        <div className="topbar"><h2>{TAB_AR[tab]}</h2>
          <div className="row">
            <span className="chip">⭐ {me?.rating_avg ? me.rating_avg : 'جديد'}</span>
            <span className="chip">🚚 {me?.deliveries_count || 0} توصيلة</span>
            <button className="btn red sm" onClick={logout}>🚪 خروج</button>
          </div>
        </div>
        {tab === 'dashboard' && <Dash offers={offers} orders={orders} me={me} onOffer={async (oid) => {
          await api(`/captains/offers/${oid}/respond`, { method: 'POST', body: { action: 'accept' } }); load(); notify('تم قبول الطلب — المطعم سيحوّله عليك ✅'); }} onOpen={setSel} />}
        {tab === 'orders' && <Card title="طلباتي"><table><thead><tr><th>الطلب</th><th>المطعم</th><th>الإجمالي</th><th>الحالة</th><th></th></tr></thead>
          <tbody>{orders.map(o => <tr key={o.id}><td><b>{o.order_no}</b></td><td>{o.restaurant_name}</td><td><Money h={o.total} /></td><td><Badge s={o.status} /></td><td><button className="btn ghost sm" onClick={() => setSel(o)}>فتح</button></td></tr>)}</tbody></table></Card>}
        {tab === 'chats' && <ChatsTab cid={cid} />}
        {sel && <OrderModal o={sel} onClose={() => setSel(null)} refresh={load} cid={cid} />}
      </div>
      <button className="btn red logout-float" onClick={logout}>🚪 تسجيل الخروج</button>
    </>
  );
}

function Dash({ offers, orders, me, onOffer, onOpen }) {
  const active = orders.filter(o => !['delivered', 'cancelled'].includes(o.status));
  return (
    <>
      <div className="kpi">
        <Stat n={me?.status === 'available' ? 'متاح 🟢' : me?.status === 'busy' ? 'مشغول 🟠' : 'غير متصل ⚪'} l="حالتك الحالية" />
        <Stat n={offers.length} l="طلبات متاحة الآن" color="#ef6c00" />
        <Stat n={active.length} l="طلبات نشطة لديك" color="#1565c0" />
        <Stat n={me?.deliveries_count || 0} l="إجمالي التوصيلات" color="#0b7a3b" />
      </div>
      <Card title="🛵 طلبات متاحة للتوصيل (تُرسل لكل الكباتن المتاحين)">
        {offers.map(o => (
          <div key={o.id} className="row" style={{ justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
            <div><b>{o.order_no}</b> — {o.restaurant}<br /><small style={{ color: 'var(--mut)' }}>📍 {o.national_address || 'بدون عنوان'} · 💰 {sar(o.total)} ر.س · 🕐 {o.est} د</small></div>
            <div className="row">
              <button className="btn" onClick={() => onOffer(o.id)}>قبول الطلب ✅</button>
              <button className="btn ghost sm" onClick={async () => { await api(`/captains/offers/${o.id}/respond`, { method: 'POST', body: { action: 'reject' } }); window.location.reload(); }}>رفض</button>
            </div>
          </div>
        ))}
        {!offers.length && <div className="empty">لا توجد طلبات متاحة حالياً — ستسمع تنبيهاً فور وصول طلب جديد 🛎</div>}
      </Card>
      {active.length > 0 && <Card title="🟢 طلباتي النشطة">
        {active.map(o => (
          <div key={o.id} className="row" style={{ justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
            <div><b>{o.order_no}</b> — {o.restaurant_name}<br /><small style={{ color: 'var(--mut)' }}>{o.national_address || ''}</small></div>
            <div className="row"><Badge s={o.status} /><button className="btn ghost sm" onClick={() => onOpen(o)}>إدارة</button></div>
          </div>
        ))}
      </Card>}
    </>
  );
}

function ChatsTab({ cid }) {
  const [rows, setRows] = useState([]);
  useEffect(() => { api('/captains/' + cid + '/conversations').then(setRows); }, []);
  const [open, setOpen] = useState(null);
  const byOrder = {};
  rows.forEach(m => { const k = m.order_no || 'عام'; (byOrder[k] = byOrder[k] || []).push(m); });
  return (
    <Card title={`جميع المحادثات المحفوظة في حسابك (${rows.length} رسالة)`}>
      <p style={{ fontSize: 13, color: 'var(--mut)', marginBottom: 12 }}>كل المحادثات من بداية الطلب حتى التقيم — محفوظة تلقائياً في حسابك بالكنترول.</p>
      {Object.entries(byOrder).slice(0, 10).map(([k, msgs]) => (
        <div key={k} style={{ marginBottom: 10 }}>
          <b style={{ fontSize: 13.5 }}>{k}</b>
          <div className="msg-bubble" style={{ maxHeight: 150, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10, padding: 8 }}>
            {msgs.slice(-12).map(m => (
              <div key={m.id} className={`m ${m.direction === 'in' ? 'in' : 'out'}`}>
                {m.body || `[${m.message_type}]`}<small>{m.created_at}</small>
              </div>
            ))}
          </div>
        </div>
      ))}
      {!rows.length && <div className="empty">لا توجد محادثات بعد</div>}
    </Card>
  );
}

function OrderModal({ o, onClose, refresh, cid }) {
  const { notify } = useApp();
  const [d, setD] = useState(null);
  const [code, setCode] = useState('');
  useEffect(() => { api('/orders/' + o.id).then(setD); }, [o.id]);
  if (!d) return <Modal title={o.order_no} onClose={onClose}><div className="empty">…</div></Modal>;
  const act = async (status) => { try { await api('/orders/' + d.id + '/status', { method: 'POST', body: { status } }); refresh(); setD(await api('/orders/' + d.id)); } catch (e) { notify(e.message); } };
  return (
    <Modal title={`${d.order_no} — ${d.restaurant_name}`} onClose={onClose} wide>
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <Badge s={d.status} /> <Pay m={d.payment_method} />
        {d.payment_status === 'paid' ? <span className="badge b-green">مدفوع ✅</span> : <span className="badge b-amber">غير مدفوع</span>}
        <Money h={d.total} /><span className="chip">🏪 {d.branch_name}</span>
      </div>
      <div className="grid g2">
        <div>
          <h4 style={{ marginBottom: 8 }}>🧾 الأصناف</h4>
          {(d.items || []).map((i, k) => <div key={k} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}><span>{i.name} ×{i.quantity}</span><span>{sar(i.price * i.quantity)} ر.س</span></div>)}
          <h4 style={{ margin: '12px 0 8px' }}>📍 التوصيل إلى</h4>
          <div style={{ fontSize: 13.5 }}>{d.national_address || `${d.lat},${d.lng}`}<br />العميل: {d.customer?.name} — {d.customer?.phone}<br />الوقت التقريبي: {d.est_delivery_min} د</div>
        </div>
        <div>
          <h4 style={{ marginBottom: 8 }}>🕐 مسار الطلب</h4>
          <div className="timeline">{(d.events || []).map(e => <div key={e.id} className="ev"><div className="dot" /><div><p>{e.message}</p><small>{e.created_at}</small></div></div>)}</div>
        </div>
      </div>
      <div className="row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
        {d.status === 'transferred' && <button className="btn" onClick={() => act('with_captain')}>🛵 استلمت الطلب من المطعم</button>}
        {d.status === 'with_captain' && <button className="btn" onClick={() => act('on_the_way')}>🚀 انطلقت للتوصيل</button>}
        {d.status === 'on_the_way' && <button className="btn" style={{ background: 'var(--green3)', color: '#063' }} onClick={() => act('arrived')}>📍 وصلت — أبلغ العميل</button>}
        {['transferred', 'with_captain', 'on_the_way', 'arrived'].includes(d.status) && (
          <div className="row" style={{ background: '#fffbe6', border: '1px solid #f5d76e', borderRadius: 10, padding: 10, width: '100%' }}>
            <span style={{ fontSize: 13 }}>🔐 اطلب من العميل <b>رمز الاستلام</b> وأرسله هنا لإغلاق الطلب:</span>
            <input style={{ width: 130 }} placeholder="رمز 6 أرقام" value={code} onChange={e => setCode(e.target.value)} />
            <button className="btn" onClick={async () => {
              try { await api('/whatsapp/close-order', { method: 'POST', body: { order_id: d.id, code, captain_id: cid } }); notify('✅ تم إغلاق الطلب برمز الاستلام'); refresh(); setD(await api('/orders/' + d.id)); }
              catch (e) { notify(e.message); }
            }}>إغلاق الطلب 🔐</button>
            {d.status === 'arrived' && <button className="btn ghost" onClick={() => act('delivered')}>أو إغلاق يدوي</button>}
          </div>
        )}
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--mut)', marginTop: 10 }}>💡 عند الضغط على "وصلت" يصل العميل إشعار واتساب: "📍 وصل كابتن التوصيل! طلبك عند الباب" ثم يُطلب منه تقييمك.</p>
    </Modal>
  );
}
