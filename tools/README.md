# tools

Command-line tools that live beside the app. Each one becomes its own workspace package.

| Tool          | Purpose                                                        | Phase |
| ------------- | -------------------------------------------------------------- | ----- |
| `capture`     | Record live RIS and Atlas streams to NDJSON and measure rates  | 0     |
| `replay-prep` | Convert RIS MRT files (Facebook outage window) to NDJSON       | 0     |
| `loadtest`    | Artillery configs and a Node Socket.IO client swarm            | 3     |
| `probe-agent` | The `ins-probe` CLI that posts checks to `POST /api/ingest`    | 4     |
