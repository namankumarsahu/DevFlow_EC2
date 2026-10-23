process.env.NODE_ENV = 'test';

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { buildctlArgs, checkRepoSize, childEnv, gitCloneArgs } from '../src/lib/buildSandbox';
import { describeLimits, explainExit, limitsExceeded, runLimitArgs, type RuntimePolicy } from '../src/lib/limits';
import { dirSizeBytes } from '../src/lib/repoSize';

const policy: RuntimePolicy = { pidsLimit: 256, nofile: 4096, tmpMb: 64, logMaxSize: '10m', logMaxFiles: 3, storageQuota: false };
const limits = { memoryMb: 512, cpus: 0.5, diskMb: 1024 };

// helper: value following a flag
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const allAfter = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

describe('runLimitArgs (Step 7)', () => {
  const args = runLimitArgs(limits, policy);
  it('caps memory with no swap, CPU, processes and open files', () => {
    expect(after(args, '--memory')).toBe('512m');
    expect(after(args, '--memory-swap')).toBe('512m');
    expect(after(args, '--cpus')).toBe('0.5');
    expect(after(args, '--pids-limit')).toBe('256');
    expect(after(args, '--ulimit')).toBe('nofile=4096:4096');
  });
  it('drops all capabilities except the ones web apps need, and blocks privilege escalation', () => {
    expect(after(args, '--cap-drop')).toBe('ALL');
    expect(allAfter(args, '--cap-add')).toEqual(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID', 'NET_BIND_SERVICE', 'KILL']);
    expect(allAfter(args, '--security-opt')).toEqual(['no-new-privileges']);
  });
  it('bounds /tmp and rotates logs', () => {
    expect(after(args, '--tmpfs')).toBe('/tmp:rw,nosuid,size=64m');
    expect(allAfter(args, '--log-opt')).toEqual(['max-size=10m', 'max-file=3']);
  });
  it('never grants privileged mode, host mounts or host networking', () => {
    for (const bad of ['--privileged', '-v', '--volume', '--mount', '--network', '--pid', '--cap-add=ALL']) expect(args).not.toContain(bad);
  });
  it('adds a disk quota only when the host supports it', () => {
    expect(args).not.toContain('--storage-opt');
    const q = runLimitArgs(limits, { ...policy, storageQuota: true });
    expect(after(q, '--storage-opt')).toBe('size=1024m');
  });
  it('formats fractional CPUs cleanly', () => {
    expect(after(runLimitArgs({ ...limits, cpus: 0.1 + 0.2 }, policy), '--cpus')).toBe('0.3');
    expect(after(runLimitArgs({ ...limits, cpus: 2 }, policy), '--cpus')).toBe('2');
  });
});

describe('limitsExceeded', () => {
  const max = { memoryMb: 2048, cpus: 2, diskMb: 5120 };
  it('accepts values at or below the maximum, and partial updates', () => {
    expect(limitsExceeded({ memoryMb: 2048, cpus: 2, diskMb: 5120 }, max)).toBeNull();
    expect(limitsExceeded({}, max)).toBeNull();
  });
  it('names the field that is too high', () => {
    expect(limitsExceeded({ memoryMb: 4096 }, max)).toMatch(/memoryMb/);
    expect(limitsExceeded({ cpus: 3 }, max)).toMatch(/cpus/);
    expect(limitsExceeded({ diskMb: 9999 }, max)).toMatch(/diskMb/);
  });
});

describe('describeLimits / explainExit', () => {
  it('summarises the limits for the deploy log', () => {
    expect(describeLimits(limits, { storageQuota: false })).toBe('512 MB RAM (no swap), 0.5 CPU, disk quota off');
    expect(describeLimits(limits, { storageQuota: true })).toBe('512 MB RAM (no swap), 0.5 CPU, 1024 MB disk');
  });
  it('explains an out-of-memory kill', () => {
    expect(explainExit('true 137', 512)).toMatch(/512 MB memory limit/);
    expect(explainExit('false 137', 512)).toMatch(/exit 137/);
    expect(explainExit('false 1', 512)).toBeNull();
    expect(explainExit('', 512)).toBeNull();
  });
});

describe('buildctlArgs (Step 6)', () => {
  const args = buildctlArgs({ addr: 'tcp://buildkit:1234', contextDir: '/tmp/b/abc', imageTag: 'devflow/p:abc', tarPath: '/tmp/b/abc.image.tar' });
  it('talks to the sandbox daemon, not the host docker daemon', () => {
    expect(args.slice(0, 3)).toEqual(['--addr', 'tcp://buildkit:1234', 'build']);
    expect(args).not.toContain('docker.sock');
  });
  it('builds the repo Dockerfile and exports a tarball', () => {
    expect(allAfter(args, '--local')).toEqual(['context=/tmp/b/abc', 'dockerfile=/tmp/b/abc']);
    expect(after(args, '--output')).toBe('type=docker,name=devflow/p:abc,dest=/tmp/b/abc.image.tar');
  });
});

describe('childEnv', () => {
  const parent = { PATH: '/usr/bin', HOME: '/root', DATABASE_URL: 'postgres://secret', JWT_SECRET: 's', ENCRYPTION_KEY: 'k', REDIS_URL: 'r' };
  it('keeps only the allow-list, so secrets are never passed to git/docker/buildctl', () => {
    expect(childEnv(parent)).toEqual({ PATH: '/usr/bin', HOME: '/root' });
  });
  it('adds explicit extras', () => {
    expect(childEnv(parent, { GIT_TERMINAL_PROMPT: '0' })).toEqual({ PATH: '/usr/bin', HOME: '/root', GIT_TERMINAL_PROMPT: '0' });
  });
});

describe('gitCloneArgs', () => {
  const args = gitCloneArgs('main', 'https://github.com/o/r', '/tmp/x');
  it('disables local-path and ext transports and submodules', () => {
    expect(allAfter(args, '-c')).toEqual(['protocol.file.allow=never', 'protocol.ext.allow=never']);
    expect(args).toContain('--no-recurse-submodules');
  });
  it('puts the user-controlled values after "--" / --branch so they cannot be parsed as flags', () => {
    expect(args.slice(args.indexOf('--branch'))).toEqual(['--branch', 'main', '--', 'https://github.com/o/r', '/tmp/x']);
  });
});

describe('repo size limit', () => {
  it('checkRepoSize', () => {
    expect(checkRepoSize(10 * 1024 * 1024, 500)).toBeNull();
    expect(checkRepoSize(600 * 1024 * 1024, 500)).toMatch(/600 MB.*500 MB/);
  });
  it('dirSizeBytes sums files, recurses, does not follow symlinks, and stops early', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'df-size-'));
    try {
      await mkdir(path.join(dir, 'a/b'), { recursive: true });
      await writeFile(path.join(dir, 'one'), Buffer.alloc(1000));
      await writeFile(path.join(dir, 'a/two'), Buffer.alloc(2000));
      await writeFile(path.join(dir, 'a/b/three'), Buffer.alloc(3000));
      await symlink('/etc', path.join(dir, 'link')); // must not count /etc
      const total = await dirSizeBytes(dir);
      expect(total >= 6000 && total < 7000).toBe(true);
      expect((await dirSizeBytes(dir, 1500)) < total).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
