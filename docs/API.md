# API Reference

Base URL: `/api`. JSON in/out. Authenticated routes need `Authorization: Bearer <jwt>`.
Errors: `{ "error": "message", "details"?: {field: [msgs]} }`.

## Auth
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/register` | `{email, password(min 8)}` | First user becomes `ADMIN`. Returns `{token, user}`. Rate limited. |
| POST | `/auth/login` | `{email, password}` | Returns `{token, user}`. |
| GET | `/auth/me` | — | Current user. |

## Projects
| Method | Path | Notes |
|---|---|---|
| POST | `/projects` | `{name, repoUrl: "https://github.com/o/r", branch?, environment?: DEVELOPMENT\|STAGING\|PRODUCTION, containerPort?, memoryMb?, cpus?, diskMb?}` — limits default to the server defaults; non-admins are capped at the server maximum (400 otherwise). |
| GET | `/projects/limits` | `{defaults, max, diskQuotaEnforced}` for the limits form. |
| GET | `/projects` | Own projects (admins see all). |
| GET | `/projects/:id` | Includes `webhookSecret`. |
| PATCH | `/projects/:id` | Partial update (not `repoUrl`). Resource limits apply on the next deploy. |
| DELETE | `/projects/:id` | Deletes data and queues container teardown. |
| POST | `/projects/:id/deploy` | `202` + Deployment (QUEUED). |
| GET | `/projects/:id/deployments?limit=50` | History: commit, duration, status, url. Preview deployments are not listed here. |
| GET | `/projects/:id/previews` | One entry per pull request: `{prNumber, title, branch, headSha, slug, status: ACTIVE\|CLOSED, url, latest}`. `url` is set only while the preview is live. |
| DELETE | `/projects/:id/previews/:previewId` | Shut a preview down now (closing the PR does this automatically). |
| PUT | `/projects/:id/github-token` | `{token}` write-only, encrypted. Used only to comment the preview link on pull requests. |
| DELETE | `/projects/:id/github-token` | |

## Environment variables
| Method | Path | Notes |
|---|---|---|
| GET | `/projects/:id/env` | Keys only — values are never returned. |
| PUT | `/projects/:id/env` | `{key, value}` upsert (encrypted). |
| DELETE | `/projects/:id/env/:key` | |

## Deployments
| Method | Path | Notes |
|---|---|---|
| GET | `/deployments/:id` | |
| GET | `/deployments/:id/logs` | Persisted log lines. |
| POST | `/deployments/:id/rollback` | Target must be `SUCCESS`. Creates a new deployment re-running that image. |
| POST | `/deployments/:id/cancel` | Works for QUEUED / BUILDING / DEPLOYING. |

Status lifecycle: `QUEUED → BUILDING → DEPLOYING → SUCCESS | FAILED | CANCELLED`.

## Live logs (WebSocket)
`ws(s)://<host>/ws/logs?deploymentId=<id>&token=<jwt>`

Server sends history first, then live messages:
```json
{"type":"log","line":"==> Building image …","ts":1730000000000}
{"type":"status","status":"SUCCESS"}
```
Close codes: `4401` unauthorized, `4403` forbidden.

## GitHub webhook
`POST /webhooks/github/:projectId` — configure in GitHub with content type `application/json`, event `push`, and the project's secret. Verified with `X-Hub-Signature-256` (HMAC-SHA256, constant-time compare). Only pushes to the project's tracked branch trigger a deployment.

### Pull request previews (Step 14)
Also subscribe the webhook to **Pull requests**. With `previewsEnabled` set on the project (PATCH `/projects/:id`):

| PR action | Result |
|---|---|
| `opened`, `reopened`, `synchronize`, `ready_for_review` | Builds the PR's head branch and serves it at `https://<project-slug>-pr<N>.<DOMAIN>`. Older builds of the same PR are cancelled. |
| `closed` (merged or not) | Cancels running builds, removes the containers and the route. |
| anything else, or a PR from a **fork** | `202 {ignored}`. Forks are never built: they would run a stranger's code next to your secrets. |

The project response now includes `previewsEnabled` and `hasGithubToken` (the token itself is never returned).

## Admin (ADMIN role)
| Method | Path | Notes |
|---|---|---|
| GET | `/admin/stats` | Totals, status breakdown, success rate, avg duration, last-7-days series. |
| GET | `/admin/users` | |
| PATCH | `/admin/users/:id` | `{role}` — cannot change self. |
| DELETE | `/admin/users/:id` | Cannot delete self. |

## Health
`GET /health` → `{ok:true}`
