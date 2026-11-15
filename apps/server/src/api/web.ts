import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import express, { Router, type Request } from 'express';

/**
 * Serving the built web app from the server itself, for hosts that run one
 * container per service (Railway). It does what Caddy does in the Compose
 * stack, so the browser still talks to one origin:
 *
 *  - `/assets/*`: Vite puts a content hash in every file name, so they are
 *    cached for a year. If the build left a `.br` or `.gz` copy next to a file
 *    (apps/web/scripts/precompress.mjs) and the browser accepts it, that copy
 *    is sent instead: the globe's code is about 2 MB raw, under 600 KB gzipped.
 *  - other files in the build (fonts, country shapes): cached for an hour.
 *  - any other GET that is not the API: `index.html`, never cached, so client
 *    routes like /feed survive a reload and a new deploy is picked up at once.
 */
export function webRouter(dir: string): Router | null {
  const index = join(dir, 'index.html');
  if (!existsSync(index)) return null;
  const router = Router();
  const assets = join(dir, 'assets');

  // Which pre-compressed copies exist, read once (the build never changes at run time).
  const compressed = new Set<string>();
  if (existsSync(assets)) {
    for (const name of readdirSync(assets)) {
      if (name.endsWith('.br') || name.endsWith('.gz')) compressed.add(name);
    }
  }

  const TYPES: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.html': 'text/html; charset=utf-8',
  };

  router.get('/assets/{*file}', (req: Request, res, next) => {
    const name = req.path.slice('/assets/'.length);
    // Only plain file names inside assets/ (no "..", no sub-folders).
    if (!name || normalize(name) !== name || name.includes(sep) || name.includes('/'))
      return next();
    const accepts = String(req.get('accept-encoding') ?? '');
    const pick =
      accepts.includes('br') && compressed.has(`${name}.br`)
        ? { file: `${name}.br`, encoding: 'br' }
        : accepts.includes('gzip') && compressed.has(`${name}.gz`)
          ? { file: `${name}.gz`, encoding: 'gzip' }
          : null;
    if (!pick) return next();
    const path = join(assets, pick.file);
    if (!existsSync(path) || !statSync(path).isFile()) return next();
    res.set({
      'Content-Encoding': pick.encoding,
      'Content-Type': TYPES[extname(name)] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      Vary: 'Accept-Encoding',
    });
    res.sendFile(path);
  });
  router.use(
    '/assets',
    express.static(assets, { immutable: true, maxAge: '1y', index: false, fallthrough: false }),
  );
  router.use(express.static(dir, { index: false, maxAge: '1h' }));

  // The single-page app for every other page address.
  router.get('/{*page}', (req, res, next) => {
    const p = req.path;
    if (p.startsWith('/api/') || p.startsWith('/socket.io/') || p === '/metrics') return next();
    res.set('Cache-Control', 'no-cache').sendFile(index);
  });
  return router;
}
