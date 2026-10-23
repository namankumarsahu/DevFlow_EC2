import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, Deployment, fmtDuration, Limits, LimitsInfo, Preview, Project } from '../api';
import LogViewer from '../components/LogViewer';
import StatusBadge from '../components/StatusBadge';

const ACTIVE = ['QUEUED', 'BUILDING', 'DEPLOYING'];

export default function ProjectDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [project, setProject] = useState<Project>();
  const [deps, setDeps] = useState<Deployment[]>([]);
  const [envKeys, setEnvKeys] = useState<{ key: string }[]>([]);
  const [selected, setSelected] = useState<string>();
  const [envForm, setEnvForm] = useState({ key: '', value: '' });
  const [error, setError] = useState('');
  const [limitsInfo, setLimitsInfo] = useState<LimitsInfo>();
  const [limitsForm, setLimitsForm] = useState<Limits>();
  const [limitsSaved, setLimitsSaved] = useState(false);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [ghToken, setGhToken] = useState('');

  const refresh = useCallback(async () => {
    setDeps(await api<Deployment[]>(`/projects/${id}/deployments`));
    setProject(await api<Project>(`/projects/${id}`));
    setPreviews(await api<Preview[]>(`/projects/${id}/previews`));
  }, [id]);

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    api<{ key: string }[]>(`/projects/${id}/env`).then(setEnvKeys);
    api<LimitsInfo>('/projects/limits').then(setLimitsInfo).catch(() => undefined);
    const t = setInterval(() => refresh().catch(() => undefined), 3000);
    return () => clearInterval(t);
  }, [id, refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await refresh(); } catch (e) { setError((e as Error).message); }
  };

  const deploy = () => act(async () => setSelected((await api<Deployment>(`/projects/${id}/deploy`, { method: 'POST' })).id));
  const rollback = (d: Deployment) => act(async () => setSelected((await api<Deployment>(`/deployments/${d.id}/rollback`, { method: 'POST' })).id));
  const cancel = (d: Deployment) => act(() => api(`/deployments/${d.id}/cancel`, { method: 'POST' }));

  async function saveEnv(e: FormEvent) {
    e.preventDefault();
    await act(() => api(`/projects/${id}/env`, { method: 'PUT', body: envForm }));
    setEnvForm({ key: '', value: '' });
    setEnvKeys(await api(`/projects/${id}/env`));
  }
  // Fill the limits form once, from the first load of the project (the 3s refresh must not overwrite typing).
  useEffect(() => {
    if (project && !limitsForm) setLimitsForm({ memoryMb: project.memoryMb, cpus: project.cpus, diskMb: project.diskMb });
  }, [project, limitsForm]);

  async function saveLimits(e: FormEvent) {
    e.preventDefault();
    if (!limitsForm) return;
    setLimitsSaved(false);
    await act(() => api(`/projects/${id}`, { method: 'PATCH', body: limitsForm }));
    setLimitsSaved(true);
  }
  const togglePreviews = (on: boolean) => act(() => api(`/projects/${id}`, { method: 'PATCH', body: { previewsEnabled: on } }));
  async function saveToken(e: FormEvent) {
    e.preventDefault();
    await act(() => api(`/projects/${id}/github-token`, { method: 'PUT', body: { token: ghToken } }));
    setGhToken('');
  }
  const removeToken = () => act(() => api(`/projects/${id}/github-token`, { method: 'DELETE' }));
  const closePreview = (p: Preview) => act(() => api(`/projects/${id}/previews/${p.id}`, { method: 'DELETE' }));
  async function delEnv(key: string) {
    await api(`/projects/${id}/env/${key}`, { method: 'DELETE' });
    setEnvKeys(await api(`/projects/${id}/env`));
  }
  async function remove() {
    if (!confirm('Delete project and stop its container?')) return;
    await api(`/projects/${id}`, { method: 'DELETE' });
    nav('/');
  }

  if (!project) return <p className="text-slate-500">{error || 'Loading…'}</p>;
  const btn = 'rounded px-2 py-1 text-xs';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold">{project.name}</h2>
          <p className="text-sm text-slate-400">{project.repoUrl} · {project.branch} · {project.environment}</p>
          {project.slug && project.currentDeploymentId && (
            <a className="text-sm text-indigo-400 hover:underline" target="_blank" rel="noreferrer"
               href={`${location.protocol}//${project.slug}.${location.hostname}`}>
              {project.slug}.{location.hostname} ↗
            </a>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={deploy} className="rounded bg-indigo-600 px-4 py-2 font-medium hover:bg-indigo-500">Deploy</button>
          <button onClick={remove} className="rounded border border-rose-800 px-4 py-2 text-rose-300 hover:bg-rose-950">Delete</button>
        </div>
      </div>
      {error && <p className="text-sm text-rose-400">{error}</p>}

      <section className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900 text-xs uppercase text-slate-400">
            <tr><th className="p-3">Status</th><th>Commit</th><th>Duration</th><th>URL</th><th>Started</th><th></th></tr>
          </thead>
          <tbody>
            {deps.map((d) => (
              <tr key={d.id} className={`border-t border-slate-800 ${selected === d.id ? 'bg-slate-900' : ''}`}>
                <td className="p-3">
                  <StatusBadge status={d.status} />
                  {d.rollbackOfId && <span className="ml-2 text-xs text-slate-500">rollback</span>}
                  {project.currentDeploymentId === d.id && <span className="ml-2 text-xs text-emerald-400">● current</span>}
                </td>
                <td className="font-mono text-xs">{d.commitHash?.slice(0, 7) ?? '—'}</td>
                <td>{fmtDuration(d.durationMs)}</td>
                <td>{d.url ? <a className="text-indigo-400 hover:underline" href={d.url} target="_blank" rel="noreferrer">{d.url}</a> : '—'}</td>
                <td className="text-xs text-slate-400">{new Date(d.createdAt).toLocaleString()}</td>
                <td className="space-x-1 pr-3 text-right">
                  <button className={`${btn} bg-slate-800`} onClick={() => setSelected(d.id)}>Logs</button>
                  {d.status === 'SUCCESS' && project.currentDeploymentId !== d.id && (
                    <button className={`${btn} bg-amber-600/30 text-amber-200`} onClick={() => rollback(d)}>Rollback</button>
                  )}
                  {ACTIVE.includes(d.status) && <button className={`${btn} bg-rose-600/30 text-rose-200`} onClick={() => cancel(d)}>Cancel</button>}
                </td>
              </tr>
            ))}
            {deps.length === 0 && <tr><td className="p-4 text-slate-500" colSpan={6}>No deployments yet.</td></tr>}
          </tbody>
        </table>
      </section>

      {selected && <LogViewer deploymentId={selected} />}

      <section className="rounded-lg border border-slate-800 p-4 text-sm">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">Preview deployments</h3>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={project.previewsEnabled} onChange={(e) => togglePreviews(e.target.checked)} />
            Deploy every pull request
          </label>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          Each open pull request gets its own URL and is removed when the PR closes. Add the <span className="font-mono">Pull requests</span> event
          to the GitHub webhook below. Pull requests from forks are never built, and previews use this project&apos;s environment variables.
        </p>
        <form onSubmit={saveToken} className="mb-4 flex flex-wrap items-center gap-2">
          <input className="min-w-[16rem] flex-1 rounded bg-slate-900 px-2 py-1 text-sm" type="password" required
                 placeholder={project.hasGithubToken ? 'Token saved. Paste a new one to replace it' : 'GitHub token (optional, to comment the link on the PR)'}
                 value={ghToken} onChange={(e) => setGhToken(e.target.value)} />
          <button className="rounded bg-slate-700 px-3 py-1">Save token</button>
          {project.hasGithubToken && <button type="button" onClick={removeToken} className="text-xs text-rose-400">remove</button>}
        </form>
        <ul className="space-y-2">
          {previews.filter((p) => p.status === 'ACTIVE').map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded bg-slate-900 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate"><span className="font-mono text-slate-400">#{p.prNumber}</span> {p.title || p.branch}</div>
                <div className="text-xs text-slate-500">{p.branch} · {p.headSha?.slice(0, 7) ?? '—'}</div>
              </div>
              <div className="flex items-center gap-3">
                {p.latest && <StatusBadge status={p.latest.status} />}
                {p.url && <a className="text-indigo-400 hover:underline" href={p.url} target="_blank" rel="noreferrer">Open ↗</a>}
                {p.latest && <button className={`${btn} bg-slate-800`} onClick={() => setSelected(p.latest!.id)}>Logs</button>}
                <button className={`${btn} bg-rose-600/30 text-rose-200`} onClick={() => closePreview(p)}>Remove</button>
              </div>
            </li>
          ))}
          {previews.every((p) => p.status !== 'ACTIVE') && <li className="text-slate-500">No open previews.</li>}
        </ul>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-lg border border-slate-800 p-4">
          <h3 className="mb-3 font-semibold">Environment variables</h3>
          <p className="mb-3 text-xs text-slate-500">Encrypted at rest (AES-256-GCM). Values are write-only. Applied on next deploy.</p>
          <form onSubmit={saveEnv} className="mb-3 flex gap-2">
            <input className="w-1/3 rounded bg-slate-900 px-2 py-1 text-sm" placeholder="KEY" value={envForm.key} onChange={(e) => setEnvForm({ ...envForm, key: e.target.value })} required />
            <input className="flex-1 rounded bg-slate-900 px-2 py-1 text-sm" type="password" placeholder="value" value={envForm.value} onChange={(e) => setEnvForm({ ...envForm, value: e.target.value })} required />
            <button className="rounded bg-slate-700 px-3 text-sm">Save</button>
          </form>
          <ul className="space-y-1 text-sm">
            {envKeys.map((v) => (
              <li key={v.key} className="flex justify-between rounded bg-slate-900 px-2 py-1">
                <span className="font-mono">{v.key}</span>
                <button className="text-rose-400" onClick={() => delEnv(v.key)}>remove</button>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg border border-slate-800 p-4 text-sm">
          <h3 className="mb-3 font-semibold">Resource limits</h3>
          <p className="mb-3 text-xs text-slate-500">
            Each app runs with its own memory, CPU and disk cap so one app cannot take the server down. Applied on next deploy.
          </p>
          {limitsForm && (
            <form onSubmit={saveLimits} className="space-y-2">
              {([
                ['memoryMb', 'Memory (MB)', 64, 64],
                ['cpus', 'CPU cores', 0.1, 0.1],
                ['diskMb', 'Disk (MB)', 128, 128],
              ] as const).map(([key, label, min, step]) => (
                <label key={key} className="flex items-center justify-between gap-3">
                  <span>
                    {label}
                    {limitsInfo && <span className="ml-2 text-xs text-slate-500">max {limitsInfo.max[key]}</span>}
                  </span>
                  <input
                    type="number" min={min} step={step} max={limitsInfo?.max[key]}
                    className="w-28 rounded bg-slate-900 px-2 py-1 text-right"
                    value={limitsForm[key]}
                    onChange={(e) => { setLimitsSaved(false); setLimitsForm({ ...limitsForm, [key]: Number(e.target.value) }); }}
                  />
                </label>
              ))}
              {limitsInfo && !limitsInfo.diskQuotaEnforced && (
                <p className="text-xs text-amber-300/80">Disk quota is not enforced on this server yet; logs and /tmp are still capped.</p>
              )}
              <div className="flex items-center gap-3">
                <button className="rounded bg-slate-700 px-3 py-1">Save limits</button>
                {limitsSaved && <span className="text-xs text-emerald-400">Saved. Redeploy to apply.</span>}
              </div>
            </form>
          )}
        </section>

        <section className="rounded-lg border border-slate-800 p-4 text-sm">
          <h3 className="mb-3 font-semibold">Auto-deploy (GitHub webhook)</h3>
          <p className="mb-2 text-slate-400">In your repo: Settings → Webhooks → Add webhook</p>
          <dl className="space-y-2">
            <div><dt className="text-xs text-slate-500">Payload URL</dt><dd className="break-all font-mono text-xs">{location.origin}/api/webhooks/github/{project.id}</dd></div>
            <div><dt className="text-xs text-slate-500">Content type / Events</dt><dd>application/json · push, pull requests</dd></div>
            <div><dt className="text-xs text-slate-500">Secret</dt><dd className="break-all font-mono text-xs">{project.webhookSecret}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  );
}
