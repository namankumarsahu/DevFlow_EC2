import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';

jest.mock('../src/db', () => ({
  prisma: {
    user: { count: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    project: { findUnique: jest.fn(), aggregate: jest.fn(), create: jest.fn() },
    deployment: { create: jest.fn() },
  },
}));
jest.mock('../src/queue', () => ({ getQueue: jest.fn() }));

import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { getQueue } from '../src/queue';

const db = prisma as any;
const app = createApp();

beforeEach(() => jest.resetAllMocks());

const asUser = (role: 'USER' | 'ADMIN' = 'USER') => {
  db.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.co', role });
  return `Bearer ${signToken({ id: 'u1', role })}`;
};

describe('auth', () => {
  it('makes the first registered user an ADMIN and never leaks the hash', async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.user.count.mockResolvedValue(0);
    db.user.create.mockImplementation(async ({ data }: any) => ({ id: 'u1', createdAt: new Date(), ...data }));
    const res = await request(app).post('/api/auth/register').send({ email: 'Admin@Example.com', password: 'password123' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('ADMIN');
    expect(res.body.user.email).toBe('admin@example.com');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('makes later users regular USERs', async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.user.count.mockResolvedValue(3);
    db.user.create.mockImplementation(async ({ data }: any) => ({ id: 'u2', createdAt: new Date(), ...data }));
    const res = await request(app).post('/api/auth/register').send({ email: 'u@example.com', password: 'password123' });
    expect(res.body.user.role).toBe('USER');
  });

  it('rejects duplicate emails (409) and weak passwords (400)', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'x' });
    expect((await request(app).post('/api/auth/register').send({ email: 'a@b.co', password: 'password123' })).status).toBe(409);
    expect((await request(app).post('/api/auth/register').send({ email: 'a@b.co', password: 'short' })).status).toBe(400);
  });

  it('logs in with correct credentials and rejects wrong ones', async () => {
    db.user.findUnique.mockResolvedValue({
      id: 'u1', email: 'a@b.co', role: 'USER', createdAt: new Date(), passwordHash: await bcrypt.hash('correct-pass', 4),
    });
    const ok = await request(app).post('/api/auth/login').send({ email: 'a@b.co', password: 'correct-pass' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeDefined();
    const bad = await request(app).post('/api/auth/login').send({ email: 'a@b.co', password: 'wrong-pass1' });
    expect(bad.status).toBe(401);
  });
});

describe('authorization', () => {
  it('requires a token for protected routes', async () => {
    expect((await request(app).get('/api/projects')).status).toBe(401);
    expect((await request(app).get('/api/projects').set('Authorization', 'Bearer garbage')).status).toBe(401);
  });

  it('blocks non-admins from admin routes', async () => {
    const res = await request(app).get('/api/admin/stats').set('Authorization', asUser('USER'));
    expect(res.status).toBe(403);
  });

  it('hides other users\' projects behind a 404', async () => {
    const auth = asUser('USER');
    db.project.findUnique.mockResolvedValue({ id: 'p1', ownerId: 'someone-else' });
    expect((await request(app).get('/api/projects/p1').set('Authorization', auth)).status).toBe(404);
  });
});

describe('project validation', () => {
  it('rejects non-GitHub / flag-like repo URLs', async () => {
    const auth = asUser('USER');
    for (const repoUrl of ['https://evil.com/a/b', '--upload-pack=touch /tmp/x', 'file:///etc/passwd']) {
      const res = await request(app).post('/api/projects').set('Authorization', auth).send({ name: 'x', repoUrl });
      expect(res.status).toBe(400);
    }
  });
});

describe('GitHub webhook', () => {
  const project = { id: 'p1', ownerId: 'u1', branch: 'main', webhookSecret: 'topsecret' };
  const body = JSON.stringify({ ref: 'refs/heads/main' });
  const sign = (b: string, secret = project.webhookSecret) =>
    'sha256=' + crypto.createHmac('sha256', secret).update(b).digest('hex');

  it('rejects a bad signature', async () => {
    db.project.findUnique.mockResolvedValue(project);
    const res = await request(app)
      .post('/api/webhooks/github/p1')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-Hub-Signature-256', sign(body, 'wrong'))
      .send(body);
    expect(res.status).toBe(401);
  });

  it('queues a deployment for a signed push to the tracked branch', async () => {
    db.project.findUnique.mockResolvedValue(project);
    db.deployment.create.mockResolvedValue({ id: 'd1' });
    const add = jest.fn();
    (getQueue as jest.Mock).mockReturnValue({ add });
    const res = await request(app)
      .post('/api/webhooks/github/p1')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);
    expect(res.status).toBe(202);
    expect(add).toHaveBeenCalledWith('deploy', { deploymentId: 'd1' }, expect.anything());
  });

  it('ignores pushes to other branches', async () => {
    db.project.findUnique.mockResolvedValue(project);
    const other = JSON.stringify({ ref: 'refs/heads/dev' });
    const res = await request(app)
      .post('/api/webhooks/github/p1')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-Hub-Signature-256', sign(other))
      .send(other);
    expect(res.status).toBe(202);
    expect(res.body.ignored).toBeDefined();
  });
});
