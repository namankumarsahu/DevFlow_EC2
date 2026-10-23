import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Project } from '../api';

export default function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [form, setForm] = useState({ name: '', repoUrl: '', branch: 'main', environment: 'PRODUCTION', containerPort: 3000 });
  const [error, setError] = useState('');

  const load = () => api<Project[]>('/projects').then(setProjects);
  useEffect(() => void load(), []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/projects', { method: 'POST', body: form });
      setForm({ ...form, name: '', repoUrl: '' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const input = 'rounded bg-slate-900 px-3 py-2 text-sm';
  return (
    <div className="space-y-8">
      <form onSubmit={create} className="grid gap-3 rounded-lg border border-slate-800 p-4 md:grid-cols-6">
        <input className={`${input} md:col-span-1`} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <input className={`${input} md:col-span-2`} placeholder="https://github.com/owner/repo" value={form.repoUrl} onChange={(e) => setForm({ ...form, repoUrl: e.target.value })} required />
        <input className={input} placeholder="Branch" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
        <select className={input} value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}>
          <option>DEVELOPMENT</option><option>STAGING</option><option>PRODUCTION</option>
        </select>
        <input className={input} type="number" title="Container port" value={form.containerPort} onChange={(e) => setForm({ ...form, containerPort: Number(e.target.value) })} />
        <button className="rounded bg-indigo-600 py-2 text-sm font-medium hover:bg-indigo-500 md:col-span-6">Create project</button>
        {error && <p className="text-sm text-rose-400 md:col-span-6">{error}</p>}
      </form>

      <div className="grid gap-4 md:grid-cols-2">
        {projects.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="rounded-lg border border-slate-800 p-4 hover:border-indigo-500">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{p.name}</h3>
              <span className="rounded bg-slate-800 px-2 py-0.5 text-xs">{p.environment}</span>
            </div>
            <p className="mt-1 truncate text-sm text-slate-400">{p.repoUrl} · {p.branch}</p>
          </Link>
        ))}
        {projects.length === 0 && <p className="text-slate-500">No projects yet — create one above.</p>}
      </div>
    </div>
  );
}
