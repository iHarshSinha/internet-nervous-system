# Benchmarks

Every number here was measured, with the command that produced it. Nothing is estimated.

## Phase 0 measurements: real upstream event rates

**Run:** 13 Nov 2026, 08:47–08:57 UTC, 600 seconds. `pnpm capture --minutes 10 --no-record`
(`tools/capture`). MacBook (darwin/arm64), Node v22.23.5, home connection measured at about
9 MB/s download. All three streams ran at the same time in one process.

### Rates

| Stream | Subscription | Messages/s (avg) | Messages/s (peak 10 s) | Events/s (avg) | Events/s (peak 10 s) | KB/s | Largest message |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ris-full` | RIS Live, all collectors, all types | 674.3 | 1,515.3 | 1,835.1 | 7,451.9 | 308.0 | 18,862 B |
| `ris-filtered` | RIS Live, collector `rrc00`, UPDATE only | 538.3 | 2,263.3 | 1,464.6 | 7,887.7 | 229.2 | 18,862 B |
| `atlas` | Atlas pings 1001, 1008, 1006 + probe status | 179.1 | 222.8 | 179.1 | 222.8 | 75.7 | 22,918 B |

"Events" counts one per prefix: a RIS UPDATE that announces or withdraws several prefixes becomes
several events in our pipeline. On average one RIS message carried 2.7 prefixes.

Totals: `ris-full` 404,610 messages (401,774 UPDATE, 2,091 KEEPALIVE, 707 STATE, 25 OPEN,
13 NOTIFICATION) from 23 collectors. `atlas` 107,281 ping results, 95 probe connects, 82 disconnects.

### Validation

| Stream | Messages | Failed schema | Not JSON | Upstream warnings |
| --- | --- | --- | --- | --- |
| `ris-full` | 404,610 | 0 | 0 | 0 |
| `ris-filtered` | 322,993 | 0 | 0 | 0 |
| `atlas` | 107,458 | 0 | 0 | 0 |

The zod schemas in `packages/shared/src/upstream.ts` accepted every one of 835,061 real messages.

### Lag (our receive time minus the message's own timestamp)

| Stream | p50 | p95 | p99 | Reconnects in 10 min |
| --- | --- | --- | --- | --- |
| `ris-full` | 35.7 s | 69.7 s | 83.8 s | 7 |
| `ris-filtered` | 35.7 s | 84.3 s | 84.3 s | 8 |
| `atlas` | 69.7 s | 135.7 s | 1,470.7 s | 0 |

### Capture process

| Peak RSS | Peak heap | Average CPU (one core = 100%) | Event-loop delay p99 | Event-loop delay max |
| --- | --- | --- | --- | --- |
| 116 MB | 20.5 MB | 3.8% | 11.75 ms | 20.46 ms |

This is the cost of receiving, parsing, validating and counting only. It is a floor for the server,
not a prediction of it.

### What the numbers tell us

1. **A busy RIS Live subscription falls behind and gets disconnected.** Both RIS connections showed
   the same cycle: lag climbed steadily to about 84 seconds, the server closed the connection
   (WebSocket code 1006), we reconnected, and it started again. That happened 7 and 8 times in ten
   minutes. Our process was not the bottleneck (3.8% CPU, 12 ms event-loop delay p99, a 9 MB/s line
   carrying about 0.6 MB/s).
2. **The unfiltered stream is not complete.** In the same ten minutes the unfiltered connection
   delivered 47,564 messages from `rrc00`; the connection filtered to `rrc00` delivered 322,993.
   The unfiltered stream therefore carried about 15% of that collector's messages.
3. **Each connection seems to deliver roughly 500–700 messages per second.** Two 60-second follow-up
   tests with single-collector filters (`rrc00`, `rrc21`) delivered 485 and 498 messages per second.
   In one of them lag stayed near 4 seconds; in the other it grew to 32 seconds.
4. **RIS Live was partly unhealthy during the run.** Connection attempts were answered with
   HTTP 502 several times. We do not know yet whether points 1–3 are normal behaviour or a
   bad day. This needs a second run on another day before we rely on it.
5. **Atlas is steady and slow by design.** About 180 results per second with no reconnects and no
   warnings. Half of the results are more than 70 seconds old when they arrive and 5% are more
   than 136 seconds old, because probes report in batches. One result was 6.9 days old.
6. **Some Atlas timestamps are in the future.** At least one probe reported a time hours ahead of
   ours, which made almost every later result look late in this run's ordering statistics. The
   capture tool now sets such messages aside and counts them (`futureTimestamps`). Atlas ordering
   numbers from this run are therefore not reported; see the 30-minute run below.

### Consequences for Phase 1

- Do not subscribe to the unfiltered firehose. Open several RIS connections with narrow filters
  (per collector, and by message type) and keep each one under the rate it can sustain.
- Measure lag per connection continuously and treat rising lag as upstream backpressure: it is the
  early warning before a disconnect.
- Reconnect logic is not optional. It ran 15 times in ten minutes here.
- The watermark must ignore timestamps ahead of the server clock, or one bad probe stalls or
  corrupts every window.
- The plan's allowed lateness for Atlas (2 minutes) is close to the measured p95 (136 s); about 5%
  of results would arrive after their window closed. Either widen it to about 3 minutes or accept
  and count those as late.
- RIS ordering inside a connection: 97.7% of messages on the unfiltered stream were older than one
  already seen (collectors interleave), by 1.3 s at the median and 4.0 s at p99. The plan's
  5-second lateness for BGP covers that.

## Phase 0 recording: 30 minutes of real traffic

**Run:** 13 Nov 2026, 08:59–09:29 UTC, 1,800 seconds. `pnpm capture --minutes 30`, same machine.
This run also wrote the recordings used for replay and stress tests, and `tools/replay-prep` ran on
the same machine for part of it.

| Stream | Messages | Messages/s (avg) | Events/s (avg) | Events/s (peak 10 s) | Lag p50 | Lag p95 | Lag p99 | Reconnects | Failed schema |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ris-full` | 1,005,394 | 558.5 | 1,432.5 | 3,708.1 | 43.2 s | 92.7 s | 180.7 s | 23 | 0 |
| `ris-filtered` (`rrc00`) | 1,101,620 | 612.0 | 1,386.7 | 4,841.3 | 4.0 s | 32.5 s | 149.3 s | 4 | 0 |
| `atlas` | 320,641 | 178.1 | 178.1 | 296.4 | 69.7 s | 123.4 s | 198.7 s | 0 | 0 |

Process: peak RSS 113.6 MB, peak heap 24.6 MB, average CPU 6.2% of one core (this run also
gzipped two files), event-loop delay p99 11.8 ms, max 40.4 ms. Memory stayed flat for 30 minutes.

Recorded files (not committed; regenerate with the command above):

| File | Size | Contents |
| --- | --- | --- |
| `deploy/seed/capture/ris-full-20261113T085859Z.ndjson.gz` | 33.0 MB | 1,005,394 RIS messages |
| `deploy/seed/capture/atlas-20261113T085859Z.ndjson.gz` | 19.0 MB | 320,641 Atlas messages |

### What the longer run adds

1. **The filter is what keeps a RIS connection healthy.** The connection filtered to one collector
   had a median lag of 4.0 seconds and 4 reconnects in 30 minutes. The unfiltered one had a median
   lag of 43.2 seconds and 23 reconnects. This confirms the first run's conclusion with three times
   the data, though still on the same day.
2. **The unfiltered stream is a thin sample.** It delivered 97,825 messages from `rrc00` while the
   filtered connection delivered 1,101,620: about 9%.
3. **One collector alone is about as much as one connection carries.** `rrc00` averaged 612
   messages per second (1,387 events per second) and still lagged at times (p95 32.5 s).
4. **Atlas lateness, measured properly this time.** 727 results (0.23%) carried timestamps more
   than a minute ahead of our clock and were set aside. Of the rest, a result arrived a median of
   102 s behind the newest timestamp already seen, 164 s at p95 and 240 s at p99. An allowed
   lateness of 2 minutes would mark roughly half of Atlas results as late; **about 4 minutes
   covers 99%.** The plan's 2-minute figure needs to change.
5. **Schemas held.** All 2,427,655 messages in this run passed validation.

## Phase 0: Facebook outage replay file

`pnpm replay-prep` (13 Nov 2026). RIS update files for 4 Oct 2021, 15:20–16:30 UTC, collectors
`rrc05`, `rrc10`, `rrc11`, `rrc14`. Full per-minute data is in
`deploy/seed/replay/facebook-20211004.summary.json`.

| Measure | Value |
| --- | --- |
| MRT records read | 3,196,459 (0 malformed, 19,349 skipped as not updates) |
| Events written | 8,569,494 (7,536,132 announcements, 1,028,937 withdrawals, 4,425 peer state changes) |
| Output size | 88.6 MB gzipped |
| Average rate at 1× | about 2,040 events per second (8,569,494 events over 70 minutes) |
| AS32934 prefixes seen announced | 175 |
| AS32934 withdrawals per minute, 15:20–15:39 | 0 in every minute except 15:30 (2) |
| First AS32934 withdrawals of the burst | 15:40 UTC (12 withdrawals, 3 prefixes) |
| First minute with at least 20 AS32934 prefixes withdrawn | 15:42 UTC (378 withdrawals, 25 prefixes) |
| Peak minute | 15:43 UTC (769 withdrawals, 27 prefixes) |

Withdrawals are attributed to AS32934 only for prefixes the tool had already seen announced by it
in this window, so these counts are a lower bound.

## Phase 1: storage, first measurements

**Run:** 13 Nov 2026, about 10:23–10:33 UTC, `pnpm dev` with the Docker `mongo:8` container, four RIS
collectors and three Atlas measurements. Collection sizes from `db.<collection>.stats()`.

| Collection | Documents | Data | Storage (compressed) | Indexes |
| --- | --- | --- | --- | --- |
| `asn_ranges` | 103,403 | 4.83 MB | 1.14 MB | 1.09 MB |
| `probes` | 17,910 | 1.63 MB | 0.57 MB | 0.20 MB |
| `metrics_hourly` (after about 6 stored minutes) | 848 | 0.13 MB | 0.07 MB | 0.13 MB |

- Reference data: the first download (five registry files plus 36 pages of probes) took about
  40 seconds; later restarts load it from MongoDB.
- One minute of routing touched the world, 104 countries and 579 networks (the 300 busiest are
  stored per family per minute). A bulk write of one minute's documents took 9–28 ms.
- Pipeline over the run: 235,977 events received, 235,602 counted, 3 duplicates dropped, 316 late,
  56 with timestamps from the future.

`metrics_hourly` will grow with every hour until its TTLs start deleting. **Not yet measured:** its
size after a full hour and after the 2–3 day retention. That decides whether MongoDB Atlas M0
(512 MB) is enough; re-measure after a long run before deploying.

## Phase 1: live rooms

**Run:** 13 Nov 2026, `pnpm dev` on live data (four RIS collectors, three Atlas measurements). One
Socket.IO client subscribed to `world`, `country:US`, `country:BR` and `country:DE` for 75 seconds,
then fetched `GET /api/history` for the same rooms. JSON encoding (MessagePack comes in Phase 3).

| Room | Frames | Frames/s | Gaps | Bytes/s | Deltas per frame | 1 s points overlapping history | Mismatches |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `world` | 103 | 1.4 | 0 | 0.93 KB | 32.0 | 75 | 0 |
| `country:US` | 70 | 0.9 | 0 | 0.10 KB | 1.1 | 75 | 0 |
| `country:BR` | 70 | 0.9 | 0 | 0.10 KB | 1.1 | 75 | 0 |
| `country:DE` | 70 | 0.9 | 0 | 0.10 KB | 1.1 | 75 | 0 |

Every 1-second point that arrived live and also appeared in the history response had identical
values. `resync` for the last three frames of `country:US` returned exactly frames 68, 69 and 70.

## Phase 2: detection

**Tuning run:** the 30-minute recording of 13 Nov 2026 (`ris-full-*.ndjson.gz`, sampled firehose)
replayed through the real pipeline, detectors and incident manager on its own clock (about 20 s of
CPU). First thresholds opened 19 incidents, mostly small networks whose few known prefixes flapped
(after a restart we only know prefixes seen since start). Requiring 20 different routers to withdraw
a prefix before it counts as gone, 20 routers reporting, 3 collectors for a new origin, and reopening
an incident instead of opening a new one brought it to **4 incidents**, all warnings: two possible
hijacks (6 and 31 prefixes at a new origin, 13 and 5 collectors) and two small networks whose every
known prefix was withdrawn by 29–32 routers.

**Facebook scenario (recorded data, 10×):** in the test on a simulated clock a critical incident for
AS32934 opens 12.7 s after the first withdrawal and resolves after the simulated recovery. Live
(13 Nov 2026, dev server): the incident opened 24 s after the trigger, with 1,735 withdrawals in a
minute seen by 105 routers.

**Attack simulator, live (14 Nov 2026):** country blackout on DE (its three largest networks in our
table, every German Atlas probe): AS29066, AS8881 and AS60664 critical **4.2 s** after the trigger
(storm + vanished), `country:DE` critical **5.2 s** after (storm + latency + dropout).

## Phase 2: Cloudflare Radar

First poll (14 Nov 2026): 7 days of outage annotations and traffic anomalies plus a day of hijacks
and leaks returned 60 events and 40 attack pairs (20 layer 7, 20 layer 3). Route leaks were the
bulk and most were seen by one or two peers, so only leaks seen by at least 10 peers are kept.
Hijacks are requested with `minConfidence=8`: about 50 in 7 days. Each poll is 4 requests every
3 minutes plus 2 every 15 minutes, far below Cloudflare's API limits.

## Phase 3, step 1: ingest in its own worker thread

The upstream feeds, the pipeline, the detectors and the replay player now run in a worker thread
(`apps/server/src/ingest/worker.ts`). The main thread keeps Express, Socket.IO and MongoDB and
talks to the ingest side through `ingest/link.ts` (messages defined in `ingest/protocol.ts`).
`INGEST_THREAD=off` runs the same code in the main thread over a `MessageChannel`, which is how
the comparison below was made.

Setup: Apple M4 Pro (12 cores, 24 GB), Node 22.23, local MongoDB in Docker, a separate database,
`NODE_ENV=production`, live feeds off. The Facebook outage file replayed at 50x while a client sent
`GET /healthz` back to back for 30 s. `/healthz` does no work, so its timing is the main thread's
own responsiveness.

| | Ingest thread on | Ingest thread off |
|---|---|---|
| Replay throughput through the pipeline | 90,681 events/s | 90,569 events/s |
| `/healthz` p50 | 0.09 ms | 0.09 ms |
| `/healthz` p95 | 0.15 ms | 0.31 ms |
| `/healthz` p99 | 0.35 ms | 1.21 ms |
| `/healthz` slowest | 3.7 ms | 16.5 ms |
| Requests answered in 30 s | 280,594 | 208,206 |
| Idle `/healthz` p99, before the replay | 0.47 ms | 0.44 ms |

So at 90k events/s the main thread's p99 stays at idle level with the thread, and is 3.5 times
worse without it (and the slowest request 4.5 times worse). Throughput is the same either way; at
50x the pipeline is not yet the limit. Higher speeds and Socket.IO fan-out are T1 and T2.

A request from the main thread into the ingest thread (for example "which prefixes does this
network announce", used by the attack simulator) takes 0.010 ms at the median and 0.113 ms at p99
(200 calls, idle). On the live feeds (four RIS collectors and Atlas, a few minutes after start) the
ingest thread's JavaScript heap was 66 MB, the whole process 328 MB RSS, and the ingest thread's
event-loop p99 delay about 12 ms. (RSS is per process; only the heap is per thread.)

## Phase 3, step 2: bounded queue, sampling and shedding

Every source now goes through one bounded queue in the ingest thread
(`apps/server/src/ingest/pipeline/queue.ts`): connectors parse, validate and normalise, offer the
events, and return; the pipeline drains the queue in slices of up to 8 ms, so socket reads keep
interleaving. Pressure levels: below 70% everything gets in; 70-95% everything gets in and the raw
feed sampling ratio k doubles each second (halves again below 50%); 95-100% route announcements
are shed; 100-120% only withdrawals and probe status get in (a reserve, because outage detection
needs them); at 120% everything is refused and counted as overflow. Live feeds cannot wait, so they
shed. A file (the replay) can wait: the player pauses reading until the queue is half empty and
then re-anchors its clock, so nothing is lost and nothing is stamped late.

Per-event cost, measured on 300,000 recorded RIS messages (796,603 events), one core:
parse + zod + normalise 2.87 us per message (about 920,000 events/s); dedupe + windows + origin
table + detectors 1.72 us per event (about 580,000 events/s on this sample).

To load the pipeline beyond the 50x replay, the replay can now `amplify`: each recorded event is
played N times with its own event ID, as if N times as many routers had reported it. Runs of 25 s
on the Facebook outage window at 50x, same machine as step 1:

| Run | Queue | Offered/s | Processed/s | Shed/s | Max fill | Longest wait | Notes |
|---|---|---|---|---|---|---|---|
| 1x, waits (default) | 100,000 | 91,937 | 91,937 | 0 | 1.3% | 7 ms | |
| 10x amplified, waits | 100,000 | 913,567 | 913,567 | 0 | 13.3% | 13 ms | |
| 10x amplified, lossy | 100,000 | 917,629 | 917,629 | 0 | 13.0% | 51 ms | |
| 10x amplified, waits | 5,000 | 643,773 | 643,789 | 0 | 82.8% | 9 ms | 2,384 pauses, nothing lost |
| 10x amplified, lossy | 5,000 | 920,860 | 706,578 | 197,468 | 111.6% | 14 ms | shed: 5.22 M announcements, 1,930 peer-state; 446,830 overflow |

What this shows:

- With the default queue the ingest thread processes over 910,000 events a second (about 300 times
  the live rate of about 3,000) and the queue never passes 14%. The reader and the pipeline share
  the thread, so the reader only runs when the pipeline yields: that self-limits the queue.
- With the queue shrunk to 5,000 events to force overload, a file source pauses instead of losing
  anything, and a live-like source sheds route announcements first. In the Facebook window,
  withdrawals alone (amplified 10x) exceeded the queue plus its reserve, so the hard limit also
  refused events; that is counted as overflow and shown, never silent.
- No event was late in any run (`lateMinute` stayed 0).
- On the live feeds (four RIS collectors and Atlas) the queue's deepest point in the first minutes
  was 846 events, with nothing shed.

## Phase 3, step 3: delivery (MessagePack, firehose, slow clients, joiner state)

**MessagePack vs JSON.** A separate server on the live feeds (four RIS collectors and Atlas), 50
clients each in `world`, `incidents`, `arcs`, `country:US` and `country:DE`, 30 s per run after a
60 s warm-up, bytes counted where Engine.IO writes them (`/api/status` `delivery`). Runs
alternated, two each:

| Parser | Bytes per client per second | Frames per client per second | Bytes per frame |
|---|---|---|---|
| JSON | 3,808 / 3,505 (mean 3,657) | 2.97 / 3.30 | 1,282 / 1,062 |
| MessagePack | 2,228 / 2,176 (mean 2,202) | 2.37 / 2.77 | 940 / 786 |

MessagePack sent 40% fewer bytes per client per second and about 26% fewer per frame. The frame
counts differ between runs because the live traffic did. Conflation (500 ms) was on in all runs; at
these settings one client costs about 2.2 KB/s.

**Joiner state instead of a room-wide re-send.** Before this step, a client joining a room made the
broadcaster forget what it had sent there, so the next frame re-sent every current value to every
member. On the live server the `world` room holds 14,775 current values (277,933 bytes as JSON,
mostly per-probe latency buckets), so every page load cost every other viewer about 278 KB, which
grows with the square of the number of clients. Now the joiner gets those values once in its `sub`
acknowledgement and nobody else gets anything.

**Firehose.** On the live feeds, `feed:*:*` matched 1,395 events/s and sent exactly 20/s;
`feed:atlas.ping:DE` matched 27/s and sent 17.8/s (some quarter seconds had fewer than five).

**Slow clients.** A client in 20 busy rooms stopped reading its socket for 40 s and then resumed:
it received all 383 buffered frames with no gaps, and was not downgraded, because at about 2 KB/s
the operating system's socket buffers on localhost absorbed the stall (the server's own backlog,
which the detector reads, never grew). With conflation switched off (about 200 frames/s) a 25 s
stall was also absorbed. Downgrade, summaries and recovery are covered by an integration test that
stands in for the backlog reading (`server.test.ts`, "slow clients"); they matter on genuinely slow
links, where the client's TCP window stays closed.

A 90 s stall (conflation off) ended differently: after resuming, the client received frames at the
normal rate (525 in 4 s) rather than a 90 s backlog, still with no sequence gap. The likely cause
(not confirmed from logs) is Socket.IO's heartbeat: a client that does not answer pings for about
45 s (25 s interval + 20 s timeout) is disconnected and its buffers freed; on resume it reconnects
and connection-state recovery restores its rooms.

## Phase 3, step 4: client render budget

The page applies live updates at most once per animation frame, merged into one store update (one
React render), and once a second while the tab is hidden; the globe skips rebuilding its layers
while hidden. Long lists are virtualised (TanStack Virtual): the raw feed (`/feed`, 500 rows kept)
and Activity (200 kept). `window.__perf()` reports painted frames, updates applied, apply time and
long tasks; the HUD (step 6) will show the same numbers.

Measured in the Claude browser pane (Chrome 156) on live data:

- Raw feed, withdrawals only, after 20 s: 500 rows in the list (20,034 px tall), 20 rows in the
  DOM. Applying an update took 0.1 ms at the median and at most 0.2 ms; no long tasks; 117 frames
  painted per second (the pane was not throttling at that moment).
- Globe page, 10 s: the pane throttled animation frames to about 1 per second, so the 2-3 server
  frames arriving each second were applied together as one update; apply time at most 1.9 ms. One
  long task (87 ms) since page load, most likely the globe building its layers.
- On a 375 px wide phone viewport the feed page has no horizontal scroll (page width 375 px).

Frame rate on a normal laptop during a 50x replay is load test T4 and must be measured in a real
Chrome window (the pane throttles animation frames).
