import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { webRouter } from './web.ts';

let server: Server;
let base = '';

beforeAll(async () => {
  // A miniature build: index.html, one hashed asset with a Brotli copy, one public file.
  const dir = mkdtempSync(join(tmpdir(), 'ins-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
  const js = 'console.log("hello");'.repeat(100);
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), js);
  writeFileSync(join(dir, 'assets', 'index-abc123.js.br'), brotliCompressSync(js));
  writeFileSync(join(dir, 'countries.json'), '{}');

  const app = express();
  app.get('/api/ping', (_req, res) => void res.json({ ok: true }));
  app.use(webRouter(dir)!);
  app.use((_req, res) => void res.status(404).json({ error: 'not_found' }));
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('serving the web app', () => {
  it('answers client routes with index.html, never cached', async () => {
    for (const path of ['/', '/feed', '/c/IN', '/incident/x']) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('<title>app</title>');
    }
  });

  it('leaves the API alone, including unknown API paths', async () => {
    expect(await (await fetch(`${base}/api/ping`)).json()).toEqual({ ok: true });
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it('sends the Brotli copy of an asset to browsers that accept it, cached for a year', async () => {
    const res = await fetch(`${base}/assets/index-abc123.js`, {
      headers: { 'accept-encoding': 'br' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('br');
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(res.headers.get('cache-control')).toMatch(/immutable/);
    expect(await res.text()).toContain('console.log("hello");'); // fetch decodes it
  });

  it('serves public files, and 404s a missing asset instead of returning the page', async () => {
    expect((await fetch(`${base}/countries.json`)).status).toBe(200);
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
  });

  it('serves nothing when there is no build', () => {
    expect(webRouter(mkdtempSync(join(tmpdir(), 'ins-empty-')))).toBeNull();
  });
});
