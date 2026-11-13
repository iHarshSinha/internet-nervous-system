# Internet Nervous System

Hackathon entry for **MERNIFY: High-Throughput Streams & Telemetry**. The app is a live 3D globe that
ingests real internet telemetry (BGP routing updates, RIPE Atlas latency measurements, Cloudflare Radar
events), detects outages and hijacks, and pushes room-scoped live updates to browsers over Socket.IO.
Goal: win. Cover every core requirement and every bonus point in the problem statement.

- Full plan (source of truth for scope, design and phases): `docs/PLAN.md`. Read the relevant section
  before starting a task. It is a snapshot of the team's shared plan doc; if they disagree, ask.
- Problem statement: `docs/MERNIFY_ProblemStatement.pdf`. Check it when unsure about a requirement.
- Session prompts and workflow: `docs/KICKOFF.md`.

## Hard requirements (from the problem statement)

- Node.js + Express backend, MongoDB database, React frontend, and Socket.IO as the live delivery channel.
  All four must be meaningfully used. External APIs may add data but must not replace any of them.
- Batching, throttling or aggregation; Socket.IO rooms or namespaces for subscriptions; history from
  MongoDB merged with live updates without duplicates; every event carries source, event ID and
  timestamp; duplicates and out-of-order events handled; input validation and rate limiting; basic
  auth and access control; a responsive client under frequent updates.
- Deliverables: a working hosted app, a GitHub repo whose README has the required headings, a 3–5 minute
  video, and an optional architecture doc (we are doing it).
- AI tools are allowed, but the team must understand and be able to explain every line. Write new code
  during the hackathon. Attribute every library, API and borrowed snippet in the README.

## Architecture in one paragraph

Five sources (RIS Live, RIPE Atlas, Cloudflare Radar, a historical replay of RIS MRT files, and our own
probe agent) feed an **ingest worker thread**: connect → validate (zod) → normalise to the event
envelope → dedupe → event-time windows (1 s and 1 min, with watermarks) → aggregate (health per country
and ASN) → detect (D1–D7, fused into scored incidents). The **main thread** runs Express (REST: history,
auth, watchlists, agent ingest, ops) and Socket.IO (namespaces `/live`, `/user`, `/admin`). The worker
writes idempotent upserts to MongoDB and sends changes to Socket.IO, which conflates them and emits
numbered delta frames to rooms. The browser runs the socket in a Web Worker and renders once per frame.

## Stack

TypeScript (strict, ESM) on Node.js 22 · pnpm workspaces · Express 5 · Socket.IO 4 +
`socket.io-msgpack-parser` · `ws` for upstream feeds · zod · MongoDB official Node driver · jsonwebtoken,
bcrypt, express-rate-limit · pino, prom-client · React + Vite, react-globe.gl, uPlot, TanStack Query and
Virtual, Zustand, Comlink, Tailwind · Vitest, Artillery · Docker Compose, Caddy, GitHub Actions.
Ask before adding a dependency that is not on this list.

## Repo layout

```
apps/server     Express + Socket.IO + ingest worker (src/api, realtime, ingest/{sources,pipeline,detect}, db, auth, metrics)
apps/web        React app (pages, globe, charts, workers/socket.worker.ts, store, api)
packages/shared zod schemas, event envelope, room names, constants. The single source of truth for contracts
tools/          capture (record live streams, measure rates), replay-prep (MRT to NDJSON), loadtest, probe-agent
deploy/         Caddyfile, seed data
docs/           PLAN.md, problem statement, architecture.md, benchmarks.md
```

## Commands

Needs Node 22.18+ (`.nvmrc`) and pnpm 11.28.9 (pinned in `package.json`; `corepack enable` provides it).

- `pnpm install`
- `docker compose up -d mongo`: local database for development
- `pnpm dev`: shared (tsc watch), server (:3000) and web (:5173) with hot reload. Open http://localhost:5173
- `pnpm lint`, `pnpm typecheck`, `pnpm test`: all must pass before every commit (`pnpm format` fixes style)
- `docker compose --profile demo up --build`: full stack in replay mode at http://localhost:8080
- `docker compose --profile live up --build`: the same stack on the real feeds

## Toolchain notes (decided while scaffolding)

- **TypeScript is pinned to 6.0.x.** typescript-eslint does not support TypeScript 7 yet.
- **The server runs `.ts` files directly with Node** (type stripping, no tsx or ts-node). So in
  `apps/server` and `packages/shared`: import with the real `.ts` extension, use `import type` for
  types, and avoid enums and constructor parameter properties (`erasableSyntaxOnly` enforces this).
  `tsc` rewrites the extensions to `.js` in the production build.
- **`packages/shared` is consumed from its `dist`.** `pnpm dev` keeps it rebuilt; the root `typecheck`
  and `test` scripts build it first.
- **pnpm 12 does not start under corepack on this setup**, which is why 11.28.9 is pinned.
- **Hosting is Railway, not a VM** (decided 13 Nov 2026). Railway runs one Dockerfile per service, not
  Compose, so for production the Express server will also serve the built web app (same origin kept).
  Not built yet. Compose with Caddy stays for local runs and for judges. Database: MongoDB Atlas M0.

## Contracts (defined in packages/shared; change them there first)

- Event envelope: `{ v, src, eid, kind, ts, its, entity, data }`. `src` is `ris|atlas|radar|replay|agent`;
  `eid` is globally unique (a multi-prefix RIS update becomes one event per prefix, suffixed `#n`); `ts` is
  event time from the source, `its` is our ingest time (both in ms).
- Rooms: `world`, `country:<CC>`, `asn:<N>`, `incidents`, `arcs`, `feed:<kind>:<cc>`, `user:<id>` (in `/user`),
  `ops` (in `/admin`).
- Frame: `{ r: room, s: seq, t: serverMs, d: [[key, field, value], ...] }`. Deltas only, never full state.
- History and live merge: join the room (the ack returns seq S0), buffer frames, `GET /api/history`
  returns data plus `snapshotSeq`, drop buffered frames with seq up to `snapshotSeq`, apply the rest.
  A gap in seq triggers `resync` (served from a ring buffer of the last 120 frames per room).
  The client stores points keyed by timestamp.

## Data sources: facts and gotchas

- RIS Live: `wss://ris-live.ripe.net/v1/ws/?client=$RIS_CLIENT_NAME`, then send `ris_subscribe` with filters.
  Messages carry `id`, `timestamp`, `peer`, `peer_asn`, `host`, `type`, `path`, `announcements`, `withdrawals`.
  There is no replay, so our MongoDB is the history.
- RIPE Atlas: `wss://atlas-stream.ripe.net/stream/` over **plain WebSocket** (its Socket.IO interface is
  legacy). Send `["atlas_subscribe", {streamType, msm, ...}]`. `sendBacklog` works only with `msm`.
  Dedupe on (`msm_id`, `prb_id`, `timestamp`). Built-in pings to root servers: 1001, 1008, 1006, ...;
  traceroutes are 5000–6999. If we fall behind, Atlas drops messages and sends one warning; count it.
- Cloudflare Radar: REST, polled every 1–5 minutes with `CLOUDFLARE_API_TOKEN`. Optional: the UI layer
  hides itself without a token. Data license CC BY-NC 4.0, so attribute it.
- Replay: NDJSON in `deploy/seed`, streamed through the same pipeline at 1×–50×. Demo incident: the
  Facebook outage, AS32934, 4 Oct 2021, withdrawals around 15:39 UTC.
- Never invent event rates or benchmark numbers. Measure them and record them in `docs/benchmarks.md`.

## Rules

**MongoDB**
- Don't use time-series collections where uniqueness matters: they don't support unique indexes. Use
  regular collections with unique keys.
- Metrics use hourly bucket documents per scope. Write with `$set` on `m.<minute>`, never `$inc`, so
  replays and restarts never double-count.
- Count from deduplicated events *before* any sampling. Set TTLs so we stay under Atlas M0's 512 MB.

**Real-time**
- Emit deltas to rooms only, never broadcast to everyone. Conflate per room every 500 ms. The firehose
  uses volatile emits. Slow clients are downgraded to 2-second summaries.
- Validate every socket payload with zod. Token bucket on `sub`, `unsub` and `resync` (5/s), max 20 rooms.

**Frontend**
- Only relative URLs (`/api`, `/socket.io`). Web and API share one origin behind Caddy, so never put an
  API URL in Vite env.
- Socket in a Web Worker; one render per animation frame; virtualise long lists; uPlot for time series.

**Security**
- bcrypt; a 15-minute access JWT in memory; a refresh token in an httpOnly, Secure, SameSite=Strict
  cookie, rotated and stored hashed. Roles: visitor, user, admin. Secrets only in env, never committed.

**Docker**
- Multi-stage builds (`pnpm deploy`), non-root user, `HEALTHCHECK` on `/healthz`, `.dockerignore`.
- Images for linux/amd64 and linux/arm64. No secrets in images.

**Code and workflow**
- Server logging uses pino. No `console.log` in server code.
- Pipeline logic (dedupe, watermarks, windows, detectors) gets Vitest tests with recorded fixtures.
- Work phase by phase from `docs/PLAN.md` → "Build plan". Tick the checkbox there when a task is done.
- Small commits with clear messages. Never commit `.env` or recorded data larger than a few MB.
- Comment non-obvious code briefly. The team must be able to explain it to judges.
- After finishing a task, update "Current status" below.

## Current status

**Phase 0 in progress** (updated 13 Nov 2026). `docs/KICKOFF.md` session 1 is done:

- Monorepo scaffold, lint, typecheck and tests all pass (36 shared tests, 12 server tests).
- `packages/shared`: event envelope, rooms, delta frames, sub/unsub/resync payloads, history query
  and response. Treat these as frozen; change them there first.
- `apps/server`: `/healthz`, `/readyz`, `/api/status`; Socket.IO `/live` with validated `sub`/`unsub`,
  per-room sequence numbers and a 1 Hz heartbeat frame to `world` (a stand-in for real telemetry).
- `apps/web`: socket in a Web Worker, Zustand store, a canvas pulse sphere and live readouts.
- Dockerfiles, `docker-compose.yml` (`live` and `demo` profiles), Caddyfile. Verified at :8080.

Also done: `tools/capture` and measured rates (`docs/benchmarks.md`), `tools/replay-prep` and the
Facebook replay file, CI workflows (not yet confirmed green on GitHub).

Not done yet in Phase 0: accounts (Atlas, Cloudflare, Railway) and a first deploy.

Known gaps to close in Phase 1: no `resync` handler or ring buffer yet (gaps are only counted), no
socket rate limiting, no auth, no helmet. `MODE=replay` only changes a label until Phase 2.

**Measured facts that change the plan** (details in `docs/benchmarks.md`):
- Never subscribe to the unfiltered RIS firehose: it lags 40+ s, reconnects constantly and carries
  about 9–15% of a collector's messages. Use several connections, each filtered to one collector.
- One collector (`rrc00`) is about 600 messages/s, 1,400 events/s.
- Atlas needs about 4 minutes of allowed lateness, not 2. Ignore timestamps ahead of the clock.
- The Facebook replay is 8.57M events (about 2,040/s at 1x); the burst starts 15:40 UTC.

**Phase 1 progress** (the user wants it one step at a time, with a report after each):
- [x] Connectors: `apps/server/src/ingest/` has a reconnecting `UpstreamSocket`, one RIS connection
  per collector (`RIS_COLLECTORS`) and one Atlas connection, normalisers to the envelope, and
  `IngestStats`. Events currently go to a no-op sink in `server.ts`; the pipeline attaches there.
  The `world` heartbeat frame carries per-source events/s, lag and upstream counts.
- [x] Pipeline: `apps/server/src/ingest/pipeline/` (`Deduper`, `Watermark`, `TumblingWindows`,
  `OriginTable`, aggregates, `Pipeline`). Pure, clock passed in, tested on recorded fixtures in
  `pipeline/fixtures/`. A batch passed to `Pipeline.ingest` must be the events of ONE upstream
  message (dedupe checks the first event's ID). Routing gets 1 s windows (world) and 1 min windows
  (world + `asn:<n>`), one watermark partition per collector; Atlas gets 1 min windows only
  (lateness 240 s). `ingest.onMinute(listener)` is where storage and detection attach.
- [ ] Next: reference data (probe and ASN to country), per-country scopes, `metrics_hourly`
  upserts and `GET /api/history`.
