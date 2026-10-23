// Step 4: build a repo that has no Dockerfile. We look at the files, work out what kind of app it is and
// write a Dockerfile for it. Pure logic over a tiny "files" interface, so it is easy to test.

export type RepoFiles = {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string | null>; // null when missing / unreadable
};

export type Detection =
  | { kind: 'dockerfile' } // the repo brings its own: always wins
  | { kind: 'generated'; framework: string; summary: string; dockerfile: string; dockerignore: string; buildArgKeys: string[] }
  | { kind: 'unsupported'; reason: string };

type PkgManager = 'npm' | 'yarn' | 'yarn-berry' | 'pnpm';
type Pkg = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  main?: string;
};

// ---- small helpers (exported for tests) -------------------------------------------------------------

const NODE_VERSIONS = [18, 20, 22, 24];
export const DEFAULT_NODE = 22;

// "engines.node": ">=18" / "^20.1.0" / "20.x" / "18 || 20"  ->  one of the Node images we use.
export function pickNodeVersion(range: string | undefined): number {
  const m = /(\d{1,2})/.exec(range ?? '');
  if (!m) return DEFAULT_NODE;
  const want = Number(m[1]);
  return NODE_VERSIONS.find((v) => v >= want) ?? NODE_VERSIONS[NODE_VERSIONS.length - 1];
}

// A path that is safe to put in a Dockerfile: relative, no "..", no spaces/quotes/flags.
export function safeRelPath(p: string | undefined): string | null {
  if (!p) return null;
  const clean = p.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!/^[\w][\w./-]*$/.test(clean) || clean.split('/').includes('..')) return null;
  return clean;
}

// Variables the framework inlines into the browser bundle at BUILD time. These are public by design,
// so they (and only they) are passed to the build. Everything else stays runtime-only.
const PUBLIC_PREFIX: Record<string, string> = { vite: 'VITE_', next: 'NEXT_PUBLIC_', cra: 'REACT_APP_', astro: 'PUBLIC_' };

export function buildArgKeysFor(kind: string, envKeys: string[]): string[] {
  const prefix = PUBLIC_PREFIX[kind];
  return prefix ? envKeys.filter((k) => k.startsWith(prefix) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) : [];
}

const run = (pm: PkgManager, script: string) => (pm === 'npm' ? `npm run ${script}` : pm === 'pnpm' ? `pnpm run ${script}` : `yarn ${script}`);

function installCmd(pm: PkgManager, hasNpmLock: boolean): string {
  switch (pm) {
    case 'pnpm': return 'corepack enable && pnpm install --frozen-lockfile';
    case 'yarn': return 'corepack enable && yarn install --frozen-lockfile';
    case 'yarn-berry': return 'corepack enable && yarn install --immutable';
    default: return hasNpmLock ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund';
  }
}

const argLines = (keys: string[]) => keys.map((k) => `ARG ${k}`).join('\n');

// ---- Dockerfile templates ---------------------------------------------------------------------------

type NginxMode = 'spa' | 'static' | 'export';

// nginx:alpine renders /etc/nginx/templates/*.template with the container's env vars at start-up, so the
// server listens on $PORT like every other DevFlow app. Written with printf so it needs no extra files.
function nginxConf(mode: NginxMode): string[] {
  const location =
    mode === 'spa' ? 'try_files $uri $uri/ /index.html;' : mode === 'export' ? 'try_files $uri $uri.html $uri/index.html =404;' : 'try_files $uri $uri/ =404;';
  return [
    'server {',
    '  listen ${PORT};',
    '  root /usr/share/nginx/html;',
    '  index index.html;',
    '  gzip on;',
    '  gzip_types text/css application/javascript application/json image/svg+xml text/plain;',
    mode === 'export' ? '  error_page 404 /404.html;' : '',
    `  location / { ${location} }`,
    '}',
  ].filter(Boolean);
}

function nginxStage(dir: string | null, mode: NginxMode): string {
  const conf = nginxConf(mode).map((l) => `'${l}'`).join(' ');
  return [
    'FROM nginx:stable-alpine',
    `RUN mkdir -p /etc/nginx/templates && printf '%s\\n' ${conf} > /etc/nginx/templates/default.conf.template`,
    dir ? `COPY --from=build /app/${dir} /usr/share/nginx/html` : 'COPY . /usr/share/nginx/html',
  ].join('\n');
}

type NodeBuild = { node: number; pm: PkgManager; hasNpmLock: boolean; buildArgKeys: string[]; buildCmd: string | null };

function nodeBuildStage(o: NodeBuild, extra: string[] = []): string {
  return [
    `FROM node:${o.node}-slim AS build`,
    'WORKDIR /app',
    // Manifests first: the (slow) install layer is cached until a dependency changes.
    // Yarn Berry needs its .yarn/ folder (pinned release, plugins) before it can install, so it gets the whole repo.
    o.pm === 'yarn-berry' ? 'COPY . .' : 'COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./',
    `RUN ${installCmd(o.pm, o.hasNpmLock)}`,
    o.pm === 'yarn-berry' ? '' : 'COPY . .',
    ...extra,
    argLines(o.buildArgKeys),
    o.buildCmd ? `RUN ${o.buildCmd}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const assertDir = (dir: string) =>
  `RUN test -d ${dir} || (echo "==> The build finished but there is no '${dir}' folder. Add a Dockerfile, or set the build output folder to '${dir}'." >&2; exit 1)`;

const DOCKERIGNORE = ['node_modules', '.git', 'npm-debug.log*', '.DS_Store', ''].join('\n');

// ---- detection --------------------------------------------------------------------------------------

const SSR_FRAMEWORKS = ['@sveltejs/kit', '@remix-run/dev', '@react-router/dev', 'nuxt', '@tanstack/start', '@solidjs/start', 'solid-start'];

async function firstExisting(repo: RepoFiles, names: string[]): Promise<string | null> {
  for (const n of names) if (await repo.exists(n)) return n;
  return null;
}

async function configText(repo: RepoFiles, base: string): Promise<string> {
  const f = await firstExisting(repo, ['js', 'mjs', 'cjs', 'ts', 'mts'].map((e) => `${base}.${e}`));
  return f ? ((await repo.read(f)) ?? '') : '';
}

export async function detectProject(repo: RepoFiles, opts: { envKeys?: string[] } = {}): Promise<Detection> {
  if (await repo.exists('Dockerfile')) return { kind: 'dockerfile' };
  const envKeys = opts.envKeys ?? [];

  const pkgText = await repo.read('package.json');
  if (pkgText === null) {
    if (await repo.exists('index.html')) {
      return {
        kind: 'generated', framework: 'Static site', summary: 'plain HTML/CSS/JS, served by nginx',
        dockerfile: nginxStage(null, 'static') + '\n', dockerignore: DOCKERIGNORE, buildArgKeys: [],
      };
    }
    for (const [file, what] of [['requirements.txt', 'Python'], ['pyproject.toml', 'Python'], ['go.mod', 'Go'], ['pom.xml', 'Java'], ['Gemfile', 'Ruby'], ['composer.json', 'PHP']] as const) {
      if (await repo.exists(file)) {
        return { kind: 'unsupported', reason: `This looks like a ${what} project. Automatic builds currently cover Node.js apps (Next.js, Vite, React, Express, ...) and static sites. Add a Dockerfile to the repo root.` };
      }
    }
    return { kind: 'unsupported', reason: 'No Dockerfile, package.json or index.html at the repo root. If the app lives in a sub-folder, add a Dockerfile at the root.' };
  }

  let pkg: Pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return { kind: 'unsupported', reason: 'package.json is not valid JSON.' };
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const has = (n: string) => n in deps;
  const scripts = pkg.scripts ?? {};

  const hasNpmLock = (await repo.exists('package-lock.json')) || (await repo.exists('npm-shrinkwrap.json'));
  const pm: PkgManager = (await repo.exists('pnpm-lock.yaml'))
    ? 'pnpm'
    : (await repo.exists('yarn.lock'))
      ? ((await repo.exists('.yarnrc.yml')) ? 'yarn-berry' : 'yarn')
      : 'npm';
  const node = pickNodeVersion(pkg.engines?.node);
  const base = { node, pm, hasNpmLock };
  const via = `${pm === 'yarn-berry' ? 'yarn' : pm}, Node ${node}`;
  const buildScript = scripts.build ? run(pm, 'build') : null;

  // ---- Next.js ----
  if (has('next')) {
    const cfg = await configText(repo, 'next.config');
    const buildCmd = buildScript ?? 'npx next build';
    const buildArgKeys = buildArgKeysFor('next', envKeys);
    if (/output\s*:\s*['"]export['"]/.test(cfg)) {
      const dockerfile = [nodeBuildStage({ ...base, buildArgKeys, buildCmd }, ['ENV NEXT_TELEMETRY_DISABLED=1']), assertDir('out'), nginxStage('out', 'export')].join('\n\n') + '\n';
      return { kind: 'generated', framework: 'Next.js (static export)', summary: `built to static files in "out", served by nginx (${via})`, dockerfile, dockerignore: DOCKERIGNORE, buildArgKeys };
    }
    const dockerfile =
      [
        nodeBuildStage({ ...base, buildArgKeys, buildCmd }, ['ENV NEXT_TELEMETRY_DISABLED=1']),
        // next start reads the port from -p; PORT is set by DevFlow at run time.
        'ENV NODE_ENV=production',
        'EXPOSE 3000',
        'CMD ["sh", "-c", "exec ./node_modules/.bin/next start -H 0.0.0.0 -p ${PORT:-3000}"]',
      ].join('\n') + '\n';
    return { kind: 'generated', framework: 'Next.js', summary: `next build, then next start on $PORT (${via})`, dockerfile, dockerignore: DOCKERIGNORE, buildArgKeys };
  }

  // ---- Create React App ----
  if (has('react-scripts')) {
    const buildArgKeys = buildArgKeysFor('cra', envKeys);
    const dockerfile = [nodeBuildStage({ ...base, buildArgKeys, buildCmd: buildScript ?? 'npx react-scripts build' }), assertDir('build'), nginxStage('build', 'spa')].join('\n\n') + '\n';
    return { kind: 'generated', framework: 'Create React App', summary: `built to static files in "build", served by nginx (${via})`, dockerfile, dockerignore: DOCKERIGNORE, buildArgKeys };
  }

  // ---- Vite (and Astro in its default static mode) ----
  const ssr = SSR_FRAMEWORKS.find(has);
  if ((has('vite') || has('astro')) && !ssr && buildScript) {
    const isAstro = has('astro') && !has('vite');
    const cfg = await configText(repo, isAstro ? 'astro.config' : 'vite.config');
    const outDir = safeRelPath(/outDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(cfg)?.[1]) ?? 'dist';
    const buildArgKeys = buildArgKeysFor(isAstro ? 'astro' : 'vite', envKeys);
    const dockerfile = [nodeBuildStage({ ...base, buildArgKeys, buildCmd: buildScript }), assertDir(outDir), nginxStage(outDir, isAstro ? 'static' : 'spa')].join('\n\n') + '\n';
    return {
      kind: 'generated', framework: isAstro ? 'Astro (static)' : 'Vite', summary: `built to static files in "${outDir}", served by nginx (${via})`,
      dockerfile, dockerignore: DOCKERIGNORE, buildArgKeys,
    };
  }

  // ---- Any other Node server: Express, Fastify, Koa, NestJS, SvelteKit (adapter-node), ... ----
  let start: string | null = null;
  const startScript = scripts.start?.trim();
  if (startScript) {
    const direct = /^node\s+(\S+\.(?:c|m)?js)$/.exec(startScript); // "node server.js" -> run it directly (clean SIGTERM handling)
    const file = direct ? safeRelPath(direct[1]) : null;
    start = file ? `CMD ["node", "${file}"]` : pm === 'npm' ? 'CMD ["npm", "start"]' : `CMD ["${pm === 'pnpm' ? 'pnpm' : 'yarn'}", "start"]`;
  } else {
    const entry = safeRelPath(pkg.main) ?? (await firstExisting(repo, ['server.js', 'index.js', 'app.js', 'src/index.js', 'src/server.js']));
    if (entry) start = `CMD ["node", "${entry}"]`;
  }
  if (!start) {
    return { kind: 'unsupported', reason: 'package.json has no "start" script and no entry file (index.js, server.js, app.js). Add a "start" script, or add a Dockerfile.' };
  }
  const label = has('express') ? 'Express' : has('fastify') ? 'Fastify' : has('@nestjs/core') ? 'NestJS' : has('koa') ? 'Koa' : ssr ? `${ssr} (Node server)` : 'Node.js';
  const dockerfile =
    [nodeBuildStage({ ...base, buildArgKeys: [], buildCmd: buildScript }), 'ENV NODE_ENV=production', 'EXPOSE 3000', start].join('\n') + '\n';
  return { kind: 'generated', framework: label, summary: `${buildScript ? 'build script, then ' : ''}${start.replace(/^CMD /, 'start with ')} (${via})`, dockerfile, dockerignore: DOCKERIGNORE, buildArgKeys: [] };
}
