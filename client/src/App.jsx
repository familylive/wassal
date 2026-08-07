import React, { createContext, useContext, useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { io } from 'socket.io-client';
import { api, getToken, clearToken } from './api.js';
import Login from './pages/Login.jsx';
import Admin from './pages/Admin.jsx';
import Restaurant from './pages/Restaurant.jsx';
import Captain from './pages/Captain.jsx';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export function notify(msg) {
  const el = document.createElement('div');
  el.className = 'notif'; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [socket, setSocket] = useState(null);
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    if (!getToken()) { setReady(true); return; }
    api('/auth/me').then(d => setUser(d.user)).catch(() => clearToken()).finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!user) return;
    const s = io('/', { auth: { role: user.role, restaurant_id: user.restaurant_id, captain_id: user.captain_id } });
    setSocket(s);
    return () => s.disconnect();
  }, [user]);

  const logout = () => { clearToken(); setUser(null); nav('/'); };

  if (!ready) return <div className="empty">تحميل…</div>;
  if (!user) return <Login onLogin={setUser} />;

  // أدوار السلسلة كلها تذهب للوحة المطعم/الفرع
  const isRestaurant = ['restaurant', 'owner', 'manager', 'supervisor', 'quality', 'cashier'].includes(user.role);
  const home = user.role === 'admin' ? '/admin' : isRestaurant ? '/restaurant' : '/captain';
  if (loc.pathname === '/') return <Navigate to={home} replace />;
  if (user.role === 'admin' && !loc.pathname.startsWith('/admin')) return <Navigate to="/admin" replace />;
  if (isRestaurant && !loc.pathname.startsWith('/restaurant')) return <Navigate to="/restaurant" replace />;
  if (user.role === 'captain' && !loc.pathname.startsWith('/captain')) return <Navigate to="/captain" replace />;

  return (
    <Ctx.Provider value={{ user, socket, logout, notify }}>
      <Routes>
        <Route path="/admin/*" element={<Admin />} />
        <Route path="/restaurant/*" element={<Restaurant />} />
        <Route path="/captain/*" element={<Captain />} />
      </Routes>
    </Ctx.Provider>
  );
}
