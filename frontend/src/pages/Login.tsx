import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, auth, User } from '../api';

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const nav = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ token: string; user: User }>(`/auth/${mode}`, { method: 'POST', body: { email, password } });
      auth.set(r.token);
      onLogin(r.user);
      nav('/');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="mx-auto mt-24 max-w-sm">
      <h1 className="mb-1 text-3xl font-bold">DevFlow</h1>
      <p className="mb-6 text-sm text-slate-400">Self-hosted deployments from GitHub, one click.</p>
      <form onSubmit={submit} className="space-y-3">
        <input className="w-full rounded bg-slate-900 px-3 py-2" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="w-full rounded bg-slate-900 px-3 py-2" type="password" placeholder="Password (min 8 chars)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button className="w-full rounded bg-indigo-600 py-2 font-medium hover:bg-indigo-500">{mode === 'login' ? 'Sign in' : 'Create account'}</button>
      </form>
      <button className="mt-4 text-sm text-slate-400 hover:text-slate-200" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'No account? Register' : 'Have an account? Sign in'}
      </button>
    </div>
  );
}
