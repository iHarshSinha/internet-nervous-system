# Internet Nervous System: the complete guide

This document explains the whole project from scratch: the networking ideas it is built on, where
its data comes from, every part of the system, and why each decision was made. No prior knowledge
of networking is assumed. Read it top to bottom once; after that, use the glossary at the end as a
reference.

Contents

1. What we built, in one page
2. How the internet works (the parts we need)
3. When the internet breaks: outages, hijacks, leaks and attacks
4. The story we demo: the Facebook outage of 4 October 2021
5. Where our data comes from
6. The hackathon brief and how we answer it
7. The system at a glance
8. The event envelope: one shape for every event
9. The ingest pipeline, step by step
10. Detecting trouble: detectors and incidents
11. Storage: what goes into MongoDB and why
12. Real-time delivery: Socket.IO, rooms and frames
13. The web app
14. Accounts, security and limits
15. Admin features: scenarios, attacks and replay
16. Watching the system itself: metrics, /ops and the HUD
17. How fast it is: measured results
18. Tools around the app
19. Running it
20. Known problems and what is left
21. Glossary

---

## 1. What we built, in one page

**Internet Nervous System** is a live 3D globe that shows the health of the internet as it
happens. It reads three real, public streams of internet measurements:

- **RIS Live**: every change in how the internet's networks route traffic to each other (tens of
  thousands of changes per minute).
- **RIPE Atlas**: round-trip times measured by thousands of small probes in homes and offices
  around the world.
- **Cloudflare Radar**: Cloudflare's own reports of outages, traffic anomalies, route hijacks,
  route leaks and DDoS attacks.

From these the server works out, every second, how healthy each country and each network is,
spots trouble (a network disappearing, a possible hijack, latency jumping, measurement probes
going dark), groups the evidence into **incidents**, stores everything in MongoDB, and pushes
updates to every open browser over Socket.IO. Browsers only receive the parts they are looking at
(a country, a network, the incident list), only what changed, and merged into at most two updates
a second.

On screen you get: a globe coloured by country health, latency dots for thousands of probes, attack
arcs from Cloudflare, an incident feed, country and incident pages with charts that join stored
history to live data without gaps or duplicates, a raw event feed, and a performance page that
shows the server's own numbers. Admins can trigger simulated outages and attacks for demos, and
replay the real Facebook outage of 2021.

It is built for the MERNIFY hackathon track "High-Throughput Streams & Telemetry", with Node.js +
Express, MongoDB, React and Socket.IO.

---

## 2. How the internet works (the parts we need)

### 2.1 Packets and IP addresses

Everything on the internet travels as **packets**: small chunks of data (typically up to about
1,500 bytes) with a destination address written on them. Each device that talks on the internet
has an **IP address**:

- **IPv4** addresses look like `157.240.22.35` (four numbers from 0 to 255; about 4.3 billion in
  total).
- **IPv6** addresses look like `2a03:2880:f12f:83:face:b00c:0:25de` (much longer, because IPv4 ran
  out).

A packet is passed from **router** to router, each one deciding which neighbour to hand it to
next, until it reaches the destination. No single router knows the whole path; each only needs
to know which neighbour is the right next step.

### 2.2 Prefixes: blocks of addresses

Addresses are handed out and routed in blocks called **prefixes**, written in **CIDR notation**:
`157.240.0.0/16` means "every address that starts with the same first 16 bits as 157.240.0.0",
which is 157.240.0.0 to 157.240.255.255, 65,536 addresses. A larger number after the slash means a
smaller block: a `/24` is 256 addresses, a `/32` is a single IPv4 address. IPv6 prefixes work the
same way (`2a03:2880::/32`).

Routing works on prefixes, not single addresses: a router's table says "for anything in
157.240.0.0/16, go this way".

### 2.3 Networks and Autonomous Systems (AS, ASN)

The internet is a network of networks. Each independently run network (an internet provider, a
cloud company, a university, a big company like Facebook) is an **Autonomous System (AS)** and
has a number, its **ASN**:

- AS32934 is Facebook (Meta).
- AS13335 is Cloudflare.
- AS15169 is Google.
- AS9829 is BSNL (India).

There are roughly 75,000 ASes active. Each AS **originates** (owns and announces) some prefixes.
Who owns which ASN is recorded by the five **Regional Internet Registries (RIRs)**: ARIN (North
America), RIPE NCC (Europe, Middle East, Central Asia), APNIC (Asia-Pacific), LACNIC (Latin
America), AFRINIC (Africa). Their public "delegated" files say which country each ASN is
registered in; we use those to put networks on the map.

### 2.4 BGP: how networks tell each other where things are

Networks learn where to send packets from each other using the **Border Gateway Protocol
(BGP)**. Neighbouring networks run BGP sessions between their routers (they are each other's
**peers**) and send two kinds of messages:

- **Announcement**: "You can reach 157.240.0.0/16 through me. The path is 3356 1299 32934."
- **Withdrawal**: "Forget what I said: I can no longer reach 157.240.0.0/16."

The **AS path** in an announcement is the chain of networks the route passes through. The last
number is the **origin AS** (the owner, here 32934 = Facebook). Each network adds its own number
when it passes a route on, which is how loops are avoided and how routers prefer shorter paths.

BGP is built on trust. A network can announce any prefix, and its neighbours will usually believe
it. That trust is why the problems in section 3 are possible.

Every second, all over the world, thousands of these messages flow, because links fail and
recover, companies change providers, and engineers change settings. A steady background of
announcements and withdrawals ("churn") is normal. In our live data about 95% of route changes are
announcements and about 5% are withdrawals.

### 2.5 Route collectors: watching BGP from outside

You cannot see BGP traffic between two companies' routers. But some organisations run **route
collectors**: routers that peer with hundreds of networks and simply record every message they
receive. RIPE NCC's collectors are called `rrc00`, `rrc01` ... `rrc26` (RIS = Routing Information
Service), placed at internet exchanges around the world. Each collector has many **peers**
(networks feeding it their view). When the same withdrawal arrives from 100 peers, it is real and
widespread; when it comes from one, it is probably that one network's local hiccup.

### 2.6 DNS and the root servers

People use names like `facebook.com`, not IP addresses. The **Domain Name System (DNS)** turns
names into addresses. At the top of DNS are the 13 **root servers** (`a.root-servers.net` to
`m.root-servers.net`, each actually hundreds of machines worldwide). Because they are everywhere
and always up, they make an excellent fixed target to measure latency against, which is exactly
what RIPE Atlas does for us.

### 2.7 Latency, ping, round trip and packet loss

- **Latency** is how long data takes to travel. We measure **round-trip time (RTT)**: the time
  from sending a small message to getting the answer back, in milliseconds.
- **Ping** is the classic tool: send an "echo request", wait for the "echo reply", time it.
- **Packet loss**: a ping that never gets a reply. A little loss is normal; lots of it means
  something is broken.
- Typical numbers: under 20 ms to a nearby server, 100 to 300 ms across the world. A sudden jump
  for many probes in one country means congestion or a broken route.

### 2.8 Internet exchanges and data centres

An **Internet Exchange Point (IXP)** is a building where many networks connect to each other
directly (for example in Frankfurt, Amsterdam, London, Ashburn in Virginia, Mumbai). Most of a
country's traffic flows through a few such hubs. That is why our attack arcs end at a country's
main hub (Ashburn for the US, Frankfurt for Germany, Mumbai for India) rather than at the middle
of the country.

---

## 3. When the internet breaks: outages, hijacks, leaks and attacks

### 3.1 Outage (a network vanishes)

A network's routes are withdrawn, so nobody knows how to reach it any more. Causes: a bad
configuration change, a fibre cut, a power failure, or a government shutting the internet down
(a **country blackout**). In BGP data this shows up as a **withdrawal storm**: many withdrawals
for one network's prefixes, seen by many peers at once.

### 3.2 BGP hijack (someone claims addresses that are not theirs)

A network announces a prefix that belongs to someone else (by mistake or on purpose). Because BGP
trusts announcements, some of the internet starts sending that traffic to the wrong network, which
can drop it, read it or impersonate the real owner. Famous examples: Pakistan Telecom
accidentally taking YouTube offline worldwide in 2008, and cryptocurrency thefts by hijacking a
DNS provider's addresses in 2018. In our data a hijack shows up as an **origin change**: a prefix
previously announced by AS A is suddenly announced with origin AS B, seen at several collectors,
and A is not on the new path.

### 3.3 Route leak

A network passes on routes it should have kept to itself (for example a small customer
re-announcing everything its provider told it). Traffic then takes a wrong, often overloaded
path. Cloudflare Radar reports leaks; we keep only those seen by at least 10 peers, because most
leaks are tiny and seen by one or two.

### 3.4 DDoS attacks

A **Denial of Service** attack tries to make a service unusable by overwhelming it. A
**Distributed** DoS (DDoS) uses thousands or millions of machines at once, usually a **botnet**
(hacked computers, cameras and routers controlled by the attacker). Two main kinds:

- **Layer 3/4 attacks** (network and transport layers): flood the target's network with raw
  packets (for example UDP floods or SYN floods) to fill its links or exhaust its connection
  tables. Measured in packets or bits per second.
- **Layer 7 attacks** (application layer): send huge numbers of seemingly normal requests (for
  example HTTP requests for a web page) so the servers run out of capacity. Harder to filter
  because each request looks legitimate.

"Layers" refers to the OSI model: layer 3 is IP (addresses and routing), layer 4 is TCP/UDP
(connections and ports), layer 7 is the application (HTTP, DNS and so on).

Cloudflare sees a large share of the world's DDoS attacks against its customers and publishes, per
day, which countries attacks come **from** and which they target. Those are the **attack pairs**
we draw as arcs on the globe (for example "CN to US: 14%" of layer-7 attack traffic).

### 3.5 Traffic anomaly

A sudden drop (or spike) in a country's or network's traffic compared with its normal pattern.
Cloudflare detects these from its own traffic and publishes them; a sharp drop often means an
outage or shutdown.

### 3.6 Latency surge and probe dropout

From the measurement side:

- **Latency surge**: many probes in one country suddenly see much higher round-trip times than
  their own normal.
- **Probe dropout**: many probes in one country disconnect within minutes of each other, which
  usually means their internet connections went down (power cut, provider outage, shutdown).

---

## 4. The story we demo: the Facebook outage of 4 October 2021

On 4 October 2021, at about **15:39 UTC**, Facebook, Instagram and WhatsApp disappeared from the
internet for about six hours. During routine maintenance, a command meant to check capacity on
Facebook's backbone accidentally disconnected all of its data centres. Facebook's DNS servers are
designed to stop announcing their own addresses when they cannot reach the data centres, so they
**withdrew their BGP routes**. Within minutes the rest of the internet no longer knew how to reach
Facebook's DNS servers, so `facebook.com` could not even be looked up. Engineers had trouble
getting in to fix it, because their own tools ran on the same network.

In BGP data this is textbook: a burst of withdrawals for AS32934's prefixes from about a hundred
peers at every collector. We use the public RIS recordings of that afternoon in two ways:

- **The full replay**: 8.57 million events from 15:20 to 16:30 UTC (four collectors), played
  through the exact same pipeline at 1x to 50x speed. Used for load tests.
- **The scenario**: just Facebook's own events from 15:39 to 15:54, played now, for about two
  minutes, so the outage happens live on screen in a demo (with a "SIMULATION" badge for
  everyone).

---

## 5. Where our data comes from

### 5.1 RIS Live (RIPE NCC)

- **What**: a public WebSocket stream of the BGP messages RIPE's route collectors receive, live.
- **Address**: `wss://ris-live.ripe.net/v1/ws/?client=internet-nervous-system`. After connecting we
  send `ris_subscribe` with a filter.
- **What a message has**: `timestamp`, `peer` (IP of the router that sent it), `peer_asn`, `host`
  (which collector), `type` (`UPDATE`), `path` (AS path), `announcements` (list of next hops and
  prefixes) and `withdrawals` (list of prefixes). One message can carry many prefixes, so we turn
  it into one event per prefix.
- **What we measured before building anything** (Phase 0): never subscribe to the unfiltered
  stream; it lags 40+ seconds behind, gets disconnected repeatedly and delivers only a tenth of the
  messages. So we open **one connection per collector** (`rrc00, rrc10, rrc11, rrc14` by default),
  each filtered to that collector. One collector (`rrc00`) is about 600 messages/s, 1,400 events/s.
  A healthy connection is about 3 s behind real time.
- **No replay**: if we miss something, it is gone. That is why our MongoDB is the history.

### 5.2 RIPE Atlas (RIPE NCC)

- **What**: about 12,000 to 18,000 small hardware probes hosted by volunteers in homes and
  offices worldwide, running measurements and streaming the results.
- **Address**: plain WebSocket `wss://atlas-stream.ripe.net/stream/` (its Socket.IO interface is
  legacy). We send `["atlas_subscribe", {streamType: "result", msm: 1001}]` for each measurement,
  plus `probestatus` for connect and disconnect events.
- **Measurements we follow**: the built-in IPv4 pings to the root DNS servers, `1001` (k-root),
  `1008` (l-root), `1006` (m-root). Every probe pings them every 4 minutes.
- **Probe information** (where each probe is, which network it sits in) comes from Atlas's probe
  list API, downloaded once a day and cached in MongoDB.
- **Gotchas we measured**: results arrive late (102 s behind at the median, 240 s at p99), so
  latency is only computed per minute and windows wait 4 minutes for stragglers. If we are too
  slow, Atlas drops messages and sends one warning; we count those.
- **Dedupe key**: measurement, probe and the probe's own timestamp.

### 5.3 Cloudflare Radar

- **What**: Cloudflare's public data portal about internet traffic, attacks and routing, seen from
  its global network. It needs a free API token (`CLOUDFLARE_API_TOKEN`); without one the layer
  simply hides itself.
- **What we poll every 3 minutes**: outage annotations and traffic anomalies (last 7 days), BGP
  hijacks (last day, confidence 8 or more) and route leaks (last day, kept if seen by 10 or more
  peers).
- **Every 15 minutes**: the top layer-7 and layer-3 attack pairs (Radar only offers these as
  1-day aggregates).
- **How we use it**: stored in `radar_events` (kept 30 days), drawn as arcs and listed in a panel,
  and used as **confirmation**: if Radar reports a problem for the same network (or country, for
  outages) we already suspect, our incident's score goes up. Radar alone never opens an incident.
- **Licence**: Radar data is CC BY-NC 4.0 (free for non-commercial use with credit), so it is
  credited in the panel and footer.

### 5.4 RIPEstat

RIPE's lookup API. We use it for **network names** ("Facebook, Inc." for AS32934), fetched only
when an incident needs one and cached in MongoDB (`asn_names`), and for **announced prefixes** of
a network when the attack simulator needs real prefixes our live table has not seen yet.

### 5.5 The five RIR delegated files

Downloaded weekly (5 requests in total) and cached in MongoDB (`asn_ranges`): which country each
ASN is registered in. This is how a routing event gets a country.

### 5.6 Recorded data (replay)

`tools/replay-prep` reads RIPE's raw **MRT** archive files (the binary format collectors store
updates in) and writes our own event format as gzipped NDJSON (one JSON event per line). The full
Facebook window is `deploy/seed/replay/facebook-20211004.ndjson.gz` (89 MB, not committed); the
small scenario cut is `deploy/seed/scenarios/facebook-2021.ndjson.gz` (132 KB, committed).

---

## 6. The hackathon brief and how we answer it

The brief: build a real-time telemetry monitoring platform with the MERN stack and Socket.IO that
ingests continuous streams from several sources, processes them, stores history, broadcasts
updates to many clients, visualises them, merges history with live data without duplicates, and
stays responsive. Judging: functionality 30%, UX 20%, technical implementation 20%, originality
20%, presentation 10%, plus bonus points.

| Requirement | How we meet it |
|---|---|
| Multiple sources | RIS Live, RIPE Atlas, Cloudflare Radar, replay (plus a probe agent planned) |
| Batching, throttling, aggregation | 1-second and 1-minute windows; changes merged per room every 500 ms; bounded queue |
| Rooms or namespaces | 3 namespaces (`/live`, `/user`, `/admin`), rooms per country, network, incidents, feed, stats |
| History merged with live, no duplicates | the snapshot-sequence merge protocol (section 12.6) |
| Source, ID, timestamp on every event | the event envelope (section 8) |
| Duplicates and out-of-order events | dedupe, event-time windows, watermarks, corrections |
| Responsive client | socket in a Web Worker, one render per animation frame, virtualised lists |
| Validation and rate limiting | zod everywhere, limits per IP, per socket and per sign-in |
| Authentication and access control | Google sign-in, our own short-lived tokens, user and admin roles |
| Bonus: performance numbers | load tests T1 to T6 (section 17) |
| Bonus: anomaly detection and alerts | detectors and incidents (section 10), watchlist alerts |
| Bonus: backpressure | bounded queue with sampling, shedding and pausing (section 9.4) |
| Bonus: hosting | not done yet (Railway planned) |

---

## 7. The system at a glance

```
 RIS Live (4 WebSockets) ─┐
 RIPE Atlas (WebSocket) ──┤                      INGEST THREAD (worker_threads)
 Replay file / scenarios ─┼──► validate ─► normalise ─► bounded queue ─► dedupe ─► watermarks
                          │                                              ─► 1 s and 1 min windows
                          │                                              ─► totals per world / country / network
                          │                                              ─► detectors ─► incidents
                          │                          │ messages (windows, incidents, state, samples)
                          │                          ▼
 Cloudflare Radar (REST) ─┴──────────────────► MAIN THREAD
                                                 Express REST API  ──► MongoDB (history, incidents, users ...)
                                                 Socket.IO (/live, /user, /admin)
                                                    rooms ─► 500 ms delta frames ─► browsers
                                                 metrics (/metrics, ingest_stats)

 BROWSER: socket in a Web Worker ─► stores (Zustand) ─► one render per frame ─► globe, charts, lists
```

Two threads in one Node.js process:

- The **ingest thread** does the heavy, bursty work: reading the feeds, checking and
  transforming every event, counting, detecting. It never touches the database or the browsers.
- The **main thread** answers HTTP requests, talks to MongoDB and sends updates to browsers. A
  burst of 100,000 events a second in the ingest thread does not slow it down (measured: its
  99th-percentile event-loop delay stayed under 5 ms at every load).

**Repository layout**

```
apps/server       Express + Socket.IO + the ingest thread
  src/ingest/       sources (RIS, Atlas, Radar, replay), pipeline (queue, dedupe, watermark,
                    windows, aggregates, origin table), detect (detectors, incidents), core.ts and
                    link.ts (the two sides of the thread boundary), feed.ts (firehose sampler)
  src/realtime/     broadcaster (frames), live and private namespaces, slow clients, stats room
  src/api/          REST routes (history, incidents, globe, radar, auth, me, admin, ops)
  src/db/           MongoDB stores
  src/auth/         Google verification, tokens, users and watchlists
  src/scenarios/    the Facebook scenario and the attack simulator
  src/metrics/      Prometheus metrics, per-minute records, percentiles, event-loop delay
apps/web          React app (pages, globe, charts, workers/socket.worker.ts, stores)
packages/shared   the contracts both sides use: event envelope, rooms, frames, schemas
tools/            capture, replay-prep, loadtest
deploy/           Caddyfile, seed data (scenario file, replay file)
docs/             PLAN.md, benchmarks.md, manual-checks.md, this guide
```

---

## 8. The event envelope: one shape for every event

Every event from every source is converted into the same shape, defined in
`packages/shared/src/envelope.ts`:

```json
{
  "v": 1,
  "src": "ris",
  "eid": "ris:rrc00-80.81.195.178-01a1d421a6ac0017#0",
  "kind": "bgp.announce",
  "ts": 1794560337580,
  "its": 1794560339697,
  "entity": { "prefix": "5.42.160.0/22", "collector": "rrc00", "asn": 57976 },
  "data": { "peer": "80.81.195.178", "peerAsn": 206356, "path": [206356, 57976] }
}
```

- `v`: version of the format.
- `src`: where it came from: `ris`, `atlas`, `radar`, `replay` or `agent`.
- `eid`: a globally unique event ID. A RIS message with three prefixes becomes three events with
  the message's ID plus `#0`, `#1`, `#2`.
- `kind`: what it is: `bgp.announce`, `bgp.withdraw`, `bgp.peer_state`, `atlas.ping`,
  `atlas.probe_status`, and the Radar kinds.
- `ts`: **event time**: when it happened, according to the source.
- `its`: **ingest time**: when we received it. The difference is the **lag**.
- `entity`: what it is about (prefix, collector, origin ASN, probe, measurement).
- `data`: details (peer, path, round-trip time, ...). Simulated events carry `simulated: true`.

Why both `ts` and `its`? Because counting must be by **when things happened**, not when they
reached us. If a collector's connection stalls for 20 seconds and then delivers everything at
once, those events still belong to the seconds in which they happened.

---

## 9. The ingest pipeline, step by step

### 9.1 Connect (and stay connected)

`UpstreamSocket` (`apps/server/src/ingest/sources/upstream-socket.ts`) is a WebSocket client that
never gives up: on any close it reconnects with **exponential backoff with jitter** (wait 1 s,
then 2, 4, 8 ... up to 10 s, each randomised between half and full, so thousands of clients do not
all retry at the same instant), re-sends its subscriptions, and sends pings so a connection that
is open but silently dead is noticed (no data for 60 s means reconnect). The 10-second ceiling came
from load test T6: with the old 30-second ceiling, the feed came back 18.5 s after the network
returned; now 8.2 s.

### 9.2 Validate

Every upstream message is parsed and checked with **zod** schemas (`packages/shared/src/upstream.ts`)
written from real captured messages. Anything that is not JSON or does not match is **rejected and
counted** (never silently dropped). Schemas check only the fields we rely on and let unknown extra
fields through, so a feed adding a field does not break us.

### 9.3 Normalise

The checked message is turned into envelopes (section 8). One RIS message becomes one event per
prefix; an Atlas ping becomes one event with the round-trip time (or `null` if no reply came back).

### 9.4 The bounded queue (backpressure)

Normalised events go into one **bounded queue** (`pipeline/queue.ts`) between the connectors and the
pipeline. The connectors return at once, so the thread keeps reading its sockets; the pipeline
drains the queue in slices of up to 8 ms. If events arrive faster than they can be processed, the
queue grows, and its fill level decides what happens (default capacity 100,000 events):

| Fill | What happens |
|---|---|
| under 70% | everything gets in |
| 70 to 95% | everything gets in; the raw feed shown to people is thinned to 1 in k (k doubles each second while the pressure lasts) |
| 95 to 100% | route announcements are dropped ("shed"): the bulk of traffic and the least important one by one |
| 100 to 120% | a reserve: only withdrawals and probe connect/disconnect get in, because outage detection needs them |
| 120% and over | nothing gets in ("overflow") |

Every dropped event is counted by kind. **Live feeds** cannot be paused (RIS has no replay), so they
shed. **A file** can be paused, so the replay waits for the queue to drain to half and then carries
on: real backpressure, no loss. Measured: the pipeline handles over 1.3 million events a second on
this machine, and the queue never got past 14% in load tests with the default size.

### 9.5 Dedupe

The same event can arrive twice (after a reconnect, or if a replay is started again). The
**deduper** (`pipeline/dedupe.ts`) remembers each message ID for 5 to 10 minutes. To save memory it
stores a 48-bit hash of the ID, not the string, in two **generations**: new IDs go into the current
set; every 5 minutes the current set becomes the previous one and the old previous one is thrown
away. Checking costs one hash and two set lookups, with no timers per entry. Two different IDs
sharing a hash is about one in 280 million; MongoDB's unique keys are the backstop.

### 9.6 Event time, windows and watermarks

We count events in **tumbling windows**: fixed, back-to-back buckets of time that do not overlap.
Routing is counted in **1-second windows** (for the live view) and **1-minute windows** (for
storage and detection); latency in 1-minute windows. An event stamped 12:00:07.3 always goes into
the window [12:00:07, 12:00:08), however late it arrives, while that window is open. That makes
counts **reproducible**: replaying the same data gives the same numbers.

But when is a window finished? Events arrive out of order and late. A **watermark** is the
system's promise: "we do not expect events older than this any more". Ours
(`pipeline/watermark.ts`) works like this:

- Each RIS collector is a **partition** with its own delay. For each we track the newest event
  time seen.
- The watermark is the **slowest healthy partition's** newest time, minus an **allowed lateness**
  (5 s for routing, 240 s for Atlas, from our measurements).
- A partition more than 15 s behind the leader is left out (so one stuck connection cannot freeze
  everything), and a partition silent for 30 s is ignored.
- A timestamp more than 60 s in the future (a probe with a wrong clock) is refused, so it cannot
  push the watermark forward.
- The watermark never moves backwards.

A window closes when the watermark passes its end. This is why "route changes a second" on screen
describes a second that ended about 10 seconds earlier: that is the price of exact counts.

### 9.7 Corrections: late events still count

If a collector falls far behind, its events arrive after their 1-second window has closed. Early on
we simply left them out of the per-second numbers (they still counted in their minute). In one
slow minute that was 58% of all routing events. Now closed 1-second windows are **kept for 2
minutes**: a late event is added to its window and the corrected total is sent again under the
same key, so charts fill in. The headline number on the home page uses the newest second that
**every** connected collector has passed (`Watermark.complete`), so it is complete, and the panel
says which second it is ("as of 17:37:57"). Measured: the headline matched each second's final
total in 29 of 29 samples, and in normal conditions 4.5% of events arrive late and are corrected
in.

### 9.8 Totals per scope

Each window keeps an aggregate per **scope**: `world`, `country:<CC>` and `asn:<N>`. For routing:
announcements, withdrawals and distinct prefixes withdrawn. For latency: the median (p50) and 95th
percentile (p95) round-trip time, pings, lost pings, probes reporting, probes that joined or left.
Scope names are exactly the Socket.IO room names, so no translation is needed when publishing.

### 9.9 The origin table

To know which network a **withdrawal** is about (withdrawals do not say), the pipeline keeps an
**origin table** (`pipeline/origins.ts`): for every prefix, who announced it last, and whether it is
currently withdrawn. It also counts, per network, how many prefixes it has and how many are gone.
This powers "network vanished" detection and gives the attack simulator real prefixes to use.
Known limit: it only knows prefixes seen since the server started (we do not load a full routing
table snapshot).

### 9.10 Country lookup

A routing event's country is the **registration country** of its origin network (from the RIR
files). An Atlas event's country is where the **probe physically is**. These lookups are in memory
and synchronous; until the reference data has loaded, events just do not get a country.

### 9.11 The health score

`packages/shared/src/health.ts`: a number from 0 (broken) to 100 (healthy) per country, network or
the world, as the **worse** of two signals:

- **Routing**: the share of route changes that were withdrawals. Up to 25% is normal churn (score
  stays 100); 75% or more scores 0; linear in between.
- **Reachability**: the share of pings with no reply. Up to 5% is normal; 50% or more scores 0.

With too little data (fewer than 20 route changes or 5 pings) a signal counts as healthy, so a
quiet country is not painted as broken.

### 9.12 Why a worker thread

Node.js runs your JavaScript on one thread with an **event loop**: it takes one task at a time
(an incoming message, a timer, an HTTP request) and runs it to completion. If one task takes
100 ms, everything else waits 100 ms. Ingesting tens of thousands of events per second is a lot of
small tasks, which would make HTTP and Socket.IO responses wait. So the ingest side runs in a
**worker thread** (`worker_threads`), with its own event loop and memory, and talks to the main
thread only through messages (`ingest/protocol.ts` defines every message type; `ingest/link.ts` is
the main thread's side, `ingest/core.ts` the worker's). Measured at 90,000 events a second: the main
thread's 99th-percentile response time was 0.35 ms with the thread, 1.21 ms without. If the thread
crashes it is restarted after 1 second, and messages sent in the gap are delivered to the new one.

---

## 10. Detecting trouble: detectors and incidents

### 10.1 Signals from detectors

Detectors (`ingest/detect/detectors.ts`) watch the stream and produce **signals**: "this scope looks
wrong, with this weight and this evidence".

- **D1, withdrawal storm.** A network's (or country's) withdrawals in the last minute compared with
  its own normal, using a **robust z-score**: how many "typical deviations" above the median it is,
  where median and **MAD** (median absolute deviation) are used instead of mean and standard
  deviation because one past spike does not distort them. Fires at z > 6, with at least 20
  distinct prefixes withdrawn by at least 5 different routers, and only after 10 minutes of
  history (baselines are reloaded from MongoDB at startup). Weight 0.4, more if seen very widely.
- **D1b, network vanished.** A large share (15% or more, at least 15 prefixes) of a network's known
  prefixes is currently withdrawn, each withdrawn by at least 20 different routers in the last 5
  minutes and not re-announced. One router dropping a path is normal; Facebook's prefixes were
  withdrawn by about 100. Weight up to 0.6 (full at 40% gone).
- **D2, origin change (possible hijack).** A prefix suddenly announced with a different origin, seen
  at 3 or more collectors, with the previous owner not on the new path. Weight 0.3 + 0.05 per
  prefix (up to 6).
- **D3, latency surge.** Each probe keeps an **EWMA** (exponentially weighted moving average: a
  running average that gives recent values more weight) of its own round-trip time to each
  target. A probe is "degraded" if it is well above its own normal on all its targets. If 30% or
  more of a country's probes (at least 5) are degraded, the country gets a signal. Weight 0.2, more
  with 20 or more probes.
- **D4, probe dropout.** 5 or more probes in a country disconnected in 5 minutes, and at least 20%
  of its connected probes. Weight 0.3, more the larger the share.
- **D6, Cloudflare confirmation.** A current Radar report for the same network (or country, for
  outages and anomalies). Weight 0.3; never opens an incident alone.
- (Planned for Phase 4: **D5** route flapping and **D7** probe-agent failures.)

Live traffic for a network that a simulation is currently faking is **masked** (kept away from
detection), so the real network's normal updates do not "heal" the simulated outage.

### 10.2 From signals to incidents

The **incident manager** (`ingest/detect/incidents.ts`):

- Groups signals by scope (one network or one country).
- **Score** = sum of the weights of the signal types seen in the last 10 minutes, capped at 1.
  Severity: below 0.5 "watch" (no incident), 0.5 to 0.8 **warning**, 0.8 and above **critical**.
- An incident opens at warning, stays **open** while signals keep coming, becomes **resolving**
  when they stop, and **resolved** after 30 quiet seconds.
- If the same scope has trouble again within 30 minutes, the old incident is **reopened** instead
  of a new one being created.
- Each incident gets a plain-language summary built from templates (which network or country,
  what was seen, how many address blocks and routers) and the network's name from RIPEstat.

Incidents are stored in MongoDB, sent live to the `incidents` room and to the room of the country
and network concerned, and to the personal channel of anyone whose watchlist covers them.

### 10.3 What the screen does with them

Every incident appears in the feed, tagged **REAL** (detected in live data) or **SIMULATED**. Only
**major** ones take over the screen (red edge pulse, alert cards, painting the country, flying the
camera there): any simulation, any country-wide incident, or a network incident with a large
footprint (50+ known prefixes vanished, 100+ prefixes in a storm, or 10+ prefixes hijacked). Small
networks flapping stay in the feed so the screen is not in permanent alarm.

---

## 11. Storage: what goes into MongoDB and why

| Collection | What | Kept |
|---|---|---|
| `metrics_hourly` | per scope per hour, one slot per minute: routing and latency totals | world 7 days, country 3 days, network 2 days (busiest 300 networks only) |
| `incidents` | every incident, `_id` = incident ID | kept |
| `radar_events` | Cloudflare Radar events, `_id` = our ID | 30 days |
| `ingest_stats` | per minute: per-source counts, pipeline and delivery numbers | 7 days |
| `scenario_runs` | when simulations ran (charts shade those stretches) | kept |
| `asn_ranges`, `probes`, `meta`, `asn_names` | reference data caches | refreshed weekly / daily |
| `users`, `refresh_tokens`, `watchlists` | accounts and sign-in | refresh tokens 7 days |

**The bucket pattern.** `metrics_hourly` has one document per scope per hour with a field per minute
(`m.07`, `m.08` ...), instead of one document per minute: 60 times fewer documents and indexes.
A unique index on (scope, key, hour) guarantees one bucket per hour.

**Idempotent writes.** Every write is `$set` of specific fields of one minute (for example
`m.07.ann = 812`), never `$inc` (add). Writing the same minute again (after a restart or a replay)
therefore leaves the document exactly as it was: no double counting. Routing and latency fill the
same minute separately, each writing only its own fields.

**Why not MongoDB time-series collections?** They do not support unique indexes, and uniqueness is
what makes our writes safe to repeat.

**TTL (time to live).** Documents carry an `expireAt` date and a TTL index deletes them
automatically, to stay under the 512 MB of MongoDB Atlas's free tier.

**History API.** `GET /api/history?scope=country&key=IN&from=...` returns stored minutes, the last
15 minutes of 1-second points from memory, and a `snapshotSeq` (section 12.6).

---

## 12. Real-time delivery: Socket.IO, rooms and frames

### 12.1 WebSocket and Socket.IO

HTTP is request and response: the browser asks, the server answers. For live data the server must
be able to **push**. A **WebSocket** is a long-lived two-way connection over which either side can
send at any time. **Socket.IO** is a library on top of it that adds reconnection, **namespaces**
(separate channels on one connection), **rooms** (groups of sockets you can send to at once),
acknowledgements (replies to messages) and recovery after short drops.

### 12.2 Our namespaces and rooms

- `/live` (public): rooms `world`, `incidents`, `arcs`, `stats`, `country:<CC>`, `asn:<N>`,
  `feed:<kind>:<cc>`.
- `/user` (signed-in users): each user's own room `user:<id>` for personal alerts.
- `/admin` (admins): `ops`.

A browser receives **nothing** until it joins rooms (`sub`), and then only what those rooms carry.
The home page joins `world`, `incidents` and `arcs`; a country page also joins `country:IN`; the
performance page joins `stats`. At most 20 rooms per socket, and one raw-feed room.

### 12.3 Frames: only what changed

The server never sends whole state. It sends **frames**:

```json
{ "r": "country:IN", "s": 42, "t": 1794565823000, "d": [["now", "health", 97], ["s:1794565822000", "bgp", {"ann": 34, "wd": 5, "pfx": 2}]] }
```

`r` room, `s` sequence number (goes up by exactly 1 per frame per room), `t` server time, `d` the
changes as `[key, field, value]`. Two kinds of change:

- **set**: a current value (a country's health). Set five times in one interval, only the last is
  sent; a value equal to the last one sent (or within a small tolerance) is not sent at all.
- **append**: a record that must not be merged away (one closed second), with a unique key.

### 12.4 Conflation: at most two frames a second per room

Changes are staged and sent as **one frame per room every 500 ms** ("conflation"). Without it each
change would be its own frame: load test T5 measured 67 frames a second per client instead of 2.6,
3.6 times the bytes, and the server's event loop reaching 188 ms.

### 12.5 Sequence numbers, gaps and resync

Because every frame in a room is numbered, the browser can check it received all of them, in
order. The last 120 frames per room are kept on the server. If the browser sees a gap (frame 45
after 42), it asks `resync` for everything after 42 and applies them in order; if they have already
left the buffer, it reloads that room's history from the REST API. Duplicates (a number already
applied) are dropped.

### 12.6 Merging history with live data (no duplicates, no gaps)

The protocol, used by every chart:

1. Join the room. The acknowledgement says the room's current sequence number S0, and includes
   the room's current values ("state"), so a new viewer does not need everyone else to be re-sent
   everything.
2. Hold incoming frames in a buffer.
3. Fetch history from the REST API. The response includes `snapshotSeq`: the room's sequence
   number at the moment the history was read.
4. Drop buffered frames with a sequence number up to `snapshotSeq` (history already contains
   them); apply the rest in order.
5. The browser stores points **keyed by timestamp**, so even an overlap would replace, never
   duplicate.

### 12.7 MessagePack

By default Socket.IO sends JSON text. We use **MessagePack**, a binary format that encodes the same
data more compactly (numbers as bytes, no quotes). Measured with 50 live clients: 40% fewer bytes
per client; in T5, 29%.

### 12.8 The firehose (raw feed)

The `/feed` page shows individual events. Sending every event to every viewer would be thousands a
second, so the ingest thread samples only for rooms that have viewers, picking a **fair random
sample** of at most 20 events a second per room (**reservoir sampling**: every event has the same
chance of being kept, however many arrive), and counts all of them, so the page can say "1,266/s,
showing 1.1%". These are sent **volatile**: if a browser is not ready to receive, it simply misses
that batch rather than building a backlog.

### 12.9 Slow clients

A browser on a bad connection cannot take frames as fast as they come; Socket.IO would keep
queueing for it. Once a second the server checks each socket's unsent backlog; a client that stays
behind (over 256 KB or 64 messages, twice in a row) is moved to **summary mode**: normal frames skip
it, and every 2 seconds it gets one merged frame per room, marked with the range of sequence numbers
it covers (`f` to `s`), so its order check still passes. When its backlog has cleared for 5 checks
it returns to normal frames.

### 12.10 Short drops and recovery

Socket.IO's **connection-state recovery** keeps a disconnected client's session for 2 minutes and
re-sends what it missed when it comes back. Measured: a client whose network was gone for 30 s
reconnected in 13 ms and got everything with no gap; after 150 s (past the window) it rejoined its
rooms and started from fresh numbers, also with no gap. A client that stops reading entirely is
dropped after about 43 s (Socket.IO's ping every 25 s plus a 20 s timeout).

---

## 13. The web app

**Stack**: React 19, Vite (build tool), Tailwind CSS 4 (styling), Zustand (small state stores),
TanStack Query (REST fetching and caching), TanStack Virtual (virtualised lists), uPlot (fast time
charts), react-globe.gl on three.js (WebGL globe), Comlink (calling a Web Worker like a normal
object).

**Pages** (a tiny router in `router.ts`, no library):

- `/`: the globe on the right, a sidebar on the left: welcome or sign-in, "Right now" (route
  changes a second, latency, countries, incidents), incidents, busiest countries, trouble spots,
  and folded "More detail" sections (activity, Cloudflare Radar, probe latency, data sources,
  pipeline, control room). Country search (press `/`), a regions menu, a `?` help popover.
- `/c/<CC>`: a country: health, 1-second and per-minute routing charts, latency, its incidents.
- `/incident/<id>`: summary, score, evidence, reachability, timeline, the network's chart.
- `/feed`: the raw feed, filterable by type and country, virtualised, pauses when you scroll down.
- `/ops`: performance: the server's numbers live and minute by minute; admins get replay controls.
- `/me`: your watchlist (countries, networks, minimum severity).
- `/login`: Google sign-in.

**The socket lives in a Web Worker** (`workers/socket.worker.ts`). A Web Worker is a background
thread in the browser; decoding messages and checking sequence numbers there means a burst of
frames can never make scrolling or the globe stutter. The worker hands the page batched updates.

**One render per frame.** The page applies those updates at most once per **animation frame**
(about every 16 ms on a 60 Hz screen), merged into a single store update, so React renders at most
once per frame; in a hidden tab, once a second. The globe re-reads its data every 1.2 s and skips
work while hidden.

**Virtualised lists.** A list of 500 rows only puts the 15 to 20 visible rows into the page; the
rest exist only as data.

**The globe**: countries drawn as hexagon dots coloured by health; Atlas probes as particles
coloured by latency bucket (under 20 ms to over 200 ms, or no reply); rings on the busiest
countries; Cloudflare attack arcs ending at each country's main internet hub; incident markers
that show an icon when facing you and a pulsing dot near the edge. India's outline follows the
Government of India's official boundary.

**Design ("Graphite")**: near-black grey background, grey surfaces, one accent colour (signal
cyan); fonts Michroma (headings), Rajdhani (text), Share Tech Mono (numbers), all self-hosted.
Progressive disclosure: the simple things first, details folded away. Times are shown in your own
time zone (click the clock for UTC).

**The HUD** (press `~` anywhere): frames drawn per second, frames skipped, server frames received,
renders, time to apply an update, long tasks (main-thread work over 50 ms), and the age of each
frame on arrival, corrected for the difference between your clock and the server's (measured with
`/api/time`: the answer with the shortest round trip, assuming the server read its clock halfway).

---

## 14. Accounts, security and limits

**Sign-in is Google only.** The browser gets a signed **ID token** from Google; our server verifies
the signature itself against Google's public keys (JWKS) and the audience (our client ID). No
client secret is needed or stored. Then the server issues its own tokens:

- An **access token**: a **JWT** (JSON Web Token: a signed, tamper-proof bundle of claims such as
  user ID and role), valid **15 minutes**, kept only in the page's memory, sent as
  `Authorization: Bearer ...`.
- A **refresh token**: a random string in an `httpOnly` (JavaScript cannot read it), `Secure`,
  `SameSite=Strict` cookie, valid 7 days, **stored only as a hash** and **rotated** on every use (a
  stolen, already-used token stops working).

**Roles**: visitor (no account; everything public works), user (watchlist, personal alerts), admin
(addresses in `ADMIN_EMAILS`: scenarios, replay, `/metrics`). The `/user` and `/admin` Socket.IO
namespaces check the token during the handshake, before the connection is accepted.

**Validation**: every REST body and query, every socket message and every upstream message is
checked with zod. Socket payloads are treated as unknown until checked.

**Rate limits** (all configurable):

- REST: 100 requests per minute per IP; sign-in 10 per minute per IP.
- New socket connections: 20 per minute per address.
- `sub`, `unsub` and `resync`: a **token bucket** of 5 per second per socket (a bucket refills at a
  steady rate; each message takes a token; an empty bucket means "too fast"); a socket that keeps
  hitting the limit is disconnected.
- At most 20 rooms per socket, one raw-feed room, 64 KB per incoming message.

**Other**: `helmet` sets HTTP security headers; secrets only in `.env` (never committed); the
Docker images run as a non-root user.

---

## 15. Admin features: scenarios, attacks and replay

**Scenarios** (Control room on the home page, admins only) inject simulated events into the live
stream, **now**, so a demo does not have to wait for a real outage. Everything they produce is
marked `simulated`, has its own event IDs (`replay:s<run>:...`), is recorded in `scenario_runs`, and
everyone sees a "SIMULATION" badge.

- **Facebook outage (recorded)**: Facebook's real events from 2021, played at 10x in about two
  minutes: real announcements, the real withdrawals, then simulated re-announcements for recovery.
- **Network outage**: pick a network; its real prefixes are withdrawn by many simulated routers.
- **Route hijack**: a made-up network AS64511 (a number reserved for documentation) announces a
  real network's prefixes, seen at several collectors.
- **Latency surge**: a country's real probes report much higher round-trip times.
- **Probe dropout**: a country's real probes disconnect.
- **Country blackout**: the three biggest networks of a country go down, and its probes slow down
  and drop off. Measured: Germany's networks turned critical in 4.2 s, the country in 5.2 s.

**Replay** (on `/ops`, admins only): the full 8.57-million-event recording at 1x to 50x, optionally
**amplified** (each event played N times, as if N times more routers had reported it) and **lossy**
(sheds like a live feed instead of waiting). Used for load tests.

---

## 16. Watching the system itself: metrics, /ops and the HUD

- **`/metrics`** (admins, or a scraper with `METRICS_TOKEN`): over 300 lines (about 135 of our own
  metrics, the rest Node's process numbers) in the standard
  **Prometheus** text format (a monitoring system that scrapes such pages): events, rejections,
  duplicates, lateness, queue, shed counts, processing delay, window-to-publish delay, MongoDB
  write time, event-loop delay of both threads, memory, sockets, frames and bytes sent, slow
  clients, Node's own process numbers.
- **`ingest_stats`**: the same numbers saved once a minute in MongoDB (7 days), read by
  `/api/ops/history`.
- **The `stats` room**: once a second, for the `/ops` page, open to anyone (no personal data).
- **Event-loop delay** is measured with Node's `monitorEventLoopDelay`. We found that Node's reading
  includes its own sampling interval (an idle loop reads 10 ms at a 10 ms resolution), so the
  interval is subtracted; earlier figures in the benchmarks were corrected.
- **Percentiles** (p50, p95, p99): the value below which 50%, 95% or 99% of measurements fall. p99
  shows the slow cases that averages hide.

---

## 17. How fast it is: measured results

All on one Apple M4 Pro laptop. Full details: `docs/benchmarks.md`; raw results:
`tools/loadtest/results/`.

| Test | Result |
|---|---|
| Live load | 4 RIS collectors + Atlas: about 1,000 to 3,000 events/s; processing p99 1 to 4 ms |
| Ingest thread on vs off (50x replay, 90k events/s) | main thread response p99 0.35 ms vs 1.21 ms |
| T1, ingest throughput | up to 1.35 million events/s through the whole pipeline, nothing shed; the file reader is the limit |
| T2, fan-out | 100 to 2,000 clients all connected, 0 gaps or duplicates; delivery p99 10 ms at 100, 62 ms at 2,000 (load generator on the same machine); about 2 KB/s per client |
| T3, soak | 30 minutes, 500 clients: 0 gaps or disconnects; memory grows for 10 minutes (the deduper, bounded) then creeps slowly (a 2-hour run is pending) |
| T5, optimisations | bytes per client: all on 1,565/s; JSON x1.4; every frame to everyone x1.5; conflation off x3.6; all off x4.7 |
| T6, chaos | upstream cut: feed back 8.2 s after the network; client offline 30 s: recovered, no gap; server `kill -9`: answering in 0.27 s, all clients back in 0.79 s, no duplicate documents |
| Detection | Germany blackout: networks critical in 4.2 s, country in 5.2 s |
| Delivery size | MessagePack 40% smaller than JSON on live data |

---

## 18. Tools around the app

- **`tools/capture`**: records the live RIS and Atlas streams to NDJSON and measures their rates
  (Phase 0). Its numbers set our lateness and collector choices.
- **`tools/replay-prep`**: reads RIPE's MRT archive files and writes our event format; also cuts the
  small Facebook scenario file.
- **`tools/loadtest`**: a fleet of Socket.IO clients that behave like browser tabs (check every
  frame's sequence, time its delivery, count bytes), a once-a-second sampler of `/metrics`, a replay
  driver, `--loop` for long soaks, and a WebSocket **relay** used to cut the server's upstream in
  the chaos test.

---

## 19. Running it

Needs Node 22.18+ and pnpm 11.28.9 (`corepack enable`), Docker for MongoDB.

```bash
pnpm install
```

```bash
docker compose up -d mongo
```

```bash
pnpm dev
```

The app is at http://localhost:5173 (API on :3000). Checks before every commit:
`pnpm lint`, `pnpm typecheck`, `pnpm test`. Full stack in Docker: `docker compose --profile demo up
--build` (recorded data) or `--profile live` (real feeds), at http://localhost:8080.

Important settings in `.env` (see `.env.example`): `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS`,
`JWT_SECRET`, `CLOUDFLARE_API_TOKEN`, `MONGODB_URI`, `RIS_COLLECTORS`, `INGEST_THREAD`,
`INGEST_QUEUE_MAX`, `SOCKET_PARSER`, `CONFLATE_MS`, `BROADCAST`, `SLOW_CLIENTS`, `METRICS_TOKEN`.

---

## 20. Known problems and what is left

Known problems:

1. A server restart splits an ongoing incident in two (the open one is closed at startup, the same
   outage opens a new one about 30 s later).
2. The server's byte counter reads about 19% below what clients receive at 2,000 clients.
3. Possible slow memory growth after the first 10 minutes (a 2-hour soak will tell).
4. The origin table only knows prefixes seen since start (no full routing-table snapshot).

Left to do for the hackathon: hosting (Railway + MongoDB Atlas), the README with the eight
required sections, the architecture document, the 3 to 5 minute video, and the planned extras (an
onboarding overlay, the probe agent CLI with detectors D5 and D7). The by-hand checks are listed
in `docs/manual-checks.md`.

---

## 21. Glossary

- **Allowed lateness**: how long a window waits for late events before closing (5 s routing, 240 s
  Atlas).
- **Announcement**: a BGP message saying "you can reach this prefix through me".
- **AS / ASN**: Autonomous System, one independently run network, and its number.
- **AS path**: the chain of networks a route passes through; the last one is the origin.
- **Backoff (exponential, with jitter)**: waiting longer after each failed retry, randomised.
- **Backpressure**: slowing a producer down because the consumer cannot keep up.
- **BGP**: Border Gateway Protocol, how networks tell each other which addresses they can reach.
- **Botnet**: many hacked devices controlled together, used for DDoS.
- **Bucket pattern**: one database document per time range (an hour) holding many readings.
- **CIDR**: notation for address blocks (`157.240.0.0/16`).
- **Collector (route collector)**: a router that peers with many networks and records what they
  send (`rrc00` ...).
- **Conflation**: merging many changes into one message per interval.
- **DDoS**: Distributed Denial of Service, overwhelming a service from many machines at once.
- **Dedupe**: dropping events already seen.
- **Delta**: only the change, not the whole state.
- **DNS**: the system that turns names into IP addresses.
- **EWMA**: exponentially weighted moving average.
- **Event loop**: how Node.js runs one task at a time; its delay shows how busy it is.
- **Event time / ingest time**: when something happened / when we received it.
- **Firehose**: the raw stream of individual events.
- **Hijack (BGP)**: announcing addresses that belong to someone else.
- **Idempotent**: doing it twice has the same effect as once.
- **IXP**: Internet Exchange Point, where many networks connect.
- **JWT**: JSON Web Token, a signed bundle of claims used as an access token.
- **Latency / RTT**: time to travel; round-trip time.
- **Layer 3 / 4 / 7**: network (IP), transport (TCP/UDP) and application (HTTP) layers.
- **Leak (route leak)**: re-announcing routes that should have stayed private.
- **MAD**: median absolute deviation, a robust measure of spread.
- **MessagePack**: a compact binary alternative to JSON.
- **MRT**: the file format route collectors archive updates in.
- **Namespace / room (Socket.IO)**: a separate channel / a group of sockets to send to.
- **NDJSON**: one JSON object per line.
- **Origin AS**: the network that owns and announces a prefix.
- **p50, p95, p99**: percentiles: half, 95% or 99% of values are below this.
- **Packet loss**: data (a ping) that never arrived.
- **Peer**: a network exchanging BGP routes with another (or with a collector).
- **Ping**: an echo request used to measure round-trip time.
- **Prefix**: a block of IP addresses.
- **Probe (RIPE Atlas)**: a small device that runs measurements from someone's network.
- **Prometheus**: a monitoring system that scrapes numbers from `/metrics` pages.
- **Reservoir sampling**: picking a fair random sample of fixed size from a stream of unknown
  length.
- **Resync**: asking the server to re-send frames after a gap.
- **RIR**: Regional Internet Registry (ARIN, RIPE NCC, APNIC, LACNIC, AFRINIC).
- **RIS / RIS Live**: RIPE's Routing Information Service, and its live stream.
- **Root servers**: the 13 named servers at the top of DNS.
- **Scope**: what a number is about: `world`, `country:IN`, `asn:32934`.
- **Sequence number**: a frame's position in its room's stream.
- **Shedding**: dropping low-priority work under overload.
- **Token bucket**: a rate limiter that refills tokens at a steady rate.
- **TTL index**: a MongoDB index that deletes documents after a date.
- **Tumbling window**: fixed, back-to-back, non-overlapping time buckets.
- **Volatile emit**: a Socket.IO message that is dropped if the client cannot take it now.
- **Watermark**: the point in event time before which no more events are expected.
- **Web Worker / worker thread**: a background thread in the browser / in Node.js.
- **Withdrawal**: a BGP message saying "I can no longer reach this prefix".
- **WebSocket**: a long-lived two-way connection between browser and server.
- **zod**: a TypeScript library for checking that data has the expected shape.
