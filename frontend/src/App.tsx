import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, auth, User } from './api';
import Admin from './pages/Admin';
import Login from './pages/Login';
import ProjectDetail from './pages/ProjectDetail';
import Projects from './pages/Projects';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(!auth.get());
  const nav = useNavigate();

  useEffect(() => {
    if (!auth.get()) return;
    api<User>('/auth/me').then(setUser).catch(() => auth.clear()).finally(() => setReady(true));
  }, []);

  if (!ready) return null;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<Login onLogin={setUser} />} />
      </Routes>
    );
  }

  const logout = () => {
    auth.clear();
    setUser(null);
    nav('/login');
  };

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-8 flex items-center justify-between border-b border-slate-800 pb-4">
        <nav className="flex items-center gap-6">
          <Link to="/" className="text-xl font-bold">DevFlow</Link>
          <Link to="/" className="text-sm text-slate-400 hover:text-slate-200">Projects</Link>
          {user.role === 'ADMIN' && <Link to="/admin" className="text-sm text-slate-400 hover:text-slate-200">Admin</Link>}
        </nav>
        <div className="flex items-center gap-4 text-sm text-slate-400">
          <span>{user.email} <span className="rounded bg-slate-800 px-1.5 text-xs">{user.role}</span></span>
          <button onClick={logout} className="hover:text-slate-200">Sign out</button>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/admin" element={user.role === 'ADMIN' ? <Admin me={user} /> : <Navigate to="/" />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </div>
  );
}
