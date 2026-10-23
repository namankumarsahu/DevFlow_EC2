import http from 'http';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// HTTP status code, or null when nothing answered (refused / timed out).
export type ProbeResult = number | null;

export function httpProbe(host: string, port: number, path: string, timeoutMs = 3000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path, timeout: timeoutMs, headers: { 'User-Agent': 'DevFlow-healthcheck' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

export type HealthOutcome =
  | { ok: true; attempts: number }
  | { ok: false; reason: 'timeout' | 'exited' | 'cancelled'; lastStatus: ProbeResult; attempts: number };

// "Healthy" = answers HTTP with anything below 500, several times in a row, and the container is still running.
// A 404 or 302 on "/" is fine (the server is up); a 5xx or no answer is not.
export async function waitHealthy(o: {
  probe: () => Promise<ProbeResult>;
  isAlive: () => Promise<boolean>;
  shouldAbort?: () => Promise<boolean>;
  timeoutMs: number;
  intervalMs?: number;
  successesNeeded?: number;
  onAttempt?: (attempt: number, status: ProbeResult, elapsedMs: number) => void;
}): Promise<HealthOutcome> {
  const interval = o.intervalMs ?? 1000;
  const needed = o.successesNeeded ?? 2;
  const started = Date.now();
  let attempts = 0;
  let streak = 0;
  let last: ProbeResult = null;
  for (;;) {
    if (o.shouldAbort && (await o.shouldAbort())) return { ok: false, reason: 'cancelled', lastStatus: last, attempts };
    if (!(await o.isAlive())) return { ok: false, reason: 'exited', lastStatus: last, attempts };
    last = await o.probe();
    attempts++;
    o.onAttempt?.(attempts, last, Date.now() - started);
    streak = last !== null && last < 500 ? streak + 1 : 0;
    if (streak >= needed) {
      // It answered, but make sure it did not crash straight afterwards.
      if (!(await o.isAlive())) return { ok: false, reason: 'exited', lastStatus: last, attempts };
      return { ok: true, attempts };
    }
    if (Date.now() - started >= o.timeoutMs) return { ok: false, reason: 'timeout', lastStatus: last, attempts };
    await sleep(interval);
  }
}
