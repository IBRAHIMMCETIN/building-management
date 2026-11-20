import { Hono } from 'hono';
import { type Authenticator, type IdentityResolver, denyAll, denyAllIdentity } from './auth/claims.js';
import { type EventPublisher, createInMemoryEventPublisher } from './events/publisher.js';
import { announcementRoutes } from './modules/announcements/routes.js';
import { apartmentRoleRoutes } from './modules/apartment-roles/routes.js';
import { type ApartmentRoleService, createApartmentRoleService } from './modules/apartment-roles/service.js';
import { type AnnouncementService, createAnnouncementService } from './modules/announcements/service.js';
import { coreRoutes } from './modules/core/routes.js';
import { type CoreService, createCoreService } from './modules/core/service.js';
import { documentRoutes } from './modules/documents/routes.js';
import { type DocumentsService, createDocumentsService } from './modules/documents/service.js';
import { financeRoutes } from './modules/finance/routes.js';
import { importRoutes } from './modules/imports/routes.js';
import { type ImportsService, createImportsService } from './modules/imports/service.js';
import { type FinanceService, createFinanceService } from './modules/finance/service.js';
import { healthRoutes } from './modules/health/routes.js';
import { meRoutes } from './modules/me/routes.js';
import { type MeService, createMeService } from './modules/me/service.js';
import { membershipRoutes } from './modules/memberships/routes.js';
import { type MembershipService, createMembershipService } from './modules/memberships/service.js';
import { loadPaymentsConfig } from './modules/payments/config.js';
import type { FakePaymentProvider } from './modules/payments/fakeProvider.js';
import { paymentCallbackRoutes, paymentPortalRoutes } from './modules/payments/routes.js';
import { type PaymentsService, createPaymentsService } from './modules/payments/service.js';
import { portalRepository } from './modules/portal/repository.js';
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
  documentsService?: DocumentsService;
  importsService?: ImportsService;
  membershipService?: MembershipService;
  residentsService?: ResidentsService;
  announcementService?: AnnouncementService;
  apartmentRoleService?: ApartmentRoleService;
  /**
   * Online odeme (Adim 8b). Verilmezse ortam degiskenlerinden (`loadPaymentsConfig`) kurulur;
   * PAYMENTS_PROVIDER tanimsizsa online odeme kapalidir. `fakePaymentProvider` yalnizca sahte
   * saglayicinin test sayfasi rotalarini acar.
   */
  paymentsService?: PaymentsService;
  fakePaymentProvider?: FakePaymentProvider;
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

  // CORS preflight: API Gateway'deki kimliksiz `OPTIONS /api/{proxy+}` rotasi buraya duser.
  // CORS basliklarini API Gateway ekler (cors_configuration); burada yalnizca 2xx donulur.
  // Kimlik dogrulama middleware'lerinden ONCE tanimlanmalidir.
  app.options('/api/*', (c) => c.body(null, 204));

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

  const portalService = config.portalService ?? createPortalService();
  // Belgeler: makbuz yetkisi portal listesinden, fatura tasima finans gider kaydindan.
  const documentsService = config.documentsService ?? createDocumentsService({ portal: portalService });
  app.route('/api/documents', documentRoutes({ authenticate, service: documentsService }));

  const financeService =
    config.financeService ?? createFinanceService({ events, attachments: { promote: documentsService.promoteInvoice } });
  app.route('/api/finance', financeRoutes({ authenticate, service: financeService }));

  const membershipService = config.membershipService ?? createMembershipService();
  app.route('/api/memberships', membershipRoutes({ authenticate, service: membershipService }));
  // Davet, uyelik kurallarini memberships servisinden alir (tek kaynak).
  const residentsService = config.residentsService ?? createResidentsService({ memberships: membershipService });
  app.route('/api/residents', residentRoutes({ authenticate, service: residentsService }));

  // Toplu aktarim: yazimlar mevcut servislerle (ayni is kurallari).
  const importsService =
    config.importsService ??
    createImportsService({
      residents: residentsService,
      finance: financeService,
      memberships: membershipService,
      ...(config.coreService ? { core: config.coreService } : {}),
    });
  app.route('/api/imports', importRoutes({ authenticate, service: importsService }));

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

  // Online odeme: sakin uclari portal'dan ONCE baglanir (daha ozel yol); callback kimliksizdir.
  let paymentsService = config.paymentsService;
  let fakePaymentProvider = config.fakePaymentProvider;
  if (!paymentsService) {
    const payments = loadPaymentsConfig();
    fakePaymentProvider = payments.fake;
    paymentsService = createPaymentsService({
      portal: portalService,
      ledger: portalRepository,
      finance: financeService,
      provider: payments.provider,
      apiBaseUrl: payments.apiBaseUrl,
      webAppUrl: payments.webAppUrl,
      intentTtlMinutes: payments.intentTtlMinutes,
    });
  }
  app.route('/api/portal/payments', paymentPortalRoutes({ authenticate, service: paymentsService }));
  app.route('/api/payments', paymentCallbackRoutes({ service: paymentsService, fake: fakePaymentProvider }));

  app.route(
    '/api/portal',
    portalRoutes({
      authenticate,
      service: portalService,
    }),
  );

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  return app;
}
