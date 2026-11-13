# Moving to Claude Code: setup, workflow and session prompts

This kit carries everything decided in the planning chat:

- `CLAUDE.md`: Claude Code reads it at the start of every session.
- `docs/PLAN.md`: the full plan.
- `docs/MERNIFY_ProblemStatement.pdf`: the problem statement.
- This file: setup steps and session prompts.

## 1. One-time setup

1. **Machine prerequisites:** Git, Node.js 22, pnpm (`corepack enable`), Docker Desktop.
2. **Create the repo.** Make an empty GitHub repo named `internet-nervous-system` (private until submission is fine). Unzip this kit into a folder, then:

   ```bash
   cd internet-nervous-system
   git init
   git add .
   git commit -m "Add plan, problem statement and CLAUDE.md"
   git branch -M main
   git remote add origin git@github.com:<you>/internet-nervous-system.git
   git push -u origin main
   ```

3. **Open Claude Code on the folder.** Pick one:
   - **Desktop app** (the app you're already using): open the **Code** tab, choose the **Local** environment, click **Open folder…** and pick the repo. No separate install needed.
   - **Terminal:** install with `curl -fsSL https://claude.ai/install.sh | bash` (macOS, Linux, WSL) or `irm https://claude.ai/install.ps1 | iex` (Windows PowerShell). Then run `cd internet-nervous-system && claude`.

   Use a **local** session, not a cloud one. This project needs Docker and live WebSocket connections running on your own machine.
4. **Check the context loaded.** Run `/memory` and confirm `CLAUDE.md` is listed.
5. **Accounts to create when session 2 asks for them:**
   - MongoDB Atlas, free M0 cluster
   - A Cloudflare API token that can read Radar data
   - An always-on VM with at least 2 GB RAM (check the GitHub Student Developer Pack for credits)
   - Optionally, a domain

## 2. How to work, every session

- **Keep sessions small.** One task, or a small group of related tasks, per session. Use `/clear` or start a new session between tasks.
- **Plan big tasks first.** Start in plan mode: `Shift+Tab` until the status bar shows plan mode, or choose **Plan** in the desktop app. Review the plan, then let it edit.
- **End every task the same way.** Ask Claude to:
  1. Run lint, typecheck and tests.
  2. Commit.
  3. Tick the task in `docs/PLAN.md`.
  4. Update "Current status" in `CLAUDE.md`.
- **Make sure you can explain everything.** If you can't explain a file, ask: "Explain this file as if I'm presenting it to judges." Judges will ask.
- **Resume where you left off** with `claude --continue`, or `/resume` inside a session.
- **Teammates** clone the same repo and get the same `CLAUDE.md`. Personal notes go in `CLAUDE.local.md`, which is gitignored.
- **If the plan changes** in the shared doc, export it as Markdown and replace `docs/PLAN.md`.

## 3. Session prompts (copy and paste)

### Session 1: scaffold, contracts, hello-world stack (Phase 0)

```text
Read CLAUDE.md, then these sections of docs/PLAN.md: "Stream processing", "Real-time delivery
with Socket.IO", "Tech stack, repo and deployment" and "Build plan". We are starting Phase 0.
In plan mode, propose how you will do these steps, in order:
1. Scaffold the pnpm monorepo (apps/server, apps/web, packages/shared, tools/) with strict
   TypeScript, ESLint and Prettier, plus root scripts dev, lint, typecheck, test, build.
2. packages/shared: zod schemas and types for the event envelope, room names, the frame format,
   sub/unsub/resync payloads and the history response, with Vitest tests.
3. Dockerfiles for server and web: multi-stage, pnpm deploy, non-root, HEALTHCHECK on /healthz,
   and a .dockerignore.
4. docker-compose.yml with proxy (Caddy), server, mongo and seed, plus the profiles demo, loadtest
   and scale; deploy/Caddyfile; .env.example.
5. Hello world: the server emits a heartbeat frame to the `world` room every second, and the web
   app shows it live through Caddy at http://localhost:8080.
Keep it minimal but production-shaped. Wait for my approval before editing. After each step, run
lint, typecheck and tests, then commit.
```

### Session 2: CI and deployment (Phase 0)

```text
Phase 0: CI and deploy. Add .github/workflows/ci.yml (lint, typecheck, test, build, and docker
build without push, on pull requests) and release.yml (on main: buildx multi-arch images for
linux/amd64 and linux/arm64, pushed to GHCR, tagged with the commit SHA and latest). Then write
docs/deploy.md: provision an Ubuntu VM, install Docker, point a domain, fill .env with the Atlas
MONGODB_URI, run `docker compose pull && docker compose up -d`, and confirm Caddy serves HTTPS.
I'll create the accounts myself, so list exactly what I need to create and which values to copy.
```

### Session 3: capture tool and real event rates (Phase 0)

```text
Phase 0: capture. Build tools/capture, a Node CLI that connects to RIS Live (the full stream, and
separately a filtered subscription) and to RIPE Atlas (built-in measurements 1001, 1008, 1006 plus
probestatus). It validates messages with the shared zod schemas, writes gzipped NDJSON per source,
and every 10 seconds prints events per second per source and the process's memory use. Run it for
10 minutes and record the measured numbers in docs/benchmarks.md under "Phase 0 measurements".
Do not guess numbers. Then record 30 minutes of traffic for replay and stress tests (keep large
files out of git and add a script that regenerates them).
```

### Session 4: Facebook outage replay file (Phase 0)

```text
Phase 0: replay prep. Build tools/replay-prep: download RIS MRT update files
(https://data.ris.ripe.net/rrcXX/2021.10/updates.20211004.HHmm.gz) for 15:20–16:30 UTC from 3–4
collectors (for example rrc00 and rrc10), convert them with bgpkit-parser into our event envelope
as NDJSON sorted by timestamp, and check that the AS32934 withdrawals appear around 15:39 UTC.
Write the output to deploy/seed/replay/ (gitignored if large) with a script that regenerates it.
```

### Every later task (Phases 1–4)

```text
Phase <N>, task: "<task text copied from docs/PLAN.md>". Read the PLAN.md sections it depends on
(<section names>). Plan first and wait for approval. Then implement it with tests, run lint,
typecheck and tests, commit, tick the box in docs/PLAN.md, and update "Current status" in CLAUDE.md.
```

## 4. Phase gates (check before moving on)

| Gate | Done when |
| --- | --- |
| End of Phase 0 | Hello-world stack is live on the server; real event rates are measured; contracts are frozen; replay files are ready |
| End of Phase 1 | Live data on the hosted globe; history joins live with no gaps or duplicates (the app is submittable from here) |
| End of Phase 2 | The Facebook replay opens a critical incident |
| End of Phase 3 | The results table is filled with measured numbers |
| End of Phase 4 | Submitted: hosted app, repo, README, video |
