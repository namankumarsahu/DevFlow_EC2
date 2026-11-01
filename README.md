# DevFlow — self-hosted deployment platform

Connect a GitHub repo, deploy with one click, watch the build live over WebSockets, and roll back instantly.

**Stack:** Node.js · Express 5 · TypeScript · PostgreSQL · Prisma · Redis · BullMQ · React · Tailwind · Docker Compose · GitHub Actions · Jest + Supertest


## DevFlow Link: https://3.105.144.208.sslip.io

## Features
- JWT auth with `USER` / `ADMIN` roles (first registered account is admin)
- Projects: GitHub repo + branch + environment (dev/staging/prod)
- Deployment pipeline on a BullMQ queue: clone → `docker build` → `docker run`
- Live logs via WebSocket (history + streaming through Redis pub/sub)
- Deployment history: commit hash, duration, status, URL
- **Every project gets its own HTTPS subdomain** (`https://<slug>.<your-domain>`) via Caddy + Let's Encrypt
- One-click rollback to any previous successful deployment (re-runs the stored image)
- Encrypted environment variables (AES-256-GCM, write-only API)
- Admin dashboard: deployment stats, 7-day chart, user management
- **Bonus:** GitHub push webhooks (HMAC verified), deployment cancellation, multiple environments

Docs: [Architecture & schema](docs/ARCHITECTURE.md) · [API reference](docs/API.md) · [Preview deploys](docs/PREVIEWS.md) · [Auto-detect](docs/AUTODETECT.md)

## Quick start (Docker)

Requires Docker with Compose v2.

```bash
cp .env.example .env
# generate real secrets:
#   openssl rand -hex 32   -> ENCRYPTION_KEY
#   openssl rand -hex 32   -> JWT_SECRET
docker compose up -d --build
```
Open http://localhost (apps appear at `http://<slug>.localhost`), register (you become admin), create a project and press **Deploy**.

> The target repo can have a `Dockerfile` at its root (listening on `$PORT`, default 3000), or no Dockerfile at all: DevFlow detects Next.js, Vite, Create React App, Express/other Node servers and plain static sites and builds them anyway ([docs/AUTODETECT.md](docs/AUTODETECT.md)). Only public GitHub repos are supported.

## Local development

```bash
docker compose up -d postgres redis      # infra only (add `ports:` mappings 5432/6379 locally)
cd backend
cp ../.env.example .env                  # set DATABASE_URL=postgresql://devflow:<pw>@localhost:5432/devflow
npm install && npx prisma db push
npm run dev          # API on :4000
npm run dev:worker   # worker (needs git + docker on your machine)
cd ../frontend && npm install && npm run dev   # UI on :5173 (proxies /api and /ws)
```

## Tests
```bash
cd backend && npm test
```
Covers encryption, auth flows, RBAC, ownership checks, input validation (repo URL injection attempts) and webhook signature verification. Prisma and the queue are mocked, so no services are needed.

## Deploy to a server (HTTPS + subdomains)
1. Any Ubuntu VPS / EC2 (t3.small+). Open ports **22, 80, 443** only (the old 20000–20100 range is no longer needed).
2. DNS (Cloudflare, set to **DNS only**): `A devflow.com -> <server ip>` and `A *.devflow.com -> <server ip>`.
3. `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`
4. `git clone <your-repo> ~/devflow && cd ~/devflow && cp .env.example .env` — set secrets, `DOMAIN=devflow.com`, `CORS_ORIGIN=https://devflow.com`, optionally `ACME_EMAIL`.
5. `docker compose up -d --build` — the dashboard is at `https://devflow.com`, each project at `https://<slug>.devflow.com`.
6. CI/CD: add repo secrets `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`; every push to `main` runs tests, builds images and redeploys over SSH (`.github/workflows/ci.yml`).

### Zero-downtime deploys
Every deployment runs in its own container (`devflow-<project>-<deployment>`). A deploy goes:
1. Start the **new** container next to the old one. The old one keeps serving.
2. **Health check:** the worker calls `GET /` (`HEALTH_PATH`) on the new container until it answers with a status below 500, twice in a row (up to `HEALTH_TIMEOUT_MS`). A 404 or a redirect is fine, it means the server is up. If the container exits, or nothing answers, or it only returns 5xx, the deploy **fails, the new container is deleted and the old version is never touched**.
3. **Switch:** Caddy is told to route to the new container (graceful reload; requests already in flight finish).
4. **Drain:** after `DRAIN_MS` the old container is removed.

Rollbacks use the same path, so they are zero-downtime too. Apps must listen on `$PORT`. Long-lived connections (WebSockets) are cut at the switch and reconnect to the new version.

### How routing works
Caddy is the only public entrypoint (80/443). After every deploy / rollback / delete, the api/worker rebuild the full route table from the database and push it to Caddy's admin API, which listens on a **unix socket** shared only with api + worker. App containers run on a separate `devflow_apps` network with no published ports, so they are reachable only through Caddy and cannot reach Postgres/Redis. Certificates live in the `caddy_data` volume — don't delete it (Let's Encrypt allows ~50 new certs per domain per week).

## Security notes
- Passwords: bcrypt (cost 12). JWT 12h; user re-loaded per request so role changes/deletions apply immediately.
- Helmet, CORS allow-list, rate-limited auth routes, zod validation everywhere.
- Repo URL/branch allow-lists + no-shell process spawning prevent command/argument injection.
- Secrets are decrypted only in the worker and passed via a temp env-file (0600) removed after start.
- Production refuses to boot with default `JWT_SECRET` / `ENCRYPTION_KEY`.
- **Sandboxed builds (step 6):** untrusted Dockerfiles are built in a separate rootless BuildKit container on its own network; `git`/`docker`/`buildctl` run with a minimal environment (no secrets); repos over `MAX_REPO_MB` are rejected.
- **Auto-detect frameworks (step 4):** no Dockerfile needed for Next.js, Vite, CRA, Express/Node servers and static sites. DevFlow writes one, shows it in the deploy log, and builds it in the same sandbox. Details: [docs/AUTODETECT.md](docs/AUTODETECT.md).
- **Preview deploys (step 14):** every open pull request gets its own URL (`<slug>-pr<N>.<DOMAIN>`), a GitHub comment with the link, and is removed when the PR closes. Opt-in per project; fork PRs are never built. Setup: [docs/PREVIEWS.md](docs/PREVIEWS.md).
- **Resource limits (step 7):** every app gets memory (no swap), CPU, process, file-descriptor, `/tmp` and log-size limits, dropped capabilities and `no-new-privileges`. Memory/CPU/disk are set per project in the dashboard. Details, first-deploy checks and remaining gaps: [docs/SANDBOX.md](docs/SANDBOX.md).

## Known limitations / next steps
- **The worker still mounts the Docker socket** (root-equivalent on the host) to start app containers. Builds no longer use it (they run in rootless BuildKit), and app containers are limited, but apps share the host kernel. See "What this does NOT fix yet" in [docs/SANDBOX.md](docs/SANDBOX.md). On EC2 run `scripts/block-metadata.sh`.
- Redeploys are zero-downtime (see below). During the switch both versions run at once, so a deploy briefly needs about double the app's memory.
- Schema is applied with `prisma db push`; for a real production flow commit migrations (`npx prisma migrate dev --name init`) and switch to `migrate deploy`.
- Private repos, email/Discord notifications and a CPU/memory monitoring dashboard (`docker stats`) are not implemented.
- Apps on the `devflow_apps` network can still reach each other (per-project networks come with the sandboxing phase).
- One Let's Encrypt cert per subdomain; a wildcard cert (DNS challenge) is the upgrade if you outgrow the rate limits.
- `Project.hostPort` is a legacy column, no longer published or used for URLs.

## Submission checklist
- [ ] Push to a public GitHub repo
- [ ] Deploy to EC2 and put the live URL here
- [ ] Render the Mermaid diagrams in `docs/ARCHITECTURE.md` to PNG if the reviewer wants an image
- [ ] Record the 3–5 min demo (register → create project → deploy → live logs → env var → rollback → admin dashboard)
