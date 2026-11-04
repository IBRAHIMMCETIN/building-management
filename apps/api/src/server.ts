import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const version = process.env.APP_VERSION ?? 'dev';
// Release paketinde React build'i server.mjs'in yanindaki public/ klasorunde durur.
const publicDir =
  process.env.PUBLIC_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const app = createApp({ version });

app.use('/*', serveStatic({ root: publicDir }));
// SPA: bilinmeyen sayfa yollarinda React uygulamasi acilir.
app.get('*', serveStatic({ root: publicDir, path: 'index.html' }));

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`building-management ${version} listening on :${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
