# Internet Nervous System: the short guide

The same ground as `PROJECT_GUIDE.md` in half the length. Each section gives the idea, then how
we did it and the numbers. The full guide has more background, examples and a longer glossary.

---

## 1. What it is

A live 3D globe showing the health of the internet. The server reads three real, public streams:

- **RIS Live**: every change in how the internet's networks route traffic to each other.
- **RIPE Atlas**: round-trip times measured by thousands of small probes worldwide.
- **Cloudflare Radar**: Cloudflare's reports of outages, anomalies, hijacks, leaks and DDoS attacks.

It scores the health of every country and network each second, detects trouble, groups evidence
into **incidents**, stores history in MongoDB and pushes updates to browsers over Socket.IO. Each
browser gets only the parts it is looking at, only what changed, at most twice a second. Built for
the MERNIFY hackathon ("High-Throughput Streams & Telemetry") with Node.js + Express, MongoDB,
React and Socket.IO.

---

## 2. Internet basics

**Packets and IP addresses.** Data travels in small packets, each addressed to an **IP address**:
IPv4 like `157.240.22.35`, or IPv6 like `2a03:2880::25de`. **Routers** pass each packet to a
neighbour, hop by hop, until it arrives. No router knows the whole path, only the next step.

**Prefixes.** Addresses are routed in blocks written in **CIDR** notation. `157.240.0.0/16` covers
the 65,536 addresses that share the first 16 bits. A bigger number after the slash means a smaller
block (`/24` is 256 addresses).

**Autonomous Systems (AS).** The internet is about 75,000 independently run networks, each with a
number (**ASN**): AS32934 is Facebook, AS13335 Cloudflare, AS9829 BSNL. Each **originates**
(owns and announces) some prefixes. Five **Regional Internet Registries** (ARIN, RIPE NCC, APNIC,
LACNIC, AFRINIC) record which country each ASN is registered in. We use their files to put
networks on the map.

**BGP.** Networks tell each other what they can reach with the **Border Gateway Protocol**.
Neighbours (**peers**) send two kinds of message:

- **announcement**: "reach 157.240.0.0/16 through me, path 3356 1299 32934";
- **withdrawal**: "I can no longer reach it".

The **AS path** lists the networks a route passes through; the last one is the **origin**. BGP
trusts what it is told, which is why hijacks are possible. Some churn is always normal: about 95%
of live route changes are announcements, 5% withdrawals.

**Route collectors.** RIPE runs routers (`rrc00` to `rrc26`) that peer with hundreds of networks
and record everything they hear. A withdrawal reported by 100 peers is real; by one, it is
probably a local hiccup.

**DNS and root servers.** DNS turns names into addresses. At its top are 13 named root servers,
each run as many machines worldwide, which makes them a good fixed target for measuring latency.

**Latency.** **Round-trip time (RTT)** is the time for a message to go and come back (a **ping**).
Under 20 ms is nearby; 100 to 300 ms is across the world. A ping with no reply is **packet loss**.

**Internet exchanges (IXPs).** Buildings where many networks connect, such as Frankfurt, Ashburn
in Virginia, or Mumbai. Most of a country's traffic goes through a few of them, so our attack arcs
end at those hubs.

---

## 3. What goes wrong

- **Outage**: a network's routes are withdrawn and nobody can reach it. Causes include a bad
  configuration, a cable cut, a power failure, or a government shutdown (a **country blackout**).
  It shows up as a **withdrawal storm**: many withdrawals, from many peers, at once.
- **BGP hijack**: a network announces someone else's prefixes, so traffic goes to the wrong place.
  Examples: Pakistan Telecom took YouTube offline in 2008; in 2018 crypto thieves hijacked a DNS
  provider's addresses. It shows up as an **origin change** seen at several collectors.
- **Route leak**: a network passes on routes it should have kept private, sending traffic down
  the wrong path.
- **DDoS** (Distributed Denial of Service): many machines, usually a **botnet** of hacked devices,
  overwhelm a target.
  - **Layer 3/4** attacks flood the target with raw packets (UDP or SYN floods).
  - **Layer 7** attacks send masses of normal-looking requests, such as HTTP.
  - Cloudflare publishes which countries attacks come from and go to. These **attack pairs** are
    the arcs on our globe.
- **Traffic anomaly**: a country's or network's traffic suddenly drops (or spikes) against its
  normal pattern.
- **Latency surge**: many probes in a country suddenly see much slower round trips than their own
  normal.
- **Probe dropout**: many probes in a country disconnect at once, usually because their
  connections went down.

**Our demo story: Facebook, 4 October 2021.** At about 15:39 UTC a maintenance command disconnected
all of Facebook's data centres. Its DNS servers then withdrew their BGP routes, and Facebook,
Instagram and WhatsApp vanished for about six hours. RIPE's recordings show a burst of withdrawals
for AS32934 from about 100 peers. We use them two ways:

- **as a demo**: Facebook's own events, played now in about two minutes;
- **as load**: the full 8.57 million events from 15:20 to 16:30 UTC, replayed at up to 50x.

---

## 4. Data sources

| Source | What we take | Important details |
|---|---|---|
| **RIS Live** (WebSocket) | BGP messages: timestamp, peer, peer AS, collector, AS path, announcements, withdrawals | One connection per collector (`rrc00, rrc10, rrc11, rrc14`). The unfiltered stream lags 40+ s and drops connections. `rrc00` is about 600 messages (1,400 events) a second, normally 3 s behind. There is no replay, so MongoDB is the history. |
| **RIPE Atlas** (WebSocket) | Pings to the root DNS servers (`1001` k-root, `1008` l-root, `1006` m-root) every 4 minutes from each probe; probes connecting and disconnecting | 15,000+ connected probes. Results arrive 102 s late at the median and 240 s at p99, so latency is counted per minute and windows wait 4 minutes. The probe list (location, network) is cached daily. |
| **Cloudflare Radar** (REST, token needed) | Every 3 min: outages, traffic anomalies, hijacks (confidence 8+), leaks (seen by 10+ peers). Every 15 min: the top layer-3 and layer-7 attack pairs | Stored 30 days; drawn as arcs; **confirms** our incidents (never opens one alone). Licence CC BY-NC 4.0, so it is credited. |
| **RIPEstat** (REST) | Network names; the prefixes a network announces | Fetched on demand and cached. |
| **RIR files** | Which country each ASN is registered in | 5 downloads a week, cached. |
| **Recorded data** | RIPE's MRT archives converted to our format | The full Facebook window (89 MB, not committed) and a 132 KB scenario cut (committed). |

---

## 5. Architecture

```
 RIS Live x4, RIPE Atlas, replay
        │
        ▼  INGEST THREAD (worker thread)
 validate ─► normalise ─► bounded queue ─► dedupe ─► watermarks ─► 1 s / 1 min windows
        ─► totals per world / country / network ─► detectors ─► incidents
        │  messages
        ▼  MAIN THREAD                                        Cloudflare Radar (REST)
 Express REST API ─► MongoDB          Socket.IO /live /user /admin ─► rooms ─► browsers
```

Node.js runs JavaScript on one thread with an **event loop**: one task at a time, so a slow task
delays everything else. The bursty ingest work therefore runs in a **worker thread** with its own
loop. It talks to the main thread only through typed messages (`ingest/protocol.ts`, `link.ts`,
`core.ts`). The main thread handles HTTP, MongoDB and Socket.IO.

At 90,000 events a second, the main thread's 99th-percentile response time was 0.35 ms with the
worker thread and 1.21 ms without it. A crashed ingest thread restarts after 1 s.

**Repository**: `apps/server` (API, real-time delivery, ingest, detection, storage), `apps/web`
(React), `packages/shared` (contracts both sides use), `tools/` (capture, replay-prep, loadtest),
`docs/`.

---

## 6. The event envelope

Every event from every source gets one shape:

```json
{ "v": 1, "src": "ris", "eid": "ris:rrc00-...#0", "kind": "bgp.announce",
  "ts": 1794560337580, "its": 1794560339697,
  "entity": { "prefix": "5.42.160.0/22", "collector": "rrc00", "asn": 57976 },
  "data": { "peerAsn": 206356, "path": [206356, 57976] } }
```

- `src` is the source; `eid` is a unique ID (a message with three prefixes becomes three events,
  `#0` to `#2`); `kind` is the type (`bgp.announce`, `bgp.withdraw`, `atlas.ping`,
  `atlas.probe_status` ...).
- `ts` is **event time** (when it happened) and `its` is **ingest time** (when we got it).
- Counting always uses event time, so a burst of late events still lands in the right seconds.

---

## 7. The pipeline

1. **Connect.** Each feed is a WebSocket that reconnects forever, with **exponential backoff and
   jitter** (1, 2, 4 ... up to 10 s, randomised), re-subscribes, and pings to catch dead
   connections. Load test T6: the feed returned 8.2 s after a network cut (18.5 s with the old
   30 s ceiling).

2. **Validate** every message with **zod** schemas. Bad messages are rejected and counted, never
   silently dropped.

3. **Normalise** to envelopes.

4. **Bounded queue** (backpressure). Connectors hand events over and return at once; the pipeline
   drains the queue in 8 ms slices. Default capacity is 100,000 events.

   | Queue fill | What happens |
   |---|---|
   | under 70% | everything gets in |
   | 70 to 95% | everything gets in; the raw feed is thinned to 1 in k |
   | 95 to 100% | announcements are dropped (**shed**) |
   | 100 to 120% | only withdrawals and probe status get in (a reserve) |
   | 120% and over | nothing gets in (**overflow**) |

   Every drop is counted. Live feeds shed; a replay file waits instead (no loss). In practice the
   pipeline handled 1.35 million events/s and the queue never passed 14%.

5. **Dedupe.** Message IDs are remembered for 5 to 10 minutes, as 48-bit hashes in two 5-minute
   generations (the old one is dropped whole). A false match is about 1 in 280 million.

6. **Windows and watermarks.**
   - Events are counted in **tumbling windows** (fixed, back-to-back): 1 second for the live view,
     1 minute for storage and detection.
   - A **watermark** says "no older events are expected now": the slowest healthy collector's
     newest timestamp minus an **allowed lateness** (5 s routing, 240 s Atlas).
   - A collector more than 15 s behind, or silent for 30 s, is left out. Timestamps more than 60 s
     in the future are refused.
   - Windows close when the watermark passes them, so the live number describes a second about
     10 s ago. That is the price of exact counts.

7. **Corrections.** Closed 1-second windows are kept for 2 minutes. A late event updates its
   window and the corrected total is sent again under the same key.
   - The headline shows the newest second **every** connected collector has passed ("as of
     17:37:57").
   - Before this fix, one slow minute lost 58% of events from the per-second numbers. After it,
     the headline matched the final total in 29 of 29 checks, and 4.5% of events were corrected
     in.

8. **Totals per scope** (`world`, `country:IN`, `asn:32934`, which are also the room names):
   announcements, withdrawals and distinct prefixes withdrawn; latency p50/p95, pings, losses and
   probes.

9. **Origin table.** Who announced each prefix last, and which are withdrawn. It tells us which
   network a withdrawal belongs to and powers "network vanished". It only knows prefixes seen since
   start.

10. **Country.** A routing event gets its network's registration country; an Atlas event gets the
    probe's physical location.

11. **Health score** (0 to 100) is the worse of two signals:
    - **routing**: the withdrawal share, normal up to 25%, scoring 0 at 75%;
    - **reachability**: lost pings, normal up to 5%, scoring 0 at 50%.

    Too little data counts as healthy.

---

## 8. Detection

Detectors emit **signals** with a weight:

| Detector | Fires when | Weight |
|---|---|---|
| **D1 withdrawal storm** | Withdrawals far above the scope's own normal: robust z-score > 6 (median and **MAD**, which one old spike cannot distort), with 20+ prefixes, 5+ routers and 10 min of history | 0.4, more if widespread |
| **D1b network vanished** | 15%+ of a network's prefixes (at least 15) withdrawn by 20+ routers each, not re-announced | up to 0.6 (full at 40% gone) |
| **D2 possible hijack** | A prefix's origin changes, seen at 3+ collectors, with the old owner not on the new path | 0.3 + 0.05 per prefix |
| **D3 latency surge** | 30%+ of a country's probes (5+) well above their own **EWMA** (a running average weighted toward recent values) on all targets | 0.2, more with 20+ probes |
| **D4 probe dropout** | 5+ probe disconnects in 5 min, 20%+ of the country's probes | 0.3, more with a bigger share |
| **D6 Cloudflare** | Radar reports the same network (or country, for outages) | 0.3, confirmation only |

**Incidents.**
- The **score** is the sum of signal weights over 10 minutes, capped at 1. Below 0.5 is "watch",
  0.5 is **warning**, 0.8 is **critical**.
- An incident goes **open**, then **resolving** when signals stop, then **resolved** after 30 quiet
  seconds. The same scope within 30 minutes **reopens** the old incident.
- Summaries come from templates; names come from RIPEstat.
- Incidents are stored, sent to the `incidents`, country and network rooms, and to users whose
  watchlist covers them.
- Live traffic for a network a simulation is faking is masked from detection.
- Only **major** incidents take over the screen (red pulse, alert cards, camera flies there): a
  simulation, a whole country, or a network with 50+ prefixes vanished, 100+ prefixes in a storm or
  10+ hijacked. Small networks stay in the feed.

---

## 9. Storage (MongoDB)

| Collection | Contents | Kept |
|---|---|---|
| `metrics_hourly` | per scope per hour, a slot per minute | world 7 d, country 3 d, networks 2 d (busiest 300) |
| `incidents` | every incident | kept |
| `radar_events` | Cloudflare events | 30 d |
| `ingest_stats` | per-minute pipeline and delivery numbers | 7 d |
| `scenario_runs` | when simulations ran | kept |
| `asn_ranges`, `probes`, `meta`, `asn_names` | reference caches | refreshed |
| `users`, `refresh_tokens`, `watchlists` | accounts | tokens 7 d |

- **Bucket pattern**: one document per hour with a field per minute, 60 times fewer documents. A
  unique index on (scope, key, hour) guarantees one per hour.
- **Idempotent writes**: `$set` of a minute's fields, never `$inc`, so writing a minute twice
  (after a restart or replay) changes nothing.
- No time-series collections, because they cannot have unique indexes.
- **TTL indexes** delete old data automatically, keeping us under Atlas's free 512 MB.
- `GET /api/history` returns stored minutes, the last 15 minutes of seconds from memory, and a
  `snapshotSeq` (section 10).

---

## 10. Real-time delivery

**WebSocket** is a two-way connection that stays open, so the server can push. **Socket.IO** adds
reconnection, **namespaces** (separate channels) and **rooms** (groups to send to).

- **Namespaces and rooms**:
  - `/live` (public): `world`, `incidents`, `arcs`, `stats`, `country:<CC>`, `asn:<N>`,
    `feed:<kind>:<cc>`;
  - `/user`: each user's `user:<id>` alerts;
  - `/admin`: `ops`.

  A browser gets nothing until it joins rooms: at most 20 rooms, one feed room.
- **Frames carry only changes**: `{ r: room, s: seq, t: time, d: [[key, field, value], ...] }`.
  - A **set** is a current value, sent only if it changed.
  - An **append** is a record with a unique key, such as one closed second.
- **Conflation**: one frame per room every 500 ms. Without it a client got 67 frames a second
  instead of 2.6, 3.6 times the bytes, and the server's event loop reached 188 ms.
- **Sequence numbers** go up by 1 per frame per room. The browser checks them: a duplicate is
  dropped; a gap triggers `resync` from a 120-frame buffer, or a history reload if that is too old.
- **History + live merge**:
  1. Join the room; the reply carries the current sequence number and the room's current values.
  2. Hold incoming frames.
  3. Fetch history, which includes `snapshotSeq`.
  4. Drop held frames up to `snapshotSeq`, then apply the rest.
  5. Points are stored by timestamp, so nothing is ever duplicated.
- **MessagePack** (binary instead of JSON): 40% fewer bytes on live data, 29% in T5.
- **Raw feed** (`/feed`): a fair random sample (**reservoir sampling**) of at most 20 events a
  second per room, while counting all of them. Sent **volatile**: a busy client skips a batch
  rather than queueing it.
- **Slow clients**: a socket whose unsent data stays over 256 KB or 64 messages gets one merged
  frame per room every 2 s, marked with the range of numbers it covers. It returns to normal once
  it catches up.
- **Drops**: Socket.IO keeps a dropped client's session 2 minutes and re-sends what it missed.
  - Offline 30 s: reconnected in 13 ms, no gap.
  - Offline 150 s: rejoined from fresh numbers, no gap.
  - A client that stops reading is dropped after about 43 s (ping every 25 s, timeout 20 s).

---

## 11. The web app

React 19, Vite, Tailwind 4, Zustand (state), TanStack Query (REST) and Virtual (lists), uPlot
(charts), react-globe.gl on three.js (globe), Comlink (talking to a Web Worker).

**Pages**:
- `/`: the globe on the right; a sidebar with welcome/sign-in, "Right now", incidents, busiest
  countries and folded detail sections.
- `/c/<CC>`: a country's health, routing and latency charts.
- `/incident/<id>`: evidence, score and timeline.
- `/feed`: the raw stream, filterable by type and country.
- `/ops`: server performance.
- `/me`: your watchlist.
- `/login`: sign-in.

**Keeping it smooth**:
- The socket runs in a **Web Worker** (a background thread), so decoding and order checks never
  block scrolling.
- Updates are merged and applied **once per animation frame**, so React renders at most once per
  frame, and once a second in a hidden tab.
- Long lists are **virtualised**: of 500 rows, only the ~20 visible are in the page.

**The globe**: hexagon dots coloured by country health; probe dots coloured by latency; rings on
the busiest countries; Cloudflare attack arcs ending at internet hubs; incident icons. India's
outline follows the official Indian boundary.

**Look**: dark grey ("Graphite"), one cyan accent, fonts Michroma, Rajdhani and Share Tech Mono.
Simple first, details folded away. Times are shown in your own time zone.

**HUD** (press `~`): frames per second, skipped frames, update cost, long tasks, and each frame's
age on arrival corrected by a measured clock offset.

---

## 12. Accounts and security

- **Google sign-in**: the server checks Google's signed ID token against Google's public keys. No
  client secret is needed.
- **Our own tokens**:
  - a 15-minute **JWT** access token (a signed bundle of user ID and role), kept in memory only;
  - a 7-day **refresh token** in an `httpOnly`, `Secure`, `SameSite=Strict` cookie, stored only as
    a hash and replaced on every use.
- **Roles**:
  - **visitor**: everything public;
  - **user**: watchlist and alerts;
  - **admin**: simulations, replay, `/metrics`.

  The private socket namespaces check the token before connecting.
- **Validation**: zod on every REST input, socket message and upstream message.
- **Limits**:
  - REST: 100/min per IP; sign-in: 10/min per IP; new sockets: 20/min per address;
  - `sub`/`unsub`/`resync`: a **token bucket** of 5/s per socket, which refills at a steady rate;
  - 64 KB per message.

  Helmet sets security headers; secrets live only in `.env`.

---

## 13. Admin features

**Simulations** run now, are clearly marked, and everyone sees a SIMULATION badge:
- the recorded **Facebook outage** (about 2 minutes);
- **network outage**;
- **hijack** by the made-up AS64511;
- **latency surge**;
- **probe dropout**;
- **country blackout**. Measured: Germany's networks turned critical in 4.2 s, the country in
  5.2 s.

**Replay** (`/ops`): the full recording at 1x to 50x, optionally **amplified** (each event N times)
and **lossy** (sheds like a live feed). Used for load tests.

---

## 14. Watching the system

- `/metrics`: Prometheus format, for admins or `METRICS_TOKEN`. It covers events, rejections,
  duplicates, lateness, queue and shedding, processing delay, MongoDB write time, event-loop delay
  of both threads, memory, sockets and bytes sent.
- `ingest_stats`: the same numbers once a minute in MongoDB, shown on `/ops`.
- The public `stats` room feeds `/ops` once a second.
- Event-loop delay subtracts Node's 10 ms sampling interval; earlier readings were 10 ms too high
  and have been corrected.
- **Percentiles**: p99 is the value 99% of measurements stay below. It shows the slow cases that
  averages hide.

---

## 15. Measured results (one M4 Pro laptop)

| Test | Result |
|---|---|
| Ingest thread | main-thread p99 0.35 ms with it, 1.21 ms without (at 90k events/s) |
| T1 throughput | 1.35 million events/s, nothing shed; the file reader is the limit |
| T2 fan-out | 2,000 clients, 0 gaps; delivery p99 62 ms (load generator on the same machine); about 2 KB/s per client |
| T3 soak | 30 min, 500 clients, 0 gaps; memory rises for 10 min (bounded dedupe), then creeps (2-hour run pending) |
| T5 savings | bytes per client: 1,565/s with everything on; JSON x1.4; send-to-all x1.5; no conflation x3.6; all off x4.7 |
| T6 chaos | feed back 8.2 s after the network; server `kill -9`: up in 0.27 s, clients back in 0.79 s, no duplicate documents |
| Detection | Germany blackout critical in 5.2 s |

---

## 16. Tools, running and what is left

**Tools**:
- `tools/capture` records live streams and measures rates;
- `tools/replay-prep` converts MRT archives;
- `tools/loadtest` is a fleet of clients that check sequences and time delivery, plus a server
  sampler, a replay driver, `--loop` and a relay for cutting the upstream.

**Run**: `pnpm install`, `docker compose up -d mongo`, `pnpm dev`, then open
http://localhost:5173. Before committing: `pnpm lint`, `pnpm typecheck`, `pnpm test`. Docker:
`docker compose --profile demo up --build` (at :8080).

**Known problems**:
1. A restart splits an ongoing incident in two.
2. The server's byte counter reads about 19% low at 2,000 clients.
3. Possible slow memory creep after 10 minutes.
4. The origin table knows only prefixes seen since start.

**Left**: hosting (Railway + MongoDB Atlas), the README, the architecture document, the video, and
the extras (onboarding overlay, probe agent, detectors D5 and D7). By-hand checks:
`docs/manual-checks.md`.

---

## 17. Key terms

**Announcement / withdrawal**: a BGP "reach it through me" / "no longer".
**AS / ASN**: one network and its number.
**Backpressure**: slowing a producer down for a slow consumer.
**BGP**: how networks share routes.
**CIDR / prefix**: a block of addresses.
**Collector**: a router that records what its peers send.
**Conflation**: merging changes into one message per interval.
**DDoS**: an attack from many machines.
**Delta**: only what changed.
**Event loop**: Node's one-task-at-a-time runner.
**Event / ingest time**: when it happened / when we got it.
**EWMA**: an average that favours recent values.
**Hijack / leak**: announcing others' addresses / passing on private routes.
**Idempotent**: doing it twice equals doing it once.
**JWT**: a signed token.
**MAD**: a robust measure of spread.
**MessagePack**: compact binary JSON.
**p50/p95/p99**: percentiles.
**Peer**: a network exchanging routes.
**Probe**: an Atlas measuring device.
**Reservoir sampling**: a fair sample from a stream.
**RTT**: round-trip time.
**Room / namespace**: a group of sockets / a channel.
**Shedding**: dropping low-priority work.
**Token bucket**: a steady-rate limiter.
**Tumbling window**: fixed time buckets.
**TTL**: automatic expiry.
**Volatile**: may be skipped.
**Watermark**: "no older events expected".
**Web Worker**: a background thread in the browser.
**zod**: a library that checks data shapes.
