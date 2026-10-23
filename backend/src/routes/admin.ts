import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError } from '../lib/errors';
import { authenticate, requireAdmin } from '../middleware/auth';

export const adminRouter = Router();
adminRouter.use(authenticate, requireAdmin);

adminRouter.get('/stats', async (_req, res) => {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const [users, projects, byStatus, avg, recent] = await Promise.all([
    prisma.user.count(),
    prisma.project.count(),
    prisma.deployment.groupBy({ by: ['status'], _count: true }),
    prisma.deployment.aggregate({ _avg: { durationMs: true }, where: { status: 'SUCCESS' } }),
    prisma.deployment.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, status: true } }),
  ]);

  const counts: Record<string, number> = {};
  byStatus.forEach((s) => (counts[s.status] = s._count));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const finished = (counts.SUCCESS ?? 0) + (counts.FAILED ?? 0);

  const days = new Map<string, { date: string; total: number; success: number; failed: number }>();
  for (let i = 6; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    days.set(date, { date, total: 0, success: 0, failed: 0 });
  }
  recent.forEach((d) => {
    const b = days.get(d.createdAt.toISOString().slice(0, 10));
    if (!b) return;
    b.total++;
    if (d.status === 'SUCCESS') b.success++;
    if (d.status === 'FAILED') b.failed++;
  });

  res.json({
    users,
    projects,
    deployments: {
      total,
      byStatus: counts,
      successRate: finished ? (counts.SUCCESS ?? 0) / finished : null,
      avgDurationMs: avg._avg.durationMs ? Math.round(avg._avg.durationMs) : null,
    },
    last7Days: [...days.values()],
  });
});

adminRouter.get('/users', async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, role: true, createdAt: true, _count: { select: { projects: true } } },
  });
  res.json(users);
});

adminRouter.patch('/users/:id', async (req, res) => {
  const { role } = z.object({ role: z.enum(['USER', 'ADMIN']) }).parse(req.body);
  if (req.params.id === req.user!.id) throw new HttpError(400, 'You cannot change your own role');
  const user = await prisma.user.update({ where: { id: req.params.id }, data: { role } });
  res.json({ id: user.id, email: user.email, role: user.role });
});

adminRouter.delete('/users/:id', async (req, res) => {
  if (req.params.id === req.user!.id) throw new HttpError(400, 'You cannot delete yourself');
  await prisma.user.delete({ where: { id: req.params.id } });
  res.status(204).end();
});
