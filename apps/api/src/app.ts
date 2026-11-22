import { Hono } from 'hono';
import { type Authenticator, type IdentityResolver, denyAll, denyAllIdentity } from './auth/claims.js';
import { type MfaPolicy, loadMfaPolicy, withMfaPolicy } from './auth/mfa.js';
import { handleError } from './http/helpers.js';
import { mfaAdminRoutes } from './modules/mfa/routes.js';
import { type MfaService, createMfaService } from './modules/mfa/service.js';
import { announcementRoutes } from './modules/announcements/routes.js';
import { auditRoutes, requestContext } from './modules/audit/routes.js';
import type { AuditReader, CheckpointStore } from './modules/audit/repository.js';
import { type MetricsEmitter, noopMetrics } from './observability/metrics.js';
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
import { bankRoutes } from './modules/finance/bank/routes.js';
import { type BankService, createBankService } from './modules/finance/bank/service.js';
import { type BankMatchService, createBankMatchService } from './modules/finance/bank/matchService.js';
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
import { type InvoiceService, createInvoiceService } from './modules/payments/invoices.js';
import { type PayoutService, createPayoutService } from './modules/payments/payouts.js';
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
import { createOwnershipReader } from './modules/ownership/reader.js';
import { ownershipRoutes } from './modules/ownership/routes.js';
import { type OwnershipService, createOwnershipService } from './modules/ownership/service.js';

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
  /** Gecelik zincir dogrulamasinin kontrol noktalari (`GET /api/audit/integrity`). */
  auditCheckpoints?: Pick<CheckpointStore, 'get'>;
  /** EMF metrikleri (Lambda: `createEmfEmitterFromEnv`); verilmezse yayinlanmaz. */
  metrics?: MetricsEmitter;
  /** Kullanici bildirim tercihleri (`/api/me/notification-preferences`). */
  notificationPreferences?: PreferencesService;
  /** Testlerde sahte repository ile servis enjekte etmek icin. */
  coreService?: CoreService;
  financeService?: FinanceService;
  /** Tasinmada cari kapama (testlerde sahte depolarla). */
  closureService?: ClosureService;
  /** Finans 2.1: hisseli mulkiyet ve mulk/hisse devri (testlerde sahte depolarla). */
  ownershipService?: OwnershipService;
  portalService?: PortalService;
  documentsService?: DocumentsService;
  importsService?: ImportsService;
  /** Faz B1: banka ekstresi aktarimi (testlerde sahte depo/depolama/HMAC). */
  bankService?: BankService;
  /** Faz B2: banka satiri eslestirme (testlerde sahte depolarla). */
  bankMatchService?: BankMatchService;
  membershipService?: MembershipService;
  residentsService?: ResidentsService;
  announcementService?: AnnouncementService;
  apartmentRoleService?: ApartmentRoleService;
  /**
   * Online odeme (Adim 8b). Verilmezse ortam degiskenlerinden (`loadPaymentsConfig`) kurulur;
   * PAYMENTS_PROVIDERS bossa online odeme kapalidir (P2: birden fazla saglayici + varsayilan). `fakePaymentProvider` yalnizca sahte
   * saglayicinin test sayfasi rotalarini acar.
   */
  paymentsService?: PaymentsService;
  /** P4: platform transferi izleme ve platform komisyon faturasi (verilmezse ortamdan kurulur). */
  payoutService?: PayoutService;
  invoiceService?: InvoiceService;
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
  const metrics = config.metrics ?? noopMetrics;
  const mfaService = config.mfaService ?? createMfaService({ policy: mfaPolicy, metrics });
  const authenticate = withSupportAccess(
    withMfaPolicy(config.authenticate ?? denyAll, mfaPolicy, () => new Date(), metrics),
    supportService,
  );
  // Modul rotalari kendi onError'unu baglar; kalan hatalar da (ornek MFA_REQUIRED) ayni bicimde.
  app.onError(handleError);

  // Denetim baglami (requestId, kisaltilmis IP/UA); tum rotalardan once.
  app.use('/api/*', requestContext());

  // CORS preflight: API Gateway'deki kimliksiz `OPTIONS /api/{proxy+}` rotasi buraya duser.
  // CORS basliklarini API Gateway ekler (cors_configuration); burada yalnizca 2xx donulur.
  // Kimlik dogrulama middleware'lerinden ONCE tanimlanmalidir.
  app.options('/api/*', (c) => c.body(null, 204));

  app.route('/api/health', healthRoutes(config));
  app.route(
    '/api/audit',
    auditRoutes({
      authenticate,
      ...(config.auditReader ? { reader: config.auditReader } : {}),
      ...(config.auditCheckpoints ? { checkpoints: config.auditCheckpoints } : {}),
    }),
  );
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

  // Finans 2.1: mulkiyet sicili okuyucusu (split faturalama, portal paydas carisi, uyelik pay kurali).
  const ownershipReader = createOwnershipReader();
  const portalService = config.portalService ?? createPortalService({ ownership: ownershipReader });
  // Belgeler: makbuz yetkisi portal listesinden, fatura tasima finans gider kaydindan.
  const documentsService = config.documentsService ?? createDocumentsService({ portal: portalService });
  app.route('/api/documents', documentRoutes({ authenticate, service: documentsService }));

  const financeService =
    config.financeService ??
    createFinanceService({
      attachments: { promote: documentsService.promoteInvoice },
      // Bos daire kurali: tahakkuk tarihinde oturan yoksa sakin gideri malike.
      memberships: membershipRepository,
      ownership: ownershipReader,
    });
  // Online odeme (Adim 8b). Yonetici uclari finans rotalarindan, sakin uclari portal
  // rotalarindan ONCE baglanir (daha ozel yol); callback/webhook kimliksizdir.
  let paymentsService = config.paymentsService;
  let fakePaymentProvider = config.fakePaymentProvider;
  let payoutService = config.payoutService;
  let invoiceService = config.invoiceService;
  if (!paymentsService) {
    const payments = loadPaymentsConfig();
    fakePaymentProvider = payments.fake;
    paymentsService = createPaymentsService({
      portal: portalService,
      ledger: portalRepository,
      finance: financeService,
      providers: payments.providers,
      // P4: API yalnizca SIFRELER; transferleri zamanlanmis worker gonderir (payoutMode varsayilan 'defer').
      ...(payments.vault ? { vault: payments.vault } : {}),
      apiBaseUrl: payments.apiBaseUrl,
      webAppUrl: payments.webAppUrl,
      intentTtlMinutes: payments.intentTtlMinutes,
    });
    payoutService ??= createPayoutService({ providers: payments.providers, ...(payments.vault ? { vault: payments.vault } : {}) });
    invoiceService ??= createInvoiceService({ settings: payments.invoices });
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
  // Faz B1: banka ekstresi aktarimi (ekstre yukleme, onizleme, satir aktarimi, sutun eslemesi).
  // Faz B2: eslestirme finans cekirdegini (postBatch) ve portal uyelik kurallarini kullanir.
  const bankMatchService = config.bankMatchService ?? createBankMatchService({ finance: financeService, portal: portalService, ownership: ownershipReader });
  app.route('/api/bank', bankRoutes({ authenticate, service: config.bankService ?? createBankService(), match: bankMatchService }));
  app.route('/api/payments', paymentCallbackRoutes({ service: paymentsService, payouts: payoutService, fake: fakePaymentProvider }));
  app.route('/api/admin/payments', paymentAdminRoutes({ authenticate, service: paymentsService, payouts: payoutService, invoices: invoiceService }));

  const membershipService = config.membershipService ?? createMembershipService({ ownership: ownershipReader });
  // Finans 2.1: sahte finans servisiyle kurulan testlerde (ownershipService verilmemisse) baglanmaz.
  const ownershipService = config.ownershipService ?? (config.financeService ? undefined : createOwnershipService({ finance: financeService }));
  if (ownershipService) app.route('/api/ownership', ownershipRoutes({ authenticate, service: ownershipService }));
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
      paymentReference: (ctx, unitId) => bankMatchService.paymentReference(ctx, unitId),
    }),
  );

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  return app;
}
