import crypto from 'crypto';
import { Request, Router } from 'express';
import { prisma } from '../db';
import { HttpError } from '../lib/errors';
import { decidePrAction } from '../lib/previews';
import { enqueueDeployment } from '../services/deployments';
import { closePreviewForPr, deployPreview } from '../services/previews';

export const webhooksRouter = Router();

// GitHub push webhook -> automatic deployment. Authenticated by HMAC (X-Hub-Signature-256).
webhooksRouter.post('/github/:projectId', async (req: Request, res) => {
  const project = await prisma.project.findUnique({ where: { id: String(req.params.projectId) } });
  if (!project) throw new HttpError(404, 'Project not found');

  const raw: Buffer | undefined = (req as any).rawBody;
  const sig = String(req.headers['x-hub-signature-256'] ?? '');
  const expected = 'sha256=' + crypto.createHmac('sha256', project.webhookSecret).update(raw ?? '').digest('hex');
  const valid = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!valid) throw new HttpError(401, 'Invalid signature');

  const event = req.headers['x-github-event'];
  if (event === 'ping') return res.json({ ok: true });

  // Step 14: pull requests -> preview deployments (opt-in per project).
  if (event === 'pull_request') {
    if (!project.previewsEnabled) return res.status(202).json({ ignored: 'previews are not enabled for this project' });
    const decision = decidePrAction(req.body ?? {});
    if (decision.kind === 'ignore') return res.status(202).json({ ignored: decision.reason });
    if (decision.kind === 'close') {
      const closed = await closePreviewForPr(project.id, decision.number);
      return res.status(202).json({ closed: !!closed });
    }
    const { preview, deployment } = await deployPreview(project, decision);
    return res.status(202).json({ previewId: preview.id, deploymentId: deployment.id });
  }
  if (event !== 'push') return res.status(202).json({ ignored: `event ${String(event)}` });
  if (req.body?.ref !== `refs/heads/${project.branch}`) return res.status(202).json({ ignored: 'other branch' });

  const d = await enqueueDeployment(project.id, project.ownerId);
  res.status(202).json({ deploymentId: d.id });
});
