// Step 7: per-app resource limits. Pure functions only (no I/O) so they are easy to test.

export type ResourceLimits = { memoryMb: number; cpus: number; diskMb: number };

export type RuntimePolicy = {
  pidsLimit: number; // max processes/threads per app (stops fork bombs)
  nofile: number; // max open files per app
  tmpMb: number; // size of the writable /tmp (tmpfs, counted against the memory limit)
  logMaxSize: string; // docker json-file rotation, e.g. "10m"
  logMaxFiles: number;
  storageQuota: boolean; // pass --storage-opt size=<diskMb>m (needs overlay2 on xfs with pquota)
};

// Capabilities an ordinary web app may still need (bind ports, chown its files, drop to a non-root user).
// Everything else docker grants by default (NET_RAW, MKNOD, SETFCAP, SYS_CHROOT, AUDIT_WRITE, ...) is removed.
export const KEPT_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID', 'NET_BIND_SERVICE', 'KILL'] as const;

// Returns an error message when `want` is above `max`, otherwise null.
export function limitsExceeded(want: Partial<ResourceLimits>, max: ResourceLimits): string | null {
  if (want.memoryMb !== undefined && want.memoryMb > max.memoryMb) return `memoryMb cannot exceed ${max.memoryMb}`;
  if (want.cpus !== undefined && want.cpus > max.cpus) return `cpus cannot exceed ${max.cpus}`;
  if (want.diskMb !== undefined && want.diskMb > max.diskMb) return `diskMb cannot exceed ${max.diskMb}`;
  return null;
}

// docker rejects --cpus with more than 3 decimals on some versions; keep it tidy.
const fmtCpus = (n: number) => String(Math.round(n * 100) / 100);

// The `docker run` flags that confine one user app. Memory-swap == memory means "no swap", so the
// memory limit is a real ceiling instead of letting the app thrash the host's disk.
export function runLimitArgs(limits: ResourceLimits, policy: RuntimePolicy): string[] {
  const args = [
    '--memory', `${limits.memoryMb}m`,
    '--memory-swap', `${limits.memoryMb}m`,
    '--cpus', fmtCpus(limits.cpus),
    '--pids-limit', String(policy.pidsLimit),
    '--ulimit', `nofile=${policy.nofile}:${policy.nofile}`,
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    ...KEPT_CAPS.flatMap((c) => ['--cap-add', c]),
    // The only extra writable scratch space that is size-capped regardless of the storage driver.
    '--tmpfs', `/tmp:rw,nosuid,size=${policy.tmpMb}m`,
    // Without rotation a chatty app can fill the disk through docker's own log file.
    '--log-driver', 'json-file',
    '--log-opt', `max-size=${policy.logMaxSize}`,
    '--log-opt', `max-file=${policy.logMaxFiles}`,
  ];
  if (policy.storageQuota) args.push('--storage-opt', `size=${limits.diskMb}m`);
  return args;
}

export const describeLimits = (l: ResourceLimits, policy: Pick<RuntimePolicy, 'storageQuota'>) =>
  `${l.memoryMb} MB RAM (no swap), ${fmtCpus(l.cpus)} CPU, ${policy.storageQuota ? `${l.diskMb} MB disk` : 'disk quota off'}`;

// Why did the container die? Parsed from `docker inspect -f '{{.State.OOMKilled}} {{.State.ExitCode}}'`.
export function explainExit(inspectOutput: string, memoryMb: number): string | null {
  const [oom, code] = inspectOutput.trim().split(/\s+/);
  if (oom === 'true') return `it was killed for using more than its ${memoryMb} MB memory limit (raise "Memory" in the project's resource limits)`;
  if (code === '137') return 'it was killed (exit 137), possibly by the memory limit';
  return null;
}
