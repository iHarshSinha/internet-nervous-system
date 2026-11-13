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

These are planned. Update this section as soon as the scaffold exists.

- `pnpm install`
- `docker compose up mongo`: local database for development
- `pnpm dev`: server and web with hot reload (run natively, not in Docker)
- `pnpm lint`, `pnpm typecheck`, `pnpm test`: all must pass before every commit
- `docker compose --profile demo up`: full stack in replay mode at http://localhost:8080

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

Phase 0 has not started. First task: scaffold the monorepo, add the shared contracts, and get the
Docker Compose hello-world running (see `docs/KICKOFF.md`, session 1).
