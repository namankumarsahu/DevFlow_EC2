import { getRedis } from '../redis';

// Worker -> API fan-out for live logs / status over Redis pub/sub.
export const channel = (deploymentId: string) => `logs:${deploymentId}`;

export const publishLog = (id: string, line: string) =>
  getRedis().publish(channel(id), JSON.stringify({ type: 'log', line, ts: Date.now() }));

export const publishStatus = (id: string, status: string) =>
  getRedis().publish(channel(id), JSON.stringify({ type: 'status', status, ts: Date.now() }));
