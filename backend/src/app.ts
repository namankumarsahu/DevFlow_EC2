import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { config } from './config';
import { errorHandler } from './middleware/error';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { deploymentsRouter } from './routes/deployments';
import { projectsRouter } from './routes/projects';
import { webhooksRouter } from './routes/webhooks';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin }));
  // Keep the raw body: GitHub's HMAC signature is computed over the exact bytes.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => ((req as any).rawBody = buf) }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: config.isProd ? 30 : 1000 }), authRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/deployments', deploymentsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/webhooks', webhooksRouter);

  app.use(errorHandler);
  return app;
}
