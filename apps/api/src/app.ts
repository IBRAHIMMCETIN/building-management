import { Hono } from 'hono';
import { type Authenticator, type IdentityResolver, denyAll, denyAllIdentity } from './auth/claims.js';
import { type EventPublisher, createInMemoryEventPublisher } from './events/publisher.js';
import { announcementRoutes } from './modules/announcements/routes.js';
import { apartmentRoleRoutes } from './modules/apartment-roles/routes.js';
import { type ApartmentRoleService, createApartmentRoleService } from './modules/apartment-roles/service.js';
import { type AnnouncementService, createAnnouncementService } from './modules/announcements/service.js';
import { coreRoutes } from './modules/core/routes.js';
import { type CoreService, createCoreService } from './modules/core/service.js';
import { financeRoutes } from './modules/finance/routes.js';
import { type FinanceService, createFinanceService } from './modules/finance/service.js';
import { healthRoutes } from './modules/health/routes.js';
import { meRoutes } from './modules/me/routes.js';
import { type MeService, createMeService } from './modules/me/service.js';
import { membershipRoutes } from './modules/memberships/routes.js';
import { type MembershipService, createMembershipService } from './modules/memberships/service.js';
import { portalRoutes } from './modules/portal/routes.js';
import { residentRoutes } from './modules/residents/routes.js';
import { type ResidentsService, createResidentsService } from './modules/residents/service.js';
import { type PortalService, createPortalService } from './modules/portal/service.js';

export type AppConfig = {
  version: string;
  /**
   * Yalnizca yerel tani: verilirse /api/health yanitina eklenir (web, kendi moduyla
   * uyusmazligi gosterir). Production'da (server.ts/lambda.ts) verilmez.
   */
  authMode?: string;
  /**
   * Istekten dogrulanmis JWT claim'lerini cikarir (Lambda'da apiGatewayAuthenticator).
   * Verilmezse korumali rotalar 401 doner; guvenli varsayilan budur.
   */
  authenticate?: Authenticator;
  /**
   * Rol gerektirmeyen kimlik cozumleyici (`/api/me/*`): aktif baglam secilmeden once de
   * calisir. Verilmezse `/api/me` 401 doner.
   */
  identify?: IdentityResolver;
  meService?: MeService;
  /** Testlerde sahte repository ile servis enjekte etmek icin. */
  coreService?: CoreService;
  financeService?: FinanceService;
  portalService?: PortalService;
  membershipService?: MembershipService;
  residentsService?: ResidentsService;
  announcementService?: AnnouncementService;
  apartmentRoleService?: ApartmentRoleService;
  /**
   * Domain olay yayincisi (DUE_GENERATED, PAYMENT_RECEIVED). server.ts/Lambda ortam
   * degiskenlerinden `createEventPublisherFromEnv()` ile verir; verilmezse bellek ici
   * yayinci kullanilir (yerel gelistirme/test). Servisler disaridan verilirse olay
   * yayinciyi o servislerin kendi bagimliliklari belirler.
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
    '/api/me',
    meRoutes({ identify: config.identify ?? denyAllIdentity, service: config.meService ?? createMeService() }),
  );
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

  const membershipService = config.membershipService ?? createMembershipService();
  app.route('/api/memberships', membershipRoutes({ authenticate, service: membershipService }));
  app.route(
    '/api/residents',
    residentRoutes({
      authenticate,
      // Davet, uyelik kurallarini memberships servisinden alir (tek kaynak).
      service: config.residentsService ?? createResidentsService({ memberships: membershipService }),
    }),
  );

  app.route(
    '/api/apartment-roles',
    apartmentRoleRoutes({
      authenticate,
      service: config.apartmentRoleService ?? createApartmentRoleService(),
    }),
  );

  app.route(
    '/api/announcements',
    announcementRoutes({
      authenticate,
      service: config.announcementService ?? createAnnouncementService({ events }),
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
