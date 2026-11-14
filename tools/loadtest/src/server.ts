import jwt from 'jsonwebtoken';

/**
 * Talking to the server under test: an admin token for the replay and
 * /metrics, the realtime settings, and a once-a-second sample of its numbers.
 */

/**
 * An admin access token. LOADTEST_TOKEN if given (a token copied from a
 * signed-in admin session); otherwise one signed with JWT_SECRET, which only
 * works against a server you run yourself with the same secret.
 */
export function adminToken(): string {
  const given = process.env.LOADTEST_TOKEN;
  if (given) return given;
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "Set LOADTEST_TOKEN (an admin access token) or JWT_SECRET (the server's secret)",
    );
  }
  return jwt.sign({ role: 'admin', email: 'loadtest@localhost' }, secret, {
    algorithm: 'HS256',
    subject: 'loadtest',
    expiresIn: 3600,
    issuer: 'ins',
  });
}

export async function getJson<T>(base: string, path: string, token?: string): Promise<T> {
  const res = await fetch(
    base + path,
    token ? { headers: { authorization: `Bearer ${token}` } } : {},
  );
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function replay(
  base: string,
  token: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${base}/api/admin/replay`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`replay ${String(body.action)}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

/** The busiest countries right now, to spread clients over country rooms like real visitors. */
export async function busiestCountries(base: string, n: number): Promise<string[]> {
  const { countries } = await getJson<{ countries: Record<string, { h: number }> }>(
    base,
    '/api/countries',
  );
  const ccs = Object.keys(countries);
  return ccs.length > 0 ? ccs.slice(0, n) : ['US', 'DE', 'IN', 'BR', 'JP'];
}

/** Clock difference to the server, from the round trip with the shortest time (see the web HUD). */
export async function clockOffset(base: string): Promise<number> {
  let best = { rtt: Infinity, offset: 0 };
  for (let i = 0; i < 5; i++) {
    const sent = Date.now();
    const { t } = await getJson<{ t: number }>(base, '/api/time');
    const got = Date.now();
    if (got - sent < best.rtt) best = { rtt: got - sent, offset: t - (sent + got) / 2 };
  }
  return Math.round(best.offset);
}

/** Pick numbers out of Prometheus text: `name{labels} value`. */
export function parseMetrics(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const space = line.lastIndexOf(' ');
    const value = Number(line.slice(space + 1));
    if (Number.isFinite(value)) out.set(line.slice(0, space), value);
  }
  return out;
}

export interface ServerSample {
  /** Seconds since the run started. */
  at: number;
  eventsPerSec: number;
  processedPerSec: number;
  queueDepth: number;
  queueFill: number;
  sampleEvery: number;
  shed: number;
  overflow: number;
  processingP99Ms: number;
  mainLoopP99Ms: number;
  ingestLoopP99Ms: number;
  /** CPU used by the server process (all threads) since the previous sample, as % of one core. */
  cpuPct: number;
  rssMb: number;
  heapMb: number;
  ingestHeapMb: number;
  bytesOutPerSec: number;
  framesOutPerSec: number;
  liveSockets: number;
  slowClients: number;
}

/**
 * Samples the server once a second from /metrics (all of these numbers are
 * there). Rates come from the change in running totals between samples.
 */
export function startSampler(base: string, token: string, onSample?: (s: ServerSample) => void) {
  const samples: ServerSample[] = [];
  const started = Date.now();
  let prev: { m: Map<string, number>; t: number } | null = null;
  let stopped = false;

  const sum = (m: Map<string, number>, prefix: string) => {
    let total = 0;
    for (const [k, v] of m) if (k === prefix || k.startsWith(`${prefix}{`)) total += v;
    return total;
  };

  const tick = async () => {
    try {
      const res = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`/metrics: HTTP ${res.status}`);
      const m = parseMetrics(await res.text());
      const t = Date.now();
      if (stopped) return;
      if (prev) {
        const dt = (t - prev.t) / 1000;
        const rate = (name: string) =>
          Math.max(0, Math.round((sum(m, name) - sum(prev!.m, name)) / dt));
        const cpu =
          sum(m, 'ins_node_process_cpu_seconds_total') -
          sum(prev.m, 'ins_node_process_cpu_seconds_total');
        const s: ServerSample = {
          at: Math.round((t - started) / 100) / 10,
          eventsPerSec: rate('ins_events_total'),
          processedPerSec: rate('ins_counted_total'),
          queueDepth: m.get('ins_queue_depth') ?? 0,
          queueFill: m.get('ins_queue_fill_ratio') ?? 0,
          sampleEvery: m.get('ins_feed_sample_every') ?? 1,
          shed: sum(m, 'ins_shed_total'),
          overflow: m.get('ins_overflow_total') ?? 0,
          processingP99Ms: m.get('ins_processing_delay_ms{quantile="0.99"}') ?? 0,
          mainLoopP99Ms: m.get('ins_event_loop_delay_ms{thread="main",quantile="0.99"}') ?? 0,
          ingestLoopP99Ms: m.get('ins_event_loop_delay_ms{thread="ingest",quantile="0.99"}') ?? 0,
          cpuPct: Math.round((cpu / dt) * 1000) / 10,
          rssMb: Math.round((m.get('ins_node_process_resident_memory_bytes') ?? 0) / 1048576),
          heapMb: Math.round((m.get('ins_node_nodejs_heap_size_used_bytes') ?? 0) / 1048576),
          ingestHeapMb: Math.round((m.get('ins_ingest_heap_bytes') ?? 0) / 1048576),
          bytesOutPerSec: rate('ins_bytes_out_total'),
          framesOutPerSec: rate('ins_frames_total'),
          liveSockets: m.get('ins_sockets{namespace="live"}') ?? 0,
          slowClients: m.get('ins_slow_clients') ?? 0,
        };
        samples.push(s);
        onSample?.(s);
      }
      prev = { m, t };
    } catch (err) {
      // A sample can fail while the server restarts (chaos tests); keep going.
      process.stderr.write(`sampler: ${String(err)}\n`);
    }
    if (!stopped) setTimeout(() => void tick(), 1000);
  };
  void tick();

  return {
    samples,
    stop() {
      stopped = true;
    },
  };
}
