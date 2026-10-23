import 'dotenv/config';

const get = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Missing env var ${k}`);
  return v;
};

const isProd = process.env.NODE_ENV === 'production';
const DEV_JWT = 'dev-secret-change-me';
const DEV_KEY = '0'.repeat(64);

export const config = {
  isProd,
  port: Number(get('PORT', '4000')),
  jwtSecret: get('JWT_SECRET', DEV_JWT),
  encryptionKey: get('ENCRYPTION_KEY', DEV_KEY), // 32 bytes, hex encoded
  redisUrl: get('REDIS_URL', 'redis://localhost:6379'),
  // Base domain. Dashboard lives at https://<domain>, each project at https://<slug>.<domain>.
  // "localhost" = local dev: plain HTTP, no certificates.
  domain: get('DOMAIN', 'localhost'),
  secure: get('DOMAIN', 'localhost') !== 'localhost',
  acmeEmail: process.env.ACME_EMAIL,
  caddyAdminSocket: get('CADDY_ADMIN_SOCKET', '/run/caddy-admin/admin.sock'),
  appsNetwork: get('APPS_NETWORK', 'devflow_apps'),
  // Hops in front of the API (caddy -> nginx -> api) so req.ip is the real client.
  trustProxy: Number(get('TRUST_PROXY', isProd ? '2' : '0')),
  workDir: get('WORK_DIR', '/tmp/devflow-builds'),
  corsOrigin: get('CORS_ORIGIN', 'http://localhost:5173'),
  // Zero-downtime deploys: the new container must answer HTTP (any status < 500) before traffic moves.
  healthPath: get('HEALTH_PATH', '/'),
  healthTimeoutMs: Number(get('HEALTH_TIMEOUT_MS', '60000')),
  drainMs: Number(get('DRAIN_MS', '10000')), // old container keeps running this long after the switch
  buildTimeoutMs: Number(get('BUILD_TIMEOUT_MS', String(15 * 60 * 1000))),

  // Step 6: where untrusted Dockerfiles are built.
  //   buildkit = separate rootless BuildKit container on its own network (default in production)
  //   docker   = the host's Docker daemon (legacy; only for local dev)
  buildSandbox: get('BUILD_SANDBOX', isProd ? 'buildkit' : 'docker') as 'buildkit' | 'docker',
  buildkitAddr: get('BUILDKIT_ADDR', 'tcp://buildkit:1234'),
  maxRepoMb: Number(get('MAX_REPO_MB', '500')),

  // Step 7: limits for every app container. Projects can choose their own up to `maxLimits`.
  defaultLimits: {
    memoryMb: Number(get('DEFAULT_MEMORY_MB', '512')),
    cpus: Number(get('DEFAULT_CPUS', '0.5')),
    diskMb: Number(get('DEFAULT_DISK_MB', '1024')),
  },
  maxLimits: {
    memoryMb: Number(get('MAX_MEMORY_MB', '2048')),
    cpus: Number(get('MAX_CPUS', '2')),
    diskMb: Number(get('MAX_DISK_MB', '5120')),
  },
  // Step 14: preview deployments per pull request.
  previews: {
    maxPerProject: Number(get('PREVIEW_MAX_PER_PROJECT', '5')), // oldest preview is retired when a new PR goes over this
  },
  runtime: {
    pidsLimit: Number(get('APP_PIDS_LIMIT', '256')),
    nofile: Number(get('APP_NOFILE', '4096')),
    tmpMb: Number(get('APP_TMP_MB', '64')),
    logMaxSize: get('APP_LOG_MAX_SIZE', '10m'),
    logMaxFiles: Number(get('APP_LOG_MAX_FILES', '3')),
    // Needs docker's overlay2 on an xfs filesystem mounted with pquota. Off by default (EC2's ext4 root can't do it).
    storageQuota: get('STORAGE_QUOTA', 'false') === 'true',
  },
};

if (!/^[a-z0-9.-]+$/.test(config.domain)) {
  throw new Error('DOMAIN must be a bare hostname like devflow.com (no scheme, no port)');
}
if (config.buildSandbox !== 'buildkit' && config.buildSandbox !== 'docker') {
  throw new Error('BUILD_SANDBOX must be "buildkit" or "docker"');
}
for (const [k, v] of Object.entries({ ...config.defaultLimits, ...config.maxLimits })) {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`Resource limit ${k} must be a positive number`);
}
for (const k of ['memoryMb', 'cpus', 'diskMb'] as const) {
  if (config.defaultLimits[k] > config.maxLimits[k]) throw new Error(`DEFAULT limit for ${k} is above the MAX`);
}
if (!Number.isInteger(config.previews.maxPerProject) || config.previews.maxPerProject < 1) {
  throw new Error('PREVIEW_MAX_PER_PROJECT must be a positive integer');
}
if (!config.healthPath.startsWith('/')) {
  throw new Error('HEALTH_PATH must start with /');
}
if (!/^[0-9a-fA-F]{64}$/.test(config.encryptionKey)) {
  throw new Error('ENCRYPTION_KEY must be 64 hex chars (openssl rand -hex 32)');
}
if (isProd && (config.jwtSecret === DEV_JWT || config.encryptionKey === DEV_KEY)) {
  throw new Error('Refusing to start in production with default secrets');
}

export const publicScheme = config.secure ? 'https' : 'http';
export const appUrl = (slug: string) => `${publicScheme}://${slug}.${config.domain}`;
