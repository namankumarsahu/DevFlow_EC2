import { parseRepo } from './previews';

const API = 'https://api.github.com';

async function gh(token: string, method: string, path: string, body?: unknown) {
  return fetch(API + path, {
    method,
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'devflow',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Create the preview comment, or edit the one we posted before. Returns the comment id to remember.
// Commenting is a nicety: this never throws, so a bad token can never fail a deployment.
export async function upsertPrComment(o: {
  token: string;
  repoUrl: string;
  prNumber: number;
  commentId: string | null;
  body: string;
}): Promise<{ commentId: string | null; error?: string }> {
  const repo = parseRepo(o.repoUrl);
  if (!repo) return { commentId: o.commentId, error: 'repo url is not a GitHub repository' };
  const base = `/repos/${repo.owner}/${repo.repo}`;
  try {
    if (o.commentId) {
      const res = await gh(o.token, 'PATCH', `${base}/issues/comments/${encodeURIComponent(o.commentId)}`, { body: o.body });
      if (res.ok) return { commentId: o.commentId };
      if (res.status !== 404) return { commentId: o.commentId, error: `GitHub ${res.status}` }; // 404 = comment was deleted: post a new one
    }
    const res = await gh(o.token, 'POST', `${base}/issues/${o.prNumber}/comments`, { body: o.body });
    if (!res.ok) return { commentId: o.commentId, error: `GitHub ${res.status}${res.status === 403 || res.status === 404 ? ' (token needs pull request write access)' : ''}` };
    const json = (await res.json()) as { id?: number };
    return { commentId: json.id ? String(json.id) : o.commentId };
  } catch (e) {
    return { commentId: o.commentId, error: (e as Error).message };
  }
}
