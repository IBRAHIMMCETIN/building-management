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
import { gatePortalRoutes, gateRoutes } from './modules/gate/routes.js';
import { type GateService, createGateService } from './modules/gate/service.js';
import { pollPortalRoutes, pollRoutes } from './modules/polls/routes.js';
import { assemblyPortalRoutes, assemblyRoutes } from './modules/assemblies/routes.js';
import { type AssemblyService, createAssemblyService } from './modules/assemblies/service.js';
import { type PollService, createPollService } from './modules/polls/service.js';
import { equipmentRoutes } from './modules/equipment/routes.js';
import { type EquipmentService, createEquipmentService } from './modules/equipment/service.js';
import { maintenanceRoutes } from './modules/maintenance/routes.js';
import { type MaintenanceService, createMaintenanceService } from './modules/maintenance/service.js';
import { reservationPortalRoutes, reservationRoutes } from './modules/reservations/routes.js';
import { type ReservationService, createReservationService } from './modules/reservations/service.js';
import { tenderPortalRoutes, tenderRoutes } from './modules/tenders/routes.js';
import { type TenderService, createTenderService } from './modules/tenders/service.js';
import { type WorkCostService, createWorkCostService } from './modules/workcosts/service.js';
import { ticketPortalRoutes } from './modules/tickets/portalRoutes.js';
import { ticketRoutes } from './modules/tickets/routes.js';
import { type TicketService, createTicketService } from './modules/tickets/service.js';
import { coreAdminRoutes, coreRoutes } from './modules/core/routes.js';
import { coreRepository } from './modules/core/repository.js';
import { financeRepository } from './modules/finance/repository.js';
import { portfolioRoutes } from './modules/portfolio/routes.js';
import { type PortfolioService, createPortfolioService, createPortfolioSources } from './modules/portfolio/service.js';
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
import { type OffsetService, createOffsetService } from './modules/finance/offsets.js';
import { type PeriodService, createPeriodService } from './modules/finance/periods.js';
import { type ReportService, createReportService } from './modules/finance/reportService.js';
import { type BudgetService, createBudgetService } from './modules/finance/budgets.js';
import { type PlanService, createPlanService } from './modules/finance/plans.js';
import { type FinanceService, createFinanceService } from './modules/finance/service.js';
import { healthRoutes } from './modules/health/routes.js';
import { meRoutes } from './modules/me/routes.js';
import { type MeService, createMeService } from './modules/me/service.js';
import { type PreferencesService, createPreferencesService } from './modules/notifications/preferences.js';
import { type DeviceService, createDeviceService } from './modules/notifications/devices.js';
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
import { meterPortalRoutes, meterReadingRoutes, meterRoutes } from './modules/meters/routes.js';
import { type MeterPortalService, createMeterPortalService } from './modules/meters/portalView.js';
import { type MeterPostingService, createMeterPostingService } from './modules/meters/posting.js';
import { bulkJobRoutes } from './modules/bulkjobs/routes.js';
import { createDynamoBulkJobRepository } from './modules/bulkjobs/repository.js';
import { type BulkJobQueue, createInlineBulkJobQueue, loadBulkJobQueueFromEnv } from './modules/bulkjobs/queue.js';
import { type BulkJobService, createBulkJobService } from './modules/bulkjobs/service.js';
import { type MeterReadingService, createMeterReadingService } from './modules/meters/readings.js';
import { type MeterReversalService, createMeterReversalService } from './modules/meters/reversal.js';
import { type MeterService, createMeterService } from './modules/meters/service.js';
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
  auditCheckpoints?: Pick<CheckpointStore, 'get'> & Partial<Pick<CheckpointStore, 'put'>>;
  /** Denetim uclarinin saati (test). */
  auditNow?: () => Date;
  /** EMF metrikleri (Lambda: `createEmfEmitterFromEnv`); verilmezse yayinlanmaz. */
  metrics?: MetricsEmitter;
  /** Kullanici bildirim tercihleri (`/api/me/notification-preferences`). */
  notificationPreferences?: PreferencesService;
  /** Mobil push cihaz kaydi (`/api/me/devices`). */
  deviceService?: DeviceService;
  /** Testlerde sahte repository ile servis enjekte etmek icin. */
  coreService?: CoreService;
  financeService?: FinanceService;
  /** Tasinmada cari kapama (testlerde sahte depolarla). */
  closureService?: ClosureService;
  /** Finans 2.2: avans mahsubu ve borc yapilandirma (testlerde sahte depolarla). */
  offsetService?: OffsetService;
  planService?: PlanService;
  /** Finans 2.4: mali donem kapanisi. */
  periodService?: PeriodService;
  reportService?: ReportService;
  budgetService?: BudgetService;
  /** Finans 2.1: hisseli mulkiyet ve mulk/hisse devri (testlerde sahte depolarla). */
  ownershipService?: OwnershipService;
  /** Finans 2.3: sayac / endeks dagitimi (testlerde sahte depolarla). */
  meterService?: MeterService;
  meterReadingService?: MeterReadingService;
  /** Finans 2.3-3: hesap onizleme, onay ve toplu tahakkuk. */
  meterPostingService?: MeterPostingService;
  /**
   * Buyuk toplu tahakkuk / sayac onayi arka plan isleri. Verilmezse `BULK_JOBS_QUEUE_URL` varsa
   * SQS, yoksa (yerel gelistirme) ayni surecte isleyen kuyrukla kurulur.
   */
  bulkJobService?: BulkJobService;
  /** Finans 2.3-4: toplu geri alma ve duzeltilmis donem. */
  meterReversalService?: MeterReversalService;
  /** Finans 2.3-5a: sakin tuketim gecmisi ve dagitim dokumu PDF. */
  meterPortalService?: MeterPortalService;
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
  /** Y1: anket / oylama (yonetici + sakin portali). */
  pollService?: PollService;
  /** Y1-3: kat malikleri kurulu (hazirun, katilim, yeter sayi, karar, cagri, tutanak; sakin portali). */
  assemblyService?: AssemblyService;
  /** Faz 3 (O1): ariza / talep. */
  ticketService?: TicketService;
  /** Faz 3 (O1-3): periyodik bakim. */
  maintenanceService?: MaintenanceService;
  workCostService?: WorkCostService;
  /** Ariza & bakim v2: ekipman sicili. */
  equipmentService?: EquipmentService;
  /** Ortak alan rezervasyonu (ucret Finans `chargeUnit` / ters kayit ile). */
  reservationService?: ReservationService;
  /** Ihale / teklif toplama (teklif belgeleri documents servisiyle). */
  tenderService?: TenderService;
  apartmentRoleService?: ApartmentRoleService;
  /** Yonetim firmasi portfoyu (testlerde sahte kaynaklarla). */
  portfolioService?: PortfolioService;
  /** Guvenlik kapisi: plaka, misafir QR gecisi, kurye, kapi gunlugu. */
  gateService?: GateService;
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
      ...(config.auditNow ? { now: config.auditNow } : {}),
    }),
  );
  app.route('/api/support/sessions', supportRoutes({ authenticate, service: supportService }));
  app.route(
    '/api/me',
    meRoutes({
      identify: config.identify ?? denyAllIdentity,
      service: config.meService ?? createMeService(),
      preferences: config.notificationPreferences ?? createPreferencesService(),
      devices: config.deviceService ?? createDeviceService(),
      mfa: mfaService,
    }),
  );
  app.route('/api/mfa', mfaAdminRoutes({ authenticate, service: mfaService }));
  // Finans 2.4: aidat plani gelir hesabi ayarlarda dogrulanir (finans servisi asagida kurulur).
  let incomeAccountResolver: FinanceService['resolveIncomeAccount'] | undefined;
  const coreService =
    config.coreService ??
    createCoreService({
      validateIncomeAccount: async (apartmentId, actor, accountId) => {
        await incomeAccountResolver?.({ apartmentId, userId: actor }, accountId, 'monthlyDuesPlan.incomeAccountId');
      },
    });
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
  incomeAccountResolver = financeService.resolveIncomeAccount;
  // Sayac onayi hem senkron rotada hem arka plan isinde ayni servisle calisir.
  const meterPostingService = config.meterPostingService ?? createMeterPostingService({ finance: financeService, ownership: ownershipReader });
  const meterReversalService = config.meterReversalService ?? createMeterReversalService({ finance: financeService });
  // Toplu isler: SQS (Lambda) veya yerelde ayni surecte parcali isleme.
  let bulkJobService: BulkJobService | undefined = config.bulkJobService;
  if (!bulkJobService) {
    const queue: BulkJobQueue = loadBulkJobQueueFromEnv() ?? createInlineBulkJobQueue(() => (m) => (bulkJobService as BulkJobService).handle(m).then(() => undefined));
    bulkJobService = createBulkJobService({ repository: createDynamoBulkJobRepository(), queue, finance: financeService, meters: meterPostingService, meterReversal: meterReversalService });
  }
  app.route('/api/jobs', bulkJobRoutes({ authenticate, service: bulkJobService }));
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
  // Finans 2.2: sahte finans servisiyle kurulan testlerde (servis verilmemisse) baglanmaz.
  const offsetService = config.offsetService ?? (config.financeService ? undefined : createOffsetService({ portal: portalService }));
  const periodService = config.periodService ?? (config.financeService ? undefined : createPeriodService());
  const budgetService = config.budgetService ?? (config.financeService ? undefined : createBudgetService({ finance: financeService, core: coreService }));
  const reportService = config.reportService ?? (config.financeService ? undefined : createReportService({ ledger: financeService }));
  const planService = config.planService ?? (config.financeService ? undefined : createPlanService({ finance: financeService, portal: portalService }));
  app.route(
    '/api/finance',
    financeRoutes({
      authenticate,
      service: financeService,
      closures: config.closureService ?? (config.financeService ? undefined : createClosureService({ finance: financeService })),
      ...(offsetService ? { offsets: offsetService } : {}),
      ...(planService ? { plans: planService } : {}),
      ...(periodService ? { periods: periodService } : {}),
      ...(reportService ? { reports: reportService } : {}),
      ...(budgetService ? { budgets: budgetService } : {}),
      jobs: bulkJobService,
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
  // Finans 2.3: sayac sicili / degisim / sablon / donem (yonetici) ve okuma girisi (+ bina gorevlisi).
  const meterPortalService = config.meterPortalService ?? createMeterPortalService();
  app.route(
    '/api/metering',
    meterRoutes({
      portal: meterPortalService,
      authenticate,
      service: config.meterService ?? createMeterService(),
      posting: meterPostingService,
      jobs: bulkJobService,
      reversal: meterReversalService,
    }),
  );
  app.route('/api/meter-readings', meterReadingRoutes({ authenticate, service: config.meterReadingService ?? createMeterReadingService() }));
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
  // Y1: anket / oylama. Oy hakki ve agirlik mulkiyet modulunun oy listesinden; sakin dairesi portal kuraliyla.
  const pollService = config.pollService ?? createPollService({ portal: portalService });
  app.route('/api/polls', pollRoutes({ authenticate, service: pollService }));
  const assemblyService = config.assemblyService ?? createAssemblyService();
  app.route('/api/assemblies', assemblyRoutes({ authenticate, service: assemblyService }));

  // Faz 3 (O1): ariza / talep (yonetim, gorevli, guvenlik, denetci).
  const ticketService = config.ticketService ?? createTicketService();
  // O1-4: talep ve bakim gorevi masraflari (Finans baglantisi).
  const workCostService = config.workCostService ?? createWorkCostService({ finance: financeService });
  app.route('/api/tickets', ticketRoutes({ authenticate, service: ticketService, costs: workCostService }));
  const maintenanceService = config.maintenanceService ?? createMaintenanceService({ tickets: ticketService });
  app.route('/api/maintenance', maintenanceRoutes({ authenticate, service: maintenanceService, costs: workCostService }));
  // Ariza & bakim v2: ekipman sicili (masraf iptal kontrolu Finans'tan).
  const equipmentService = config.equipmentService ?? createEquipmentService({ finance: financeService });
  app.route('/api/equipment', equipmentRoutes({ authenticate, service: equipmentService }));
  const reservationService = config.reservationService ?? createReservationService({ finance: financeService });
  app.route('/api/reservations', reservationRoutes({ authenticate, service: reservationService }));
  const tenderService =
    config.tenderService ??
    createTenderService({ documents: { promote: documentsService.promoteTenderQuote, sign: documentsService.signTenderDocument }, finance: financeService });
  app.route('/api/tenders', tenderRoutes({ authenticate, service: tenderService }));

  // Yonetim firmasi portfoyu: kullanicinin yonettigi / denetledigi tum apartmanlarin ozetleri,
  // mevcut servislerin salt okunur ozetlerinden (yeniden hesaplama yok).
  const portfolioService =
    config.portfolioService ??
    createPortfolioService({
      sources: createPortfolioSources({
        core: coreRepository,
        ledger: financeRepository,
        finance: financeService,
        reports: reportService ?? createReportService({ ledger: financeService }),
        tickets: ticketService,
        maintenance: maintenanceService,
        equipment: equipmentService,
        polls: pollService,
        assemblies: assemblyService,
        tenders: tenderService,
      }),
    });
  app.route('/api/portfolio', portfolioRoutes({ authenticate, service: portfolioService }));

  // Guvenlik kapisi (yonetim + guvenlik; sakin portali `/api/portal`'dan once).
  const gateService = config.gateService ?? createGateService({ metrics });
  app.route('/api/gate', gateRoutes({ authenticate, service: gateService }));
  app.route('/api/portal/gate', gatePortalRoutes({ authenticate, service: gateService }));
  app.route('/api/portal/payments', paymentPortalRoutes({ authenticate, service: paymentsService }));
  app.route('/api/portal/meters', meterPortalRoutes({ authenticate, service: meterPortalService }));
  // Faz 3 (O1-2): sakin ariza / talep (daha ozel yol, `/api/portal`'dan once).
  app.route('/api/portal/tickets', ticketPortalRoutes({ authenticate, service: ticketService }));
  app.route('/api/portal/reservations', reservationPortalRoutes({ authenticate, service: reservationService }));
  app.route('/api/portal/polls', pollPortalRoutes({ authenticate, service: pollService }));
  // Genel kurul devami: kat maliki sakinler icin toplantilar, kararlar ve tutanak.
  app.route('/api/portal/assemblies', assemblyPortalRoutes({ authenticate, service: assemblyService }));
  app.route('/api/portal/tenders', tenderPortalRoutes({ authenticate, service: tenderService }));
  app.route(
    '/api/portal',
    portalRoutes({
      authenticate,
      service: portalService,
      paymentReference: (ctx, unitId) => bankMatchService.paymentReference(ctx, unitId),
      ...(offsetService ? { offsets: offsetService } : {}),
      ...(planService ? { plans: planService } : {}),
    }),
  );

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  return app;
}
