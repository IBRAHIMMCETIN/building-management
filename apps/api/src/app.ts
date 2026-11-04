import { Hono } from 'hono';
import { healthRoutes } from './modules/health/routes.js';

export type AppConfig = {
  version: string;
};

// Runtime'dan bagimsiz API: bugun EC2'da Node sunucusu, ileride Lambda
// (hono/aws-lambda) ayni uygulamayi calistirir. Yeni domain modulleri
// src/modules/<modul>/ altina eklenip burada baglanir.
export function createApp(config: AppConfig) {
  const app = new Hono();

  app.route('/api/health', healthRoutes(config));

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  return app;
}
