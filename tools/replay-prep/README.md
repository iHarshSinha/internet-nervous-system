# ins-replay-prep

Turns archived internet routing data into a file our replay source can play back through the
pipeline. The default is the Facebook outage of 4 October 2021.

## What it does

1. Downloads RIS "updates" files (one per collector per 5 minutes) from
   `https://data.ris.ripe.net/<collector>/<YYYY.MM>/updates.<YYYYMMDD>.<HHmm>.gz`.
2. Decodes them with our own small MRT reader (`src/mrt.ts`, RFC 6396). No external parser is needed.
3. Converts every announced or withdrawn prefix into one event in our envelope (`src: "replay"`).
4. Writes one time-ordered, gzipped NDJSON file plus a small summary.

## Run it

From the repository root:

```bash
pnpm replay-prep
```

That downloads about 67 MB and writes `deploy/seed/replay/facebook-20211004.ndjson.gz`
(about 89 MB, 8.57 million events). Neither is committed; this command regenerates them, and
downloads are cached in `deploy/seed/replay/mrt/`. The summary
(`facebook-20211004.summary.json`) is committed as evidence of what the file contains.

Options: `--collectors rrc05,rrc10,rrc11,rrc14`, `--date 20211004`, `--from 1520`, `--to 1630`,
`--name <output name>`, `--watch-asn 32934`.

## Things worth knowing

- **Event IDs are deterministic** (`replay:<collector>-<file>-<record>#<part>`), so converting or
  replaying twice produces the same IDs and can never create duplicates.
- **Withdrawals do not say who owned the prefix.** A BGP withdrawal carries only the prefix. The
  pipeline has to remember the origin from earlier announcements. The tool does the same to print
  its check, which is why its Facebook numbers count only prefixes it had seen announced.
- **Timestamps have one-second resolution** in these 2021 files, so many events share a timestamp.
- **The check:** the tool prints, per minute, withdrawals of prefixes originated by `--watch-asn`.
  For AS32934 the burst starts at 15:40 UTC and the first minute with at least 20 distinct prefixes
  withdrawn is 15:42 UTC, as seen from these four collectors.

Data: RIS raw data is provided by the RIPE NCC.
