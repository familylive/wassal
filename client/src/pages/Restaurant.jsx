import React, { useEffect, useState } from 'react';
import { api, sar, payAr, getToken } from '../api.js';
import { useApp, notify } from '../App.jsx';
import { Card, Stat, Modal, Fld, Badge, Money, Pay, OrdersTable } from '../components/ui.jsx';

// 📅 حسابات مدة العروض
const dayStr = (v) => (v ? String(v).slice(0, 10) : '');
const todayStr = () => new Date().toISOString().slice(0, 10);
const offStatus = (o) => !Number(o.is_active) ? { t: 'متوقف', c: 'b-gray' }
  : (o.starts_at && dayStr(o.starts_at) > todayStr()) ? { t: 'لم يبدأ', c: 'b-amber' }
    : (o.ends_at && dayStr(o.ends_at) < todayStr()) ? { t: 'منتهي', c: 'b-red' } : { t: 'فعّال', c: 'b-green' };
const offPeriod = (o) => (o.starts_at || o.ends_at)
  ? (o.starts_at && o.ends_at ? `📅 من ${dayStr(o.starts_at)} إلى ${dayStr(o.ends_at)}`
    : o.ends_at ? `📅 حتى ${dayStr(o.ends_at)}` : `📅 من ${dayStr(o.starts_at)}`) : '';

const TABS_OWNER = ['dashboard', 'orders', 'menu', 'offers', 'branches', 'reports', 'ratings', 'chats'];
const TABS_SUPERVISOR = ['dashboard', 'orders', 'branch', 'reports', 'chats'];
const TABS_QUALITY = ['dashboard', 'reports', 'ratings'];
const TABS_CASHIER = ['orders'];
const TAB_AR = { dashboard: '📊 الوضع', orders: '📦 الطلبات', menu: '🍽 المنيو', offers: '🔥 العروض', branches: '🏪 الفروع', chats: '💬 المحادثات', branch: '🏪 إعدادات فرعي', reports: '📋 التقارير', ratings: '⭐ التقييمات والجودة' };
const ROLE_AR = { owner: 'المطعم الرئيسي', manager: 'مشرف فرع', supervisor: 'مشرف فرع', quality: 'مدير الجودة', cashier: 'الكاشير' };
// التبويبات حسب الدور والصلاحية
function tabsFor(user) {
  if (user.role === 'quality') return TABS_QUALITY;
  if (user.role === 'cashier') return TABS_CASHIER;
  if (user.branch_id) return TABS_SUPERVISOR;   // مشرف الفرع
  return TABS_OWNER;                            // المطعم الرئيسي
}

export default function Restaurant() {
  const { user, socket, logout, notify } = useApp();
  const [tab, setTab] = useState('dashboard');
  const [orders, setOrders] = useState([]);
  const [stats, setStats] = useState(null);
  const [sel, setSel] = useState(null);
  const [menuOpen, setMenuOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth > 900);
  const rid = user.restaurant_id;
  const isBranch = !!user.branch_id;
  const isOwner = user.role === 'owner' || user.role === 'admin';
  const TABS = tabsFor(user);

  // 🟠🟢 حالة استقبال الطلبات (مفتوح · مشغول · مغلق)
  const [status, setStatus] = useState(null);
  const loadStatus = async () => { try { setStatus(await api('/restaurants/' + rid + '/status')); } catch (e) {} };
  const setStatusAction = async (action) => {
    try {
      await api('/restaurants/' + rid + '/status', { method: 'POST', body: { action } });
      await loadStatus();
      notify(action === 'busy' ? '🟠 النشاط صار «مشغول» — العملاء يشوفون «عاود الطلب لاحقًا»' : action === 'close' ? '🔒 أُغلق استقبال الطلبات' : '🟢 النشاط يستقبل الطلبات');
    } catch (e) { notify(e.message); }
  };
  const loadOrders = async () => { try { setOrders(await api('/orders')); } catch (e) {} };
  const loadStats = async () => { try { setStats(await api(`/restaurants/${rid}/stats${isBranch ? '?branch_id=' + user.branch_id : ''}`)); } catch (e) {} };
  useEffect(() => { loadOrders(); loadStats(); loadStatus(); const t = setInterval(loadStatus, 60000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!socket) return;
    const f = () => { loadOrders(); loadStats(); if (user.role !== 'cashier') notify('🔔 تحديث في الطلبات'); };
    socket.on('order:new', f); socket.on('order:update', f);
    socket.on('order:cancelled', (d) => { loadOrders(); loadStats(); notify('❌ أُلغي الطلب ' + (d.order_no || '') + (d.reason ? ' — ' + d.reason : '')); });
    socket.on('captain:accept', () => { loadOrders(); loadStats(); notify('🤝 كابتن قبل التوصيل!'); });
    return () => { socket.off('order:new', f); socket.off('order:update', f); socket.off('captain:accept'); };
  }, [socket]);

  const openCount = orders.filter(o => ['new', 'confirmed', 'preparing', 'ready', 'offered', 'accepted', 'transferred', 'with_captain', 'on_the_way', 'arrived'].includes(o.status)).length;

  return (
    <>
      <div className={`sidebar ${menuOpen ? 'open' : 'closed'}`}>
        <div className="logo"><img src="/logo.png" alt="" style={{ width: 54, height: 54, borderRadius: '50%', verticalAlign: 'middle', marginLeft: 8 }} />تلي هم<small>{isBranch ? 'لوحة ' + (ROLE_AR[user.role] || 'الفرع') + ' — ' + user.branch_name : 'لوحة المطعم — ' + user.restaurant_name}</small></div>
        <nav>{TABS.map(t => <a key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{TAB_AR[t]}</a>)}</nav>
        <div className="foot" style={{ fontSize: 13 }}>{user.name}</div>
      </div>
      <div className={`main ${menuOpen ? '' : 'expanded'}`}>
        <div className="topbar">
          <div className="row"><button className="menu-btn" onClick={() => setMenuOpen(!menuOpen)}>☰</button><h2>{TAB_AR[tab]}</h2></div>
          <div className="row">
            <a href="/sim" target="_blank"><button className="btn ghost sm">🧪 محاكي واتساب</button></a>
            <span className="chip">طلبات نشطة: <b>{openCount}</b></span>
            <span className="chip" style={{ background: status?.state === 'busy' ? '#fff3e0' : status?.state === 'closed' ? '#fdecea' : '#e8f5e9' }}>
              {!status ? '…' : status.state === 'closed' ? '🔒 مغلق — لا نستقبل طلبات' : status.state === 'busy' ? `🟠 مشغول — يرجع بعد ${status.minutesLeft} د` : '🟢 يستقبل الطلبات'}
            </span>
            {status?.state === 'busy'
              ? <button className="btn ghost sm" onClick={() => setStatusAction('open')}>🟢 رجّع الاستقبال</button>
              : <button className="btn ghost sm" onClick={() => setStatusAction('busy')}>🟠 مشغول (زحمة)</button>}
            {status?.state === 'closed'
              ? <button className="btn ghost sm" onClick={() => setStatusAction('open')}>🟢 افتح الآن</button>
              : <button className="btn ghost sm" onClick={() => setStatusAction('close')}>🔒 إغلاق الاستقبال</button>}
          </div>
        </div>
        {menuOpen && <div className="backdrop" onClick={() => setMenuOpen(false)} />}
        <button className="btn red logout-float" onClick={logout}>🚪 خروج</button>
        {tab === 'dashboard' && <Dash stats={stats} orders={orders} onOpen={setSel} isBranch={isBranch} />}
        {tab === 'orders' && <Card title={user.role === 'cashier' ? 'طلبات اليوم — الكاشير' : 'كل الطلبات'}><OrdersTable orders={orders} onOpen={setSel} /></Card>}
        {tab === 'menu' && isOwner && <MenuTab rid={rid} />}
        {tab === 'offers' && isOwner && <OffersTab rid={rid} onGoMenu={() => setTab('menu')} />}
        {tab === 'branches' && isOwner && <BranchesTab rid={rid} />}
        {tab === 'branch' && <MyBranch rid={rid} branchId={user.branch_id} />}
        {tab === 'reports' && <ReportsTab user={user} rid={rid} />}
        {tab === 'ratings' && <RatingsTab user={user} rid={rid} />}
        {tab === 'chats' && <ChatsTab rid={rid} branchId={isBranch ? user.branch_id : null} />}
        {sel && <OrderModal o={sel} onClose={() => setSel(null)} refresh={() => { loadOrders(); loadStats(); }} />}
      </div>
    </>
  );
}

function Dash({ stats, orders, onOpen, isBranch }) {
  const active = orders.filter(o => ['new', 'offered', 'accepted'].includes(o.status));
  const live = orders.filter(o => !['delivered', 'cancelled'].includes(o.status));
  return (
    <>
      <div className="kpi">
        <Stat n={stats?.today.orders ?? '…'} l="طلبات اليوم" />
        <Stat n={stats ? sar(stats.today.revenue) + ' ر.س' : '…'} l="إيراد اليوم" color="#0b7a3b" />
        <Stat n={stats?.month.orders ?? '…'} l="طلبات الشهر" color="#1565c0" />
        <Stat n={active.length} l="بانتظار تحويل كابتن" color="#ef6c00" />
        <Stat n={stats?.open ?? 0} l="طلبات مفتوحة" color="#8e24aa" />
      </div>
      <Card title="🟢 الطلبات الحية" action={live.length ? <span className="badge b-green">{live.length} نشط</span> : null}>
        {live.map(o => (
          <div key={o.id} className="row" style={{ justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
            <div><b>{o.order_no}</b> — {o.branch_name || ''}<br /><small style={{ color: 'var(--mut)' }}>{o.national_address || ''} · {o.est_delivery_min} د</small></div>
            <div className="row"><Badge s={o.status} /><Money h={o.total} /><button className="btn ghost sm" onClick={() => onOpen(o)}>فتح</button></div>
          </div>
        ))}
        {!live.length && <div className="empty">{isBranch ? 'لا توجد طلبات نشطة لفرعك حالياً' : 'لا توجد طلبات نشطة — جرّب محاكي واتساب 🧪'}</div>}
      </Card>
    </>
  );
}

// 🎉 مناسبات جاهزة للخصم (اليوم الوطني · يوم المعلم …) — ويقدر يكتب مناسبة خاصة
const DISCOUNT_OCCASIONS = [
  'اليوم الوطني', 'يوم التأسيس', 'يوم العلم', 'يوم المعلم', 'يوم الأم', 'يوم الطفل',
  'رمضان', 'عيد الفطر', 'عيد الأضحى', 'الجمعة البيضاء', 'يوم القهوة السعودية',
  'افتتاح جديد', 'عرض خاص'
];

function MenuTab({ rid }) {
  const [cats, setCats] = useState([]);
  const [items, setItems] = useState([]);
  const [cm, setCm] = useState(null);
  const [im, setIm] = useState(null);
  const [pct, setPct] = useState(0);
  const [pctInput, setPctInput] = useState('');
  const [occ, setOcc] = useState('');          // مناسبة من القائمة (أو 'custom')
  const [custom, setCustom] = useState('');    // مناسبة مكتوبة يدويًا
  const [from, setFrom] = useState('');        // 📅 بداية الخصم
  const [to, setTo] = useState('');            // 📅 نهاية الخصم
  const load = async () => {
    setCats(await api('/menu/categories?restaurant_id=' + rid));
    setItems(await api('/menu/items?restaurant_id=' + rid));
    try {
      const r = await api('/restaurants/' + rid);
      const p = Number(r?.menu_discount_pct || 0);
      const l = String(r?.menu_discount_label || '');
      setPct(p); setPctInput(String(p));
      setFrom(dayStr(r?.menu_discount_from)); setTo(dayStr(r?.menu_discount_to));
      if (!l) { setOcc(''); setCustom(''); }
      else if (DISCOUNT_OCCASIONS.includes(l)) { setOcc(l); setCustom(''); }
      else { setOcc('custom'); setCustom(l); }
    } catch (e) {}
  };
  useEffect(() => { load(); }, []);
  const net = (price) => Math.round(Number(price || 0) * (100 - pct) / 100);
  const label = occ === 'custom' ? custom.trim() : occ;
  const saveDisc = async (v, l, f0 = from, t0 = to) => {
    const p = Math.min(90, Math.max(0, Math.round(Number(v) || 0)));
    const lbl = String(l || '').trim().slice(0, 40);
    await api('/restaurants/' + rid, { method: 'PUT', body: { menu_discount_pct: p, menu_discount_label: lbl, menu_discount_from: f0 || null, menu_discount_to: t0 || null } });
    setPct(p); setPctInput(String(p)); setFrom(f0 || ''); setTo(t0 || '');
    if (!lbl) { setOcc(''); setCustom(''); }
  };
  const discState = !pct ? null
    : (from && from > todayStr()) ? { t: 'لم يبدأ', c: 'b-amber' }
      : (to && to < todayStr()) ? { t: 'منتهي', c: 'b-red' } : { t: 'فعّال', c: 'b-green' };
  return (
    <>
      <Card title="🏷 خصم المنيو" action={discState ? <span className={'badge ' + discState.c}>{discState.t} {(label ? label + ' — ' : '') + pct + '%'}</span> : <span className="badge b-gray">غير مفعّل</span>}>
        <div style={{ fontSize: 13, color: 'var(--mut)', marginBottom: 8 }}>
          نسبة تُخصم تلقائيًا على <b>كل أصناف المنيو</b> — تظهر للعميل بالسعر القديم مشطوبًا وبجواره السعر بعد الخصم، وتُنزل الخصم على الفاتورة تلقائيًا بلا ما يسوي العميل شيء.
          <br />اختر <b>مناسبة العرض</b> (اليوم الوطني · يوم المعلم …) وبتظهر للعميل مع الخصم وفي الفاتورة والتقارير.
          <br />📅 وحدّد <b>مدة العرض</b> (من/إلى) — يشتغل داخل المدة فقط، وبعدها يرجع السعر الأصلي تلقائيًا.
          <br />لا تؤثر على حصة المنصة (العمولة تُحسب على السعر قبل الخصم).
        </div>
        <div className="row">
          <select value={occ} onChange={(e) => { const v = e.target.value; setOcc(v); if (v !== 'custom') setCustom(''); }} style={{ minWidth: 170 }}>
            <option value="">اختر مناسبة العرض</option>
            {DISCOUNT_OCCASIONS.map(o => <option key={o} value={o}>{o}</option>)}
            <option value="custom">أخرى…</option>
          </select>
          {occ === 'custom' ? <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="اكتب مناسبة العرض" style={{ minWidth: 170 }} /> : null}
          <input type="number" min="0" max="90" value={pctInput} onChange={(e) => setPctInput(e.target.value)} style={{ width: 100 }} />
          <span style={{ color: 'var(--mut)' }}>%</span>
          <span style={{ color: 'var(--mut)', fontSize: 13 }}>📅 من</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span style={{ color: 'var(--mut)', fontSize: 13 }}>إلى</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <button className="btn sm" onClick={() => saveDisc(pctInput, label)}>💾 حفظ</button>
          {pct ? <button className="btn ghost sm" onClick={() => saveDisc(0, '')}>⛔ أوقف الخصم</button> : null}
        </div>
      </Card>
      <Card title={`الأقسام (${cats.length})`} action={<button className="btn sm" onClick={() => setCm({})}>➕ قسم</button>}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {cats.map(c => (
            <span key={c.id} className="chip">{c.icon} {c.name}
              <button className="btn ghost sm" style={{ padding: '2px 8px' }} onClick={() => setCm(c)}>✏️</button>
              <button className="btn red sm" style={{ padding: '2px 8px' }} onClick={async () => { await api('/menu/categories/' + c.id, { method: 'DELETE' }); load(); }}>🗑</button>
            </span>
          ))}
        </div>
      </Card>
      <Card title={`الأصناف (${items.length})`} action={<button className="btn sm" onClick={() => setIm({})}>➕ صنف</button>}>
        <table>
          <thead><tr><th>الصنف</th><th>القسم</th><th>السعر</th><th>شائع</th><th>متاح</th><th></th></tr></thead>
          <tbody>
            {items.map(i => (
              <tr key={i.id}>
                <td><b>{i.name}</b><br /><small style={{ color: 'var(--mut)' }}>{i.description}</small></td>
                <td>{cats.find(c => c.id === i.category_id)?.name || '—'}</td>
                <td>{pct ? <><s style={{ color: 'var(--mut)' }}>{sar(i.price)}</s> <b>{sar(net(i.price))}</b> ر.س</> : <>{sar(i.price)} ر.س</>}</td>
                <td>{i.is_popular ? '⭐' : ''}</td>
                <td>{i.is_available ? <span className="badge b-green">متاح</span> : <span className="badge b-red">نفد</span>}</td>
                <td className="row"><button className="btn ghost sm" onClick={() => setIm(i)}>✏️</button>
                  <button className="btn red sm" onClick={async () => { await api('/menu/items/' + i.id, { method: 'DELETE' }); load(); }}>🗑</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {cm && <CatForm rid={rid} c={cm.id ? cats.find(x => x.id === cm.id) : null} onClose={() => setCm(null)} onSaved={() => { setCm(null); load(); }} />}
      {im && <ItemForm rid={rid} cats={cats} i={im.id ? items.find(x => x.id === im.id) : null} onClose={() => setIm(null)} onSaved={() => { setIm(null); load(); }} />}
    </>
  );
}
function CatForm({ rid, c, onClose, onSaved }) {
  const [f, setF] = useState(c || { name: '', icon: '🍽' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={c ? 'تعديل قسم' : 'قسم جديد'} onClose={onClose}>
      <div className="form-grid">
        <Fld label="اسم القسم"><input value={f.name} onChange={set('name')} /></Fld>
        <Fld label="أيقونة"><input value={f.icon} onChange={set('icon')} /></Fld>
      </div>
      <div className="row" style={{ marginTop: 14 }}><button className="btn" onClick={async () => { if (c) await api('/menu/categories/' + c.id, { method: 'PUT', body: f }); else await api('/menu/categories', { method: 'POST', body: { ...f, restaurant_id: rid } }); onSaved(); }}>حفظ</button></div>
    </Modal>
  );
}
function ItemForm({ rid, cats, i, onClose, onSaved }) {
  const [f, setF] = useState(i || { name: '', description: '', price: 1000, category_id: cats[0]?.id || '', is_available: 1, is_popular: 0, prep_time_min: 15 });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const num = (k) => (e) => setF({ ...f, [k]: Number(e.target.value) });
  return (
    <Modal title={i ? 'تعديل صنف' : 'صنف جديد'} onClose={onClose} wide>
      <div className="form-grid">
        <Fld label="اسم الصنف"><input value={f.name} onChange={set('name')} /></Fld>
        <Fld label="القسم"><select value={f.category_id} onChange={set('category_id')}>{cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Fld>
        <Fld label="الوصف"><input value={f.description} onChange={set('description')} /></Fld>
        <Fld label="السعر (هللة)"><input type="number" value={f.price} onChange={num('price')} /></Fld>
        <Fld label="وقت التحضير (د)"><input type="number" value={f.prep_time_min} onChange={num('prep_time_min')} /></Fld>
        <Fld label="شائع"><select value={f.is_popular} onChange={num('is_popular')}><option value={1}>نعم ⭐</option><option value={0}>لا</option></select></Fld>
      </div>
      <div className="row" style={{ marginTop: 14 }}><button className="btn" onClick={async () => { if (i) await api('/menu/items/' + i.id, { method: 'PUT', body: f }); else await api('/menu/items', { method: 'POST', body: { ...f, restaurant_id: rid } }); onSaved(); }}>حفظ</button></div>
    </Modal>
  );
}

// 🔥 تبويب العروض: العرض الفعّال + إضافة عرض — كلها على شكل أيقونات
function OffersTab({ rid, onGoMenu }) {
  const [offers, setOffers] = useState([]);
  const [m, setM] = useState(null);
  const [disc, setDisc] = useState({ pct: 0, label: '' });
  const load = async () => {
    setOffers(await api('/offers?restaurant_id=' + rid));
    try {
      const r = await api('/restaurants/' + rid);
      setDisc({ pct: Number(r?.menu_discount_pct || 0), label: String(r?.menu_discount_label || '') });
    } catch (e) {}
  };
  useEffect(() => { load(); }, []);
  const active = offers.filter(o => Number(o.is_active));
  const offIcon = (o) => o.type === 'percent' ? '🏷' : o.type === 'bundle' ? '🎁' : '💸';
  const offVal = (o) => o.type === 'percent' ? `خصم ${o.value}%`
    : o.type === 'bundle' ? `باقة${o.value ? ' — ' + sar(o.value) + ' ر.س' : ''}`
    : `خصم ${sar(o.value)} ر.س`;
  return (
    <>
      <Card title="🏷 خصم المنيو — عرض فعّال" action={disc.pct ? <span className="badge b-green">فعّال {disc.pct}%</span> : <span className="badge b-gray">غير مفعّل</span>}>
        <div className="grid g3">
          <div className="tile" onClick={onGoMenu}>
            <div className="ic">🏷</div>
            <div className="t">{disc.pct ? `خصم ${disc.pct}% على المنيو كله` : 'فعّل خصم على المنيو كله'}</div>
            <div className="s">{disc.label ? `مناسبة العرض: ${disc.label}` : 'اضغط لتحديد النسبة والمناسبة'}</div>
          </div>
          <div className="tile" onClick={onGoMenu}>
            <div className="ic">🖼</div>
            <div className="t">ظهور السعر المشطوب</div>
            <div className="s">{disc.pct ? `السعر القديم مشطوب وبجواره ${disc.pct}% أقل` : 'يظهر عند تفعيل الخصم'}</div>
          </div>
        </div>
      </Card>
      <Card title={`🔥 عروض الحملات (${active.length} فعّال من ${offers.length})`}>
        <div className="grid g3">
          {offers.map(o => (
            <div key={o.id} className="tile">
              <div className="ic">{offIcon(o)}</div>
              <div className="t">{o.title}</div>
              <div className="s">{offVal(o)}{Number(o.min_order) ? ` · حد أدنى ${sar(o.min_order)} ر.س` : ''}</div>
              {offPeriod(o) ? <div className="s">{offPeriod(o)}</div> : null}
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                <span className={'badge ' + offStatus(o).c}>{offStatus(o).t}</span>
                <button className="btn ghost sm" onClick={() => setM(o)}>✏️ تعديل</button>
                <button className="btn red sm" onClick={async () => { if (!confirm('حذف العرض «' + o.title + '»؟')) return; await api('/offers/' + o.id, { method: 'DELETE' }); load(); }}>🗑</button>
              </div>
            </div>
          ))}
          <div className="tile add" onClick={() => setM({})}>
            <div className="ic">➕</div>
            <div className="t">إضافة عرض</div>
            <div className="s">نسبة % · مبلغ ثابت · باقة</div>
          </div>
        </div>
        {!offers.length ? <div className="empty">ما فيه عروض حملات بعد — اضغط «➕ إضافة عرض»، أو فعّل «خصم المنيو» من الأعلى.</div> : null}
      </Card>
      {m && <OfferForm rid={rid} o={m.id ? offers.find(x => x.id === m.id) : null} onClose={() => setM(null)} onSaved={() => { setM(null); load(); }} />}
    </>
  );
}
function OfferForm({ rid, o, onClose, onSaved }) {
  const [f, setF] = useState(o || { title: '', description: '', type: 'percent', value: 10, min_order: 0, is_active: 1 });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const num = (k) => (e) => setF({ ...f, [k]: Number(e.target.value) });
  return (
    <Modal title={o ? 'تعديل عرض' : 'عرض جديد'} onClose={onClose}>
      <div className="form-grid">
        <Fld label="العنوان"><input value={f.title} onChange={set('title')} /></Fld>
        <Fld label="الوصف"><input value={f.description} onChange={set('description')} /></Fld>
        <Fld label="النوع"><select value={f.type} onChange={set('type')}><option value="percent">نسبة %</option><option value="fixed">مبلغ ثابت</option><option value="bundle">باقة</option></select></Fld>
        <Fld label="القيمة (٪ أو هللة)"><input type="number" value={f.value} onChange={num('value')} /></Fld>
        <Fld label="الحد الأدنى (هللة)"><input type="number" value={f.min_order} onChange={num('min_order')} /></Fld>
        <Fld label="نشط"><select value={f.is_active} onChange={num('is_active')}><option value={1}>نعم</option><option value={0}>لا</option></select></Fld>
        <Fld label="يبدأ من (اختياري)"><input type="date" value={dayStr(f.starts_at)} onChange={(e) => setF({ ...f, starts_at: e.target.value })} /></Fld>
        <Fld label="ينتهي في (اختياري)"><input type="date" value={dayStr(f.ends_at)} onChange={(e) => setF({ ...f, ends_at: e.target.value })} /></Fld>
      </div>
      <div className="row" style={{ marginTop: 14 }}><button className="btn" onClick={async () => { const body = { ...f, starts_at: f.starts_at ? dayStr(f.starts_at) + ' 00:00:00' : null, ends_at: f.ends_at ? dayStr(f.ends_at) + ' 23:59:59' : null }; if (o) await api('/offers/' + o.id, { method: 'PUT', body }); else await api('/offers', { method: 'POST', body: { ...body, restaurant_id: rid } }); onSaved(); }}>حفظ</button></div>
    </Modal>
  );
}

function BranchesTab({ rid, isBranch }) {
  const [branches, setB] = useState([]);
  const [m, setM] = useState(null);
  const [mgr, setMgr] = useState(null); // نافذة إنشاء حساب مدير فرع
  const load = async () => {
    const bs = await api('/branches?restaurant_id=' + rid);
    const users = await api('/restaurants/' + rid + '/branch-users').catch(() => []);
    setB(bs.map(x => ({ ...x, manager: users.find(u => u.branch_id === x.id)?.name || null })));
  };
  useEffect(() => { load(); }, []);
  return (
    <Card title={`الفروع ونطاق التوصيل (${branches.length})`} action={<button className="btn sm" onClick={() => setM({})}>➕ فرع</button>}>
      <p style={{ fontSize: 13, color: 'var(--mut)', marginBottom: 10 }}>🏢 سلسلة مطاعم: كل فرع له <b>لوحة تحكم مستقلة</b> بحساب خاص يدير طلباته وإعداداته، والمنيو مشترك يُدار من المطعم الرئيسي.</p>
      <table>
        <thead><tr><th>الفرع</th><th>الموقع</th><th>نطاق التوصيل (الزوم)</th><th>رسوم التوصيل</th><th>حد أدنى</th><th>لوحة الفرع</th><th></th></tr></thead>
        <tbody>
          {branches.map(b => (
            <tr key={b.id}>
              <td><b>{b.name}</b></td><td>{b.city} — {(b.address || '').slice(0, 50)}</td>
              <td><span className="badge b-blue">{b.delivery_radius_km} كم</span></td>
              <td>{sar(b.delivery_fee)} ر.س</td><td>{sar(b.min_order)} ر.س</td>
              <td>{b.manager ? <span className="badge b-green">{b.manager}</span> : <button className="btn sm" onClick={() => setMgr(b)}>👤 إنشاء حساب</button>}</td>
              <td className="row"><button className="btn ghost sm" onClick={() => setM(b)}>✏️</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {m && <BranchForm rid={rid} b={m.id ? branches.find(x => x.id === m.id) : null} onClose={() => setM(null)} onSaved={() => { setM(null); load(); }} />}
      {mgr && <ManagerForm b={mgr} onClose={() => setMgr(null)} onSaved={() => { setMgr(null); load(); }} />}
    </Card>
  );
}

// إنشاء حساب مدير الفرع المستقل
function ManagerForm({ b, onClose, onSaved }) {
  const [f, setF] = useState({ name: 'مشرف ' + b.name, phone: '', password: 'branch123', role: 'supervisor' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={`إنشاء حساب لوحة فرع — ${b.name}`} onClose={onClose}>
      <p style={{ fontSize: 13, color: 'var(--mut)', marginBottom: 10 }}>كل موظف يدخل بحسابه بصلاحياته الخاصة:</p>
      <div className="form-grid">
        <Fld label="الاسم"><input value={f.name} onChange={set('name')} /></Fld>
        <Fld label="الجوال (بيانات الدخول)"><input value={f.phone} onChange={set('phone')} /></Fld>
        <Fld label="كلمة المرور"><input value={f.password} onChange={set('password')} /></Fld>
        <Fld label="الدور">
          <select value={f.role} onChange={set('role')}>
            <option value="supervisor">🛠 مشرف الفرع — طلبات وإعدادات وتقارير فرعه</option>
            <option value="quality">⭐ مدير الجودة — تقييمات العملاء ومدى وصول الطلبات والتقارير</option>
            <option value="cashier">💵 الكاشير — طلبات الفرع فقط (بدون تقارير)</option>
          </select>
        </Fld>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" onClick={async () => {
          try { await api('/auth/register-branch-user', { method: 'POST', body: { branch_id: b.id, name: f.name, phone: f.phone, password: f.password, role: f.role } }); notify('✅ تم إنشاء الحساب'); onSaved(); }
          catch (e) { notify(e.message); }
        }}>حفظ الحساب</button>
      </div>
    </Modal>
  );
}

// لوحة الفرع المستقلة: إعدادات فرعي
function MyBranch({ rid, branchId }) {
  const [b, setB] = useState(null);
  const [m, setM] = useState(false);
  const load = async () => { const rows = await api('/branches?restaurant_id=' + rid); setB(rows.find(x => x.id === branchId) || rows[0]); };
  useEffect(() => { load(); }, []);
  if (!b) return <div className="empty">تحميل…</div>;
  return (
    <Card title={`إعدادات فرعي — ${b.name}`} action={<button className="btn sm" onClick={() => setM(true)}>✏️ تعديل</button>}>
      <div className="grid g2">
        <div><b>العنوان:</b> {b.city} — {b.address}</div>
        <div><b>نطاق التوصيل (الزوم):</b> <span className="badge b-blue">{b.delivery_radius_km} كم</span></div>
        <div><b>رسوم التوصيل:</b> {sar(b.delivery_fee)} ر.س</div>
        <div><b>الحد الأدنى:</b> {sar(b.min_order)} ر.س</div>
        <div><b>هاتف الفرع:</b> {b.phone || '—'}</div>
      </div>
      {m && <BranchForm rid={rid} b={b} onClose={() => setM(false)} onSaved={() => { setM(false); load(); }} />}
    </Card>
  );
}
function BranchForm({ rid, b, onClose, onSaved }) {
  const [f, setF] = useState(b || { name: '', city: 'الرياض', address: '', lat: '', lng: '', delivery_radius_km: 15, delivery_fee: 1000, min_order: 3000 });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={b ? 'تعديل فرع' : 'فرع جديد'} onClose={onClose} wide>
      <div className="form-grid">
        <Fld label="اسم الفرع"><input value={f.name} onChange={set('name')} /></Fld>
        <Fld label="المدينة"><input value={f.city} onChange={set('city')} /></Fld>
        <Fld label="العنوان"><input value={f.address || ''} onChange={set('address')} /></Fld>
        <Fld label="خط العرض"><input value={f.lat || ''} onChange={set('lat')} /></Fld>
        <Fld label="خط الطول"><input value={f.lng || ''} onChange={set('lng')} /></Fld>
        <Fld label="نطاق التوصيل (كم)"><input type="number" value={f.delivery_radius_km} onChange={set('delivery_radius_km')} /></Fld>
        <Fld label="رسوم التوصيل (هللة)"><input type="number" value={f.delivery_fee} onChange={set('delivery_fee')} /></Fld>
        <Fld label="حد أدنى (هللة)"><input type="number" value={f.min_order} onChange={set('min_order')} /></Fld>
      </div>
      <div className="row" style={{ marginTop: 14 }}><button className="btn" onClick={async () => {
        const body = { ...f, restaurant_id: rid, lat: f.lat ? Number(f.lat) : null, lng: f.lng ? Number(f.lng) : null, delivery_radius_km: Number(f.delivery_radius_km), delivery_fee: Number(f.delivery_fee), min_order: Number(f.min_order) };
        if (b) await api('/branches/' + b.id, { method: 'PUT', body }); else await api('/branches', { method: 'POST', body });
        onSaved();
      }}>حفظ</button></div>
    </Modal>
  );
}

function ChatsTab({ rid, branchId }) {
  const [rows, setRows] = useState([]);
  useEffect(() => { api('/restaurants/' + rid + '/conversations' + (branchId ? '?branch_id=' + branchId : '')).then(setRows); }, []);
  return (
    <Card title="كل محادثات الطلبات (محفوظة)">
      <div className="msg-bubble">
        {rows.slice(0, 80).map(m => (
          <div key={m.id} className={`m ${m.direction === 'in' ? 'in' : 'out'}`}>
            <small>{m.order_no || ''} · {m.message_type} · {m.direction === 'in' ? 'من العميل' : 'إلى العميل'}</small>
            {m.body || '(رسالة تفاعلية)'}<small>{m.created_at}</small>
          </div>
        ))}
        {!rows.length && <div className="empty">لا توجد محادثات بعد</div>}
      </div>
    </Card>
  );
}

function OrderModal({ o, onClose, refresh }) {
  const { notify } = useApp();
  const [d, setD] = useState(null);
  const [captains, setCaptains] = useState([]);
  useEffect(() => { api('/orders/' + o.id).then(setD); }, [o.id]);
  useEffect(() => { api('/captains').then(setCaptains).catch(() => {}); }, []);
  if (!d) return <Modal title={o.order_no} onClose={onClose}><div className="empty">…</div></Modal>;

  const act = async (fn) => { try { await fn(); refresh(); const fresh = await api('/orders/' + o.id); setD(fresh); } catch (e) { notify(e.message); } };
  const accepted = (d.offers || []).filter(x => x.status === 'accepted');

  // 🖨 الإيصال الحراري (بدون ختم) — مقاس طابعة الكاشير
  const receiptBlobUrl = async () => {
    const res = await fetch('/api/orders/' + d.id + '/receipt.png', { headers: { Authorization: 'Bearer ' + getToken() } });
    if (!res.ok) throw new Error('تعذّر إنشاء الإيصال');
    return URL.createObjectURL(await res.blob());
  };
  const printReceipt = async () => {
    try {
      const url = await receiptBlobUrl();
      const w = window.open('', '_blank');
      if (!w) { notify('اسمح بالنوافذ المنبثقة للطباعة'); return; }
      w.document.write(`<html dir="rtl"><head><title>إيصال ${d.order_no}</title><style>@page{size:80mm auto;margin:2mm}html,body{margin:0;background:#fff}img{width:76mm;display:block;margin:0 auto}</style></head><body><img src="${url}" onload="setTimeout(function(){window.print()},350)"></body></html>`);
      w.document.close();
      notify('🖨 جاهز للطباعة');
      await api('/orders/' + d.id + '/receipt/send', { method: 'POST' });
      notify('📤 وأرسلنا نسخة الإيصال للعميل');
    } catch (e) { notify(e.message); }
  };
  const sendReceipt = async () => { try { await api('/orders/' + d.id + '/receipt/send', { method: 'POST' }); notify('📤 أُرسل الإيصال للعميل'); } catch (e) { notify(e.message); } };

  return (
    <Modal title={`${d.order_no} — ${d.restaurant_name || ''}`} onClose={onClose} wide>
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <Badge s={d.status} /> <Pay m={d.payment_method} />
        {d.payment_status === 'paid' ? <span className="badge b-green">مدفوع ✅</span> : <span className="badge b-amber">انتظار دفع</span>}
        <Money h={d.total} />
        <span className="chip">🕐 {d.est_delivery_min} د</span>
        <span className="chip">🏪 {d.branch_name}</span>
      </div>

      {/* أزرار الحالة للمطعم */}
      {['new', 'confirmed', 'preparing'].includes(d.status) && (
        <div className="row" style={{ marginBottom: 12 }}>
          {d.status === 'new' && <button className="btn" onClick={() => act(() => api('/orders/' + d.id + '/status', { method: 'POST', body: { status: 'confirmed' } }))}>✔️ تأكيد الطلب</button>}
          {d.status === 'confirmed' && <button className="btn" onClick={() => act(() => api('/orders/' + d.id + '/status', { method: 'POST', body: { status: 'preparing' } }))}>👨‍🍳 بدء التحضير</button>}
          {d.status === 'preparing' && <button className="btn" onClick={() => act(() => api('/orders/' + d.id + '/status', { method: 'POST', body: { status: 'ready' } }))}>📦 جاهز</button>}
          {d.status !== 'delivered' && d.status !== 'cancelled' && !d.captain_id && (
            <button className="btn" style={{ background: '#e65100', color: '#fff' }} onClick={() => act(async () => {
              const r = await api('/orders/' + d.id + '/redispatch', { method: 'POST', body: {} });
              notify(r?.offered ? `🛵 ${r.note || ''}` : `⚠️ ${r?.note || 'ما فيه كابتن متاح'}`);
            })}>🛵 إعادة البحث عن كابتن</button>
          )}
          <button className="btn" style={{ background: '#37474f', color: '#fff' }} onClick={printReceipt}>🖨 اطبع الإيصال</button>
          <button className="btn ghost" onClick={sendReceipt}>📤 أرسل الإيصال للعميل</button>
          <button className="btn red" onClick={() => act(() => api('/orders/' + d.id + '/cancel', { method: 'POST', body: { reason: 'إلغاء من المطعم' } }))}>إلغاء</button>
        </div>
      )}

      {/* قبول الكباتن + التحويل */}
      {['offered', 'accepted'].includes(d.status) && (
        <Card title="🛵 قبول الكباتن للطلب — حوّل الطلب على الكابتن المناسب">
          {(d.offers || []).filter(x => x.status === 'offered' || x.status === 'accepted').map(x => (
            <div key={x.id} className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <span>{x.captain_name || 'كابتن ' + x.captain_id} {x.status === 'accepted' && <span className="badge b-green">قبل ✅</span>}</span>
              {x.status === 'accepted' && <button className="btn sm" onClick={() => act(() => api('/orders/' + d.id + '/assign', { method: 'POST', body: { captain_id: x.captain_id } }))}>تحويل الطلب عليه ⬅️</button>}
            </div>
          ))}
          {!accepted.length && <div className="empty">بانتظار قبول الكباتن… (يصل الطلب لكل الكباتن المتاحين تلقائياً)</div>}
        </Card>
      )}

      <div className="grid g2">
        <div>
          <h4 style={{ marginBottom: 8 }}>🧾 الأصناف</h4>
          {(d.items || []).map((i, k) => <div key={k} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}><span>{i.name} ×{i.quantity}</span><span>{sar(i.price * i.quantity)} ر.س</span></div>)}
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}><b>الإجمالي</b><b>{sar(d.total)} ر.س</b></div>
          <h4 style={{ margin: '14px 0 8px' }}>📍 التوصيل</h4>
          <div style={{ fontSize: 13.5, lineHeight: 1.9 }}>{d.national_address || `${d.lat},${d.lng}`}<br />العميل: {d.customer?.name} — {d.customer?.phone}</div>
          {d.captain && <div style={{ fontSize: 13.5, marginTop: 8 }}>🛵 الكابتن: {d.captain.name} — {d.captain.phone}</div>}
          {d.contact_reported_at
            ? <div style={{ fontSize: 13, marginTop: 8, color: '#b3261e' }}>🚫 العميل أبلغ عن إزعاج — التواصل موقوف في هذا الطلب</div>
            : d.contact_pref === 'voice' ? <div style={{ fontSize: 13, marginTop: 8 }}>🎤 التواصل مع الكابتن عبر البوت (رقم العميل مخفي)</div>
            : d.contact_pref === 'call' ? <div style={{ fontSize: 13, marginTop: 8 }}>📞 العميل سمح للكابتن بالاتصال — لهذا الطلب فقط</div>
            : d.contact_pref === 'none' ? <div style={{ fontSize: 13, marginTop: 8 }}>🚫 العميل طلب عدم التواصل</div>
            : <div style={{ fontSize: 13, marginTop: 8, color: '#8a6d00' }}>⏳ لم يحدد العميل طريقة التواصل — يُفترض إخفاء الرقم</div>}
          {d.rating_restaurant && <div style={{ fontSize: 13.5, marginTop: 8 }}>⭐ تقييم العميل: مطعم {'⭐'.repeat(d.rating_restaurant)} · سرعة {'⭐'.repeat(d.rating_speed || 0)} · كابتن {'⭐'.repeat(d.rating_captain || 0)}</div>}
          {d.status === 'cancelled' && (
            <div style={{ fontSize: 13.5, marginTop: 10, background: '#fde8e8', border: '1px solid #f5c6c6', borderRadius: 10, padding: 10 }}>
              ❌ <b>أُلغي الطلب</b> — استبيان العميل:<br />
              السبب: <b>{d.cancel_reason || '—'}</b>{d.cancel_note ? <><br />التفاصيل: {d.cancel_note}</> : null}
            </div>
          )}
        </div>
        <div>
          <h4 style={{ marginBottom: 8 }}>🕐 مسار الطلب + المحادثة</h4>
          <div className="timeline">
            {(d.events || []).map(e => <div key={e.id} className="ev"><div className="dot" /><div><p>{e.message}</p><small>{e.created_at}</small></div></div>)}
          </div>
          <h4 style={{ margin: '12px 0 8px' }}>💬 المحادثة (محفوظة)</h4>
          <div className="msg-bubble" style={{ maxHeight: 200, overflow: 'auto' }}>
            {(d.conversations || []).slice(-15).map(m => (
              <div key={m.id} className={`m ${m.direction === 'in' ? 'in' : 'out'}`}>
                {m.body || `[${m.message_type}]`}<small>{m.created_at}</small>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ===== التقارير (يومي/أسبوعي/شهري/ربع سنوي/نصف سنوي/سنوي) =====
const PERIODS = [['daily', '📅 يومي'], ['weekly', '📆 أسبوعي'], ['monthly', '🗓 شهري'], ['quarterly', '📊 ربع سنوي (3 أشهر)'], ['semiannual', '📈 نصف سنوي (6 أشهر)'], ['annual', '📉 سنوي']];
const SAR = (h) => (h / 100).toFixed(2);
const reportDate = (t) => t ? t.slice(0, 16) : '—';

function ReportsTab({ user, rid }) {
  const [period, setPeriod] = useState('daily');
  const [data, setData] = useState(null);
  const [orders, setOrders] = useState([]);
  const branchQ = user.branch_id ? '&branch_id=' + user.branch_id : '';
  const load = async () => {
    const [d, o] = await Promise.all([
      api('/reports/summary?period=' + period + branchQ),
      api('/reports/orders?period=' + period + branchQ)
    ]);
    setData(d); setOrders(o);
  };
  useEffect(() => { load().catch(e => notify(e.message)); }, [period]);
  const s = data?.summary;
  return (
    <>
      <Card title="📋 التقارير" action={
        <div className="row">
          <select value={period} onChange={e => setPeriod(e.target.value)} style={{ width: 200 }}>
            {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <button className="btn" onClick={() => window.print()}>🖨 طباعة / PDF</button>
        </div>
      }>
        <div className="report-print">
          <div style={{ textAlign: 'center', marginBottom: 14 }}>
            <h3 style={{ margin: 0 }}>تقرير {user.restaurant_name}{user.branch_name ? ' — فرع ' + user.branch_name : ''}</h3>
            <small style={{ color: 'var(--mut)' }}>الفترة: {data?.period?.label} — تاريخ الإصدار: {new Date().toLocaleDateString('ar-SA')}</small>
          </div>
          {s && (
            <>
              <div className="kpi">
                <Stat n={s.orders} l="عدد الطلبات" />
                <Stat n={SAR(s.revenue) + ' ر.س'} l="الإيراد" color="#0b7a3b" />
                <Stat n={s.rest_rating ? s.rest_rating.toFixed(1) + ' ⭐' : '—'} l="تقييم المطعم" color="#ef6c00" />
                <Stat n={s.speed_rating ? s.speed_rating.toFixed(1) + ' ⭐' : '—'} l="تقييم السرعة" color="#1565c0" />
                <Stat n={s.cap_rating ? s.cap_rating.toFixed(1) + ' ⭐' : '—'} l="تقييم الكابتن" color="#8e24aa" />
                <Stat n={(s.rated || 0) + ' تقييم'} l="عدد التقييمات" color="#546e7a" />
              </div>
              <div className="grid g3" style={{ marginBottom: 14 }}>
                <Card title="🚚 مدى وصول الطلبات">
                  <div style={{ fontSize: 13.5, lineHeight: 2 }}>
                    إجمالي الطلبات: <b>{s.orders}</b><br />
                    وصلت للعميل: <b>{data?.delivery?.reached || 0}</b> ({s.orders ? Math.round((data?.delivery?.reached || 0) / s.orders * 100) : 0}%)<br />
                    تم تسليمها: <b>{data?.delivery?.delivered || 0}</b><br />
                    ملغاة/معلقة: <b>{s.orders - (data?.delivery?.reached || 0)}</b>
                  </div>
                </Card>
                <Card title="💳 طرق الدفع">
                  {data.payments.map(p => (
                    <div key={p.payment_method} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                      <span>{payAr[p.payment_method] || p.payment_method}</span><b>{p.c} طلب — {SAR(p.rev)} ر.س</b>
                    </div>
                  ))}
                </Card>
                <Card title="🏆 الأصناف الأكثر طلباً">
                  {data.top.map((t, i) => <div key={i} style={{ padding: '3px 0', fontSize: 13.5 }}>{i + 1}. {t.name} ×{t.qty}</div>)}
                </Card>
                <Card title={`❌ الطلبات الملغاة وأسبابها (${data.cancelTotal || 0})`}>
                  {(data.cancellations || []).map((c, i) => (
                    <div key={i} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                      <span>{c.cancel_reason}</span><b>{c.c} طلب</b>
                    </div>
                  ))}
                  {!data.cancellations?.length && <div style={{ fontSize: 13, color: 'var(--mut)' }}>لا توجد إلغاءات في هذه الفترة ✅</div>}
                </Card>
              </div>
              <h4 style={{ margin: '10px 0 8px' }}>📦 تفاصيل الطلبات ({orders.length})</h4>
              <table style={{ fontSize: 12.5 }}>
                <thead><tr><th>الطلب</th><th>العميل</th><th>الفرع</th><th>المبلغ</th><th>الدفع</th><th>الحالة</th><th>الوقت</th><th>تقييم</th></tr></thead>
                <tbody>
                  {orders.map(o => (
                    <tr key={o.id}>
                      <td><b>{o.order_no}</b></td><td>{o.customer_name || '—'}</td><td>{o.branch || '—'}</td>
                      <td>{SAR(o.total)} ر.س</td><td>{payAr[o.payment_method] || o.payment_method}</td>
                      <td><Badge s={o.status} /></td><td>{reportDate(o.created_at)}</td>
                      <td>{o.rating_restaurant ? '⭐'.repeat(o.rating_restaurant) : '—'}</td>
                    </tr>
                  ))}
                  {!orders.length && <tr><td colSpan={8} className="empty">لا توجد طلبات في هذه الفترة</td></tr>}
                </tbody>
              </table>
            </>
          )}
        </div>
      </Card>
    </>
  );
}

// ===== تقييمات العملاء + جودة التوصيل (مدير الجودة) =====
function RatingsTab({ user, rid }) {
  const [period, setPeriod] = useState('weekly');
  const [rows, setRows] = useState([]);
  const branchQ = user.branch_id ? '&branch_id=' + user.branch_id : '';
  const load = async () => setRows(await api('/reports/ratings?period=' + period + branchQ));
  useEffect(() => { load().catch(e => notify(e.message)); }, [period]);
  const avg = (k) => { const v = rows.map(r => r[k]).filter(Boolean); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : '—'; };
  return (
    <>
      <div className="kpi">
        <Stat n={rows.length} l="التقييمات في الفترة" />
        <Stat n={avg('rating_restaurant') + ' ⭐'} l="متوسط تقييم المطعم" color="#ef6c00" />
        <Stat n={avg('rating_speed') + ' ⭐'} l="متوسط تقييم السرعة" color="#1565c0" />
        <Stat n={avg('rating_captain') + ' ⭐'} l="متوسط تقييم الكابتن" color="#8e24aa" />
      </div>
      <Card title="⭐ تقييمات العملاء ومدى وصول الطلبات" action={
        <div className="row">
          <select value={period} onChange={e => setPeriod(e.target.value)} style={{ width: 200 }}>
            {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <button className="btn" onClick={() => window.print()}>🖨 طباعة</button>
        </div>
      }>
        <div className="report-print">
          <table>
            <thead><tr><th>الطلب</th><th>العميل</th><th>الفرع</th><th>المطعم</th><th>السرعة</th><th>الكابتن</th><th>تعليق</th><th>الوصول</th></tr></thead>
            <tbody>
              {rows.map(o => (
                <tr key={o.id}>
                  <td><b>{o.order_no}</b></td><td>{o.customer_name || '—'}</td><td>{o.branch || '—'}</td>
                  <td>{o.rating_restaurant ? '⭐'.repeat(o.rating_restaurant) : '—'}</td>
                  <td>{o.rating_speed ? '⭐'.repeat(o.rating_speed) : '—'}</td>
                  <td>{o.rating_captain ? '⭐'.repeat(o.rating_captain) : '—'}</td>
                  <td style={{ maxWidth: 200 }}>{o.rating_comment || '—'}</td>
                  <td>{o.arrived_at ? reportDate(o.arrived_at) : '—'}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={8} className="empty">لا توجد تقييمات في هذه الفترة</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
