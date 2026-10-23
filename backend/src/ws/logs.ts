import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { prisma } from '../db';
import { channel } from '../lib/events';
import { verifyToken } from '../middleware/auth';
import { createRedis } from '../redis';

// ws://host/ws/logs?deploymentId=...&token=<jwt>
// Sends persisted history first, then streams new lines published by the worker via Redis.
export function attachLogServer(server: http.Server) {
  const wss = new WebSocketServer({ server, path: '/ws/logs' });
  const sub = createRedis();
  const rooms = new Map<string, Set<WebSocket>>();

  sub.on('message', (ch, msg) => {
    rooms.get(ch.slice('logs:'.length))?.forEach((ws) => ws.readyState === ws.OPEN && ws.send(msg));
  });

  wss.on('connection', async (ws, req) => {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const deploymentId = url.searchParams.get('deploymentId') ?? '';
      const { id: userId } = verifyToken(url.searchParams.get('token') ?? '');

      const user = await prisma.user.findUnique({ where: { id: userId } });
      const dep = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true } });
      if (!user || !dep || (dep.project.ownerId !== user.id && user.role !== 'ADMIN')) {
        return ws.close(4403, 'Forbidden');
      }

      // Subscribe before reading history so nothing is missed (a line may rarely appear twice).
      if (!rooms.has(deploymentId)) rooms.set(deploymentId, new Set());
      const room = rooms.get(deploymentId)!;
      if (room.size === 0) await sub.subscribe(channel(deploymentId));
      room.add(ws);

      ws.on('close', () => {
        room.delete(ws);
        if (room.size === 0) {
          rooms.delete(deploymentId);
          void sub.unsubscribe(channel(deploymentId));
        }
      });

      const [logs, fresh] = await Promise.all([
        prisma.deploymentLog.findMany({ where: { deploymentId }, orderBy: { id: 'asc' } }),
        prisma.deployment.findUnique({ where: { id: deploymentId } }),
      ]);
      logs.forEach((l) => ws.send(JSON.stringify({ type: 'log', line: l.line, ts: l.createdAt.getTime() })));
      ws.send(JSON.stringify({ type: 'status', status: fresh?.status }));
    } catch {
      ws.close(4401, 'Unauthorized');
    }
  });
}
