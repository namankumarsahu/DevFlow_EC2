import { useEffect, useState } from 'react';
import { api, fmtDuration, User } from '../api';

type Stats = {
  users: number; projects: number;
  deployments: { total: number; byStatus: Record<string, number>; successRate: number | null; avgDurationMs: number | null };
  last7Days: { date: string; total: number; success: number; failed: number }[];
};
type AdminUser = User & { _count: { projects: number } };

export default function Admin({ me }: { me: User }) {
  const [stats, setStats] = useState<Stats>();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState('');

  const load = () => {
    api<Stats>('/admin/stats').then(setStats).catch((e) => setError(e.message));
    api<AdminUser[]>('/admin/users').then(setUsers).catch(() => undefined);
  };
  useEffect(load, []);

  const run = (fn: () => Promise<unknown>) => fn().then(load).catch((e) => setError(e.message));
  if (!stats) return <p className="text-slate-500">{error || 'Loading…'}</p>;

  const max = Math.max(1, ...stats.last7Days.map((d) => d.total));
  const card = (label: string, value: string | number) => (
    <div className="rounded-lg border border-slate-800 p-4">
      <div className="text-xs uppercase text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );

  return (
    <div className="space-y-8">
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <div className="grid gap-4 md:grid-cols-5">
        {card('Users', stats.users)}
        {card('Projects', stats.projects)}
        {card('Deployments', stats.deployments.total)}
        {card('Success rate', stats.deployments.successRate == null ? '—' : `${Math.round(stats.deployments.successRate * 100)}%`)}
        {card('Avg build', fmtDuration(stats.deployments.avgDurationMs))}
      </div>

      <section className="rounded-lg border border-slate-800 p-4">
        <h3 className="mb-4 font-semibold">Deployments — last 7 days</h3>
        <div className="flex h-40 items-end gap-3">
          {stats.last7Days.map((d) => (
            <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
              <div className="flex w-full flex-1 flex-col justify-end" title={`${d.success} ok / ${d.failed} failed / ${d.total} total`}>
                <div className="bg-rose-500/70" style={{ height: `${(d.failed / max) * 100}%` }} />
                <div className="bg-emerald-500/70" style={{ height: `${(d.success / max) * 100}%` }} />
              </div>
              <span className="text-xs text-slate-500">{d.date.slice(5)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900 text-xs uppercase text-slate-400">
            <tr><th className="p-3">Email</th><th>Role</th><th>Projects</th><th>Joined</th><th></th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-slate-800">
                <td className="p-3">{u.email}</td>
                <td>{u.role}</td>
                <td>{u._count.projects}</td>
                <td className="text-xs text-slate-400">{new Date(u.createdAt).toLocaleDateString()}</td>
                <td className="space-x-2 pr-3 text-right">
                  {u.id !== me.id && (
                    <>
                      <button className="text-xs text-indigo-300" onClick={() => run(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { role: u.role === 'ADMIN' ? 'USER' : 'ADMIN' } }))}>
                        make {u.role === 'ADMIN' ? 'user' : 'admin'}
                      </button>
                      <button className="text-xs text-rose-400" onClick={() => confirm(`Delete ${u.email}?`) && run(() => api(`/admin/users/${u.id}`, { method: 'DELETE' }))}>delete</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
