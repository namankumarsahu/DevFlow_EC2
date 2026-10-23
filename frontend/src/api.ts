export type User = { id: string; email: string; role: 'USER' | 'ADMIN'; createdAt: string };
export type Project = {
  id: string; name: string; repoUrl: string; branch: string; environment: string;
  containerPort: number; memoryMb: number; cpus: number; diskMb: number; hostPort: number; slug: string | null; webhookSecret: string; currentDeploymentId: string | null;
  previewsEnabled: boolean; hasGithubToken: boolean;
};
export type Preview = {
  id: string; prNumber: number; title: string; branch: string; headSha: string | null; slug: string;
  status: 'ACTIVE' | 'CLOSED'; url: string | null; updatedAt: string;
  latest: { id: string; status: Deployment['status']; error: string | null } | null;
};
export type Limits = { memoryMb: number; cpus: number; diskMb: number };
export type LimitsInfo = { defaults: Limits; max: Limits; diskQuotaEnforced: boolean };
export type Deployment = {
  id: string; status: 'QUEUED' | 'BUILDING' | 'DEPLOYING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  commitHash: string | null; url: string | null; durationMs: number | null; createdAt: string;
  rollbackOfId: string | null; error: string | null;
};

export const auth = {
  get: () => localStorage.getItem('token'),
  set: (t: string) => localStorage.setItem('token', t),
  clear: () => localStorage.removeItem('token'),
};

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(auth.get() ? { Authorization: `Bearer ${auth.get()}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    auth.clear();
    window.location.href = '/login';
  }
  if (!res.ok) {
    const details = data?.details ? ' — ' + Object.values(data.details).flat().join(', ') : '';
    throw new Error((data?.error ?? `HTTP ${res.status}`) + details);
  }
  return data as T;
}

export const fmtDuration = (ms: number | null) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
