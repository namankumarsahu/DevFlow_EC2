import crypto from 'crypto';
import request from 'supertest';

jest.mock('../src/db', () => ({ prisma: { project: { findUnique: jest.fn() } } }));
jest.mock('../src/queue', () => ({ getQueue: jest.fn() }));
jest.mock('../src/services/previews', () => ({ deployPreview: jest.fn(), closePreviewForPr: jest.fn() }));

import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { buildPreviewRoutes } from '../src/lib/caddyConfig';
import { staleNamesInScope } from '../src/lib/containers';
import { COMMENT_MARKER, decidePrAction, parseRepo, previewComment, previewSlug } from '../src/lib/previews';
import { closePreviewForPr, deployPreview } from '../src/services/previews';

const db = prisma as any;
const app = createApp();
beforeEach(() => jest.resetAllMocks());

const pr = (over: any = {}, action = 'opened') => ({
  action,
  number: 7,
  pull_request: {
    number: 7,
    title: 'Add dark mode',
    head: { ref: 'feature/dark-mode', sha: 'a'.repeat(40), repo: { full_name: 'me/app' } },
    base: { repo: { full_name: 'me/app' } },
    ...over,
  },
});

describe('decidePrAction', () => {
  it('deploys opened / reopened / synchronize / ready_for_review', () => {
    for (const a of ['opened', 'reopened', 'synchronize', 'ready_for_review']) {
      expect(decidePrAction(pr({}, a))).toMatchObject({ kind: 'deploy', number: 7, branch: 'feature/dark-mode' });
    }
  });
  it('closes on closed (merged or not)', () => {
    expect(decidePrAction(pr({}, 'closed'))).toEqual({ kind: 'close', number: 7 });
  });
  it('ignores labels, edits, assignments, ...', () => {
    for (const a of ['labeled', 'edited', 'assigned', 'converted_to_draft']) {
      expect(decidePrAction(pr({}, a)).kind).toBe('ignore');
    }
  });
  it('never builds pull requests from forks', () => {
    const d = decidePrAction(pr({ head: { ref: 'x', sha: 'b'.repeat(40), repo: { full_name: 'stranger/app' } } }));
    expect(d.kind).toBe('ignore');
    expect(decidePrAction(pr({ head: { ref: 'x', sha: 'b'.repeat(40), repo: null } })).kind).toBe('ignore'); // deleted fork
  });
  it('is case-insensitive about the repo name', () => {
    const d = decidePrAction(pr({ head: { ref: 'x', sha: 'b'.repeat(40), repo: { full_name: 'Me/App' } } }));
    expect(d.kind).toBe('deploy');
  });
  it('rejects flag-like branch names and bad shas (they reach git)', () => {
    expect(decidePrAction(pr({ head: { ref: '--upload-pack=x', sha: 'c'.repeat(40), repo: { full_name: 'me/app' } } })).kind).toBe('ignore');
    expect(decidePrAction(pr({ head: { ref: 'ok', sha: 'not-a-sha', repo: { full_name: 'me/app' } } })).kind).toBe('ignore');
  });
  it('survives malformed payloads', () => {
    expect(decidePrAction({}).kind).toBe('ignore');
    expect(decidePrAction({ action: 'opened' }).kind).toBe('ignore');
  });
});

describe('previewSlug', () => {
  it('stays a single DNS label and cannot collide with a project slug', () => {
    const slug = previewSlug('a'.repeat(40) + '-a1b2c3', 1234567);
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(previewSlug('blog-a1b2c3', 12)).toBe('blog-a1b2c3-pr12');
    expect(/-[0-9a-f]{6}$/.test(previewSlug('blog-a1b2c3', 12))).toBe(false); // project slugs end in 6 hex chars
  });
});

describe('previewComment', () => {
  it('carries the marker and the right content per state', () => {
    expect(previewComment({ state: 'building', sha: 'abcdef1234' })).toContain(COMMENT_MARKER);
    const ready = previewComment({ state: 'ready', sha: 'abcdef1234', url: 'https://x-pr7.devflow.com' }, 'https://devflow.com/projects/p1');
    expect(ready).toContain('https://x-pr7.devflow.com');
    expect(ready).toContain('abcdef1');
    expect(ready).toContain('https://devflow.com/projects/p1');
    expect(previewComment({ state: 'closed' })).toContain('removed');
  });
  it('sanitises error text so it cannot inject markdown, html or @mentions', () => {
    const c = previewComment({ state: 'failed', sha: 'abcdef1234', error: 'boom <script>@everyone `x`\nnext line' });
    expect(c).not.toMatch(/<script>|@everyone|`x`/);
    expect(c).not.toContain('\nnext line');
  });
});

describe('parseRepo', () => {
  it('parses github https urls only', () => {
    expect(parseRepo('https://github.com/me/app')).toEqual({ owner: 'me', repo: 'app' });
    expect(parseRepo('https://github.com/me/app.git')).toEqual({ owner: 'me', repo: 'app' });
    expect(parseRepo('https://evil.com/me/app')).toBeNull();
  });
});

describe('staleNamesInScope', () => {
  const ps = ['devflow-p1-aaaa\t', 'devflow-p1-bbbb\t', 'devflow-p1-pr1\tprev1', 'devflow-p1-pr2\tprev2'].join('\n');
  it('production cleanup never touches previews', () => {
    expect(staleNamesInScope(ps, 'devflow-p1-aaaa', { production: true })).toEqual(['devflow-p1-bbbb']);
  });
  it('preview cleanup only touches that preview', () => {
    expect(staleNamesInScope(ps, null, { previewId: 'prev1' })).toEqual(['devflow-p1-pr1']);
    expect(staleNamesInScope(ps, 'devflow-p1-pr1', { previewId: 'prev1' })).toEqual([]);
  });
  it('project teardown removes everything', () => {
    expect(staleNamesInScope(ps, null, 'all')).toHaveLength(4);
  });
});

describe('buildPreviewRoutes', () => {
  const deps = [{ id: 'd1', containerName: 'devflow-p1-d1d1d1d1' }];
  it('routes only ACTIVE previews that are live', () => {
    const routes = buildPreviewRoutes(
      [
        { slug: 'blog-a1b2c3-pr7', currentDeploymentId: 'd1', status: 'ACTIVE', containerPort: 3000 },
        { slug: 'blog-a1b2c3-pr8', currentDeploymentId: 'd1', status: 'CLOSED', containerPort: 3000 },
        { slug: 'blog-a1b2c3-pr9', currentDeploymentId: null, status: 'ACTIVE', containerPort: 3000 },
      ],
      deps,
      'devflow.com',
    );
    expect(routes).toEqual([{ host: 'blog-a1b2c3-pr7.devflow.com', upstream: 'devflow-p1-d1d1d1d1:3000' }]);
  });
});

describe('pull_request webhook', () => {
  const project = { id: 'p1', ownerId: 'u1', branch: 'main', webhookSecret: 'topsecret', previewsEnabled: true };
  const send = (payload: object, event = 'pull_request', secret = project.webhookSecret) => {
    const body = JSON.stringify(payload);
    return request(app)
      .post('/api/webhooks/github/p1')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', event)
      .set('X-Hub-Signature-256', 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex'))
      .send(body);
  };

  it('rejects an unsigned/bad signature', async () => {
    db.project.findUnique.mockResolvedValue(project);
    expect((await send(pr(), 'pull_request', 'wrong')).status).toBe(401);
    expect(deployPreview).not.toHaveBeenCalled();
  });

  it('queues a preview for an opened PR', async () => {
    db.project.findUnique.mockResolvedValue(project);
    (deployPreview as jest.Mock).mockResolvedValue({ preview: { id: 'pv1' }, deployment: { id: 'd1' } });
    const res = await send(pr());
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ previewId: 'pv1', deploymentId: 'd1' });
    expect(deployPreview).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), expect.objectContaining({ number: 7, branch: 'feature/dark-mode' }));
  });

  it('tears the preview down when the PR closes', async () => {
    db.project.findUnique.mockResolvedValue(project);
    (closePreviewForPr as jest.Mock).mockResolvedValue({ id: 'pv1' });
    const res = await send(pr({}, 'closed'));
    expect(res.body).toEqual({ closed: true });
    expect(closePreviewForPr).toHaveBeenCalledWith('p1', 7);
  });

  it('does nothing when previews are off for the project', async () => {
    db.project.findUnique.mockResolvedValue({ ...project, previewsEnabled: false });
    const res = await send(pr());
    expect(res.status).toBe(202);
    expect(res.body.ignored).toMatch(/not enabled/);
    expect(deployPreview).not.toHaveBeenCalled();
  });

  it('ignores fork PRs', async () => {
    db.project.findUnique.mockResolvedValue(project);
    const res = await send(pr({ head: { ref: 'x', sha: 'b'.repeat(40), repo: { full_name: 'stranger/app' } } }));
    expect(res.body.ignored).toMatch(/fork/);
    expect(deployPreview).not.toHaveBeenCalled();
  });
});
