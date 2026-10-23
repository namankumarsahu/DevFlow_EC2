import { config } from '../config';
import { prisma } from '../db';
import { ensureSlug } from '../lib/slug';
import { previewSlug } from '../lib/previews';
import { cancelDeployment, enqueueDeployment, enqueuePreviewTeardown } from './deployments';

const ACTIVE_DEPLOYMENT = ['QUEUED', 'BUILDING', 'DEPLOYING'];

type ProjectRef = { id: string; name: string; slug: string | null; ownerId: string };

// Stop whatever is still running for a preview (a newer commit or a closed PR makes it pointless).
async function cancelActive(previewId: string) {
  const active = await prisma.deployment.findMany({
    where: { previewId, status: { in: ACTIVE_DEPLOYMENT as any } },
    select: { id: true, status: true },
  });
  for (const d of active) await cancelDeployment(d).catch(() => undefined);
}

// Mark a preview CLOSED right away (so routing and the worker see it), then let the worker remove containers.
export async function closePreviewById(previewId: string) {
  await prisma.preview.update({ where: { id: previewId }, data: { status: 'CLOSED' } });
  await cancelActive(previewId);
  await enqueuePreviewTeardown(previewId);
}

// A PR was opened / updated: make sure it has a Preview row and queue a build of its head branch.
export async function deployPreview(project: ProjectRef, pr: { number: number; title: string; branch: string; sha: string }) {
  const slug = previewSlug(project.slug ?? (await ensureSlug(project.id, project.name)), pr.number);
  const existing = await prisma.preview.findUnique({ where: { projectId_prNumber: { projectId: project.id, prNumber: pr.number } } });

  // Abuse / disk protection: only N previews per project. A new PR retires the least recently updated one.
  if (!existing || existing.status !== 'ACTIVE') {
    const open = await prisma.preview.findMany({
      where: { projectId: project.id, status: 'ACTIVE', NOT: { id: existing?.id ?? '' } },
      orderBy: { updatedAt: 'asc' },
    });
    const overflow = open.length - (config.previews.maxPerProject - 1);
    for (const old of open.slice(0, Math.max(0, overflow))) await closePreviewById(old.id);
  }

  const data = { title: pr.title, branch: pr.branch, headSha: pr.sha, status: 'ACTIVE' as const };
  const preview = existing
    ? await prisma.preview.update({ where: { id: existing.id }, data })
    : await prisma.preview.create({ data: { ...data, projectId: project.id, prNumber: pr.number, slug } });

  await cancelActive(preview.id); // older commits of this PR are superseded
  const deployment = await enqueueDeployment(project.id, project.ownerId, undefined, { previewId: preview.id });
  return { preview, deployment };
}

export async function closePreviewForPr(projectId: string, prNumber: number) {
  const preview = await prisma.preview.findUnique({ where: { projectId_prNumber: { projectId, prNumber } } });
  if (!preview || preview.status === 'CLOSED') return null;
  await closePreviewById(preview.id);
  return preview;
}
