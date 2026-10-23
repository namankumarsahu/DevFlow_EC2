# Build sandbox and resource limits (roadmap steps 6 and 7)

## What changed

| Before | Now |
|---|---|
| `docker build` ran on the host Docker daemon, with the network and privileges that implies | Untrusted Dockerfiles run in a **separate rootless BuildKit container** (`buildkit` service) |
| Build steps could reach everything on the default Docker network | Builds live on their own `devflow_builds` network that holds only the worker and BuildKit (no Postgres, Redis, API or user apps) |
| Worker passed its full environment (DB URL, JWT secret, encryption key) to `git`/`docker` | Child processes get an allow-list env (`PATH`, `HOME`, ...). No secrets |
| No limits on app containers | Memory (no swap), CPU, processes, open files, `/tmp`, log size, optional disk quota |
| Huge repos accepted | Rejected above `MAX_REPO_MB` (default 500) |

Build flow: `git clone` (hardened) -> size check -> `buildctl build` against the BuildKit container -> image exported as a tarball -> `docker load` into the app daemon -> normal blue/green deploy.

## Step 6: build sandbox

**What it protects against.** A malicious or compromised `Dockerfile` (or a dependency's install script) no longer runs on the host's Docker daemon. "root" inside a build maps to an unprivileged user on the host, the build cannot talk to your database or other apps, and BuildKit's own CPU, memory, process count and cache size are capped.

**Settings** (`.env`): `BUILD_SANDBOX=buildkit|docker`, `BUILDKIT_VERSION`, `BUILDKIT_MEM`, `BUILDKIT_CPUS`, `BUILDKIT_CACHE_MB`, `MAX_REPO_MB`.
`BUILD_SANDBOX=docker` is the old behaviour. Use it for local development, or as an emergency fallback. The worker warns loudly at startup in production when it is set.

### Things to check on your first deploy (I could not run Docker where this was written)
1. `docker compose up -d --build`, then `docker compose logs buildkit`. It should print that it is listening on `tcp://0.0.0.0:1234`.
2. Deploy any app. The log should say `sandboxed rootless BuildKit`, then show BuildKit's progress output, then `Loading built image into the app runtime`.
3. **Ubuntu 24.04 caveat.** Ubuntu 23.10+ restricts unprivileged user namespaces with AppArmor, which can stop rootless BuildKit from starting (errors mentioning `permission denied`, `newuidmap` or `user namespace`). The compose file already sets `apparmor=unconfined` for that container, which is normally enough. If it still fails, on the host run:
   `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`
   (and persist it in `/etc/sysctl.d/`). This relaxes a host-wide setting, so only do it if needed.
4. If the build step cannot be made to work in time, set `BUILD_SANDBOX=docker` and `docker compose up -d`. Nothing else changes.

### Block the cloud metadata service (do this on EC2)
Build steps and apps have internet access, and on EC2 `169.254.169.254` hands out the instance's IAM credentials. Run once on the host:

```bash
sudo ./scripts/block-metadata.sh
```

and require IMDSv2 (command printed by the script).

### What this does NOT fix yet
- **The worker still mounts `/var/run/docker.sock`**, because it must start user containers. A bug in the worker would still be root-equivalent on the host. Replacing this (a restricted socket proxy, or a runner VM) belongs to the scaling phase.
- **Apps share one network** (`devflow_apps`) and can reach each other. Per-project networks come later.
- **App containers share the host kernel.** The hardening below reduces risk, but a kernel exploit is out of reach of Docker alone. gVisor or Firecracker is the next step if strangers will run code here.
- **BuildKit's layer cache is shared by all builds.** One user could in theory poison a cache another user's build reuses. Fine for a small trusted group; per-user cache namespaces are a later job.
- The BuildKit container runs with seccomp and AppArmor unconfined (rootless BuildKit needs that to create user namespaces). It is not privileged and has no Docker socket, but this is the price of rootless mode.

## Step 7: resource limits

Every app container is started with these flags (`backend/src/lib/limits.ts`):

| Limit | Flag | Default |
|---|---|---|
| Memory (and no swap) | `--memory` / `--memory-swap` | 512 MB per project |
| CPU | `--cpus` | 0.5 core per project |
| Processes (fork bombs) | `--pids-limit` | 256 |
| Open files | `--ulimit nofile` | 4096 |
| Writable scratch space | `--tmpfs /tmp:size=` | 64 MB (counts toward memory) |
| Log size | `--log-opt max-size / max-file` | 10 MB x 3 files |
| Disk (writable layer) | `--storage-opt size=` | 1024 MB, **only when `STORAGE_QUOTA=true`** |
| Privileges | `--cap-drop ALL` + 7 safe caps back, `no-new-privileges` | always |

**Per project.** Each project has `memoryMb`, `cpus`, `diskMb`, editable in the dashboard (Resource limits) or with `PATCH /api/projects/:id`. Changes apply on the next deploy. Normal users are capped at `MAX_MEMORY_MB` / `MAX_CPUS` / `MAX_DISK_MB`; admins can exceed them.

**Disk quota.** Docker can only cap a container's writable layer when it uses `overlay2` on an `xfs` filesystem mounted with `pquota`. A default EC2/ext4 root disk cannot, so `STORAGE_QUOTA` is `false` and passing the flag would make `docker run` fail. Until then, disk growth is bounded by log rotation, the 64 MB `/tmp`, and the repo size limit. To enable it, put `/var/lib/docker` on an xfs volume with `pquota`, then set `STORAGE_QUOTA=true`.

**Out-of-memory kills are explained.** If a new version dies during its health check, the deploy log now says whether it was killed for exceeding its memory limit and which setting to raise.

**Capacity planning.** Limits are per app and not summed. A blue/green deploy briefly runs two copies of an app. On a 2 GB t3.small, five 512 MB apps is already too many. Watch `docker stats`.
**Apps that write files.** Apps that write outside `/tmp` (SQLite files, uploads) still work, but those writes are only capped when the disk quota is enabled.
