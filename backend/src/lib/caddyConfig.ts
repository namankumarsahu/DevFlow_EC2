import { config } from '../config';

export type AppRoute = { host: string; upstream: string };
export type CaddyOpts = { domain: string; secure: boolean; adminSocket: string; acmeEmail?: string };

// Legacy name (Step 1 and earlier): one container per project, replaced in place.
export const containerName = (projectId: string) => `devflow-${projectId}`;
// Blue/green: every deployment gets its own container, so old and new can run side by side.
export const deploymentContainerName = (projectId: string, deploymentId: string) => `devflow-${projectId}-${deploymentId.slice(0, 8)}`;

export type RouteProject = { id: string; slug: string | null; containerPort: number; currentDeploymentId: string | null };
export type RouteDeployment = { id: string; containerName: string | null };

// Which container should <slug>.<domain> point at? The one recorded on the project's current deployment.
// Deployments from before blue/green have no recorded name, so fall back to the legacy one.
export function buildRoutes(projects: RouteProject[], deployments: RouteDeployment[], domain: string): AppRoute[] {
  const nameById = new Map(deployments.map((d) => [d.id, d.containerName]));
  return projects
    .filter((p) => p.slug && p.currentDeploymentId)
    .map((p) => ({
      host: `${p.slug}.${domain}`,
      upstream: `${nameById.get(p.currentDeploymentId!) ?? containerName(p.id)}:${p.containerPort}`,
    }));
}

const proxy = (dial: string) => ({ handler: 'reverse_proxy', upstreams: [{ dial }] });
const hostRoute = (host: string, dial: string) => ({ match: [{ host: [host] }], handle: [proxy(dial)], terminal: true });

// Pure function: the full Caddy JSON config for the current set of deployed apps.
// Every route has an explicit hostname, so Caddy gets/renews a Let's Encrypt cert for each one by itself.
export function buildCaddyConfig(
  routes: AppRoute[],
  opts: CaddyOpts = { domain: config.domain, secure: config.secure, adminSocket: config.caddyAdminSocket, acmeEmail: config.acmeEmail },
) {
  const cfg: any = {
    // Host header check stays on; node sends "localhost" over the socket. Network exposure is already nil (unix socket).
    admin: { listen: `unix/${opts.adminSocket}`, origins: ['localhost'] },
    apps: {
      http: {
        servers: {
          main: {
            // 443 only: Caddy adds the :80 -> https redirect and the ACME challenge listener itself.
            listen: opts.secure ? [':443'] : [':80'],
            ...(opts.secure ? {} : { automatic_https: { disable: true } }),
            routes: [
              hostRoute(opts.domain, 'frontend:80'), // the dashboard
              ...routes.map((r) => hostRoute(r.host, r.upstream)),
              { handle: [{ handler: 'static_response', status_code: 404, body: 'No app is deployed here.' }] },
            ],
          },
        },
      },
    },
  };
  if (opts.secure && opts.acmeEmail) {
    cfg.apps.tls = { automation: { policies: [{ issuers: [{ module: 'acme', email: opts.acmeEmail }] }] } };
  }
  return cfg;
}

export type RoutePreview = { slug: string; currentDeploymentId: string | null; status: string; containerPort: number };

// Step 14: one route per ACTIVE preview that has a running deployment. Previews always have a recorded container name.
export function buildPreviewRoutes(previews: RoutePreview[], deployments: RouteDeployment[], domain: string): AppRoute[] {
  const nameById = new Map(deployments.map((d) => [d.id, d.containerName]));
  const routes: AppRoute[] = [];
  for (const p of previews) {
    if (p.status !== 'ACTIVE' || !p.currentDeploymentId) continue;
    const name = nameById.get(p.currentDeploymentId);
    if (!name) continue;
    routes.push({ host: `${p.slug}.${domain}`, upstream: `${name}:${p.containerPort}` });
  }
  return routes;
}
