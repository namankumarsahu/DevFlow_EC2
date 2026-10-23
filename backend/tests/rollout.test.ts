jest.mock('../src/db', () => ({ prisma: {} }));

import http from 'http';
import { AddressInfo } from 'net';
import { buildRoutes, containerName, deploymentContainerName } from '../src/lib/caddyConfig';
import { staleNames } from '../src/lib/containers';
import { httpProbe, waitHealthy, ProbeResult } from '../src/lib/health';

const seq = (...results: ProbeResult[]) => {
  let i = 0;
  return async () => results[Math.min(i++, results.length - 1)];
};
const base = { isAlive: async () => true, timeoutMs: 500, intervalMs: 5 };

describe('waitHealthy', () => {
  it('passes after consecutive non-5xx answers (404 counts as up)', async () => {
    const r = await waitHealthy({ ...base, probe: seq(null, null, 404, 200) });
    expect(r).toEqual({ ok: true, attempts: 4 });
  });
  it('a 5xx resets the streak', async () => {
    const r = await waitHealthy({ ...base, probe: seq(200, 500, 200, 200) });
    expect(r).toEqual({ ok: true, attempts: 4 });
  });
  it('times out when nothing ever answers', async () => {
    const r = await waitHealthy({ ...base, timeoutMs: 40, probe: seq(null) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timeout');
  });
  it('times out when it only ever returns 500', async () => {
    const r = await waitHealthy({ ...base, timeoutMs: 40, probe: seq(500) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r).toMatchObject({ reason: 'timeout', lastStatus: 500 });
  });
  it('fails fast if the container exits', async () => {
    const r = await waitHealthy({ ...base, probe: seq(null), isAlive: async () => false, timeoutMs: 60_000 });
    expect(r).toMatchObject({ ok: false, reason: 'exited' });
  });
  it('fails if it answers then crashes straight away', async () => {
    let calls = 0;
    const r = await waitHealthy({ ...base, probe: seq(200), isAlive: async () => ++calls < 3 });
    expect(r).toMatchObject({ ok: false, reason: 'exited' });
  });
  it('can be cancelled', async () => {
    const r = await waitHealthy({ ...base, probe: seq(null), shouldAbort: async () => true, timeoutMs: 60_000 });
    expect(r).toMatchObject({ ok: false, reason: 'cancelled' });
  });
});

describe('httpProbe', () => {
  it('returns the real status code, and null when nothing listens', async () => {
    const srv = http.createServer((_, res) => { res.statusCode = 404; res.end(); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    expect(await httpProbe('127.0.0.1', port, '/')).toBe(404);
    await new Promise((r) => srv.close(r));
    expect(await httpProbe('127.0.0.1', port, '/', 500)).toBeNull();
  });
  it('returns null on a hung server instead of waiting forever', async () => {
    const srv = http.createServer(() => undefined);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const t = Date.now();
    expect(await httpProbe('127.0.0.1', (srv.address() as AddressInfo).port, '/', 150)).toBeNull();
    expect(Date.now() - t).toBeLessThan(1500);
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  });
});

describe('routes follow the current deployment', () => {
  const projects = [
    { id: 'p1', slug: 'blog-a1', containerPort: 3000, currentDeploymentId: 'd-new' },
    { id: 'p2', slug: 'old-b2', containerPort: 80, currentDeploymentId: 'd-legacy' }, // deployed before blue/green
    { id: 'p3', slug: 'idle-c3', containerPort: 80, currentDeploymentId: null },
    { id: 'p4', slug: null, containerPort: 80, currentDeploymentId: 'x' },
  ];
  const deployments = [
    { id: 'd-new', containerName: deploymentContainerName('p1', 'abcdef12-0000') },
    { id: 'd-legacy', containerName: null },
  ];
  const routes = buildRoutes(projects, deployments, 'devflow.com');
  it('points at the deployment container; falls back to the legacy name', () => {
    expect(routes).toEqual([
      { host: 'blog-a1.devflow.com', upstream: 'devflow-p1-abcdef12:3000' },
      { host: 'old-b2.devflow.com', upstream: `${containerName('p2')}:80` },
    ]);
  });
  it('skips projects with nothing deployed or no slug', () => {
    expect(routes.map((r) => r.host)).not.toContain('idle-c3.devflow.com');
  });
});

describe('staleNames', () => {
  it('lists everything except the container to keep', () => {
    expect(staleNames('a\nb\nc\n', 'b')).toEqual(['a', 'c']);
    expect(staleNames('\n', 'b')).toEqual([]);
    expect(staleNames('a\nb', null)).toEqual(['a', 'b']);
  });
});
