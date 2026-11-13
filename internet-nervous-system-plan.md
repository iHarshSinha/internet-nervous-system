# Internet Nervous System: plan summary (MERNIFY 2026)

Full plan (editable doc): https://claude.ai/artifact/2PbeaagNryMeTktuTwchj9
Coding happens in Claude Code. The repo carries CLAUDE.md, docs/PLAN.md (an export of the plan doc), docs/KICKOFF.md (session prompts) and the problem statement PDF.

## Decision
Build "Internet Nervous System" for the MERNIFY High-Throughput Streams & Telemetry track: a live 3D globe that fuses internet routing, latency and attack signals, detects outages and hijacks, and explains them. The goal is to cover every core requirement and every bonus point, and show each one in the video.

## Data sources
- RIS Live (RIPE NCC), BGP updates over WebSocket: wss://ris-live.ripe.net/v1/ws/?client=<name>
- RIPE Atlas streaming over plain WebSocket, wss://atlas-stream.ripe.net/stream/: built-in root-server pings (1001, 1008, 1006, ...), traceroutes (5000–6999), probestatus
- Cloudflare Radar API, polled with a free token: attack pairs, BGP hijacks and leaks, outages, traffic anomalies (data licensed CC BY-NC 4.0)
- Replay of the 4 Oct 2021 Facebook outage (AS32934, ~15:39 UTC) from RIS MRT update files, converted to NDJSON with bgpkit-parser
- Our own probe agent CLI posting to /api/ingest (per-device keys and rate limits)

## Key technical choices
- TypeScript monorepo: apps/server (Express 5 + Socket.IO 4, ingest in a worker_thread), apps/web (React + Vite, react-globe.gl, uPlot, Zustand, socket in a Web Worker), packages/shared (zod schemas, event envelope, room names)
- Event envelope {v, src, eid, kind, ts, its, entity, data}; dedupe on eid; event-time windows (1 s and 1 min) with watermarks; counts taken before sampling; idempotent $set upserts
- MongoDB: hourly bucket documents per country/ASN (regular collections, because time-series collections can't have unique indexes), TTLs sized for Atlas M0's 512 MB limit
- Socket.IO namespaces /live (public), /user (JWT), /admin; rooms world, country:<CC>, asn:<N>, incidents, arcs, feed, user:<id>; 500 ms conflation; MessagePack; per-room sequence numbers plus ring buffer; snapshot-plus-delta merge protocol; connection state recovery
- Detectors D1–D7 (withdrawal storm, origin change, latency surge, probe dropout, flapping, Cloudflare confirmation, agent failures), fused into scored incidents
- Deployment: one Docker Compose stack (Caddy proxy serving the web app and proxying /api and /socket.io, server, mongo for local runs, seed job; profiles demo, loadtest, scale), so web and API share one origin. The same stack runs on an always-on VM (not Render's free tier) with MongoDB Atlas. Multi-arch images go to GHCR, and judges run `docker compose --profile demo up`. Day-to-day development runs natively with `pnpm dev` and only Mongo in Docker.

## Build phases (cut from the bottom)
0 Foundations and spikes (monorepo, contracts, Compose hello-world deployed, rates measured, replay file) → 1 Core loop (app is submittable here) → 2 Detection and alerts → 3 Performance and protection (load tests T1–T6) → 4 Polish and ship (README, architecture doc, 4:30 video) → stretch goals

## Open questions
Deadline and judging format, team size and owners, budget or credits for an always-on server.
