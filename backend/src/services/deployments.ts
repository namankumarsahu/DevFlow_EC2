import { prisma } from '../db';
import { HttpError } from '../lib/errors';
import { publishStatus } from '../lib/events';
import { getQueue } from '../queue';
import { getRedis } from '../redis';

type RollbackSource = { id: string; imageTag: string; commitHash: string | null };

export async function enqueueDeployment(
  projectId: string,
  userId: string | null,
  rollback?: RollbackSource,
  opts: { previewId?: string } = {},
) {
  const deployment = await prisma.deployment.create({
    data: {
      projectId,
      triggeredById: userId,
      status: 'QUEUED',
      previewId: opts.previewId,
      rollbackOfId: rollback?.id,
      imageTag: rollback?.imageTag,
      commitHash: rollback?.commitHash,
    },
  });
  await getQueue().add('deploy', { deploymentId: deployment.id }, { jobId: deployment.id, attempts: 1 });
  return deployment;
}

export async function cancelDeployment(d: { id: string; status: string }) {
  if (d.status === 'QUEUED') {
    // The worker re-checks status after it acquires the project lock, so a job that
    // is already active (waiting for the lock) also stops cleanly.
    await getQueue().getJob(d.id).then((j) => j?.remove()).catch(() => undefined);
    await prisma.deployment.update({
      where: { id: d.id },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    await publishStatus(d.id, 'CANCELLED');
  } else if (d.status === 'BUILDING' || d.status === 'DEPLOYING') {
    // Worker polls this key and kills the running child process.
    await getRedis().set(`cancel:${d.id}`, '1', 'EX', 3600);
  } else {
    throw new HttpError(409, `Deployment already ${d.status.toLowerCase()}`);
  }
}

export const enqueueTeardown = (projectId: string) =>
  getQueue().add('teardown', { projectId }, { attempts: 1 });

// Step 14: remove a closed PR's containers (the worker waits for any in-flight build of that preview first).
export const enqueuePreviewTeardown = (previewId: string) =>
  getQueue().add('preview-teardown', { previewId }, { attempts: 1 });
