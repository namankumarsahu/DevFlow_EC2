# Auto-detect frameworks (Step 4)

If the repo has **no `Dockerfile`**, DevFlow looks at the files, writes a Dockerfile and builds it in the same sandboxed BuildKit as everything else. A `Dockerfile` in the repo root always wins: nothing is detected or changed.

The deploy log says what happened and prints the generated Dockerfile, so you can copy it into your repo and customise it:

```
==> No Dockerfile found. Detected Vite: built to static files in "dist", served by nginx (npm, Node 22)
==> Generated Dockerfile (copy it into your repo to customise it):
FROM node:22-slim AS build
...
```

## What is detected (first match wins)

| Repo has | Treated as | Built / started with |
|---|---|---|
| `Dockerfile` | your own build | used as is |
| `next` + `output: 'export'` in `next.config.*` | Next.js static export | `build` script, `out/` served by nginx |
| `next` | Next.js server | `build` script, then `next start -p $PORT` |
| `react-scripts` | Create React App | `build` script, `build/` served by nginx (SPA fallback) |
| `vite` (or `astro`) + a `build` script, and no SSR framework | Vite / Astro static | `build` script, `dist/` (or `build.outDir` from the config) served by nginx |
| anything else with `package.json` | Node server (Express, Fastify, NestJS, Koa, SvelteKit adapter-node, ...) | `build` script if present, then `node <file>` for `"start": "node file.js"`, otherwise `npm start` (or the entry in `main`, `server.js`, `index.js`, `app.js`) |
| only `index.html` | static site | served by nginx (404 for unknown paths) |
| Python / Go / Java / Ruby / PHP files | not supported yet | the deploy fails with a message asking for a Dockerfile |

Also detected: the package manager (`package-lock.json` -> `npm ci`, `yarn.lock` -> yarn, `pnpm-lock.yaml` -> pnpm, none -> `npm install`) and the Node version from `engines.node` (18, 20, 22 or 24; default 22).

## Things to know

- **Port.** Static sites and Next.js listen on `$PORT` automatically. A Node server must read `process.env.PORT` (the project's "container port" setting, default 3000).
- **Build-time variables.** Frameworks that bake settings into the browser bundle need them while building. DevFlow passes **only** variables with the framework's public prefix to the build: `VITE_*`, `NEXT_PUBLIC_*`, `REACT_APP_*`, `PUBLIC_*` (Astro). Those values end up in the shipped JavaScript anyway, but also in the image layers, so never put a secret behind one of these prefixes. Everything else stays runtime-only, as before. Changing one of these needs a redeploy (it is a rebuild).
- **Memory.** The build runs in BuildKit (`BUILDKIT_MEM`, default 1g), not under the app's limit. Next.js builds often need 2g; if a build dies with "killed", raise it. The running app is still limited by the project's Memory setting (256 MB default is tight for `next start`; try 512).
- **Monorepos / sub-folders.** Only the repo root is looked at. If the app lives in `apps/web`, add a Dockerfile at the root.
- **Next.js `output: 'standalone'`** is run with `next start`, which works but prints a warning. Add your own Dockerfile for the smaller standalone image.
- **Why not Nixpacks / Railpack?** The roadmap suggests them. They cover more languages, but each needs a large binary in the worker image and its own build path through the sandbox. This detector covers the common JavaScript cases with a plain Dockerfile that runs through the existing sandbox, and it can be unit-tested. Adding Nixpacks later means one more branch in `detectProject` for the `unsupported` cases.

## Safety

- The repo is untrusted. Files are read without following symlinks and are capped at 1 MB, and the build-output folder and entry file taken from them are checked (no `..`, spaces, quotes or leading `-`) before they reach the Dockerfile.
- A repo that ships `Dockerfile` as a symlink cannot make the worker overwrite its own files: the link is removed before the generated file is written.
- The generated Dockerfile only runs in the BuildKit sandbox, with the same limits as any other Dockerfile.

## Files
`backend/src/lib/detect.ts` (detection and Dockerfile templates), `backend/src/lib/repoFiles.ts` (safe file access), `backend/src/worker.ts` (wiring), `backend/tests/detect.test.ts`.
