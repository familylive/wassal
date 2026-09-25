import React, { useEffect, useState } from 'react';
import { api, sar, statusAr, getToken } from '../api.js';
import { useApp, notify } from '../App.jsx';
import { Card, Stat, Modal, Fld, Badge, Money, Pay } from '../components/ui.jsx';

const TABS = ['dashboard', 'restaurants', 'captains', 'customers', 'ads', 'loyalty', 'chats', 'regs', 'reports', 'types', 'settings'];
const TAB_AR = { dashboard: '📊 لوحة القيادة', restaurants: '🍽 المطاعم', captains: '🛵 الكباتن', customers: '👥 العملاء', ads: '📣 الإعلانات', loyalty: '⭐ الولاء', chats: '💬 المحادثات', regs: '📝 طلبات التسجيل', reports: '📊 تقارير المبيعات', types: '🏷 أنواع الأنشطة', settings: '⚙️ إعدادات واتساب' };

export default function Admin() {
  const { user, socket, logout, notify } = useApp();
  const [tab, setTab] = useState('dashboard');
  const [stats, setStats] = useState(null);
  const [restaurants, setRestaurants] = useState([]);
  const [captains, setCaptains] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [ads, setAds] = useState([]);
  const [orders, setOrders] = useState([]);
  const [sel, setSel] = useState(null);
  const [menuOpen, setMenuOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth > 900);

  const load = async () => {
    try {
      const [s, r, c, cu, a, o] = await Promise.all([
        api('/stats/admin'), api('/restaurants'), api('/captains'), api('/customers'), api('/ads'), api('/orders')
      ]);
      setStats(s); setRestaurants(r); setCaptains(c); setCustomers(cu); setAds(a); setOrders(o);
    } catch (e) { notify(e.message); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!socket) return;
    const f = () => load();
    socket.on('order:new', f); socket.on('order:update', f); socket.on('order:delivered', f);
    return () => { socket.off('order:new', f); socket.off('order:update', f); socket.off('order:delivered', f); };
  }, [socket]);

  const Side = () => (
    <div className={`sidebar ${menuOpen ? 'open' : 'closed'}`}>
      <div className="logo"><img src="/logo.png" alt="" style={{ width: 54, height: 54, borderRadius: '50%', verticalAlign: 'middle', marginLeft: 8 }} />واتس هم<small>لوحة التحكم</small></div>
      <nav>{TABS.map(t => <a key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{TAB_AR[t]}</a>)}</nav>
      <div className="foot" style={{ fontSize: 13 }}>{user.name}</div>
    </div>
  );

  return (
    <>
      <Side />
      <div className={`main ${menuOpen ? '' : 'expanded'}`}>
        <div className="topbar">
          <div className="row"><button className="menu-btn" onClick={() => setMenuOpen(!menuOpen)}>☰</button><h2>{TAB_AR[tab]}</h2></div>
          <a href="/sim" target="_blank"><button className="btn ghost sm">🧪 محاكي واتساب</button></a>
        </div>
        {menuOpen && <div className="backdrop" onClick={() => setMenuOpen(false)} />}
        <button className="btn red logout-float" onClick={logout}>🚪 تسجيل الخروج</button>
        {tab === 'dashboard' && <Dashboard stats={stats} orders={orders} captains={captains} onOpen={setSel} onChange={load} />}
        {tab === 'restaurants' && <RestTab data={restaurants} onChange={load} />}
        {tab === 'captains' && <CaptainsTab data={captains} onChange={load} />}
        {tab === 'customers' && <CustomersTab data={customers} />}
        {tab === 'ads' && <AdsTab data={ads} onChange={load} />}
        {tab === 'loyalty' && <LoyaltyTab />}
        {tab === 'chats' && <ChatsTab restaurants={restaurants} />}
        {tab === 'regs' && <RegistrationsTab />}
        {tab === 'reports' && <ReportsTab />}
        {tab === 'types' && <TypesTab />}
        {tab === 'settings' && <SettingsTab />}
        {sel && <OrderModal o={sel} onClose={() => setSel(null)} refresh={load} />}
      </div>
    </>
  );
}

function AssignCaptain({ order, captains, onChange }) {
  const { notify } = useApp();
  const [cid, setCid] = useState(order.captain_id || '');
  const [busy, setBusy] = useState(false);
  const open = ['new', 'confirmed', 'preparing', 'ready', 'offered', 'accepted'].includes(order.status);
  if (!open) return null;
  const go = async () => {
    if (!cid) return notify('اختر كابتن');
    setBusy(true);
    try { await api(`/orders/${order.id}/assign`, { method: 'POST', body: { captain_id: Number(cid) } }); notify('✅ تم تحويل الطلب للكابتن'); onChange(); }
    catch (e) { notify(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="row" style={{ gap: 4 }}>
      <select value={cid} onChange={e => setCid(e.target.value)} style={{ maxWidth: 130, fontSize: 12 }}>
        <option value="">— كابتن —</option>
        {captains.map(c => <option key={c.id} value={c.id}>{c.name}{c.status === 'available' ? ' ✅' : ''}</option>)}
      </select>
      <button className="btn sm" disabled={busy} onClick={go} title="حوّل الطلب لهذا الكابتن">🚀</button>
    </div>
  );
}

function Dashboard({ stats, orders, captains = [], onOpen, onChange }) {
  if (!stats) return <div className="empty">تحميل…</div>;
  return (
    <>
      <div className="kpi">
        <Stat n={stats.counts.restaurants} l="مطاعم" />
        <Stat n={stats.counts.captains} l="كباتن" color="#8e24aa" />
        <Stat n={stats.counts.customers} l="عملاء" color="#1565c0" />
        <Stat n={stats.counts.availableCaptains} l="كباتن متاحين الآن" color="#0b7a3b" />
        <Stat n={stats.today.orders} l="طلبات اليوم" color="#ef6c00" />
        <Stat n={sar(stats.today.revenue) + ' ر.س'} l="إيراد اليوم" color="#c62828" />
      </div>
      <div className="grid g2">
        <Card title="الطلبات المفتوحة">
          {stats.openOrders.map(o => (
            <div key={o.id} className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <div>
                <b>{o.order_no}</b> — {o.name_ar}{' '}
                {o.order_type === 'pickup'
                  ? <span className="badge b-amber">🏪 استلام</span>
                  : <span className="badge b-gray">🛵 توصيل</span>}
                <br /><small style={{ color: 'var(--mut)' }}>{o.created_at?.slice(0, 16)}</small>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <Badge s={o.status} />
                <AssignCaptain order={o} captains={captains} onChange={onChange} />
                <button className="btn ghost sm" onClick={() => onOpen(o)}>عرض</button>
              </div>
            </div>
          ))}
          {!stats.openOrders.length && <div className="empty">لا توجد طلبات مفتوحة</div>}
        </Card>
        <Card title="أفضل المطاعم (إيراد)">
          {stats.topRestaurants.map((r, i) => (
            <div key={i} className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <span>{i + 1}. {r.name_ar} <small style={{ color: 'var(--mut)' }}>({r.c} طلب)</small></span>
              <b>{sar(r.rev)} ر.س</b>
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}

function RestTab({ data, onChange }) {
  const [modal, setModal] = useState(null);
  const [open, setOpen] = useState(null);
  return (
    <Card title={`المطاعم (${data.length})`} action={<button className="btn sm" onClick={() => setModal({})}>➕ مطعم جديد</button>}>
      <table>
        <thead><tr><th>المطعم</th><th>المدينة</th><th>التوصيل</th><th>التقييم</th><th>الطلبات</th><th>الحالة</th><th>الاشتراك</th><th></th></tr></thead>
        <tbody>
          {data.map(r => (
            <tr key={r.id}>
              <td><b>{r.name_ar}</b><br /><small style={{ color: 'var(--mut)' }}>{r.phone}</small></td>
              <td>{r.city}</td><td>{sar(r.delivery_fee)} ر.س</td>
              <td>{r.rating_avg ? '⭐ ' + r.rating_avg : '-'}</td>
              <td>{r.delivered_count || r.orders_count || 0}</td>
              <td>{r.is_active ? <span className="badge b-green">نشط</span> : <span className="badge b-red">موقوف</span>}</td>
              <td>{r.subscription_paid
                ? <span className="badge b-green">✅ مدفوع</span>
                : <button className="btn ghost sm" onClick={async () => {
                    if (!window.confirm('تأكيد استلام اشتراك ' + r.name_ar + ' (١٠٠٠ ر.س)؟')) return;
                    try { await api('/restaurants/' + r.id + '/subscription', { method: 'POST', body: {} }); notify('✅ تم تسجيل الاشتراك'); onChange(); }
                    catch (e) { notify(e.message); }
                  }}>💳 استلمت</button>}</td>
              <td className="row"><button className="btn ghost sm" onClick={() => setOpen(r)}>إدارة</button><button className="btn red sm" onClick={async () => { if (confirm('حذف المطعم؟')) { await api('/restaurants/' + r.id, { method: 'DELETE' }); onChange(); } }}>🗑</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {modal && <RestForm r={modal.id ? data.find(x => x.id === modal.id) : null} onClose={() => setModal(null)} onSaved={() => { setModal(null); onChange(); }} />}
      {open && <RestManage r={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function RestForm({ r, onClose, onSaved }) {
  const [f, setF] = useState(r || { name_ar: '', city: 'الرياض', delivery_fee: 1000, min_order: 3000, avg_prep_time_min: 25 });
  const [types, setTypes] = useState([]);
  useEffect(() => { api('/business-types').then(d => setTypes(Array.isArray(d) ? d.filter(t => t.is_active || String(t.id) === String(f.business_type_id)) : [])).catch(() => {}); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    if (!f.name_ar) return notify('اسم المطعم مطلوب');
    if (r) { await api('/restaurants/' + r.id, { method: 'PUT', body: f }); }
    else {
      await api('/restaurants', { method: 'POST', body: f });
      await api('/auth/register-restaurant', { method: 'POST', body: { name_ar: f.name_ar, phone: f.phone, email: f.email, password: f.password || 'rest123' } });
    }
    onSaved();
  };
  return (
    <Modal title={r ? 'تعديل مطعم' : 'مطعم جديد'} onClose={onClose}>
      <div className="form-grid">
        <Fld label="اسم المطعم"><input value={f.name_ar} onChange={set('name_ar')} /></Fld>
        <Fld label="نوع النشاط">
          <select value={f.business_type_id || ''} onChange={e => setF({ ...f, business_type_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">— اختر النوع —</option>
            {types.map(t => <option key={t.id} value={t.id}>{t.icon} {t.name_ar}</option>)}
          </select>
        </Fld>
        <Fld label="المدينة"><input value={f.city} onChange={set('city')} /></Fld>
        <Fld label="الجوال"><input value={f.phone || ''} onChange={set('phone')} /></Fld>
        <Fld label="واتساب (رقم الطلبات)"><input value={f.whatsapp_number || ''} onChange={set('whatsapp_number')} /></Fld>
        <Fld label="رسوم التوصيل (هللة)"><input type="number" value={f.delivery_fee} onChange={set('delivery_fee')} /></Fld>
        <Fld label="الحد الأدنى (هللة)"><input type="number" value={f.min_order} onChange={set('min_order')} /></Fld>
        <Fld label="وقت التحضير (د)"><input type="number" value={f.avg_prep_time_min} onChange={set('avg_prep_time_min')} /></Fld>
        <Fld label="خط العرض"><input value={f.lat || ''} onChange={set('lat')} /></Fld>
        <Fld label="خط الطول"><input value={f.lng || ''} onChange={set('lng')} /></Fld>
      </div>
      <div className="row" style={{ marginTop: 16 }}><button className="btn" onClick={save}>حفظ</button><button className="btn ghost" onClick={onClose}>إلغاء</button></div>
    </Modal>
  );
}

function RestManage({ r, onClose }) {
  const [detail, setDetail] = useState(null);
  const [branchModal, setBranchModal] = useState(false);
  useEffect(() => { api('/restaurants/' + r.id).then(setDetail); }, [r.id]);
  if (!detail) return <Modal title={r.name_ar} onClose={onClose}><div className="empty">تحميل…</div></Modal>;
  return (
    <Modal title={`${r.name_ar} — الإدارة`} onClose={onClose} wide>
      <h4 style={{ margin: '10px 0 8px' }}>🏪 الفروع ونطاق التوصيل</h4>
      <table>
        <thead><tr><th>الفرع</th><th>الموقع</th><th>نطاق التوصيل</th><th>الرسوم</th></tr></thead>
        <tbody>
          {(detail.branches || []).map(b => (
            <tr key={b.id}><td><b>{b.name}</b></td><td>{b.city} — {b.address}</td><td>{b.delivery_radius_km} كم</td><td>{sar(b.delivery_fee)} ر.س</td></tr>
          ))}
        </tbody>
      </table>
      <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setBranchModal(true)}>➕ إضافة فرع</button>
      <h4 style={{ margin: '16px 0 8px' }}>📂 الأقسام والأصناف</h4>
      {(detail.menu || []).map(c => (
        <div key={c.id} style={{ marginBottom: 8 }}>
          <b>{c.icon} {c.name}</b>
          <div style={{ fontSize: 13, color: 'var(--mut)' }}>{c.items.map(i => `${i.name} (${sar(i.price)} ر.س)`).join(' · ') || 'لا أصناف'}</div>
        </div>
      ))}
      {branchModal && <BranchForm rid={r.id} onClose={() => setBranchModal(false)} onSaved={() => { setBranchModal(false); api('/restaurants/' + r.id).then(setDetail); }} />}
    </Modal>
  );
}

function BranchForm({ rid, onClose, onSaved }) {
  const [f, setF] = useState({ name: '', city: 'الرياض', lat: '', lng: '', delivery_radius_km: 15, delivery_fee: 1000 });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="فرع جديد" onClose={onClose}>
      <div className="form-grid">
        <Fld label="اسم الفرع"><input value={f.name} onChange={set('name')} /></Fld>
        <Fld label="المدينة"><input value={f.city} onChange={set('city')} /></Fld>
        <Fld label="خط العرض"><input value={f.lat} onChange={set('lat')} /></Fld>
        <Fld label="خط الطول"><input value={f.lng} onChange={set('lng')} /></Fld>
        <Fld label="نطاق التوصيل (كم)"><input type="number" value={f.delivery_radius_km} onChange={set('delivery_radius_km')} /></Fld>
        <Fld label="رسوم التوصيل (هللة)"><input type="number" value={f.delivery_fee} onChange={set('delivery_fee')} /></Fld>
      </div>
      <div className="row" style={{ marginTop: 14 }}><button className="btn" onClick={async () => { await api('/branches', { method: 'POST', body: { ...f, restaurant_id: rid, lat: f.lat ? Number(f.lat) : null, lng: f.lng ? Number(f.lng) : null } }); onSaved(); }}>حفظ</button></div>
    </Modal>
  );
}

function CaptainsTab({ data, onChange }) {
  const { notify } = useApp();
  const [modal, setModal] = useState(false);
  const setStatus = async (c, status) => {
    try { await api(`/captains/${c.id}/status`, { method: 'POST', body: { status } }); notify('✅ تم تحديث حالة الكابتن'); onChange(); }
    catch (e) { notify(e.message); }
  };
  const act = async (c, kind) => {
    const msg = kind === 'deposit'
      ? `تأكيد استلام تأمين الحساب (٥٠٠ ر.س) من ${c.name}؟`
      : `تسوية مبالغ ${c.name}؟\nالمبالغ: ${sar(c.wallet_cash || 0)} ر.س · الغرامات: ${sar(c.penalty_total || 0)} ر.س\n(تُصفَّر المبالغ وتُعاد تفعيله)`;
    if (!window.confirm(msg)) return;
    try {
      await api(`/captains/${c.id}/${kind}`, { method: 'POST', body: {} });
      notify(kind === 'deposit' ? '✅ تم تسجيل التأمين' : '✅ تمت التسوية وإعادة التفعيل');
      onChange();
    } catch (e) { notify(e.message); }
  };
  return (
    <Card title={`الكباتن (${data.length})`} action={<button className="btn sm" onClick={() => setModal(true)}>➕ كابتن جديد</button>}>
      <table>
        <thead><tr><th>الكابتن</th><th>الجوال</th><th>الهوية</th><th>المركبة</th><th>الحالة</th><th>التقييم</th><th>التوصيلات</th><th>الحساب</th><th>تحكم</th></tr></thead>
        <tbody>
          {data.map(c => (
            <tr key={c.id}>
              <td><b>{c.name}</b></td><td>{c.phone}</td><td>{c.national_id || '—'}</td><td>{c.vehicle_type} {c.vehicle_plate}</td>
              <td>{c.status === 'available' ? <span className="badge b-green">متاح</span> : c.status === 'busy' ? <span className="badge b-amber">مشغول</span> : <span className="badge b-gray">غير متصل</span>}</td>
              <td>{c.rating_count ? `⭐ ${c.rating_avg}/5 (${c.rating_count})` : <span className="badge b-gray">🆕 جديد</span>}</td><td>{c.deliveries_count}</td>
              <td>
                {c.blocked
                  ? <span className="badge b-red" title={c.blocked_reason || ''}>⛔ موقوف</span>
                  : (c.deposit_paid ? <span className="badge b-green">✅ تأمين مدفوع</span> : <span className="badge b-amber">⏳ بلا تأمين</span>)}
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                  💰 {sar(c.wallet_cash || 0)} ر.س{c.penalty_total ? ` · ⚠️ غرامات ${sar(c.penalty_total)}` : ''}
                </div>
              </td>
              <td>
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn ghost sm" disabled={c.status === 'available'} onClick={() => setStatus(c, 'available')}>✅ متاح</button>
                  <button className="btn ghost sm" disabled={c.status === 'busy'} onClick={() => setStatus(c, 'busy')}>⏳ مشغول</button>
                  <button className="btn ghost sm" disabled={c.status === 'offline'} onClick={() => setStatus(c, 'offline')}>⛔ إيقاف</button>
                </div>
                <div className="row" style={{ gap: 4, marginTop: 4 }}>
                  {!c.deposit_paid && <button className="btn ghost sm" onClick={() => act(c, 'deposit')} title="استلمت تأمين الحساب ٥٠٠ ر.س">💳 تأمين</button>}
                  {(c.wallet_cash || c.penalty_total) ? <button className="btn ghost sm" onClick={() => act(c, 'settle')} title="تسوية المبالغ المحصّلة وإعادة التفعيل">💵 تسوية</button> : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {modal && <CaptainForm onClose={() => setModal(false)} onSaved={() => { setModal(false); onChange(); }} />}
    </Card>
  );
}
function CaptainForm({ onClose, onSaved }) {
  const [f, setF] = useState({ name: '', phone: '', password: 'captain123', vehicle_type: 'دراجة' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="كابتن جديد" onClose={onClose}>
      <div className="form-grid">
        <Fld label="الاسم"><input value={f.name} onChange={set('name')} /></Fld>
        <Fld label="الجوال (بيانات الدخول)"><input value={f.phone} onChange={set('phone')} /></Fld>
        <Fld label="كلمة المرور"><input value={f.password} onChange={set('password')} /></Fld>
        <Fld label="المركبة"><input value={f.vehicle_type} onChange={set('vehicle_type')} /></Fld>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" onClick={async () => { try { await api('/auth/register-captain', { method: 'POST', body: f }); onSaved(); } catch (e) { notify(e.message); } }}>حفظ</button>
      </div>
    </Modal>
  );
}

function CustomersTab({ data }) {
  const [sel, setSel] = useState(null);
  return (
    <Card title={`العملاء (${data.length})`}>
      <table>
        <thead><tr><th>الاسم</th><th>الجوال</th><th>التقييم</th><th>المستوى</th><th>النقاط</th><th>الطلبات</th><th>الإنفاق</th></tr></thead>
        <tbody>
          {data.map(c => (
            <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => setSel(c)}>
              <td><b>{c.name || '—'}</b></td><td>{c.phone}</td>
              <td>{c.score?.isNew
                ? <span className="badge b-gray">🆕 جديد</span>
                : <span className={`badge ${c.score?.tier === 'excellent' || c.score?.tier === 'very_good' ? 'b-green' : c.score?.tier === 'weak' ? 'b-red' : 'b-amber'}`}
                    title={c.score?.advice}>{c.score?.label} · {c.score?.score}/1000</span>}</td>
              <td><span className="badge b-amber">{c.tier}</span></td>
              <td>{c.points_balance}</td><td>{c.total_orders}</td><td>{sar(c.total_spent)} ر.س</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sel && <CustomerModal c={sel} onClose={() => setSel(null)} />}
    </Card>
  );
}
function CustomerModal({ c, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => { api('/customers/' + c.id).then(setD); }, [c.id]);
  if (!d) return <Modal title={c.name || c.phone} onClose={onClose}><div className="empty">…</div></Modal>;
  return (
    <Modal title={`${c.name || 'عميل'} — ${c.phone}`} onClose={onClose} wide>
      <div className="kpi" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))' }}>
        <Stat n={d.points_balance} l="نقاط" /><Stat n={d.tier} l="المستوى" /><Stat n={d.total_orders} l="الطلبات" /><Stat n={sar(d.total_spent) + ' ر.س'} l="الإنفاق" />
      </div>
      <h4 style={{ margin: '10px 0 8px' }}>📍 العناوين المحفوظة</h4>
      {(d.locations || []).map(l => <div key={l.id} className="chip" style={{ margin: 4 }}>{l.is_default ? '⭐' : ''} {l.label}: {l.national_address || `${l.lat},${l.lng}`}</div>)}
      <h4 style={{ margin: '14px 0 8px' }}>📦 الطلبات</h4>
      {(d.orders || []).slice(0, 8).map(o => (
        <div key={o.id} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
          <span><b>{o.order_no}</b> — <Badge s={o.status} /></span><span>{sar(o.total)} ر.س</span>
        </div>
      ))}
    </Modal>
  );
}

function AdsTab({ data, onChange }) {
  const [modal, setModal] = useState(false);
  const [rests, setRests] = useState([]);
  const { notify } = useApp();
  const [reqs, setReqs] = useState([]);
  const loadReqs = () => api('/ad-requests').then(setReqs).catch(() => {});
  useEffect(() => { api('/restaurants').then(setRests).catch(() => {}); loadReqs(); }, []);
  const act = async (r, kind) => {
    try {
      if (kind === 'price') {
        const v = window.prompt('سعر الإعلان بالريال:', r.price ? String(r.price / 100) : '300');
        if (!v) return;
        await api(`/ad-requests/${r.id}/price`, { method: 'POST', body: { price: Number(v) } });
        notify('✅ تم إرسال السعر للنشاط للموافقة');
      } else if (kind === 'approve') {
        const d = await api(`/ad-requests/${r.id}/approve`, { method: 'POST', body: {} });
        notify(`✅ نُشر الإعلان لـ ${d.sent} عميل في ${d.city || 'المدينة'}`);
      } else {
        await api(`/ad-requests/${r.id}/reject`, { method: 'POST', body: {} });
        notify('❌ تم رفض الإعلان');
      }
      await loadReqs(); onChange?.();
    } catch (e) { notify(e.message); }
  };
  const statusAr = { requested: '⏳ بانتظار التسعير', priced: '💰 بانتظار موافقة النشاط', paid: '💳 مدفوع — بانتظار النص', content: '✍️ بانتظار النص', pending_approval: '🔎 بانتظار اعتمادك', approved: '✅ منشور', rejected: '❌ مرفوض', declined: '↩️ اعتذر' };
  const pend = reqs.filter(r => ['requested', 'priced', 'paid', 'content', 'pending_approval'].includes(r.status));
  const platform = reqs.filter(r => !r.restaurant_id).slice(0, 6);
  return (
    <>
    {platform.length > 0 && (
      <Card title="📣 إعلانات المنصة">
        <div style={{ fontSize: 13, color: 'var(--mut)', lineHeight: 1.9, marginBottom: 8 }}>
          تُنشَأ من جوالك: اكتب <b>«إعلان»</b> على واتساب → النص (أو صورة) → الجمهور (كل العملاء / مدينة) → يُنشر فوراً. وهنا تسجّل سعرها للدفتر.
        </div>
        {platform.map(r => (
          <div key={r.id} className="row" style={{ justifyContent: 'space-between', padding: '9px 2px', borderBottom: '1px solid var(--line)' }}>
            <div>
              <b>{r.image ? '📷 ' : ''}{r.content ? r.content.slice(0, 70) : '(بلا نص)'}</b>
              <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>
                {statusAr[r.status] || r.status} · 🏙 {r.city || 'كل العملاء'} · 📤 {r.sent_count || 0} عميل · 💵 {r.price ? sar(r.price) + ' ر.س' : 'بلا سعر'}
              </div>
            </div>
            <button className="btn ghost sm" onClick={() => act(r, 'price')}>💰 سجّل السعر</button>
          </div>
        ))}
      </Card>
    )}
    {pend.length > 0 && (
      <Card title={`📣 طلبات إعلانات (${pend.length})`}>
        <div style={{ fontSize: 13, color: 'var(--mut)', lineHeight: 1.9, marginBottom: 8 }}>
          النشاط يطلب من واتساب بكتابة <b>«إعلان»</b> → أنت تحدّد السعر → يوافق → يدفع → يكتب النص → تعتمده فيُنشر لعملاء مدينته فقط.
        </div>
        {pend.map(r => (
          <div key={r.id} style={{ padding: '10px 2px', borderBottom: '1px solid var(--line)' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <b>🏪 {r.restaurant_name || '-'}</b>
                <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>
                  {statusAr[r.status] || r.status} · 🏙 {r.city || '-'} ({r.cityCustomers} عميل) · 💵 {r.price ? sar(r.price) + ' ر.س' : 'بلا سعر'}
                </div>
                {r.content && <div style={{ fontSize: 13, marginTop: 4 }}>✍️ {r.content}</div>}
              </div>
              <div className="row" style={{ gap: 4 }}>
                {r.status === 'requested' && <button className="btn sm" onClick={() => act(r, 'price')}>💰 حدّد السعر</button>}
                {r.status === 'pending_approval' && <button className="btn sm" onClick={() => act(r, 'approve')}>✅ اعتماد ونشر</button>}
                {r.status === 'pending_approval' && <button className="btn ghost sm" onClick={() => act(r, 'reject')}>❌ رفض</button>}
              </div>
            </div>
          </div>
        ))}
      </Card>
    )}
    <Card title={`برنامج الإعلانات (${data.length})`} action={<button className="btn sm" onClick={() => setModal(true)}>➕ حملة جديدة</button>}>
      <table>
        <thead><tr><th>الحملة</th><th>المطعم</th><th>الموضع</th><th>الميزانية</th><th>الإنفاق</th><th>مشاهدات</th><th>نقرات</th><th>الحالة</th></tr></thead>
        <tbody>
          {data.map(a => (
            <tr key={a.id}>
              <td><b>{a.title}</b></td><td>{a.rname || '—'}</td>
              <td><span className="badge b-blue">{a.placement}</span></td>
              <td>{sar(a.budget)} ر.س</td><td>{sar(a.spent)} ر.س</td><td>{a.impressions}</td><td>{a.clicks}</td>
              <td>{a.is_active ? <span className="badge b-green">نشطة</span> : <span className="badge b-gray">متوقفة</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {modal && <AdForm rests={rests} onClose={() => setModal(false)} onSaved={() => { setModal(false); onChange(); }} />}
    </Card>
    </>
  );
}
function AdForm({ rests, onClose, onSaved }) {
  const [f, setF] = useState({ title: '', restaurant_id: '', placement: 'whatsapp', budget: 50000 });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="حملة إعلانية جديدة" onClose={onClose}>
      <div className="form-grid">
        <Fld label="عنوان الإعلان"><input value={f.title} onChange={set('title')} /></Fld>
        <Fld label="المطعم">
          <select value={f.restaurant_id} onChange={set('restaurant_id')}><option value="">—</option>{rests.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}</select>
        </Fld>
        <Fld label="الموضع">
          <select value={f.placement} onChange={set('placement')}><option value="whatsapp">واتساب</option><option value="home">الرئيسية</option><option value="search">البحث</option></select>
        </Fld>
        <Fld label="الميزانية (هللة)"><input type="number" value={f.budget} onChange={set('budget')} /></Fld>
      </div>
      <div className="row" style={{ marginTop: 14 }}><button className="btn" onClick={async () => { await api('/ads', { method: 'POST', body: { ...f, restaurant_id: f.restaurant_id ? Number(f.restaurant_id) : null } }); onSaved(); }}>حفظ</button></div>
    </Modal>
  );
}

function LoyaltyTab() {
  const [settings, setSettings] = useState(null);
  useEffect(() => { api('/loyalty/settings').then(setSettings).catch(() => {}); }, []);
  return (
    <Card title="نظام الولاء">
      <div className="grid g3">
        <Stat n={settings ? settings.points_per_riyal : '…'} l="نقطة لكل ريال" />
        <Stat n="برونزي / فضي / ذهبي / بلاتيني" l="المستويات (0/500/1500/4000 نقطة)" color="#8e24aa" />
        <Stat n="3% / 5% / 8%" l="خصم الأعضاء" color="#ef6c00" />
      </div>
      <div style={{ fontSize: 13.5, color: 'var(--mut)', lineHeight: 2, marginTop: 8 }}>
        💡 العميل يكسب نقطة عن كل ريال في الطلبات المدفوعة، ويترقى تلقائياً حسب رصيده.
        النقاط تُصرف كخصم في الطلبات القادمة، ورسالة التقييم بعد كل توصيل تعرض رصيد العميل ومستواه.
      </div>
    </Card>
  );
}

function ChatsTab({ restaurants }) {
  const [rid, setRid] = useState('');
  const [rows, setRows] = useState([]);
  const load = async (id) => { if (!id) return setRows([]); const d = await api(`/restaurants/${id}/conversations`); setRows(d); };
  useEffect(() => { if (rid) load(rid); }, [rid]);
  return (
    <Card title="جميع المحادثات">
      <div className="row" style={{ marginBottom: 14 }}>
        <select value={rid} onChange={e => setRid(e.target.value)} style={{ width: 260 }}>
          <option value="">— اختر مطعماً لعرض محادثات طلباته —</option>
          {restaurants.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
        </select>
      </div>
      <div className="msg-bubble">
        {rows.slice(0, 60).map(m => (
          <div key={m.id} className={`m ${m.direction === 'in' ? 'in' : 'out'}`}>
            <small>{m.order_no || ''} · {m.channel} · {m.direction === 'in' ? 'من العميل' : 'إلى العميل'}</small>
            {m.body || '(رسالة تفاعلية)'}<small>{m.created_at}</small>
          </div>
        ))}
        {!rows.length && <div className="empty">لا توجد محادثات</div>}
      </div>
    </Card>
  );
}

function RegistrationsTab() {
  const { notify } = useApp();
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const load = () => api('/registrations').then(setRows).catch(e => notify(e.message));
  useEffect(() => { load(); }, []);
  const act = async (r, action) => {
    setBusy(true);
    try { await api(`/registrations/${r.id}/${action}`, { method: 'POST', body: {} }); notify(action === 'approve' ? '✅ تم الاعتماد' : '❌ تم الرفض'); await load(); }
    catch (e) { notify(e.message); } finally { setBusy(false); }
  };
  const pending = rows.filter(r => r.status === 'pending_review' || r.status === 'draft');
  const others = rows.filter(r => r.status !== 'pending_review' && r.status !== 'draft');
  const label = s => s === 'approved' ? '✅ معتمد' : s === 'rejected' ? '❌ مرفوض' : '⏳ بانتظار الاعتماد';
  const Row = r => (
    <div key={r.id} style={{ padding: '10px 2px', borderBottom: '1px solid var(--line)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div onClick={() => setOpen(open === r.id ? null : r.id)} style={{ cursor: 'pointer' }}>
          <b>{r.kind === 'captain' ? '🛵 كابتن' : '🏬 نشاط'} — {r.business_name || '-'}</b>
          <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>
            {[r.city, r.district, r.postal_code].filter(Boolean).join(' — ') || '-'} · {r.phone} · {label(r.status)}{r.kind === 'business' ? ` · ${(r.items || []).length} صنف` : ` · ${r.vehicle_type || ''}`}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>
            👤 {r.owner_name || '-'} · 🔢 {r.owner_id || 'بلا هوية'}
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {r.status !== 'approved' && <button className="btn sm" disabled={busy} onClick={() => act(r, 'approve')}>✅ اعتماد</button>}
          {r.status !== 'rejected' && <button className="btn ghost sm" disabled={busy} onClick={() => act(r, 'reject')}>❌ رفض</button>}
        </div>
      </div>
      {open === r.id && (
        <div style={{ marginTop: 8, fontSize: 13, color: 'var(--mut)', lineHeight: 1.9 }}>
          {r.kind === 'business' ? (
            <>
              <div>الأصناف:</div>
              {(r.items || []).map((it, i) => <div key={i}>• {it.name} {it.price ? `— ${sar(it.price)} ر.س` : '— بلا سعر'}{it.category ? ` (${it.category})` : ''}</div>)}
            </>
          ) : (<div>المركبة: {r.vehicle_type || '-'} · المدينة: {r.city || '-'}{r.district ? ` · الحي: ${r.district}` : ''} · الهوية: {r.owner_id || '-'}</div>)}
          <div style={{ marginTop: 4 }}>{r.created_at}</div>
        </div>
      )}
    </div>
  );
  return (
    <Card title={`📝 طلبات التسجيل${pending.length ? ` (${pending.length} بانتظار)` : ''}`}>
      {pending.length > 0 && <div style={{ marginBottom: 10, fontWeight: 700, color: '#ef6c00' }}>⏳ بانتظار الاعتماد ({pending.length})</div>}
      {pending.map(Row)}
      {!pending.length && <div className="empty">لا توجد طلبات بانتظار الاعتماد ✅</div>}
      {others.length > 0 && (
        <>
          <div style={{ margin: '16px 0 6px', fontWeight: 700 }}>المعتمدة والمرفوضة</div>
          {others.slice(0, 30).map(Row)}
        </>
      )}
      <div style={{ fontSize: 13, color: 'var(--mut)', lineHeight: 1.9, marginTop: 12 }}>
        💡 الاعتماد من هنا أو من إشعار واتساب على رقم المشرف (اضبطه في ⚙️ إعدادات واتساب).
      </div>
    </Card>
  );
}

function ReportsTab() {
  const { notify } = useApp();
  const [rows, setRows] = useState([]);
  const [plat, setPlat] = useState(null);
  const [platBusy, setPlatBusy] = useState(false);
  const loadPlatform = async (preview = true) => {
    try {
      if (preview) {
        const d = await api('/report-recipients/platform/send?preview=1&which=yesterday', { method: 'POST', body: {} });
        setPlat(d);
      } else {
        setPlatBusy(true);
        const d = await api('/report-recipients/platform/send?which=yesterday', { method: 'POST', body: {} });
        notify(d.ok ? '✅ تم إرسال تقرير الإدارة لجوال المشرف' : '⚠️ تعذر الإرسال — تأكد من رقم المشرف');
        await loadPlatform(true);
      }
    } catch (e) { notify(e.message); } finally { setPlatBusy(false); }
  };
  const [rests, setRests] = useState([]);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ restaurant_id: '', name: '', phone: '', report_hour: '23:30' });
  const load = () => api('/report-recipients').then(setRows).catch(e => notify(e.message));
  useEffect(() => { load(); api('/restaurants').then(d => setRests(d || [])).catch(() => {}); }, []);
  const act = async (r, action) => {
    setBusy(true);
    try {
      if (action === 'delete') { if (!window.confirm('حذف ' + (r.name || r.phone) + ' من مستلمي التقارير؟')) { setBusy(false); return; } await api(`/report-recipients/${r.id}`, { method: 'DELETE' }); }
      else if (action === 'send') { const d = await api(`/report-recipients/${r.id}/send`, { method: 'POST', body: { which: 'today' } }); notify(d.ok ? '✅ تم إرسال التقرير الآن' : '⚠️ فشل الإرسال'); }
      else { await api(`/report-recipients/${r.id}/${action}`, { method: 'POST', body: {} }); notify(action === 'approve' ? '✅ تم الاعتماد' : '❌ تم الرفض'); }
      await load();
    } catch (e) { notify(e.message); } finally { setBusy(false); }
  };
  const preview = async (r) => {
    try {
      const res = await fetch(`/api/report-recipients/${r.id}/invoice`, { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!res.ok) throw new Error('تعذر جلب الفاتورة');
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (e) { notify(e.message); }
  };
  const setHour = async (r, report_hour) => { try { await api(`/report-recipients/${r.id}`, { method: 'PUT', body: { report_hour } }); await load(); notify('✅ تم تحديث وقت التقرير'); } catch (e) { notify(e.message); } };
  const add = async () => {
    if (!f.restaurant_id || !f.phone.trim()) return notify('اختر النشاط واكتب الجوال');
    setBusy(true);
    try { await api('/report-recipients', { method: 'POST', body: f }); notify('✅ تمت الإضافة والاعتماد'); setF({ restaurant_id: '', name: '', phone: '', report_hour: '23:30' }); await load(); }
    catch (e) { notify(e.message); } finally { setBusy(false); }
  };
  const label = s => s === 'approved' ? '✅ معتمد' : s === 'rejected' ? '❌ مرفوض' : '⏳ بانتظار الاعتماد';
  const pending = rows.filter(r => r.status === 'pending');
  const others = rows.filter(r => r.status !== 'pending');
  const Row = r => (
    <div key={r.id} style={{ padding: '10px 2px', borderBottom: '1px solid var(--line)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <b>👤 {r.name || 'بدون اسم'}</b> <span style={{ fontSize: 12.5, color: 'var(--mut)' }}>— {r.restaurant_name || 'نشاط محذوف'}</span>
          <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>
            🔢 {r.national_id || 'بلا هوية'} · 📱 {r.phone} · {label(r.status)} · ⏰ التقرير {r.report_hour || '23:30'}{r.last_sent_date ? ` · آخر إرسال ${r.last_sent_date}` : ''}
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {r.status !== 'approved' && <button className="btn sm" disabled={busy} onClick={() => act(r, 'approve')}>✅</button>}
          {r.status !== 'rejected' && <button className="btn ghost sm" disabled={busy} onClick={() => act(r, 'reject')}>❌</button>}
          <button className="btn ghost sm" disabled={busy} onClick={() => preview(r)} title="معاينة الفاتورة المختومة">📄</button>
          <button className="btn ghost sm" disabled={busy} onClick={() => act(r, 'send')} title="أرسل التقرير الآن">📤</button>
          <button className="btn ghost sm" disabled={busy} onClick={() => act(r, 'delete')}>🗑</button>
        </div>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 12.5, color: 'var(--mut)' }}>وقت التقرير اليومي:</span>
        <input type="time" value={r.report_hour || '23:30'} onChange={e => setHour(r, e.target.value)} style={{ width: 120 }} />
      </div>
    </div>
  );
  return (
    <>
    <Card title="🏛 تقرير الإدارة المجمّع">
      <div style={{ fontSize: 13, color: 'var(--mut)', lineHeight: 1.9, marginBottom: 10 }}>
        📅 يرسل تلقائياً كل يوم <b>١٢ منتصف الليل</b> على جوال المشرف — مبيعات كل نوع نشاط · المجموع الختامي · <b>حصة المنصة</b>.
      </div>
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <button className="btn ghost sm" onClick={() => loadPlatform(true)}>👁 معاينة تقرير أمس</button>
        <button className="btn" disabled={platBusy} onClick={() => loadPlatform(false)}>{platBusy ? '…' : '📤 أرسل لجوالي الآن'}</button>
      </div>
      {plat && (
        <div style={{ background: 'var(--bg2, #f7f9fb)', border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
          <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: 'var(--mut)' }}>تقرير يوم {plat.date} — يُرسل الساعة</span>
            <input type="time" value={plat.hour || '00:00'} style={{ width: 118 }}
              onChange={async (e) => {
                try { await api('/report-recipients/platform/hour', { method: 'POST', body: { hour: e.target.value } }); setPlat({ ...plat, hour: e.target.value }); notify('✅ تم تحديث وقت تقرير الإدارة'); }
                catch (err) { notify(err.message); }
              }} />
          </div>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.9, margin: 0 }}>{plat.text}</pre>
        </div>
      )}
    </Card>
    <Card title={`📊 مستلمو تقارير المبيعات${pending.length ? ` (${pending.length} بانتظار)` : ''}`}>
      <div style={{ fontSize: 13, color: 'var(--mut)', lineHeight: 1.9, marginBottom: 12 }}>
        👤 <b>مدير المطعم</b> يضيف نفسه من واتساب بكتابة <b>«مدير»</b> → يوصلك إشعار للاعتماد هنا أو على واتساب.
        <br />📄 التقرير اليومي يوصله تلقائياً (المجموع الختام · شبكة · كاش · الأكثر مبيعاً)، ويكتب <b>«تقرير»</b> بأي وقت ليوصله فوراً.
      </div>
      {pending.length > 0 && <div style={{ marginBottom: 8, fontWeight: 700, color: '#ef6c00' }}>⏳ بانتظار اعتمادك ({pending.length})</div>}
      {pending.map(Row)}
      {!pending.length && <div className="empty">لا توجد طلبات معلقة ✅</div>}
      {others.length > 0 && (<>
        <div style={{ margin: '16px 0 6px', fontWeight: 700 }}>المعتمدون والمرفوضون</div>
        {others.slice(0, 40).map(Row)}
      </>)}
      <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>➕ إضافة مباشرة (تُعتمد فوراً)</div>
        <div className="grid g2">
          <Fld label="النشاط">
            <select value={f.restaurant_id} onChange={e => setF({ ...f, restaurant_id: e.target.value })}>
              <option value="">— اختر —</option>
              {rests.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
            </select>
          </Fld>
          <Fld label="اسم المدير"><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Fld>
          <Fld label="جواله"><input value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} placeholder="0551234567" style={{ direction: 'ltr' }} /></Fld>
          <Fld label="وقت التقرير اليومي"><input type="time" value={f.report_hour} onChange={e => setF({ ...f, report_hour: e.target.value })} /></Fld>
        </div>
        <button className="btn" disabled={busy} onClick={add}>➕ إضافة واعتماد</button>
      </div>
    </Card>
    </>
  );
}

function TypesTab() {
  const { notify } = useApp();
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ name_ar: '', icon: '🏬' });
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api('/business-types').then(setRows).catch(e => notify(e.message));
  useEffect(() => { load(); }, []);
  const run = async (fn) => { setBusy(true); try { await fn(); await load(); } catch (e) { notify(e.message); } finally { setBusy(false); } };
  const add = () => {
    if (String(f.name_ar || '').trim().length < 2) return notify('اكتب اسم النوع');
    run(async () => { await api('/business-types', { method: 'POST', body: f }); notify('✅ تمت إضافة النوع'); setF({ name_ar: '', icon: '🏬' }); });
  };
  const saveEdit = () => run(async () => { await api('/business-types/' + edit.id, { method: 'PUT', body: { name_ar: edit.name_ar, icon: edit.icon } }); setEdit(null); notify('✅ تم التعديل'); });
  const toggle = t => run(async () => { await api('/business-types/' + t.id, { method: 'PUT', body: { is_active: t.is_active ? 0 : 1 } }); notify(t.is_active ? '⏸ تم الإيقاف' : '▶️ تم التشغيل'); });
  const del = t => run(async () => { await api('/business-types/' + t.id, { method: 'DELETE' }); notify('🗑 تم الحذف'); });
  return (
    <Card title="🏷 أنواع الأنشطة">
      <div className="grid g2">
        <Fld label="نوع جديد"><input value={f.name_ar} onChange={e => setF({ ...f, name_ar: e.target.value })} placeholder="مثال: مقهى" /></Fld>
        <Fld label="الأيقونة"><input value={f.icon} onChange={e => setF({ ...f, icon: e.target.value })} style={{ width: 90 }} /></Fld>
      </div>
      <button className="btn" disabled={busy} onClick={add}>➕ إضافة نوع</button>
      <div style={{ marginTop: 16 }}>
        {rows.map(t => (
          <div key={t.id} style={{ padding: '10px 2px', borderBottom: '1px solid var(--line)' }}>
            {edit && edit.id === t.id ? (
              <div className="row" style={{ gap: 8 }}>
                <input value={edit.icon} onChange={e => setEdit({ ...edit, icon: e.target.value })} style={{ width: 70 }} />
                <input value={edit.name_ar} onChange={e => setEdit({ ...edit, name_ar: e.target.value })} style={{ flex: 1 }} />
                <button className="btn sm" disabled={busy} onClick={saveEdit}>حفظ</button>
                <button className="btn ghost sm" onClick={() => setEdit(null)}>إلغاء</button>
              </div>
            ) : (
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <span style={{ fontSize: 18 }}>{t.icon}</span> <b>{t.name_ar}</b>
                  <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>{t.restaurants_count} نشاط · {t.is_active ? '✅ مفعّل' : '⏸ موقوف'}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn ghost sm" onClick={() => setEdit({ id: t.id, name_ar: t.name_ar, icon: t.icon })}>✏️ تعديل</button>
                  <button className="btn ghost sm" disabled={busy} onClick={() => toggle(t)}>{t.is_active ? '⏸' : '▶️'}</button>
                  <button className="btn ghost sm" disabled={busy} onClick={() => del(t)}>🗑</button>
                </div>
              </div>
            )}
          </div>
        ))}
        {!rows.length && <div className="empty">لا توجد أنواع — أضف واحداً</div>}
      </div>
      <div style={{ fontSize: 13, color: 'var(--mut)', lineHeight: 1.9, marginTop: 12 }}>
        💡 هذي الأنواع تظهر للنشاط لما يسجّل عبر واتساب. تقدر تضيف وتوقف أي نوع وقت ما تبي — بدون أي تعديل برمجي.
      </div>
    </Card>
  );
}

function SettingsTab() {
  const { notify } = useApp();
  const [s, setS] = useState(null);
  const [f, setF] = useState({ WHATSAPP_PROVIDER: '', WHATSAPP_PHONE_NUMBER_ID: '', WHATSAPP_VERIFY_TOKEN: '', WHATSAPP_TOKEN: '', STT_API_KEY: '', VOICE_REPLIES: '', ADMIN_PHONE: '', SUPERVISOR_NAME: '', SUPERVISOR_ID: '', COMMISSION_BUSINESS_PERCENT: '', COMMISSION_CAPTAIN_PERCENT: '', BUSINESS_SUBSCRIPTION: '', CAPTAIN_DEPOSIT: '', PAYMENT_MODE: 'mock' });
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testRes, setTestRes] = useState(null);
  const [clearing, setClearing] = useState(false);
  const clearDemo = async () => {
    if (!window.confirm('تأكيد: حذف كل المطاعم والمشتركين والكباتن والطلبات والمحادثات؟\n\nتُبقي الإعدادات وأنواع الأنشطة وحساب المدير.')) return;
    if (!window.confirm('تأكيد أخير — لا يمكن التراجع إلا من نسخة الأمان. متأكد؟')) return;
    setClearing(true);
    try { await api('/dbadmin/reset-demo?confirm=YES', { method: 'POST', body: {} }); notify('✅ تم تفريغ البيانات التجريبية'); }
    catch (e) { notify(e.message); } finally { setClearing(false); }
  };
  const [pw, setPw] = useState({ cur: '', next: '' });
  const load = () => api('/settings').then(d => {
    setS(d);
    setF(x => ({
      ...x,
      WHATSAPP_PROVIDER: d.provider || 'simulator',
      WHATSAPP_PHONE_NUMBER_ID: d.phoneNumberId || '',
      WHATSAPP_VERIFY_TOKEN: d.verifyToken || '',
      VOICE_REPLIES: d.voiceReplies ? 'true' : 'false',
      ADMIN_PHONE: d.adminPhone || '',
      SUPERVISOR_NAME: d.supervisorName || '',
      SUPERVISOR_ID: d.supervisorId || '',
      COMMISSION_BUSINESS_PERCENT: d.commissionBusinessPercent != null ? String(d.commissionBusinessPercent) : '',
      COMMISSION_CAPTAIN_PERCENT: d.commissionCaptainPercent != null ? String(d.commissionCaptainPercent) : '',
      BUSINESS_SUBSCRIPTION: d.businessSubscription != null ? String(d.businessSubscription / 100) : '',
      CAPTAIN_DEPOSIT: d.captainDeposit != null ? String(d.captainDeposit / 100) : '',
      PAYMENT_MODE: d.paymentMode || 'mock'
    }));
  }).catch(e => notify(e.message));
  useEffect(() => { load(); }, []);
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const save = async (body) => {
    setBusy(true);
    try { await api('/settings', { method: 'PUT', body }); notify('✅ تم الحفظ والتطبيق فوراً'); setRaw(''); await load(); }
    catch (e) { notify(e.message); } finally { setBusy(false); }
  };
  const runTest = async () => {
    setTestRes(null); setBusy(true);
    try {
      const r = await fetch('/api/settings/test-whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() }, body: JSON.stringify({ phone: testPhone }) });
      const d = await r.json().catch(() => ({}));
      setTestRes(d);
    } catch (e) { setTestRes({ ok: false, error: e.message }); } finally { setBusy(false); }
  };
  const onSave = () => {
    const body = {};
    for (const [k, v] of Object.entries(f)) if (v !== '' && v !== undefined) body[k] = v;
    if (!Object.keys(body).length) return notify('لا توجد قيم');
    save(body);
  };
  if (!s) return <div className="empty">تحميل…</div>;
  const okBadge = v => <span className={`badge ${v ? 'b-green' : 'b-gray'}`}>{v ? '✅ مضبوط' : '⛔ ناقص'}</span>;
  return (
    <Card title="⚙️ إعدادات واتساب والصوت">
      <div className="grid g3" style={{ marginBottom: 10 }}>
        <div className="stat"><div className="n" style={{ fontSize: 18 }}>{s.provider}</div><div className="l">مزوّد الإرسال</div></div>
        <div className="stat"><div className="n" style={{ fontSize: 18 }}>{okBadge(s.tokenSet)}</div><div className="l">توكن واتساب {s.tokenMask ? `(${s.tokenMask})` : ''}</div></div>
        <div className="stat"><div className="n" style={{ fontSize: 18 }}>{okBadge(s.sttSet)}</div><div className="l">مفتاح تفريغ الصوت</div></div>
      </div>
      <div style={{ fontSize: 13, color: 'var(--mut)', lineHeight: 1.9, marginBottom: 12 }}>
        💡 هذي الإعدادات تُحفظ في قاعدة بياناتك وتُطبّق فوراً بدون إعادة نشر. التوكن لا يظهر كاملاً بعد الحفظ (يُقنّع).
      </div>
      <div className="grid g2">
        <Fld label="مزود واتساب">
          <select value={f.WHATSAPP_PROVIDER} onChange={set('WHATSAPP_PROVIDER')}>
            <option value="simulator">simulator (محاكي — لا يرسل فعلياً)</option>
            <option value="cloud">cloud (واتساب الأعمال — Meta)</option>
          </select>
        </Fld>
        <Fld label="Phone Number ID">
          <input value={f.WHATSAPP_PHONE_NUMBER_ID} onChange={set('WHATSAPP_PHONE_NUMBER_ID')} placeholder="1328717473658833" />
        </Fld>
        <Fld label="Verify Token">
          <input value={f.WHATSAPP_VERIFY_TOKEN} onChange={set('WHATSAPP_VERIFY_TOKEN')} placeholder="wassal-verify-2026" />
        </Fld>
        <Fld label="ردود صوتية للعميل">
          <select value={f.VOICE_REPLIES} onChange={set('VOICE_REPLIES')}>
            <option value="false">لا — كتابي فقط</option>
            <option value="true">نعم — كتابي + صوتي</option>
          </select>
        </Fld>
        <Fld label="رقم المشرف (إشعارات اعتماد التسجيل)">
          <input value={f.ADMIN_PHONE || ''} onChange={set('ADMIN_PHONE')} placeholder="9665xxxxxxxx" style={{ direction: 'ltr' }} />
        </Fld>
        <Fld label="اسم المشرف العام">
          <input value={f.SUPERVISOR_NAME || ''} onChange={set('SUPERVISOR_NAME')} placeholder="الاسم الكامل" />
        </Fld>
        <Fld label="وضع الدفع">
          <select value={f.PAYMENT_MODE} onChange={set('PAYMENT_MODE')}>
            <option value="mock">🧪 تجريبي (دفع وهمي يُحتسب مدفوعاً)</option>
            <option value="moyasar">💳 حقيقي (Moyasar — مدى/Apple Pay)</option>
          </select>
        </Fld>
        <Fld label="نسبة المنصة من النشاط %">
          <input value={f.COMMISSION_BUSINESS_PERCENT || ''} onChange={set('COMMISSION_BUSINESS_PERCENT')} placeholder="15" style={{ direction: 'ltr' }} />
        </Fld>
        <Fld label="نسبة المنصة من الكابتن %">
          <input value={f.COMMISSION_CAPTAIN_PERCENT || ''} onChange={set('COMMISSION_CAPTAIN_PERCENT')} placeholder="15" style={{ direction: 'ltr' }} />
        </Fld>
        <Fld label="اشتراك النشاط (ريال)">
          <input value={f.BUSINESS_SUBSCRIPTION || ''} onChange={set('BUSINESS_SUBSCRIPTION')} placeholder="1000" style={{ direction: 'ltr' }} />
        </Fld>
        <Fld label="تأمين الكابتن (ريال)">
          <input value={f.CAPTAIN_DEPOSIT || ''} onChange={set('CAPTAIN_DEPOSIT')} placeholder="500" style={{ direction: 'ltr' }} />
        </Fld>
        <Fld label="رقم هوية المشرف العام">
          <input value={f.SUPERVISOR_ID || ''} onChange={set('SUPERVISOR_ID')} placeholder="1023456789" style={{ direction: 'ltr' }} />
        </Fld>
      </div>
      <Fld label="توكن واتساب (Access Token) — الصقه كاملاً">
        <textarea value={f.WHATSAPP_TOKEN} onChange={set('WHATSAPP_TOKEN')} rows={4} placeholder={s.tokenSet ? 'مضبوط — اتركه فارغاً للإبقاء عليه، أو الصق توكن جديد للتغيير' : 'EAA...'} style={{ width: '100%', direction: 'ltr', fontSize: 12 }} />
      </Fld>
      <Fld label="مفتاح تفريغ الصوت (Groq STT_API_KEY) — لتفعيل الطلبات الصوتية">
        <textarea value={f.STT_API_KEY} onChange={set('STT_API_KEY')} rows={2} placeholder="gsk_..." style={{ width: '100%', direction: 'ltr', fontSize: 12 }} />
      </Fld>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" disabled={busy} onClick={onSave}>{busy ? '…' : '💾 حفظ وتطبيق'}</button>
      </div>
      <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>🧪 اختبار الإرسال (يتأكد أن التوكن يعمل فعلاً)</div>
        <div className="row">
          <input value={testPhone} onChange={e => setTestPhone(e.target.value)} placeholder="9665xxxxxxxx" style={{ direction: 'ltr', flex: 1, minWidth: 160 }} />
          <button className="btn ghost" disabled={busy || !testPhone.trim()} onClick={runTest}>📤 إرسال رسالة اختبار</button>
        </div>
        {testRes && (
          <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.8, color: testRes.ok ? '#0a7' : '#c33' }}>
            {testRes.ok ? '✅ تم الإرسال فعلاً — شيك واتساب جوالك.' : '⛔ ' + (testRes.error || 'فشل')}
          </div>
        )}
      </div>
      <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>🔐 تغيير كلمة مرور المدير</div>
        <div className="grid g2">
          <Fld label="كلمة المرور الحالية"><input type="password" value={pw.cur} onChange={e => setPw({ ...pw, cur: e.target.value })} style={{ width: '100%' }} /></Fld>
          <Fld label="كلمة المرور الجديدة (6 أحرف على الأقل)"><input type="password" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} style={{ width: '100%' }} /></Fld>
        </div>
        <button className="btn ghost sm" disabled={busy || !pw.cur || !pw.next} onClick={async () => {
          try { await api('/auth/change-password', { method: 'POST', body: { current: pw.cur, next: pw.next } }); notify('✅ تم تغيير كلمة المرور — احفظها في مكان آمن'); setPw({ cur: '', next: '' }); }
          catch (e) { notify(e.message); }
        }}>💾 تغيير كلمة المرور</button>
      </div>
      <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
        <Fld label="أو الصق الإعدادات كنص (KEY=VALUE)">
          <textarea value={raw} onChange={e => setRaw(e.target.value)} rows={5}
            placeholder={'WHATSAPP_PROVIDER=cloud\nWHATSAPP_TOKEN=EAA...\nWHATSAPP_PHONE_NUMBER_ID=1328717473658833\nSTT_API_KEY=gsk_...'}
            style={{ width: '100%', direction: 'ltr', fontSize: 12 }} />
        </Fld>
        <button className="btn ghost sm" disabled={busy || !raw.trim()} onClick={() => save({ raw })}>📥 قراءة النص وتطبيقه</button>
      </div>
      <div style={{ marginTop: 18, padding: 12, border: '1px solid #f3c7c7', borderRadius: 10, background: '#fff7f7' }}>
        <div style={{ fontWeight: 700, color: '#c62828', marginBottom: 4 }}>🧹 تفريغ البيانات التجريبية</div>
        <div style={{ fontSize: 12.5, color: 'var(--mut)', lineHeight: 1.8, marginBottom: 8 }}>
          يحذف: المطاعم وأصنافها · المشتركين · الكباتن · الطلبات · المحادثات.
          <br />ويُبقي: حساب المدير · إعدادات واتساب · أنواع الأنشطة.
          <br />تُؤخذ نسخة أمان تلقائياً قبل الحذف.
        </div>
        <button className="btn ghost" disabled={clearing} onClick={clearDemo} style={{ borderColor: '#e57373', color: '#c62828' }}>
          {clearing ? '… جارٍ التفريغ' : '🧹 افرغ البيانات التجريبية'}
        </button>
      </div>
    </Card>
  );
}

function OrderModal({ o, onClose, refresh }) {
  const [d, setD] = useState(null);
  useEffect(() => { api('/orders/' + o.id).then(setD); }, [o.id]);
  if (!d) return <Modal title={o.order_no} onClose={onClose}><div className="empty">…</div></Modal>;
  return (
    <Modal title={`${d.order_no} — ${d.restaurant_name}`} onClose={onClose} wide>
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <Badge s={d.status} /> <Pay m={d.payment_method} />
        {d.payment_status === 'paid' ? <span className="badge b-green">مدفوع ✅</span> : <span className="badge b-red">غير مدفوع</span>}
        <Money h={d.total} />
      </div>
      <div className="grid g2">
        <div>
          <h4 style={{ marginBottom: 8 }}>🧾 الأصناف</h4>
          {(d.items || []).map((i, k) => <div key={k} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}><span>{i.name} ×{i.quantity}</span><span>{sar(i.price * i.quantity)} ر.س</span></div>)}
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}><b>الإجمالي</b><b>{sar(d.total)} ر.س</b></div>
          <h4 style={{ margin: '14px 0 8px' }}>📍 التوصيل</h4>
          <div style={{ fontSize: 13.5, lineHeight: 1.9 }}>الفرع: {d.branch_name}<br />العنوان: {d.national_address || `${d.lat},${d.lng}`}<br />الوقت التقريبي: {d.est_delivery_min} دقيقة</div>
          {d.captain && <div style={{ fontSize: 13.5, marginTop: 8 }}>🛵 الكابتن: {d.captain.name} — {d.captain.phone}</div>}
          <h4 style={{ margin: '14px 0 8px' }}>⭐ التقييم</h4>
          <div style={{ fontSize: 13.5 }}>المطعم: {d.rating_restaurant ? '⭐'.repeat(d.rating_restaurant) : '—'} | السرعة: {d.rating_speed ? '⭐'.repeat(d.rating_speed) : '—'} | الكابتن: {d.rating_captain ? '⭐'.repeat(d.rating_captain) : '—'}<br />{d.rating_comment && <span>💬 {d.rating_comment}</span>}</div>
        </div>
        <div>
          <h4 style={{ marginBottom: 8 }}>🕐 مسار الطلب</h4>
          <div className="timeline">
            {(d.events || []).map((e, i) => (
              <div key={e.id} className="ev"><div className="dot" /><div><p>{e.message}</p><small>{e.created_at} — {e.actor_type}</small></div></div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
