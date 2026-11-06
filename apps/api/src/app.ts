import { Hono } from 'hono';
import { type Authenticator, denyAll } from './auth/claims.js';
import { coreRoutes } from './modules/core/routes.js';
import { type CoreService, createCoreService } from './modules/core/service.js';
import { healthRoutes } from './modules/health/routes.js';

export type AppConfig = {
  version: string;
  /**
   * Istekten dogrulanmis JWT claim'lerini cikarir (Lambda'da apiGatewayAuthenticator).
   * Verilmezse korumali rotalar 401 doner; guvenli varsayilan budur.
   */
  authenticate?: Authenticator;
  /** Testlerde sahte repository ile servis enjekte etmek icin. */
  coreService?: CoreService;
};

// Runtime'dan bagimsiz API: bugun EC2'da Node sunucusu, ileride Lambda
// (hono/aws-lambda) ayni uygulamayi calistirir. Yeni domain modulleri
// src/modules/<modul>/ altina eklenip burada baglanir.
export function createApp(config: AppConfig) {
  const app = new Hono();

  app.route('/api/health', healthRoutes(config));
  app.route(
    '/api/sites',
    coreRoutes({
      authenticate: config.authenticate ?? denyAll,
      service: config.coreService ?? createCoreService(),
    }),
  );

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  return app;
}
