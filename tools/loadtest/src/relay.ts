import { WebSocket, WebSocketServer } from 'ws';

/**
 * A WebSocket relay for the chaos test: the server under test connects to
 * this relay (RIS_URL=ws://localhost:<port>/...) and the relay connects on to
 * the real feed. Stopping the relay cuts the server's upstream exactly as a
 * network failure would; starting it again shows how fast the server's
 * reconnect and resubscribe bring the feed back.
 */
export function startRelay(port: number, target: string, log: (line: string) => void) {
  const wss = new WebSocketServer({ port });
  wss.on('connection', (client, req) => {
    // Keep the path and query (RIS Live wants ?client=...), swap the host.
    const url = new URL(req.url ?? '/', target);
    const upstream = new WebSocket(url, { perMessageDeflate: false });
    const pending: (string | Buffer)[] = [];
    upstream.on('open', () => {
      for (const m of pending.splice(0)) upstream.send(m);
    });
    client.on('message', (data, isBinary) => {
      const m = isBinary ? (data as Buffer) : data.toString();
      if (upstream.readyState === WebSocket.OPEN) upstream.send(m);
      else pending.push(m);
    });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(isBinary ? data : data.toString());
    });
    const closeBoth = () => {
      client.terminate();
      upstream.terminate();
    };
    client.on('close', closeBoth);
    upstream.on('close', closeBoth);
    client.on('error', closeBoth);
    upstream.on('error', closeBoth);
    log(`relay: ${req.url ?? '/'} -> ${url.host}`);
  });
  return {
    /** Cut every connection and stop listening (the "network failure"). */
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}
