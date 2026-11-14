# Checks still to do by hand

Things built in Phase 3 (and a few carried over) that could not be verified from the development
session: they need a person signed in, a real browser window, a phone, a slow network or Docker.
Each line says what to do and what should happen. Tick them off as they are checked.

## Needs your Google sign-in (admin)

- [ ] **Replay controls on `/ops`.** Sign in as an admin, open `/ops`, scroll to "Replay (admin)",
  start the Facebook replay at 10x. Expect: state goes `playing`, "Events in" jumps, the replay
  row appears under Sources; Pause, Resume and Stop work.
- [ ] **Load-test options.** Same panel: 50x with Amplify 10x and "like a live feed" ticked.
  Expect: queue fill rises; if it passes 70% the amber "sampling 1 in k" badge shows on `/ops` and
  in the Pipeline panel; if it passes 95%, "shedding". Stop it afterwards.
- [ ] **Signed-in views from before Phase 3:** the watchlist card (two rows, click goes to `/me`)
  and the slightly bigger profile menu.

## Needs a real Chrome window (the Claude browser pane throttles animation to about 1 frame/s)

- [ ] **HUD frame rate.** Press `~` on the globe page. Expect FPS near the display rate (60 or
  120), "Frames skipped /s" near 0, "Apply p95" a few ms at most.
- [ ] **Load test T4.** With the HUD open, run a 50x replay. Note FPS, skipped frames and long
  tasks for the README.
- [ ] **Hidden tab.** Switch to another tab for a minute, come back. Expect the page to be up to
  date at once (updates were applied once a second while hidden) and no burst of work.

## Needs a phone

- [ ] **`/feed` and `/ops` on a real phone** (only a 375 px emulated viewport was checked): no
  sideways scrolling, filters usable, list scrolls smoothly.

## Needs a slow or broken network

- [ ] **Slow-client downgrade on a real slow link.** Only covered by a test that fakes the send
  backlog; on localhost the operating system's buffers absorbed every stall tried. Try a phone on
  a poor connection, or Chrome DevTools network throttling at "Slow 3G" with the HUD open, for a
  few minutes. Expect `/ops` "Browsers" to show "1 slow", and the page to keep up with no gaps.
- [ ] **A long stall.** A client that stopped reading for 90 s came back with no gaps. The likely
  reason (Socket.IO's heartbeat disconnecting it after about 45 s, then recovery) was not confirmed
  in the server log; run with `LOG_LEVEL=debug` and look for the disconnect.

## Needs a real RIS lag spike

- [ ] **Per-second corrections during a lag spike.** Covered by a test with a collector 40 s
  behind; live runs only saw collectors within 6 s. When `/ops` shows a RIS collector lagging well
  behind the others, check the "Right now" headline still matches the country charts once
  corrections arrive, and "Corrected into their second" on `/ops` climbs.

## Needs Docker

- [ ] **The server image runs the ingest worker.** The compiled server (`dist/ingest/worker.js`) was
  run locally, not from the Docker image. Run `docker compose --profile demo up --build` and check
  `/api/status` shows `ingestThread.mode: "worker"`.

- [ ] **The `loadtest` Compose profile.** Docker could not pull `node:22-alpine` from the
  development session (pulls hung), so the profile was only validated with `docker compose config`;
  the tool itself was run natively. Run:
  `JWT_SECRET=x LOADTEST_ARGS="--clients 50 --duration 15 --speed 10" docker compose --profile loadtest up --build --exit-code-from loadtest loadtest server-loadtest mongo`
  and expect a summary ending in "results  .../tools/loadtest/results/<name>.json".
  Careful: `docker compose --profile loadtest down` afterwards also stops the shared `mongo`
  container; bring it back with `docker compose up -d mongo`.

## Needs a long run

- [ ] **A soak of 2 hours or more.** The 30-minute soak (T3) showed the deduper's bounded growth in
  the first 10 minutes, then RSS +50 MB over 20 minutes and the main heap +14 MB over 30. Run
  `pnpm --filter @ins/loadtest loadtest run --clients 500 --speed 10 --loop --duration 7200` against
  a server you started with `JWT_SECRET` set, and see whether `rssMb` and `heapMb` in the results
  timeline level off.

## Not yet tested at all

- [ ] **`METRICS_TOKEN`.** Admin access to `/metrics` is tested; a scraper's bearer token is not.
  Set `METRICS_TOKEN` (24+ characters) and `curl -H "Authorization: Bearer <token>" /metrics`.
- [ ] **Ingest thread crash on the live server.** Restart after a crash is covered by a test only.
