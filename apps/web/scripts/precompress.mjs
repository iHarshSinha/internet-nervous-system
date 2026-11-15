// Writes Brotli (.br) and gzip (.gz) copies of the built assets, so a server
// without on-the-fly compression (the Node server on Railway) can send them
// compressed. Run after `vite build`:  node scripts/precompress.mjs
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const dir = join(import.meta.dirname, '..', 'dist', 'assets');
let raw = 0;
let br = 0;
for (const name of readdirSync(dir)) {
  if (!/\.(js|css|json|svg)$/.test(name)) continue;
  const path = join(dir, name);
  if (statSync(path).size < 1024) continue;
  const data = readFileSync(path);
  const b = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  writeFileSync(`${path}.br`, b);
  writeFileSync(`${path}.gz`, gzipSync(data, { level: 9 }));
  raw += data.length;
  br += b.length;
}
console.log(
  `precompressed assets: ${(raw / 1048576).toFixed(1)} MB -> ${(br / 1048576).toFixed(2)} MB (brotli)`,
);
