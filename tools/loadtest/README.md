# loadtest

Load tests for the server: a fleet of Socket.IO clients, a once-a-second sampler of the server's
own numbers, and a driver for the replay (the load source).

```bash
# against your own dev server (it must allow many connections from one address)
JWT_SECRET=<the server's> pnpm --filter @ins/loadtest loadtest run --clients 500 --speed 50

# or the whole thing in Docker (server on recorded data + the fleet)
JWT_SECRET=<anything> LOADTEST_ARGS="--clients 500 --speed 50" \
  docker compose --profile loadtest up --build --exit-code-from loadtest loadtest server-loadtest mongo
```

`pnpm loadtest --help` lists every option. A run writes `results/<name>.json`: the settings, the
clients' totals and the server's timeline (one sample per second).

## What it measures

**Clients (`src/swarm.ts`).** Each client behaves like a browser tab: WebSocket, the server's wire
format (it asks `/api/realtime`), joins `world`, `incidents`, `arcs` and one of the ten busiest
countries (one in ten also watches the raw feed with `--feed`). Every frame is checked for its
sequence number (gaps and duplicates are counted; a slow-client summary covering `f`..`s` is
fine) and timed: delivery = time received + clock offset to the server - the frame's server
stamp. Bytes are what arrives on the wire. After a long disconnect a client rejoins its rooms, as
the web app does.

**Server (`src/server.ts`).** Reads `/metrics` once a second: events in and processed per second,
queue depth and fill, sampling ratio, shed and overflow, processing delay p99, event-loop delay
of both threads, CPU (% of one core, all threads), memory, bytes and frames sent, sockets, slow
clients.

**Load (`--speed`, `--amplify`, `--lossy`).** The Facebook outage recording replayed at up to
50x; `--amplify N` plays each event N times as if N times as many routers had reported it;
`--lossy` makes it shed like a live feed instead of pausing when the queue fills.

## Things to know when reading results

- All clients run in this one Node process. Delivery delay includes this process's own event
  loop, so at thousands of clients part of the delay is the load generator, not the server. Run
  the fleet on a second machine (or several fleets) to separate the two.
- The server limits new connections per address (`SOCKET_CONNECTIONS_PER_MIN`); raise it for the
  test, as the `loadtest` Compose profile does.
- Admin access: `LOADTEST_TOKEN` (an admin access token) or `JWT_SECRET` (signs one; only for a
  server you run).

Why not Artillery (named in the plan): its Socket.IO engine cannot use our MessagePack parser
and does not check sequence numbers, and those are what these tests are about.

## Other commands

- `--loop` restarts the replay whenever it finishes (the recording lasts 6 minutes at 10x), for
  long soak tests.
- `pnpm loadtest relay --port 3901 --target wss://ris-live.ripe.net` is a WebSocket relay for the
  chaos test: start the server with `RIS_URL=ws://localhost:3901/v1/ws/?client=<name>`, then stop
  and start the relay to cut and restore the server's upstream.
- `pnpm loadtest replay start|stop|status` and `pnpm loadtest sample` drive the replay and print
  the server's numbers without any clients.
