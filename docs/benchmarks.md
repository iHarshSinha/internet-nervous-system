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
