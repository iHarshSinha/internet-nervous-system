import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In production Caddy serves this build and forwards /api and /socket.io to
// the server, so the browser only ever talks to one origin. The dev proxy
// below reproduces that locally, which is why the app uses relative URLs only.
const server = 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': server,
      '/healthz': server,
      '/readyz': server,
      '/socket.io': { target: server, ws: true },
    },
  },
});
