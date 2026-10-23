# Preview deployments (Step 14)

Every open pull request gets its own live URL, e.g. `https://blog-a1b2c3-pr12.devflow.com`, and it is removed when the PR closes.

## Set it up (once per project)
1. Open the project in the dashboard, tick **Deploy every pull request**.
2. In the GitHub repo: Settings → Webhooks → edit the DevFlow webhook → under events also tick **Pull requests**.
3. *(Optional, for the PR comment)* create a fine-grained token for that repo with **Pull requests: Read and write**, paste it under *Preview deployments → Save token*. Without it previews still work; you just won't get the link on the PR.

No DNS change is needed: the wildcard `*.<DOMAIN>` record from Step 1 already covers `<slug>-pr<N>.<DOMAIN>`.

## Behaviour
- New commit on the PR: a new build starts, the previous build of that PR is cancelled, the old preview keeps serving until the new one is healthy (same zero-downtime switch as production).
- PR closed or merged: containers and route are removed, the comment becomes "preview removed".
- At most `PREVIEW_MAX_PER_PROJECT` (default 5) previews per project; opening another retires the least recently updated one.
- Previews run with the project's CPU/memory limits and the same build sandbox as production.
- Extra env vars inside a preview: `DEVFLOW_PREVIEW=1`, `DEVFLOW_URL`, `DEVFLOW_PR_NUMBER`.

## Security notes
- **Fork PRs are never built.** They would run a stranger's code beside your secrets.
- A preview gets the project's environment variables. Do not put production-only secrets (live payment keys, prod database URL) on a project that has previews enabled; point it at a staging database instead. Per-environment variables are a good follow-up.
- Each preview hostname gets its own Let's Encrypt certificate. Let's Encrypt allows about 50 new certificates per week per registered domain, so a very busy install should move to a wildcard certificate (DNS-01) later.

## Known limits
- Images of old preview commits are not pruned yet (Step 12/13: registry and cache will handle that).
- Private repos still need Step 5 (GitHub App); previews only work where the normal deploy works.
