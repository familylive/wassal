import React, { useState } from 'react';
import { api, setToken } from '../api.js';

export default function Login({ onLogin }) {
  const [identifier, setI] = useState('');
  const [password, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const d = await api('/auth/login', { method: 'POST', body: { identifier, password } });
      setToken(d.token); onLogin(d.user);
    } catch (ex) { setErr(ex.message); }
    setBusy(false);
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <img src="/logo.png" alt="واتس هم" style={{ width: 210, height: 210, borderRadius: '50%', boxShadow: '0 10px 30px rgba(0,0,0,.2)', marginBottom: 8 }} />
          <p>منصة طلبات المطاعم عبر واتساب — من الطلب حتى التقيم</p>
        </div>
        <div style={{ display: 'grid', gap: 12 }}>
          <input placeholder="البريد الإلكتروني أو رقم الجوال" value={identifier} onChange={e => setI(e.target.value)} required />
          <input placeholder="كلمة المرور" type="password" value={password} onChange={e => setP(e.target.value)} required />
          {err && <div style={{ color: 'var(--red)', fontSize: 13 }}>{err}</div>}
          <button className="btn" disabled={busy} style={{ padding: 12 }}>{busy ? '…' : 'دخول'}</button>
        </div>
        <div style={{ marginTop: 18, fontSize: 12, color: 'var(--mut)', textAlign: 'center', lineHeight: 1.8 }}>
          كنترول: admin@wassal.app / admin123<br />
          مطعم: 0551000001 / rest1 &nbsp;|&nbsp; كابتن: 0561111111 / captain123
        </div>
      </form>
    </div>
  );
}
