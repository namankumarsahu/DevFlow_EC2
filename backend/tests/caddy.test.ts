jest.mock('../src/db', () => ({ prisma: {} }));

import { buildCaddyConfig, containerName } from '../src/lib/caddyConfig';
import { makeSlug } from '../src/lib/slug';

describe('makeSlug', () => {
  it('produces a DNS-safe label with a random suffix', () => {
    expect(makeSlug('My Cool App!', () => 'a1b2c3')).toBe('my-cool-app-a1b2c3');
    expect(makeSlug('  --Ünïcode  &  symbols-- ', () => 'x')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
  it('falls back to "app" and never exceeds 63 chars', () => {
    expect(makeSlug('!!!', () => 'abc123')).toBe('app-abc123');
    expect(makeSlug('a'.repeat(200)).length).toBeLessThanOrEqual(63);
  });
  it('does not end the base with a hyphen after truncation', () => {
    expect(makeSlug('a'.repeat(39) + ' b', () => 'zzzzzz')).not.toContain('--');
  });
});

describe('buildCaddyConfig', () => {
  const secure = { domain: 'devflow.com', secure: true, adminSocket: '/run/caddy-admin/admin.sock' };
  const routes = [{ host: 'blog-a1b2c3.devflow.com', upstream: `${containerName('p1')}:3000` }];

  it('routes the dashboard, each app, then a 404 fallback (in that order)', () => {
    const r = buildCaddyConfig(routes, secure).apps.http.servers.main.routes;
    expect(r[0].match[0].host).toEqual(['devflow.com']);
    expect(r[0].handle[0].upstreams[0].dial).toBe('frontend:80');
    expect(r[1].match[0].host).toEqual(['blog-a1b2c3.devflow.com']);
    expect(r[1].handle[0].upstreams[0].dial).toBe('devflow-p1:3000');
    expect(r[r.length - 1].handle[0].status_code).toBe(404);
  });

  it('uses HTTPS on :443 in production and keeps automatic HTTPS on', () => {
    const s = buildCaddyConfig(routes, secure).apps.http.servers.main;
    expect(s.listen).toEqual([':443']);
    expect(s.automatic_https).toBeUndefined();
  });

  it('uses plain HTTP on :80 for localhost', () => {
    const s = buildCaddyConfig([], { ...secure, domain: 'localhost', secure: false }).apps.http.servers.main;
    expect(s.listen).toEqual([':80']);
    expect(s.automatic_https).toEqual({ disable: true });
  });

  it('exposes the admin API only on a unix socket', () => {
    expect(buildCaddyConfig([], secure).admin.listen).toBe('unix//run/caddy-admin/admin.sock');
    expect(buildCaddyConfig([], secure).admin.origins).toEqual(['localhost']);
  });

  it('adds the ACME email only when provided', () => {
    expect(buildCaddyConfig([], secure).apps.tls).toBeUndefined();
    expect(buildCaddyConfig([], { ...secure, acmeEmail: 'me@x.com' }).apps.tls.automation.policies[0].issuers[0].email).toBe('me@x.com');
  });
});
