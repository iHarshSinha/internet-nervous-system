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

Filled in when the recording finishes.
