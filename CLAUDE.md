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

Known gaps: the server does not serve the web app yet (needed for Railway); no content security policy yet. `MODE=replay` only changes a label until Phase 2.

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
- [x] Reference data and storage: `apps/server/src/refdata/` loads network registration countries
  from the five RIR delegated-extended files (collection `asn_ranges`, refreshed weekly; the plan
  said RIPEstat per country, this is 5 requests instead of ~250) and Atlas probes (`probes`, daily),
  cached in MongoDB. Pipeline adds `country:<CC>` scopes (routing: the origin network's registration
  country; latency: the probe's own country). `db/metrics.ts` writes `metrics_hourly` with field-level
  `$set` (routing and latency fill the same minute separately), TTL world 7 d / country 3 d / asn 2 d,
  busiest `METRICS_ASN_LIMIT` networks only. `GET /api/history` (`api/history.ts`) returns minutes,
  15 min of in-memory seconds (`ingest/recent.ts`) and `snapshotSeq`. Health score v1 lives in
  `packages/shared/src/health.ts`. Local MongoDB is the Docker `mongo` container; `mongosh` is only a
  client for inspecting it.
- [x] Live rooms: `realtime/broadcaster.ts` stages changes (`set` = current value, sent only when
  changed beyond epsilon; `append` = unique record such as a closed window) and flushes one numbered
  frame per room every 500 ms, only to rooms with members, keeping 120 frames per room for `resync`
  (handler in `realtime/live.ts`). `realtime/publish.ts` maps closed windows to deltas; their meaning
  is documented in `packages/shared/src/live.ts`. The heartbeat now stages through the broadcaster.
  Client: `apps/web/src/realtime/roomSync.ts` (hold until ack, drop duplicates, resync on gap,
  `snapshot(seq)` for the history merge) used by the socket worker.
- [x] Globe and country page. `apps/web/src/globe/GlobeView.tsx` (react-globe.gl: hex-dot land
  coloured by health, Atlas probes as 6 particle sets by latency bucket, rings on the busiest
  countries; re-reads the store every 1.2 s), `pages/GlobePage.tsx` (panels, legend, pipeline
  strip), `pages/CountryPage.tsx` (join room -> fetch history -> `store/series.ts` merge -> uPlot
  charts in `charts/TimeChart.tsx`). Tiny router in `router.ts` (no library). Country shapes:
  `apps/web/public/geo/countries.json`, regenerated by `apps/web/scripts/prepare-countries.mjs`
  (drops rings that rounding collapses; H3 throws on them). Server: `GET /api/probes`,
  `GET /api/countries` (`api/globe.ts`), per-probe latency buckets and country health published to
  `world` by `realtime/publish.ts`. Pages are lazy-loaded (first download ~101 KB gzipped).
  `three` and `@types/three` were added as direct dependencies (react-globe.gl's engine).
- FPS cannot be measured in the Claude browser pane (it throttles animation frames to ~1/s even
  with no WebGL on the page); measure in a real browser window.
- [x] Sign-in and limits. Google only (user's decision): the page shows Google's button, the server
  verifies the ID token itself against Google's JWKS (`auth/google.ts`, no client secret), then issues
  our own 15-min access JWT + rotating httpOnly refresh cookie (`api/auth.ts`, `auth/tokens.ts`,
  `auth/store.ts`). Roles `user`/`admin` (`ADMIN_EMAILS`). `/api/me`, `/api/me/watchlist`,
  `/api/admin/stats`. Socket `/user` (joins `user:<id>`) and `/admin` (joins `ops`, pipeline numbers
  each second) in `realtime/private.ts`. Rate limits: REST per IP, Google sign-in per IP, sockets per
  address, `sub`/`unsub`/`resync` token bucket per socket (`realtime/limits.ts`). helmet. Web:
  `store/auth.ts`, `components/GoogleButton.tsx`, `components/Account.tsx`, `pages/MePage.tsx`.
  Sign-in stays hidden until `GOOGLE_CLIENT_ID` is set in `.env` (the user is creating it).
- Logged-in users get: watchlist (countries, networks, minimum severity, Discord webhook) and a
  personal alert channel; alerts themselves come with Phase 2 incidents. Admins later get replay
  controls and the ops page.
- Deploy is postponed (user's decision).

**Phase 2 progress** (user now wants the rest of Phase 2 done without stopping; Discord dropped):
- [x] Step 1, replay and scenarios. User's design (13 Nov 2026): live data flows normally; when an
  admin triggers an outage it happens NOW for about 2 minutes, then everything returns to normal.
  `tools/replay-prep/src/scenario.ts` cuts Facebook's own events (AS32934, 15:39-15:54 UTC) out of the
  full recording into `deploy/seed/scenarios/facebook-2021.ndjson.gz` (132 KB, committed, copied into
  the server Docker image). `apps/server/src/scenarios/` plays it: prime (real announcements), outage
  (real events, 10x), gone, recovery (SIMULATED re-announcements). Events are `src: replay`,
  `eid: replay:s<run>:...`, `data.simulated: true`. Runs are recorded in `scenario_runs`
  (`GET /api/scenarios/runs`) so charts can mark simulated stretches. Admin API
  `POST /api/admin/scenario`; status in the world room under key `scenario`; everyone sees a
  SIMULATION badge. The full-file `ReplayPlayer` (`/api/admin/replay`) stays for Phase 3 load tests.
  Measured: 14,163 events in 118 s; AS32934 showed 1,683 withdrawals over 27 prefixes in a minute.
- [x] Step 2, detectors (`apps/server/src/ingest/detect/`): D1 storm (median/MAD z > 6, >= 20 prefixes,
  >= 5 routers), D1b vanished (prefixes withdrawn by >= 20 routers and not re-announced), D2 origin
  change (>= 3 collectors, old owner not on the path), D3 latency (per-probe EWMA), D4 probe dropout.
  `IncidentManager` fuses signals (sum of weights over 10 min; warning >= 0.5, critical >= 0.8),
  open -> resolving -> resolved after 30 s quiet, reopens a scope within 30 min, template
  summaries, names from RIPEstat (`asn_names`). Stored in `incidents`, `GET /api/incidents[/:id]`,
  deltas `inc:<id>` to `incidents`, `country:` and `asn:` rooms; watchers get `alert:<id>` in
  `user:<id>`. Baselines reload from `metrics_hourly` at startup (`warmStart`). Thresholds were tuned
  offline on the 30-min recording (19 -> 4 incidents); the harness idea: feed
  `deploy/seed/capture/ris-full-*.ndjson.gz` through Pipeline + Detectors + IncidentManager.
  Known limit: our routing table only knows prefixes seen since start (no RIB snapshot).
- [x] Attack simulator (`scenarios/attacks.ts`): outage, hijack (AS64511), latency, dropout and
  country blackout, built from live state (real prefixes, real probes; RIPEstat announced-prefixes
  when the table is thin). Admin picks the target in the Control room. Tested end to end
  (`attacks.test.ts`). Measured live: Germany blackout -> 3 networks critical in 4.2 s, DE in 5.2 s.
- [x] Steps 3-4 (web): `store/incidents.ts` (merge by `updatedAt`), feed panel, alert cards (critical,
  simulated or watchlist only), red edge pulse while a critical incident is open, globe paints the
  country, ripples, floating label, flies there; `/incident/:id` page (summary, score, evidence,
  reachability, timeline, network chart).
- [x] Step 5, Cloudflare Radar (`ingest/sources/radar.ts`, token in `.env`): polls outage annotations,
  traffic anomalies, hijacks (minConfidence 8) and leaks (>= 10 peers kept) every 3 min, layer 7 and
  layer 3 attack pairs every 15 min (Radar only offers 1-day aggregates for pairs). Validated with zod
  (schemas in `packages/shared/src/radar.ts`), stored in `radar_events` (TTL 30 d), `GET /api/radar`,
  new events and pairs to the `arcs` room. D6 `cloudflare` signal (0.3): a current Radar event for
  the same network (or country, for outages and anomalies) confirms our incident, never opens one
  alone. Web: `store/radar.ts`, attack arcs on the globe, `components/Radar.tsx` panel. Attribution
  CC BY-NC 4.0 shown in the panel and footer.
- Phase 2 is complete.
- UI (user's direction, 14 Nov 2026): clean and calm, progressive disclosure like Figma. "Graphite"
  design system in `apps/web/src/index.css`: near-black grey ground, grey surfaces, one accent
  (signal cyan); fonts Michroma (headings, `title` utility), Rajdhani (body), Share Tech Mono
  (numbers), self-hosted via `apps/web/scripts/fetch-fonts.sh`. Home: globe on the right, one left
  sidebar (welcome or sign-in on top, "Right now" key numbers, Incidents, Busiest; everything else
  folded under "More detail": Trouble spots, Activity, Cloudflare, Probe latency, Data sources,
  Pipeline, Control room). `Panel` has `collapsible`/`defaultOpen`/`id`/`summary` (open state
  remembered per viewer). No legend bar: a ? popover explains the map; regions are a menu.
  Login uses `components/WorldDots.tsx`. Motion: `hooks/flip.ts`, page fade-in. Only "major"
  incidents (`isMajor`) turn the screen red, show alert cards, paint land or move the camera.
- India's outline follows the Government of India's boundary (Natural Earth India point-of-view
  edition, in `prepare-countries.mjs`, with a check that Aksai Chin, Gilgit, Tawang are inside).
- Next: Phase 3 (performance, load tests).

**Phase 3 progress** (user wants it step by step, a report after each; commits carry NO Co-Authored-By line):
- [x] Step 1, ingest worker thread. Feeds, pipeline, detectors, incident manager and the full-file
  replay player run in `ingest/worker.ts` via `ingest/core.ts` (`serveIngest(port)`). The main
  thread uses `ingest/link.ts` (`IngestLink`): a mirror of the ingest state (sent every 250 ms),
  closed windows and incidents as messages, and promise calls for replay controls and the attack
  simulator's routing-table questions. Messages are typed in `ingest/protocol.ts`. MongoDB writes,
  Socket.IO, the scenario runner and Radar stay on the main thread. Reference data reaches the
  thread through `RefData.subscribe`. A crashed thread restarts after 1 s (messages queued
  meanwhile). `INGEST_THREAD=off` runs the same code in-thread over a `MessageChannel`.
  Measured at 50x replay (90k events/s): `/healthz` p99 0.35 ms with the thread vs 1.21 ms without.
- [x] Step 2, bounded queue (`ingest/pipeline/queue.ts`, `INGEST_QUEUE_MAX`, default 100,000).
  Every source (RIS, Atlas, replay, injected scenarios) goes through it; the pipeline drains in
  8 ms slices. Pressure levels: <70% normal; 70-95% sampling (`sample()` gives 1 in k for the raw
  feed, k adapts each second); 95-100% shed `bgp.announce`; 100-120% reserve, only withdrawals and
  probe status; >=120% overflow. Live feeds shed; the replay waits (`offerAndWait`) and re-anchors
  its clock. Replay start takes `lossy` (shed like a live feed) and `amplify` (N copies per event,
  for load tests). Queue numbers: `/api/status` `queue`, world room key `queue`, ops room, and the
  Pipeline panel (badge when sampling or shedding). Measured: >910k events/s processed, queue
  <=14% with the default size; forced overload with a 5,000 queue sheds or pauses as designed.
- [x] Step 3, delivery. MessagePack (`socket.io-msgpack-parser`) on every namespace; the web worker
  reads `GET /api/realtime` to pick the parser. Firehose: `ingest/feed.ts` `FeedSampler` samples
  only watched `feed:<kind>:<cc>` rooms (reservoir, 5 per 250 ms = 20/s, thinned by the queue's
  1-in-k; `n` counts all), sent volatile as `EV.feed` (`e`) batches; one feed room per socket.
  Web: `store/feed.ts` (no UI yet; the list comes with step 4). Slow clients
  (`realtime/slow.ts`): backlog checked each second, slow sockets join `~slow`, normal frames
  skip them, every 2 s one merged frame per room with `f` = first seq covered (`checkSeq(last,
  s, f)`). Joiners get each room's current values in the `sub` ack (`state`); the broadcaster no
  longer re-sends everything to a room when someone joins (that was O(clients^2)), and appended
  records are no longer kept as state. Switches: `SOCKET_PARSER`, `CONFLATE_MS` (0 = off),
  `BROADCAST=rooms|all`, `SLOW_CLIENTS`. Bytes written are counted (`/api/status` `delivery`).
- [x] Step 4, client render budget. `realtime/client.ts` queues worker updates and applies them
  merged (`realtime/merge.ts`) once per animation frame, or once a second while the tab is hidden;
  the globe skips layer rebuilds while hidden. `components/VirtualList.tsx` (TanStack Virtual,
  measured rows) used by the `/feed` page (`pages/FeedPage.tsx`: type and country filters, one
  feed room at a time, pause on scroll, resume to top, rate and "showing x%" badges) and by
  Activity (200 items kept). `perf.ts` measures paints, applies, apply time and long tasks
  (`window.__perf()`), for the HUD in step 6.
- [x] Step 5, server metrics. `metrics/index.ts` (prom-client registry; counters mirror running
  totals, gauges read the ingest state on scrape), `GET /metrics` for admins or `METRICS_TOKEN`
  (`api/ops.ts`). Processing delay measured in the ingest thread (`metrics/quantiles.ts`, 1 event
  in 10, last 10 s); window-to-publish histogram via `Broadcaster.onFlush`; MongoDB write timer.
  `metrics/loop.ts` subtracts Node's sampling interval from event-loop delay (it was reading
  ~10 ms too high; benchmarks corrected). `metrics/minutes.ts` + `db/ingestStats.ts`: rows per
  source, `pipeline`, `delivery` each minute (`$set`, TTL 7 d), `GET /api/ops/history` (public).
- [x] Per-second undercount fixed (user's choice before step 6). 1-second windows keep closed
  windows 2 min (`TumblingWindows` `amendMs`, `lateSlot`, `takeAmended`); late events correct
  them and the pipeline re-emits changed scopes with `amended: true` (publisher re-appends
  `s:<start>`, skips "now" values; `RecentSeconds` and the globe sparkline upsert by time).
  Headline = newest second at or before `Watermark.complete` (slowest connected collector, no skew
  exclusion; `Pipeline.secondsComplete`, monotonic), shown "as of HH:MM:SS". Counters:
  `amendedSecond`, `lateSecond` (beyond the horizon). Live: headline equals final total in 29/29
  samples; 4.5% of events were corrected in.
- [x] Step 6, /ops and HUD. New public room `stats` (shared `rooms.stats`, in `/live`), published
  once a second by `realtime/stats.ts` (keys `in:<src>`, `pipe`, `queue`, `delay`, `pub`, `loop`,
  `mem`, `out`, `sock`, `mongo`; rates from running totals). `GET /api/time` for clock offset.
  Web: `store/ops.ts` (5 min of points), `charts/LiveChart.tsx` (uPlot from data), `pages/
  OpsPage.tsx` (8 tiles, 4 live charts, sources, data quality, minute-by-minute history 1/6/24 h,
  admin replay controls with speed, amplify, "like a live feed"), `components/Hud.tsx` (press ~ or
  `: FPS, skipped frames, server frames/s, renders/s, apply p95, long tasks, frame age corrected by
  `realtime/clock.ts` offset, gaps, resyncs). Links: Pipeline panel "Performance page", HUD.
