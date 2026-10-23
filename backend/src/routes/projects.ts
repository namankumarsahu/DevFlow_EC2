import crypto from 'crypto';
import { Request, Router } from 'express';
import { z } from 'zod';
import { appUrl, config } from '../config';
import { prisma } from '../db';
import { encrypt } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { limitsExceeded } from '../lib/limits';
import { makeSlug } from '../lib/slug';
import { closePreviewById } from '../services/previews';
import { authenticate } from '../middleware/auth';
import { enqueueDeployment, enqueueTeardown } from '../services/deployments';

export const projectsRouter = Router();
projectsRouter.use(authenticate);

export async function getAccessibleProject(req: Request, id: string) {
  const p = await prisma.project.findUnique({ where: { id } });
  if (!p || (p.ownerId !== req.user!.id && req.user!.role !== 'ADMIN')) throw new HttpError(404, 'Project not found');
  return p;
}

// Never send the encrypted GitHub token to the browser; only whether one is set.
export function publicProject<T extends { githubTokenEnc?: string | null }>(p: T) {
  const { githubTokenEnc, ...rest } = p;
  return { ...rest, hasGithubToken: !!githubTokenEnc };
}

// Strict allow-lists: values end up in `git clone`, so no flags / local paths / other hosts.
const projectSchema = z.object({
  name: z.string().min(1).max(60),
  repoUrl: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/, 'Must be https://github.com/<owner>/<repo>'),
  branch: z.string().regex(/^[\w][\w./-]*$/).max(100).default('main'),
  environment: z.enum(['DEVELOPMENT', 'STAGING', 'PRODUCTION']).default('PRODUCTION'),
  containerPort: z.number().int().min(1).max(65535).default(3000),
  // Step 7: resource limits. Upper bounds for non-admins are checked in assertWithinLimits().
  memoryMb: z.number().int().min(64).max(1_048_576).default(config.defaultLimits.memoryMb),
  cpus: z.number().min(0.1).max(64).default(config.defaultLimits.cpus),
  diskMb: z.number().int().min(128).max(10_485_760).default(config.defaultLimits.diskMb),
  previewsEnabled: z.boolean().default(false), // Step 14
});

function assertWithinLimits(req: Request, data: { memoryMb?: number; cpus?: number; diskMb?: number }) {
  if (req.user!.role === 'ADMIN') return; // admins may go above the per-app maximum
  const problem = limitsExceeded(data, config.maxLimits);
  if (problem) throw new HttpError(400, `Resource limit too high: ${problem}`);
}

// What the dashboard needs to render the limits form.
projectsRouter.get('/limits', (_req, res) => {
  res.json({ defaults: config.defaultLimits, max: config.maxLimits, diskQuotaEnforced: config.runtime.storageQuota });
});

projectsRouter.post('/', async (req, res) => {
  const data = projectSchema.parse(req.body);
  assertWithinLimits(req, data);
  const agg = await prisma.project.aggregate({ _max: { hostPort: true } });
  const project = await prisma.project.create({
    data: {
      ...data,
      ownerId: req.user!.id,
      hostPort: (agg._max.hostPort ?? 19999) + 1, // legacy column, no longer published
      slug: makeSlug(data.name),
      webhookSecret: crypto.randomBytes(24).toString('hex'),
    },
  });
  res.status(201).json(publicProject(project));
});

projectsRouter.get('/', async (req, res) => {
  const where = req.user!.role === 'ADMIN' ? {} : { ownerId: req.user!.id };
  res.json((await prisma.project.findMany({ where, orderBy: { createdAt: 'desc' } })).map(publicProject));
});

projectsRouter.get('/:id', async (req, res) => {
  res.json(publicProject(await getAccessibleProject(req, req.params.id)));
});

projectsRouter.patch('/:id', async (req, res) => {
  await getAccessibleProject(req, req.params.id);
  const data = projectSchema.partial().omit({ repoUrl: true }).parse(req.body);
  assertWithinLimits(req, data);
  res.json(publicProject(await prisma.project.update({ where: { id: req.params.id }, data })));
});

projectsRouter.delete('/:id', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  await prisma.project.delete({ where: { id: p.id } });
  await enqueueTeardown(p.id); // worker removes the running container
  res.status(204).end();
});

projectsRouter.post('/:id/deploy', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  res.status(202).json(await enqueueDeployment(p.id, req.user!.id));
});

projectsRouter.get('/:id/deployments', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(await prisma.deployment.findMany({ where: { projectId: p.id, previewId: null }, orderBy: { createdAt: 'desc' }, take: limit }));
});

// ---- Environment variables (encrypted at rest, values never returned) ----
const envSchema = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(100),
  value: z.string().max(4096).refine((v) => !/[\r\n]/.test(v), 'Newlines are not allowed'),
});

projectsRouter.get('/:id/env', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  const vars = await prisma.envVar.findMany({ where: { projectId: p.id }, orderBy: { key: 'asc' } });
  res.json(vars.map((v) => ({ key: v.key, updatedAt: v.updatedAt })));
});

projectsRouter.put('/:id/env', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  const { key, value } = envSchema.parse(req.body);
  const valueEnc = encrypt(value);
  await prisma.envVar.upsert({
    where: { projectId_key: { projectId: p.id, key } },
    create: { projectId: p.id, key, valueEnc },
    update: { valueEnc },
  });
  res.json({ key });
});

projectsRouter.delete('/:id/env/:key', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  await prisma.envVar.deleteMany({ where: { projectId: p.id, key: req.params.key } });
  res.status(204).end();
});

// ---- Step 14: preview deployments (one per open pull request) ----
projectsRouter.get('/:id/previews', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  const previews = await prisma.preview.findMany({
    where: { projectId: p.id },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { deployments: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, url: true, error: true, commitHash: true } } },
  });
  res.json(
    previews.map(({ deployments, commentId, ...pv }) => ({
      ...pv,
      latest: deployments[0] ?? null,
      url: pv.currentDeploymentId ? appUrl(pv.slug) : null, // only a preview that is actually live has a URL
    })),
  );
});

// Manually shut a preview down (the PR closing does this automatically).
projectsRouter.delete('/:id/previews/:previewId', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  const preview = await prisma.preview.findUnique({ where: { id: req.params.previewId } });
  if (!preview || preview.projectId !== p.id) throw new HttpError(404, 'Preview not found');
  if (preview.status === 'ACTIVE') await closePreviewById(preview.id);
  res.status(204).end();
});

// Token used ONLY to post the preview link on pull requests (fine-grained PAT: "Pull requests: Read and write").
const tokenSchema = z.object({ token: z.string().min(20).max(255).regex(/^[\w-]+$/, 'Not a valid GitHub token') });

projectsRouter.put('/:id/github-token', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  const { token } = tokenSchema.parse(req.body);
  await prisma.project.update({ where: { id: p.id }, data: { githubTokenEnc: encrypt(token) } });
  res.json({ hasGithubToken: true });
});

projectsRouter.delete('/:id/github-token', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  await prisma.project.update({ where: { id: p.id }, data: { githubTokenEnc: null } });
  res.status(204).end();
});
