import { Hono } from 'hono';
import { type Authenticator, denyAll } from './auth/claims.js';
import { type EventPublisher, createInMemoryEventPublisher } from './events/publisher.js';
import { coreRoutes } from './modules/core/routes.js';
import { type CoreService, createCoreService } from './modules/core/service.js';
import { financeRoutes } from './modules/finance/routes.js';
import { type FinanceService, createFinanceService } from './modules/finance/service.js';
import { healthRoutes } from './modules/health/routes.js';
import { portalRoutes } from './modules/portal/routes.js';
import { type PortalService, createPortalService } from './modules/portal/service.js';

export type AppConfig = {
  version: string;
  /**
   * Istekten dogrulanmis JWT claim'lerini cikarir (Lambda'da apiGatewayAuthenticator).
   * Verilmezse korumali rotalar 401 doner; guvenli varsayilan budur.
   */
  authenticate?: Authenticator;
  /** Testlerde sahte repository ile servis enjekte etmek icin. */
  coreService?: CoreService;
  financeService?: FinanceService;
  portalService?: PortalService;
  /**
   * Domain olay yayincisi (DUE_GENERATED, PAYMENT_RECEIVED). server.ts/Lambda ortam
   * degiskenlerinden `createEventPublisherFromEnv()` ile verir; verilmezse bellek ici
   * yayinci kullanilir (yerel gelistirme/test). `financeService` disaridan verilirse
   * olay yayinciyi o servisin kendi bagimliliklari belirler.
   */
  events?: EventPublisher;
};

// Runtime'dan bagimsiz API: bugun EC2'da Node sunucusu, ileride Lambda
// (hono/aws-lambda) ayni uygulamayi calistirir. Yeni domain modulleri
// src/modules/<modul>/ altina eklenip burada baglanir.
export function createApp(config: AppConfig) {
  const app = new Hono();
  const authenticate = config.authenticate ?? denyAll;
  const events = config.events ?? createInMemoryEventPublisher();

  app.route('/api/health', healthRoutes(config));
  app.route(
    '/api/sites',
    coreRoutes({
      authenticate,
      service: config.coreService ?? createCoreService(),
    }),
  );

  app.route(
    '/api/finance',
    financeRoutes({
      authenticate,
      service: config.financeService ?? createFinanceService({ events }),
    }),
  );

  app.route(
    '/api/portal',
    portalRoutes({
      authenticate,
      service: config.portalService ?? createPortalService(),
    }),
  );

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  return app;
}
