// Step 14: preview deployments. Pure functions only (no I/O) so they are easy to test.

export type PrPayload = {
  action?: string;
  number?: number;
  pull_request?: {
    number?: number;
    title?: string;
    state?: string;
    head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
    base?: { repo?: { full_name?: string } };
  };
};

export type PrDecision =
  | { kind: 'deploy'; number: number; title: string; branch: string; sha: string }
  | { kind: 'close'; number: number }
  | { kind: 'ignore'; reason: string };

// Same allow-list as the project branch: the value ends up in `git clone --branch`.
const SAFE_BRANCH = /^[\w][\w./-]*$/;

const DEPLOY_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

// What should a signed `pull_request` webhook do?
//  - PRs from forks are ignored: they would run a stranger's code with this project's secrets.
//  - Only the actions that change what the PR contains (or its open/closed state) matter.
export function decidePrAction(payload: PrPayload): PrDecision {
  const pr = payload.pull_request;
  const number = pr?.number ?? payload.number;
  if (!pr || !Number.isInteger(number) || (number as number) < 1) return { kind: 'ignore', reason: 'malformed payload' };
  const action = payload.action ?? '';

  if (action === 'closed') return { kind: 'close', number: number as number };
  if (!DEPLOY_ACTIONS.has(action)) return { kind: 'ignore', reason: `pull_request ${action || '(no action)'}` };

  const head = pr.head?.repo?.full_name;
  const base = pr.base?.repo?.full_name;
  if (!head || !base || head.toLowerCase() !== base.toLowerCase()) {
    return { kind: 'ignore', reason: 'pull request from a fork (not built: it would run untrusted code with your secrets)' };
  }
  const branch = pr.head?.ref ?? '';
  const sha = pr.head?.sha ?? '';
  if (!SAFE_BRANCH.test(branch) || branch.length > 100) return { kind: 'ignore', reason: 'unsupported branch name' };
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return { kind: 'ignore', reason: 'malformed commit sha' };
  return { kind: 'deploy', number: number as number, title: String(pr.title ?? '').slice(0, 200), branch, sha };
}

// "<project-slug>-pr12": one DNS label (<= 63 chars). Project slugs end in 6 hex chars, preview slugs end in
// "-pr<digits>", so the two can never collide.
export const previewSlug = (projectSlug: string, prNumber: number) => `${projectSlug}-pr${prNumber}`;

// ---- GitHub comment -------------------------------------------------------------------------------

export const COMMENT_MARKER = '<!-- devflow-preview -->';

export type CommentState =
  | { state: 'building'; sha: string }
  | { state: 'ready'; sha: string; url: string }
  | { state: 'failed'; sha: string; error: string }
  | { state: 'closed' };

const short = (sha: string) => sha.slice(0, 7);
// Keep the comment readable and never let an error message inject markdown/HTML or @mentions.
const clean = (text: string, max = 300) =>
  text.replace(/[\r\n]+/g, ' ').replace(/[<>`@]/g, '').trim().slice(0, max);

export function previewComment(c: CommentState, dashboardUrl?: string): string {
  const logs = dashboardUrl ? `\n\n[View build logs](${dashboardUrl})` : '';
  switch (c.state) {
    case 'building':
      return `${COMMENT_MARKER}\n### 🔨 DevFlow preview: building\nCommit \`${short(c.sha)}\` is being built. This comment updates when it is ready.${logs}`;
    case 'ready':
      return `${COMMENT_MARKER}\n### ✅ DevFlow preview is ready\n**${c.url}**\n\nCommit \`${short(c.sha)}\`${logs}`;
    case 'failed':
      return `${COMMENT_MARKER}\n### ❌ DevFlow preview failed\nCommit \`${short(c.sha)}\`\n\n> ${clean(c.error)}${logs}`;
    case 'closed':
      return `${COMMENT_MARKER}\n### 🧹 DevFlow preview removed\nThis pull request was closed, so its preview was shut down.`;
  }
}

// https://github.com/owner/repo -> { owner, repo }. Null for anything else.
export function parseRepo(repoUrl: string): { owner: string; repo: string } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repoUrl);
  return m ? { owner: m[1], repo: m[2] } : null;
}
