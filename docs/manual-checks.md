# Checks still to do by hand

Things built in Phase 3 (and a few carried over) that could not be verified from the development
session, because they need a person signed in, a real browser window, a phone, a slow network,
Docker or a long run. Each item says how to do it and what you should see. Write what you saw in
the "Result" line; anything that does not match goes to "Known problems" at the bottom.

**Before you start:** MongoDB and the dev servers running.

```bash
docker compose up -d mongo
```

```bash
pnpm dev
```

The app is then at http://localhost:5173 (the API at :3000). Sign-in needs `GOOGLE_CLIENT_ID` and
your address in `ADMIN_EMAILS` in `.env` (both are set).

---

## 1. Signed in as admin (Google)

- [ ] **1a. Replay controls on `/ops`.** Sign in, open http://localhost:5173/ops, scroll to the
  bottom: a "Replay (admin)" panel. Set speed 10x and press Start.
  *Expect:* state shows `playing`; "Events in" jumps (to about 20,000/s); a `replay` row appears
  under Sources; Pause, Resume and Stop each work.
  *Result:*
- [ ] **1b. The sampling/shedding badge.** Same panel: speed 50x, Amplify 20x, tick "like a live
  feed", Start. Watch the Queue tile and the Pipeline panel on the home page (More detail,
  Pipeline). *Expect:* on this Mac the queue will probably stay under 70% (the load tests never
  got it there), so most likely no badge. Either outcome is information: note the highest queue %
  you see. Press Stop afterwards.
  *Result:*
- [ ] **1c. Signed-in home page:** the watchlist card in the sidebar (countries and networks in two
  rows; clicking goes to `/me`), and the profile menu (top right) being a little larger than
  before.
  *Result:*

## 2. A real Chrome window

The Claude browser pane slows animation to about one frame a second, so frame rate can only be
read in a normal Chrome window.

- [ ] **2a. HUD.** Open http://localhost:5173 in Chrome, press `~` (or the backtick key). A small
  panel appears bottom left. *Expect:* FPS close to your display's refresh rate (60 or 120),
  "Frames skipped /s" near 0, "Apply p95" a few ms at most, Clock offset near 0.
  *Result:* FPS ___ · skipped ___ /s · apply p95 ___ ms · long tasks ___
- [ ] **2b. Load test T4 (for the README).** Signed in as admin, start a 50x replay from `/ops`,
  then go back to the globe with the HUD open and leave it for one minute, moving the globe around
  a little. Note the numbers below, then Stop the replay.
  *Result:* FPS ___ (lowest seen ___) · skipped ___ /s · apply p95 ___ ms · long tasks ___ (___ ms)
- [ ] **2c. Hidden tab.** With the globe open, switch to another tab for one minute, then come
  back. *Expect:* the numbers are current straight away, with no stutter or burst.
  *Result:*

## 3. A phone

The dev server only answers on this Mac. To reach it from a phone on the same Wi-Fi, start a
second web server that listens on the network (leave `pnpm dev` running):

```bash
cd apps/web && pnpm exec vite --host --port 5174
```

Find the Mac's address with `ipconfig getifaddr en0` and open `http://<that address>:5174` on the
phone. (Google sign-in will not work from that address; it is not needed here.)

- [ ] **3a. `/feed` and `/ops` on the phone.** *Expect:* no sideways scrolling; the type and
  country filters work; the list scrolls smoothly and pauses when you scroll down; the charts on
  `/ops` fit the screen.
  *Result:*

## 4. A really slow connection

- [ ] **4a. Slow-client mode.** The server moves a client whose unsent data keeps piling up (more
  than 256 KB or 64 messages, two checks in a row) to one merged update every 2 s. It is only
  proven by an automated test; on this Mac nothing backed up enough. A client normally receives
  2 to 5 KB/s, so the link has to be slower than that. With the phone set up as in 3: on an iPhone,
  Settings, Developer, Network Link Conditioner, add a profile with **8 kbps download**, turn it
  on, and open the home page on the phone. Watch http://localhost:5173/ops on the Mac. (The
  Developer menu appears once the iPhone has been connected to Xcode. Without an iPhone there is
  no reliable way from this Mac alone: the Mac's own Network Link Conditioner most likely does
  not slow traffic to localhost, and Chrome DevTools' throttling may not slow WebSockets. Skip it
  in that case and say so.)
  *Expect:* within a minute or two the Browsers tile says "1 slow"; the phone keeps updating
  (every 2 s) with no errors; switching the conditioner off brings it back to normal.
  *Result:*

## 5. A real lag spike on RIS (whenever it happens)

- [ ] **5a. Per-second corrections live.** Only tested with a simulated slow collector. On `/ops`,
  watch the Sources table: RIS lag is normally 3 to 10 s. If it ever reads 20 s or more, check
  that "Corrected into their second" (Data quality) climbs quickly, and that the "Right now"
  headline on the home page carries on normally, a few seconds older ("as of ...").
  *Result:*

## 6. Docker

Docker could not download images from the development session, so neither of these has run.

- [ ] **6a. The demo stack, and the ingest worker inside the image.**

  ```bash
  docker compose --profile demo up --build
  ```

  Open http://localhost:8080, then http://localhost:8080/api/status. *Expect:* the app works, and
  the status JSON contains `"ingestThread": { ..., "mode": "worker" }`.
  *Result:*
- [ ] **6b. The load-test profile.**

  ```bash
  JWT_SECRET=x LOADTEST_ARGS="--clients 50 --duration 15 --speed 10" docker compose --profile loadtest up --build --exit-code-from loadtest loadtest server-loadtest mongo
  ```

  *Expect:* a summary ending in `results  .../tools/loadtest/results/<name>.json`, 50/50 clients,
  0 gaps. **Afterwards** `docker compose --profile loadtest down` also stops the shared `mongo`;
  bring it back with `docker compose up -d mongo`.
  *Result:*

## 7. A long run (2 hours)

- [ ] **7a. Soak test.** Settles whether memory levels off (the 30-minute run showed RSS +50 MB in
  its last 20 minutes). Stop `pnpm dev` first, so nothing else uses the CPU. Then, in one terminal:

  ```bash
  cd apps/server && PORT=3100 MODE=replay SOCKET_CONNECTIONS_PER_MIN=1000000 API_RATE_PER_MIN=1000000 MONGODB_URI=mongodb://127.0.0.1:27017/ins_soak NODE_ENV=production node --env-file=../../.env src/index.ts
  ```

  and in another:

  ```bash
  cd tools/loadtest && node --env-file=../../.env src/cli.ts run --base http://localhost:3100 --clients 500 --speed 10 --loop --duration 7200 --name t3-soak-2h
  ```

  *Expect:* after 2 hours a summary with 0 gaps, and a file `tools/loadtest/results/t3-soak-2h.json`.
  Leave it there; the memory trend will be read from it.
  *Result:*

---

## Done in the development session (no need to repeat)

- **`METRICS_TOKEN`**: no token and a wrong token get 401; the right token gets 200 and the
  metrics (checked 14 Nov 2026).
- **Why the 90 s stall recovered:** the stalled client was dropped after 43.0 s with reason
  `ping timeout` (25 s ping interval + 20 s timeout), reconnected 0.6 s later on a fresh
  connection, and the server restored its session (`recovered=true`) and re-sent what it had
  missed (checked 14 Nov 2026).
- **Ingest thread crash:** restart is covered by an automated test (`link.test.ts`); there is no
  safe way to crash the thread on purpose in the running app, so it is not on this list.

## Known problems (to fix after the checks above)

1. **A server restart splits an ongoing incident in two.** The incident open when the server dies
   is closed at startup, and the same outage opens a new incident about 30 s later (seen in load
   test T6). Fix: load recent incidents at startup so the "reopen within 30 minutes" rule merges
   them.
2. **The server's byte counter reads about 19% below what clients receive** at 2,000 clients
   (T2). The client figures are the ones published; the cause is not pinned down.
3. **Slow memory creep after the first 10 minutes** of the 30-minute soak (T3): RSS +50 MB over 20
   minutes, main heap +14 MB over 30. Check 7a decides whether this is real.
4. Plus anything from the checks above that did not match.
