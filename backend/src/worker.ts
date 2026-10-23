import { execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { Job, Worker } from 'bullmq';
import { appUrl, config, publicScheme } from './config';
import { prisma } from './db';
import { buildctlArgs, buildctlPingArgs, checkRepoSize, childEnv, dockerBuildArgs, GIT_ENV, gitCloneArgs } from './lib/buildSandbox';
import { syncCaddy, syncCaddyOnStart } from './lib/caddy';
import { deploymentContainerName } from './lib/caddyConfig';
import { CleanupScope, staleNamesInScope } from './lib/containers';
import { decrypt } from './lib/crypto';
import { detectProject } from './lib/detect';
import { fsRepoFiles } from './lib/repoFiles';
import { upsertPrComment } from './lib/github';
import { CommentState, previewComment } from './lib/previews';
import { describeLimits, explainExit, runLimitArgs } from './lib/limits';
import { dirSizeBytes } from './lib/repoSize';
import { httpProbe, waitHealthy } from './lib/health';
import { publishLog, publishStatus } from './lib/events';
import { ensureSlug } from './lib/slug';
import { QUEUE_NAME } from './queue';
import { createRedis, getRedis } from './redis';

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class CancelledError extends Error {}

type Logger = { log: (line: string) => Promise<void> };

// Persist + publish lines strictly in order (chained promises) so history == live stream.
function makeLogger(deploymentId: string): Logger {
  let chain: Promise<void> = Promise.resolve();
  return {
    log: (text) => {
      const lines = text.split('\n').map((l) => l.trimEnd()).filter(Boolean);
      chain = chain.then(async () => {
        for (const line of lines) {
          await prisma.deploymentLog.create({ data: { deploymentId, line } });
          await publishLog(deploymentId, line);
        }
      });
      return chain;
    },
  };
}

async function setStatus(id: string, status: 'BUILDING' | 'DEPLOYING', extra: object = {}) {
  await prisma.deployment.update({ where: { id }, data: { status, ...extra } });
  await publishStatus(id, status);
}

// Step 14: keep ONE comment on the pull request up to date. Best effort: failures are logged, never thrown.
async function commentOnPr(project: { id: string; repoUrl: string; githubTokenEnc: string | null }, previewId: string, state: CommentState, logger?: Logger) {
  if (!project.githubTokenEnc) return;
  try {
    const preview = await prisma.preview.findUnique({ where: { id: previewId } });
    if (!preview) return;
    const dashboard = `${publicScheme}://${config.domain}/projects/${project.id}`;
    const r = await upsertPrComment({
      token: decrypt(project.githubTokenEnc),
      repoUrl: project.repoUrl,
      prNumber: preview.prNumber,
      commentId: preview.commentId,
      body: previewComment(state, dashboard),
    });
    if (r.commentId !== preview.commentId) await prisma.preview.update({ where: { id: previewId }, data: { commentId: r.commentId } });
    if (r.error) await logger?.log(`==> Could not update the pull request comment: ${r.error}`);
  } catch (e) {
    console.error('PR comment failed:', e);
  }
}

// Child processes never see the worker's secrets (DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY, ...).
async function capture(cmd: string, args: string[], cwd?: string) {
  const { stdout } = await execFileP(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024, env: childEnv(process.env) });
  return stdout;
}

// Run a command, streaming stdout/stderr to the deployment log. Supports cancellation + timeout.
function run(logger: Logger, id: string, cmd: string, args: string[], cwd?: string, extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: childEnv(process.env, extraEnv) });
    let cancelled = false;
    let timedOut = false;
    const poll = setInterval(async () => {
      if (await getRedis().get(`cancel:${id}`)) {
        cancelled = true;
        child.kill('SIGKILL');
      }
    }, 1000);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, config.buildTimeoutMs);
    const done = () => {
      clearInterval(poll);
      clearTimeout(timeout);
    };
    const onData = (d: Buffer) => void logger.log(d.toString());
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      done();
      reject(e);
    });
    child.on('close', (code) => {
      done();
      if (cancelled) reject(new CancelledError('Cancelled'));
      else if (timedOut) reject(new Error(`${cmd} timed out after ${config.buildTimeoutMs / 1000}s`));
      else if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args[0]} exited with code ${code}`));
    });
  });
}

// Remove the containers DevFlow started for this project (within `scope`), except `keep` (the one now serving traffic).
// Production and previews share the project label, so production cleanup must never touch a preview and vice versa.
async function removeProjectContainers(projectId: string, keep: string | null, scope: CleanupScope = { production: true }): Promise<string[]> {
  const out = await capture('docker', ['ps', '-a', '--filter', `label=devflow.project=${projectId}`, '--format', '{{.Names}}\t{{.Label "devflow.preview"}}']);
  const names = staleNamesInScope(out, keep, scope);
  for (const n of names) await capture('docker', ['rm', '-f', n]).catch(() => undefined);
  return names;
}

// One deployment per project at a time (production), and one per preview, so a PR build never blocks production.
async function acquireLock(key: string) {
  const token = randomUUID();
  while (!(await getRedis().set(key, token, 'PX', 30 * 60 * 1000, 'NX'))) await sleep(2000);
  return async () => {
    if ((await getRedis().get(key)) === token) await getRedis().del(key);
  };
}

async function processDeployment(deploymentId: string) {
  const dep = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true, preview: true } });
  if (!dep || dep.status !== 'QUEUED') return;
  const { project, preview } = dep;
  const branch = preview ? preview.branch : project.branch;
  const logger = makeLogger(deploymentId);
  const release = await acquireLock(preview ? `lock:preview:${preview.id}` : `lock:project:${project.id}`);
  const workDir = path.join(config.workDir, deploymentId);
  const envFile = path.join(config.workDir, `${deploymentId}.env`);
  const imageTar = path.join(config.workDir, `${deploymentId}.image.tar`); // outside workDir so it never ends up in the build context
  const startedAt = Date.now();
  // Blue/green bookkeeping: `candidate` is the new container; it is thrown away unless traffic was switched to it.
  let candidate: string | null = null;
  let switched = false;

  try {
    // Re-check: it may have been cancelled while waiting for the lock.
    const fresh = await prisma.deployment.findUnique({ where: { id: deploymentId } });
    if (fresh?.status !== 'QUEUED') return;
    if (preview) {
      // The pull request may have been closed while this build waited for the lock.
      const p = await prisma.preview.findUnique({ where: { id: preview.id } });
      if (p?.status !== 'ACTIVE') {
        await prisma.deployment.update({ where: { id: deploymentId }, data: { status: 'CANCELLED', finishedAt: new Date() } });
        await publishStatus(deploymentId, 'CANCELLED');
        return;
      }
    }
    await mkdir(config.workDir, { recursive: true });
    await setStatus(deploymentId, 'BUILDING', { startedAt: new Date() });
    if (preview) await logger.log(`==> Preview for pull request #${preview.prNumber} (branch ${preview.branch})`);

    const vars = await prisma.envVar.findMany({ where: { projectId: project.id } });
    let imageTag = dep.imageTag;
    if (dep.rollbackOfId && imageTag) {
      await logger.log(`==> Rollback: reusing image ${imageTag}`);
      await capture('docker', ['image', 'inspect', imageTag]).catch(() => {
        throw new Error('Image for the target deployment no longer exists (pruned?)');
      });
    } else {
      await logger.log(`==> Cloning ${project.repoUrl} (${branch})`);
      await run(logger, deploymentId, 'git', gitCloneArgs(branch, project.repoUrl, workDir), undefined, GIT_ENV);
      const tooBig = checkRepoSize(await dirSizeBytes(workDir, config.maxRepoMb * 1024 * 1024), config.maxRepoMb);
      if (tooBig) throw new Error(tooBig);
      const commit = (await capture('git', ['rev-parse', 'HEAD'], workDir)).trim();
      imageTag = `devflow/${project.id}:${commit.slice(0, 12)}-${deploymentId.slice(0, 8)}`;
      await prisma.deployment.update({ where: { id: deploymentId }, data: { commitHash: commit, imageTag } });
      if (preview) {
        await prisma.preview.update({ where: { id: preview.id }, data: { headSha: commit } });
        await commentOnPr(project, preview.id, { state: 'building', sha: commit }, logger);
      }
      // Step 4: no Dockerfile in the repo? Work out what the app is and write one.
      const detection = await detectProject(fsRepoFiles(workDir), { envKeys: vars.map((v) => v.key) });
      let buildArgs: Record<string, string> = {};
      if (detection.kind === 'unsupported') throw new Error(detection.reason);
      if (detection.kind === 'generated') {
        await logger.log(`==> No Dockerfile found. Detected ${detection.framework}: ${detection.summary}`);
        // rm first: a hostile repo could ship "Dockerfile" as a symlink, and writeFile would follow it out of the checkout.
        await rm(path.join(workDir, 'Dockerfile'), { force: true });
        await writeFile(path.join(workDir, 'Dockerfile'), detection.dockerfile);
        // Keep the repo's own .dockerignore when it has one; otherwise stop node_modules/.git from being copied in.
        if (!(await fsRepoFiles(workDir).exists('.dockerignore'))) {
          await rm(path.join(workDir, '.dockerignore'), { force: true });
          await writeFile(path.join(workDir, '.dockerignore'), detection.dockerignore);
        }
        await logger.log(`==> Generated Dockerfile (copy it into your repo to customise it):\n${detection.dockerfile}`);
        const wanted = new Set(detection.buildArgKeys);
        buildArgs = Object.fromEntries(vars.filter((v) => wanted.has(v.key)).map((v) => [v.key, decrypt(v.valueEnc)]));
        if (wanted.size) await logger.log(`==> Passing public build-time variables: ${[...wanted].join(', ')}`);
      } else {
        await logger.log('==> Using the Dockerfile from the repository');
      }
      await logger.log(`==> Building image ${imageTag} @ ${commit.slice(0, 7)} (${config.buildSandbox === 'buildkit' ? 'sandboxed rootless BuildKit' : 'host Docker daemon, NOT sandboxed'})`);
      if (config.buildSandbox === 'buildkit') {
        // Untrusted Dockerfile steps run inside the rootless BuildKit container, not on the host daemon.
        await run(logger, deploymentId, 'buildctl', buildctlPingArgs(config.buildkitAddr)).catch(() => {
          throw new Error(`Build sandbox unreachable at ${config.buildkitAddr}. Is the "buildkit" service running? (Set BUILD_SANDBOX=docker to fall back, unsafe for untrusted code.)`);
        });
        await run(logger, deploymentId, 'buildctl', buildctlArgs({ addr: config.buildkitAddr, contextDir: workDir, imageTag, tarPath: imageTar, buildArgs }));
        await logger.log('==> Loading built image into the app runtime');
        await run(logger, deploymentId, 'docker', ['load', '-i', imageTar]);
        await rm(imageTar, { force: true });
      } else {
        await run(logger, deploymentId, 'docker', ['build', '-t', imageTag, ...dockerBuildArgs(buildArgs), workDir]);
      }
    }

    await setStatus(deploymentId, 'DEPLOYING');
    const lines = [`PORT=${project.containerPort}`, `NODE_ENV=${project.environment.toLowerCase()}`];
    if (preview) lines.push('DEVFLOW_PREVIEW=1', `DEVFLOW_URL=${appUrl(preview.slug)}`, `DEVFLOW_PR_NUMBER=${preview.prNumber}`);
    vars.forEach((v) => lines.push(`${v.key}=${decrypt(v.valueEnc)}`));
    // env-file (mode 0600, deleted afterwards) keeps secrets out of `ps` output and logs.
    await writeFile(envFile, lines.join('\n') + '\n', { mode: 0o600 });

    const newName = deploymentContainerName(project.id, deploymentId);
    const before = await prisma.project.findUnique({ where: { id: project.id }, select: { currentDeploymentId: true } });
    const previousDeploymentId = (preview ? (await prisma.preview.findUnique({ where: { id: preview.id }, select: { currentDeploymentId: true } }))?.currentDeploymentId : before?.currentDeploymentId) ?? null;

    // 1. Start the NEW version next to the old one (different container name). Old keeps serving.
    const limits = { memoryMb: project.memoryMb, cpus: project.cpus, diskMb: project.diskMb };
    await logger.log(`==> Starting new container ${newName}${previousDeploymentId ? ' (previous version keeps serving)' : ''}`);
    await logger.log(`==> Resource limits: ${describeLimits(limits, config.runtime)}`);
    await capture('docker', ['rm', '-f', newName]).catch(() => undefined); // leftover from a retried job
    candidate = newName;
    await run(logger, deploymentId, 'docker', [
      'run', '-d', '--name', newName, '--restart', 'unless-stopped',
      // No published host port: the app is only reachable through Caddy on the apps network.
      '--network', config.appsNetwork,
      '--env-file', envFile,
      ...runLimitArgs(limits, config.runtime),
      '--label', `devflow.project=${project.id}`,
      '--label', `devflow.deployment=${deploymentId}`,
      ...(preview ? ['--label', `devflow.preview=${preview.id}`] : []),
      imageTag!,
    ]);

    // 2. Wait until it really answers HTTP. If it never does, the old version is untouched.
    await logger.log(`==> Health check: GET ${config.healthPath} on port ${project.containerPort} (up to ${Math.round(config.healthTimeoutMs / 1000)}s)`);
    let lastLogged = 0;
    const health = await waitHealthy({
      probe: () => httpProbe(newName, project.containerPort, config.healthPath),
      isAlive: async () => (await capture('docker', ['inspect', '-f', '{{.State.Running}}', newName]).catch(() => 'false')).trim() === 'true',
      shouldAbort: async () => !!(await getRedis().get(`cancel:${deploymentId}`)),
      timeoutMs: config.healthTimeoutMs,
      onAttempt: (n, status, elapsed) => {
        if (status === null && elapsed - lastLogged >= 10_000) {
          lastLogged = elapsed;
          void logger.log(`    ...still waiting for the app to accept connections (${Math.round(elapsed / 1000)}s)`);
        }
      },
    });
    if (!health.ok) {
      if (health.reason === 'cancelled') throw new CancelledError('Cancelled');
      const tail = await capture('docker', ['logs', '--tail', '40', newName]).catch(() => '');
      if (tail) await logger.log(tail);
      const exitInfo = await capture('docker', ['inspect', '-f', '{{.State.OOMKilled}} {{.State.ExitCode}}', newName]).catch(() => '');
      const why =
        health.reason === 'exited'
          ? `the container exited${explainExit(exitInfo, project.memoryMb) ? `: ${explainExit(exitInfo, project.memoryMb)}` : ''}`
          : health.lastStatus === null
            ? `nothing answered on port ${project.containerPort} within ${Math.round(config.healthTimeoutMs / 1000)}s (is the app listening on $PORT?)`
            : `it kept returning HTTP ${health.lastStatus} on ${config.healthPath}`;
      throw new Error(`New version failed its health check: ${why}.${previousDeploymentId ? ' The previous version is still serving traffic.' : ''}`);
    }
    await logger.log(`==> Healthy after ${health.attempts} check(s)`);

    // 3. Switch traffic. Caddy reloads gracefully: requests already in flight finish on the old container.
    const url = preview ? appUrl(preview.slug) : appUrl(project.slug ?? (await ensureSlug(project.id, project.name)));
    if (preview) {
      // Closed while we were building? Do not bring a dead preview back to life.
      const p = await prisma.preview.findUnique({ where: { id: preview.id }, select: { status: true } });
      if (p?.status !== 'ACTIVE') throw new CancelledError('Cancelled');
    }
    await prisma.deployment.update({ where: { id: deploymentId }, data: { containerName: newName, url } });
    const setCurrent = (id: string | null) =>
      preview
        ? prisma.preview.update({ where: { id: preview.id }, data: { currentDeploymentId: id } })
        : prisma.project.update({ where: { id: project.id }, data: { currentDeploymentId: id } });
    await setCurrent(deploymentId);
    try {
      await syncCaddy();
    } catch (e) {
      // Could not tell Caddy: put the database back so it still describes what is actually serving.
      await setCurrent(previousDeploymentId);
      throw e;
    }
    switched = true;
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: 'SUCCESS', finishedAt: new Date(), durationMs: Date.now() - startedAt },
    });
    await logger.log(`==> Live at ${url}`);
    await publishStatus(deploymentId, 'SUCCESS');
    if (preview) await commentOnPr(project, preview.id, { state: 'ready', sha: dep.commitHash ?? preview.headSha ?? '', url }, logger);

    // 4. Drain, then retire the old version. A failure here must not turn a successful deploy into a failed one.
    try {
      if (previousDeploymentId) await sleep(config.drainMs);
      const removed = await removeProjectContainers(project.id, newName, preview ? { previewId: preview.id } : { production: true });
      if (removed.length) await logger.log(`==> Stopped previous version (${removed.join(', ')})`);
    } catch (e) {
      console.error('Cleanup of old containers failed:', e);
    }
  } catch (err) {
    const cancelled = err instanceof CancelledError;
    const message = err instanceof Error ? err.message : String(err);
    if (candidate && !switched) await capture('docker', ['rm', '-f', candidate]).catch(() => undefined);
    await logger.log(cancelled ? '==> Deployment cancelled' : `==> FAILED: ${message}`);
    const status = cancelled ? 'CANCELLED' : 'FAILED';
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status, error: cancelled ? null : message, finishedAt: new Date(), durationMs: Date.now() - startedAt },
    });
    await publishStatus(deploymentId, status);
    if (preview && !cancelled) {
      const sha = (await prisma.preview.findUnique({ where: { id: preview.id }, select: { headSha: true } }))?.headSha ?? '';
      await commentOnPr(project, preview.id, { state: 'failed', sha, error: message });
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(envFile, { force: true }).catch(() => undefined);
    await rm(imageTar, { force: true }).catch(() => undefined);
    await getRedis().del(`cancel:${deploymentId}`);
    await release();
  }
}

// Step 14: a pull request was closed. Wait for any in-flight build of that preview, then remove its containers.
async function teardownPreview(previewId: string) {
  const first = await prisma.preview.findUnique({ where: { id: previewId }, include: { project: true } });
  if (!first) return;
  const release = await acquireLock(`lock:preview:${previewId}`);
  try {
    // Re-read: the PR may have been reopened while we waited (then a new deployment owns the preview again).
    const preview = await prisma.preview.findUnique({ where: { id: previewId } });
    if (!preview || preview.status !== 'CLOSED') return;
    await removeProjectContainers(first.projectId, null, { previewId }).catch(() => undefined);
    await prisma.preview.update({ where: { id: previewId }, data: { currentDeploymentId: null } });
    await syncCaddy().catch((e) => console.error('Caddy sync failed:', e));
    await commentOnPr(first.project, previewId, { state: 'closed' });
  } finally {
    await release();
  }
}

const worker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    if (job.name === 'preview-teardown') {
      await teardownPreview(job.data.previewId);
      return;
    }
    if (job.name === 'teardown') {
      await removeProjectContainers(job.data.projectId, null, 'all').catch(() => undefined);
      await syncCaddy().catch((e) => console.error('Caddy sync failed:', e));
      return;
    }
    await processDeployment(job.data.deploymentId);
  },
  { connection: createRedis(), concurrency: 2 },
);

worker.on('failed', (job, err) => console.error(`Job ${job?.id} failed:`, err));
console.log('DevFlow worker started');
if (config.isProd && config.buildSandbox !== 'buildkit') {
  console.warn('WARNING: BUILD_SANDBOX=docker. Untrusted Dockerfiles run on the host Docker daemon. Use BUILD_SANDBOX=buildkit.');
}
void syncCaddyOnStart();

const shutdown = async () => {
  await worker.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
