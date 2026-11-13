# ins-capture

Connects to the real feeds, validates and counts every message, and (optionally) records them.
We use it to measure real event rates instead of guessing, and to produce recorded traffic for
replay and stress tests.

## What it connects to

| Stream         | Subscription                                                     | Recorded |
| -------------- | ---------------------------------------------------------------- | -------- |
| `ris-full`     | RIS Live, every collector, every message type                    | yes      |
| `ris-filtered` | RIS Live, one collector (`--ris-host`, default `rrc00`), UPDATEs | no       |
| `atlas`        | RIPE Atlas ping results (`--msm`) plus probe connect/disconnect  | yes      |

`ris-filtered` is measured but not recorded, because it is a subset of `ris-full`.

## Run it

From the repository root:

```bash
pnpm capture --minutes 10 --no-record   # measure only
pnpm capture --minutes 30               # measure and record to deploy/seed/capture/
```

Options: `--minutes`, `--out <dir>`, `--no-record`, `--ris-host rrc00`, `--msm 1001,1008,1006`,
`--client <name>` (RIS Live asks clients to identify themselves), `--report-seconds 10`.

Every 10 seconds it prints messages, events and kilobytes per second for each stream, and the
process's memory. At the end it prints a JSON summary and, when recording, writes it next to the
data as `summary-<start>.json`.

## What it measures

- **messages vs. events**: one RIS message can mention many prefixes; our pipeline turns each prefix
  into its own event, so both numbers are reported.
- **lag**: receive time minus the message's own timestamp, as p50/p95/p99. This sets the watermark
  (how long a time window must stay open for late data).
- **out of order**: messages older than one already seen, and how far behind they were.
- **invalid / unparseable**: messages that fail the zod schemas in `packages/shared/src/upstream.ts`.
- **upstream warnings, reconnects**: the feed complaining, or dropping the connection.
- **process**: peak memory, average CPU, event-loop delay.

## Output format

Gzipped NDJSON, one line per message: `{"its": <our receive time in ms>, "m": <message as received>}`.
The files are large and are not committed (`deploy/seed/capture/` is in `.gitignore`); run the
command above to regenerate them.

Data: RIS Live and RIPE Atlas are services of the RIPE NCC.
