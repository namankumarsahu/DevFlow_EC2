import http from 'http';
import { randomUUID } from 'crypto';
import { config, appUrl } from '../config';
import { prisma } from '../db';
import { getRedis } from '../redis';
import { buildCaddyConfig, buildPreviewRoutes, buildRoutes } from './caddyConfig';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Caddy's admin API is a unix socket on a volume shared with api + worker only,
// so user containers (which share a network with Caddy) can never reach it.
function loadConfig(body: unknown): Promise<void> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: config.caddyAdminSocket, path: '/load', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let out = '';
        res.on('data', (d) => (out += d));
        res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error(`Caddy /load ${res.statusCode}: ${out}`))));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

// Rebuild routing from the database and hand it to Caddy. Idempotent, so it is safe to call
// after any deploy / rollback / delete and on every process start. A lock stops two callers
// racing and the older snapshot winning.
export async function syncCaddy(): Promise<void> {
  const key = 'lock:caddy-sync';
  const token = randomUUID();
  while (!(await getRedis().set(key, token, 'PX', 30_000, 'NX'))) await sleep(200);
  try {
    const projects = await prisma.project.findMany({
      where: { currentDeploymentId: { not: null }, slug: { not: null } },
      select: { id: true, slug: true, containerPort: true, currentDeploymentId: true },
    });
    const previews = await prisma.preview.findMany({
      where: { status: 'ACTIVE', currentDeploymentId: { not: null } },
      select: { slug: true, status: true, currentDeploymentId: true, project: { select: { containerPort: true } } },
    });
    const deployments = await prisma.deployment.findMany({
      where: { id: { in: [...projects.map((p) => p.currentDeploymentId!), ...previews.map((p) => p.currentDeploymentId!)] } },
      select: { id: true, containerName: true },
    });
    const routes = [
      ...buildRoutes(projects, deployments, config.domain),
      ...buildPreviewRoutes(previews.map((p) => ({ ...p, containerPort: p.project.containerPort })), deployments, config.domain),
    ];
    await loadConfig(buildCaddyConfig(routes));
  } finally {
    if ((await getRedis().get(key)) === token) await getRedis().del(key);
  }
}

// Caddy may still be booting when we start, so retry for a while. Never fatal.
export async function syncCaddyOnStart(tries = 15) {
  for (let i = 1; i <= tries; i++) {
    try {
      await syncCaddy();
      console.log('Caddy routes synced');
      return;
    } catch (e) {
      if (i === tries) console.error('Could not sync Caddy routes:', (e as Error).message);
      else await sleep(2000);
    }
  }
}

export { appUrl };
