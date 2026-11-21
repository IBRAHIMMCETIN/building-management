import { Hono } from 'hono';
import { type Authenticator, type IdentityResolver, denyAll, denyAllIdentity } from './auth/claims.js';
import { type MfaPolicy, loadMfaPolicy, withMfaPolicy } from './auth/mfa.js';
import { handleError } from './http/helpers.js';
import { mfaAdminRoutes } from './modules/mfa/routes.js';
import { type MfaService, createMfaService } from './modules/mfa/service.js';
import { announcementRoutes } from './modules/announcements/routes.js';
import { auditRoutes, requestContext } from './modules/audit/routes.js';
import type { AuditReader } from './modules/audit/repository.js';
import { supportRoutes } from './modules/support/routes.js';
import { type SupportService, createSupportService, withSupportAccess } from './modules/support/service.js';
import { apartmentRoleRoutes } from './modules/apartment-roles/routes.js';
import { type ApartmentRoleService, createApartmentRoleService } from './modules/apartment-roles/service.js';
import { type AnnouncementService, createAnnouncementService } from './modules/announcements/service.js';
import { coreAdminRoutes, coreRoutes } from './modules/core/routes.js';
import { type CoreService, createCoreService } from './modules/core/service.js';
import { documentRoutes } from './modules/documents/routes.js';
import { type DocumentsService, createDocumentsService } from './modules/documents/service.js';
import { financeRoutes } from './modules/finance/routes.js';
import { importRoutes } from './modules/imports/routes.js';
import { type ImportsService, createImportsService } from './modules/imports/service.js';
import { type ClosureService, createClosureService } from './modules/finance/closures.js';
import { type FinanceService, createFinanceService } from './modules/finance/service.js';
import { healthRoutes } from './modules/health/routes.js';
import { meRoutes } from './modules/me/routes.js';
import { type MeService, createMeService } from './modules/me/service.js';
import { type PreferencesService, createPreferencesService } from './modules/notifications/preferences.js';
import { membershipRepository } from './modules/memberships/repository.js';
import { membershipRoutes } from './modules/memberships/routes.js';
import { type MembershipService, createMembershipService } from './modules/memberships/service.js';
import { loadPaymentsConfig } from './modules/payments/config.js';
import type { FakePaymentProvider } from './modules/payments/fakeProvider.js';
import {
  paymentAdminRoutes,
  paymentCallbackRoutes,
  paymentManagerRoutes,
  paymentPortalRoutes,
} from './modules/payments/routes.js';
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
  /** `platform_admin` destek erisimi (gerekceli, sureli, denetlenen salt okunur). */
  supportService?: SupportService;
  /** Zorunlu MFA politikasi (G2); verilmezse MFA_ENFORCEMENT_MODE / MFA_GRACE_PERIOD_DAYS. */
  mfaPolicy?: MfaPolicy;
  /** TOTP kurulumu ve yonetici sifirlamasi (testlerde sahte saglayici). */
  mfaService?: MfaService;
  /** Denetim gunlugu okuyucu (`GET /api/audit`). */
  auditReader?: AuditReader;
  /** Kullanici bildirim tercihleri (`/api/me/notification-preferences`). */
  notificationPreferences?: PreferencesService;
  /** Testlerde sahte repository ile servis enjekte etmek icin. */
  coreService?: CoreService;
  financeService?: FinanceService;
  /** Tasinmada cari kapama (testlerde sahte depolarla). */
  closureService?: ClosureService;
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
};

// Runtime'dan bagimsiz API: bugun EC2'da Node sunucusu, ileride Lambda
// (hono/aws-lambda) ayni uygulamayi calistirir. Yeni domain modulleri
// src/modules/<modul>/ altina eklenip burada baglanir.
export function createApp(config: AppConfig) {
  const app = new Hono();
  // Destek erisimi: `X-Support-Session` basligi yalnizca platform_admin icin, salt okunur ve denetlenir.
  const supportService = config.supportService ?? createSupportService();
  // Zorunlu MFA (G2): rol gerektiren TUM uclar bu tek ara katmandan gecer. Destek erisiminden
  // ONCE (ic katman) uygulanir: karar platform_admin'in kendi token'iyla verilir.
  const mfaPolicy = config.mfaPolicy ?? loadMfaPolicy();
  const mfaService = config.mfaService ?? createMfaService({ policy: mfaPolicy });
  const authenticate = withSupportAccess(withMfaPolicy(config.authenticate ?? denyAll, mfaPolicy), supportService);
  // Modul rotalari kendi onError'unu baglar; kalan hatalar da (ornek MFA_REQUIRED) ayni bicimde.
  app.onError(handleError);

  // Denetim baglami (requestId, kisaltilmis IP/UA); tum rotalardan once.
  app.use('/api/*', requestContext());

  // CORS preflight: API Gateway'deki kimliksiz `OPTIONS /api/{proxy+}` rotasi buraya duser.
  // CORS basliklarini API Gateway ekler (cors_configuration); burada yalnizca 2xx donulur.
  // Kimlik dogrulama middleware'lerinden ONCE tanimlanmalidir.
  app.options('/api/*', (c) => c.body(null, 204));

  app.route('/api/health', healthRoutes(config));
  app.route('/api/audit', auditRoutes({ authenticate, ...(config.auditReader ? { reader: config.auditReader } : {}) }));
  app.route('/api/support/sessions', supportRoutes({ authenticate, service: supportService }));
  app.route(
    '/api/me',
    meRoutes({
      identify: config.identify ?? denyAllIdentity,
      service: config.meService ?? createMeService(),
      preferences: config.notificationPreferences ?? createPreferencesService(),
      mfa: mfaService,
    }),
  );
  app.route('/api/mfa', mfaAdminRoutes({ authenticate, service: mfaService }));
  const coreService = config.coreService ?? createCoreService();
  app.route('/api/sites', coreRoutes({ authenticate, service: coreService }));
  app.route('/api/admin/apartments', coreAdminRoutes({ authenticate, service: coreService }));

  const portalService = config.portalService ?? createPortalService();
  // Belgeler: makbuz yetkisi portal listesinden, fatura tasima finans gider kaydindan.
  const documentsService = config.documentsService ?? createDocumentsService({ portal: portalService });
  app.route('/api/documents', documentRoutes({ authenticate, service: documentsService }));

  const financeService =
    config.financeService ??
    createFinanceService({
      attachments: { promote: documentsService.promoteInvoice },
      // Bos daire kurali: tahakkuk tarihinde oturan yoksa sakin gideri malike.
      memberships: membershipRepository,
    });
  // Online odeme (Adim 8b). Yonetici uclari finans rotalarindan, sakin uclari portal
  // rotalarindan ONCE baglanir (daha ozel yol); callback/webhook kimliksizdir.
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
  app.route('/api/finance/online-payments', paymentManagerRoutes({ authenticate, service: paymentsService }));
  app.route(
    '/api/finance',
    financeRoutes({
      authenticate,
      service: financeService,
      closures: config.closureService ?? (config.financeService ? undefined : createClosureService({ finance: financeService })),
    }),
  );
  app.route('/api/payments', paymentCallbackRoutes({ service: paymentsService, fake: fakePaymentProvider }));
  app.route('/api/admin/payments', paymentAdminRoutes({ authenticate, service: paymentsService }));

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
      service: config.announcementService ?? createAnnouncementService(),
    }),
  );


  app.route('/api/portal/payments', paymentPortalRoutes({ authenticate, service: paymentsService }));
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
