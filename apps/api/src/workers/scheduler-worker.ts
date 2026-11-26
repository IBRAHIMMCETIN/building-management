import { type OutboxStore, createDynamoOutboxStore } from '../events/outboxStore.js';
import { type EventPublisher, buildEvent, createEventPublisherFromEnv } from '../events/publisher.js';
import { DEFAULT_SWEEP_MIN_AGE_SECONDS, type SweepOptions, sweepOutbox } from '../events/sweep.js';
import { PLATFORM_SCOPE, auditScope } from '../modules/audit/log.js';
import { type ChainVerification, createAuditReader, createDynamoCheckpointStore, verifyAuditScope } from '../modules/audit/repository.js';
import { type LedgerAuditor, createDynamoAuditSource, createLedgerAuditor } from '../modules/finance/audit.js';
import { type MetricsEmitter, createEmfEmitterFromEnv } from '../observability/metrics.js';
import { type CoreRepository, coreRepository } from '../modules/core/repository.js';
import { type IsoDate, toKurus } from '../modules/core/types.js';
import { previousPeriod } from '../modules/finance/lateFee.js';
import { type PlanService, createPlanService } from '../modules/finance/plans.js';
import { type FinanceService, DEFAULT_LATE_FEE_BASIS_POINTS, SYSTEM_ACTOR, createFinanceService } from '../modules/finance/service.js';
import { membershipRepository } from '../modules/memberships/repository.js';
import { loadPaymentsConfig } from '../modules/payments/config.js';
import { type InvoiceService, createInvoiceService, previousPeriod as previousInvoicePeriod } from '../modules/payments/invoices.js';
import { type PayoutService, createPayoutService } from '../modules/payments/payouts.js';
import { type PaymentsService, createPaymentsService } from '../modules/payments/service.js';
import { portalRepository } from '../modules/portal/repository.js';
import { createPortalService } from '../modules/portal/service.js';
import { createOwnershipReader } from '../modules/ownership/reader.js';
import { type MaintenanceService, createMaintenanceService } from '../modules/maintenance/service.js';
import { type TicketService, createTicketService } from '../modules/tickets/service.js';
import type { SqsBatchResponse, SqsEvent } from './notification-worker.js';

/**
 * Zamanlanmis gorev worker'i (SQS tuketicisi).
 *
 * Akis: EventBridge Scheduler (Europe/Istanbul) -> SQS `scheduled-jobs` -> bu Lambda.
 * Mesaj: `{ "job": "...", "scheduledTime": "<aws.scheduler.scheduled-time>" }`
 *   - scheduledTime Scheduler'in PLANLANAN zamanidir (gecikmeli/tekrar teslimde degismez); is
 *     gunu ve donem bundan, Istanbul saatine gore turetilir. Elle tetiklemek icin herhangi bir
 *     ISO zaman verilebilir.
 *   - `apartmentId` verilirse yalnizca o apartman islenir (elle yeniden calistirma).
 *
 * Isler (karar 1a / 3a):
 *   late_fees      ayin 1'i 02:30  onceki ayin gecikme tazminatini kesinlestirir (+LATE_FEE_POSTED, outbox)
 *   monthly_dues   ayin 1'i 03:00  aylik aidat planini tahakkuk eder (+DUE_GENERATED, outbox)
 *   dues_reminders her gun 10:00   vadeden 3 gun once, 1 ve 7 gun sonra hatirlatir (+DUES_REMINDER)
 *   payment_reconcile 15 dakikada bir (Adim 8b): 30 dk'dan eski PENDING online odeme niyetlerini
 *                  saglayicidan sorgulayip sonuclandirir (kaybolan callback/webhook). Online odeme
 *                  kapaliysa (PAYMENTS_PROVIDERS bos) apartmanlar `payments_disabled` ile atlanir.
 *                  Ayrica (tum apartmanlar icin calistiginda) iadesi suren niyetlerin bekleyen
 *                  kalemlerini tekrar dener (`_refunds` satiri).
 *                  P4: ayrica bekleme suresi dolan platform transferlerini (PayTR) gonderir
 *                  (`payoutMode: send`; IBAN yalnizca burada KMS ile cozulur) ve yeniden gonderime
 *                  alinmis geri donen aktarimlari isler (`_payouts` satiri).
 *   payout_returns her gun 11:30 (P4): saglayicinin geri donen aktarim listesini aktarim kayitlariyla
 *                  esler -> RETURNED + kritik alarm (apartman dongusu yok; tek tur).
 *   platform_invoices ayin 1'i 04:10 (P4): onceki donemin platform komisyon faturasi taslaklarini
 *                  (aylik veya odeme bazli) uretir; kesilmis taslaklara dokunmaz.
 *   installment_plans her gun 09:30 (Finans 2.2): aktif taksit planlarinda temerrut (muacceliyet)
 *                  taramasi; yeni temerrutte sakine DUES_REMINDER `plan_default` (outbox) ve plan
 *                  `autoAccelerate` ise muaccel kilma, degilse yonetici onayi icin isaretleme.
 *   maintenance_tasks her gun 04:10 (O1-3): aktif bakim sablonlarinin penceresindeki (bugun .. +on
 *                  hazirlik + 30 gun) eksik gorevleri olusturur; gorev anahtari (vade + sablon)
 *                  sayesinde tekrar calismasi zararsizdir. Silme yapmaz.
 *   ticket_maintenance her gun 07:30 (O1-3): cozulup `autoCloseDays` gun onaylanmayan talepleri
 *                  kapatir (closeKind auto, bildirim outbox ile) ve yonetim / gorevliye gunluk
 *                  operasyon ozeti (`OPERATIONS_DIGEST`: SLA asimi, geciken ve yaklasan bakim) yayinlar.
 *                  Olay kimligi gun bazli deterministiktir (tekrar teslimde bildirim bir kez).
 *   outbox_sweep   5 dakikada bir: esikten (varsayilan 2 dk) eski, hala bekleyen outbox
 *                  kayitlarini relay cekirdegiyle yeniden yayinlar (apartman dongusu yok; tek tur).
 *   ledger_audit   her gece 03:40: apartman basina SALT OKUNUR defter denetimi; sapma ->
 *                  log + `LedgerDrift` metrigi + platform alarmi (duzeltme yok). Pasif siteler dahil.
 *                  Faz B3: banka hesabi mutabakati (son ekstre kapanisi <-> defter, bekleyen
 *                  satirlarla aciklanamayan fark) `BankReconDiff` (kurus, mutlak toplam) ve
 *                  `BankReconAccountsOff` (farkli hesap sayisi) metrikleri.
 *
 * Idempotency: her defter yazimi donem bazli anahtar kullanir (auto-dues-<YYYY-MM>,
 * lf-<YYYY-MM>-...), olay kimlikleri deterministiktir ve bildirim worker'i ayni olayi bir kez
 * isler. Bu yuzden mesajin tekrar islenmesi (SQS en az bir kez teslim) guvenlidir.
 *
 * Apartmanlar sirayla islenir; biri hata verirse digerleri devam eder, mesaj sonunda hata
 * olarak isaretlenir ve SQS tekrar dener (tamamlanmis apartmanlar tekrarda atlanir/replay).
 * 5 denemeden sonra DLQ + alarm. Olcek buyudugunde apartman basina mesaja (fan-out) gecilir.
 */

export const JOBS = [
  'late_fees',
  'monthly_dues',
  'dues_reminders',
  'payment_reconcile',
  'outbox_sweep',
  'ledger_audit',
  'payout_returns',
  'platform_invoices',
  'installment_plans',
  'maintenance_tasks',
  'ticket_maintenance',
] as const;
export type Job = (typeof JOBS)[number];

export type JobMessage = { job: Job; scheduledTime: string; apartmentId?: string };

export class InvalidJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidJobError';
  }
}

export function parseJobMessage(body: string): JobMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new InvalidJobError('Mesaj govdesi JSON degil');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new InvalidJobError('Mesaj bir nesne olmalidir');
  const { job, scheduledTime, apartmentId } = raw as Record<string, unknown>;
  if (typeof job !== 'string' || !(JOBS as readonly string[]).includes(job)) {
    throw new InvalidJobError(`Bilinmeyen is: ${String(job)}`);
  }
  if (typeof scheduledTime !== 'string' || Number.isNaN(Date.parse(scheduledTime))) {
    throw new InvalidJobError('scheduledTime gecerli bir ISO zaman olmali');
  }
  if (apartmentId !== undefined && (typeof apartmentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(apartmentId))) {
    throw new InvalidJobError('apartmentId gecersiz');
  }
  return { job: job as Job, scheduledTime, apartmentId: apartmentId as string | undefined };
}

/** ISO zaman -> Istanbul takvim gunu. */
export function istanbulDate(iso: string): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date(iso));
}

export type SiteOutcome =
  | { apartmentId: string; status: 'done'; detail: Record<string, unknown> }
  | { apartmentId: string; status: 'skipped'; reason: string }
  | { apartmentId: string; status: 'failed'; error: string };

export type SchedulerDeps = {
  core: Pick<CoreRepository, 'listSiteIds' | 'getSite'>;
  finance: Pick<FinanceService, 'autoChargeDues' | 'postLateFees' | 'dueReminders'>;
  /** Finans 2.2: taksit plani temerrut taramasi (verilmezse ilk kullanimda kurulur). */
  plans: Pick<PlanService, 'checkDefaults'>;
  /** O1-3: talep otomatik kapanisi + SLA listesi ve bakim gorevi uretimi / ozet kalemleri. */
  tickets: Pick<TicketService, 'runDaily'>;
  maintenance: Pick<MaintenanceService, 'generate' | 'digestItems'>;
  /** null: online odeme kapali. Verilmezse ortam degiskenlerinden kurulur (ilk kullanimda). */
  payments: Pick<PaymentsService, 'reconcile' | 'reconcileRefunds'> | null;
  /** P4: platform transferi izleme (null: online odeme kapali). */
  payouts: Pick<PayoutService, 'detectReturned' | 'processResends'> | null;
  /** P4: platform komisyon faturasi taslaklari (null: online odeme kapali). */
  invoices: Pick<InvoiceService, 'draftPeriod'> | null;
  events: EventPublisher;
  /** Outbox suprucusunun deposu (varsayilan DynamoDB). */
  outbox: Pick<OutboxStore, 'listPendingPage' | 'markPublished'>;
  sweepOptions: SweepOptions;
  auditor: Pick<LedgerAuditor, 'run'>;
  /** Denetim gunlugu hash zinciri dogrulamasi (kapsam: `APT#<id>` veya `PLATFORM`). */
  auditChain: { verify(scope: string): Promise<ChainVerification> };
  metrics: MetricsEmitter;
  now: () => Date;
  log: Pick<Console, 'info' | 'error'>;
};

const errorText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : 'unknown');

export function createSchedulerWorker(overrides: Partial<SchedulerDeps> = {}) {
  const lazy: {
    events?: EventPublisher;
    finance?: SchedulerDeps['finance'];
    plans?: SchedulerDeps['plans'];
    tickets?: SchedulerDeps['tickets'];
    maintenance?: SchedulerDeps['maintenance'];
    payments?: SchedulerDeps['payments'];
    payouts?: SchedulerDeps['payouts'];
    invoices?: SchedulerDeps['invoices'];
  } = {};
  const lazyOps: { outbox?: SchedulerDeps['outbox']; auditor?: SchedulerDeps['auditor']; auditChain?: SchedulerDeps['auditChain']; metrics?: MetricsEmitter } = {};
  const now = overrides.now ?? (() => new Date());
  const events = () => (lazy.events ??= overrides.events ?? createEventPublisherFromEnv());
  const finance = () =>
    (lazy.finance ??= overrides.finance ?? createFinanceService({ now, memberships: membershipRepository, ownership: createOwnershipReader() }));
  const plans = () =>
    (lazy.plans ??=
      overrides.plans ??
      createPlanService({ finance: createFinanceService({ now, memberships: membershipRepository, ownership: createOwnershipReader() }), now }));
  // O1-3: zamanlayicida fotograf deposu gerekmez (store: undefined).
  const ticketService = () => createTicketService({ now, store: undefined });
  const tickets = () => (lazy.tickets ??= overrides.tickets ?? ticketService());
  const maintenance = () => (lazy.maintenance ??= overrides.maintenance ?? createMaintenanceService({ now, store: undefined, tickets: ticketService() }));
  /** Odeme servisleri tek yapilandirmadan, ilk kullanimda kurulur. */
  function paymentServices() {
    if (lazy.payments !== undefined && lazy.payouts !== undefined && lazy.invoices !== undefined) return;
    const needConfig = overrides.payments === undefined || overrides.payouts === undefined || overrides.invoices === undefined;
    const config = needConfig ? loadPaymentsConfig() : undefined;
    const enabled = Boolean(config && config.providers.list().length > 0);
    lazy.payments =
      overrides.payments !== undefined
        ? overrides.payments
        : enabled && config
          ? createPaymentsService({
              portal: createPortalService({ now, ownership: createOwnershipReader() }),
              ledger: portalRepository,
              finance: createFinanceService({ now, memberships: membershipRepository, ownership: createOwnershipReader() }),
              // Mutabakat her niyeti kendi saglayicisiyla sorgular (acik tum saglayicilar).
              providers: config.providers,
              // P4: vadesi gelen platform transferleri burada gonderilir (IBAN yalnizca burada cozulur).
              ...(config.vault ? { vault: config.vault } : {}),
              payoutMode: 'send',
              apiBaseUrl: config.apiBaseUrl,
              webAppUrl: config.webAppUrl,
              intentTtlMinutes: config.intentTtlMinutes,
              now,
            })
          : null;
    lazy.payouts =
      overrides.payouts !== undefined
        ? overrides.payouts
        : enabled && config
          ? createPayoutService({ providers: config.providers, ...(config.vault ? { vault: config.vault } : {}), now })
          : null;
    lazy.invoices =
      overrides.invoices !== undefined ? overrides.invoices : enabled && config ? createInvoiceService({ settings: config.invoices, now }) : null;
  }
  const payments = (): SchedulerDeps['payments'] => {
    paymentServices();
    return lazy.payments ?? null;
  };
  const payouts = (): SchedulerDeps['payouts'] => {
    paymentServices();
    return lazy.payouts ?? null;
  };
  const invoices = (): SchedulerDeps['invoices'] => {
    paymentServices();
    return lazy.invoices ?? null;
  };
  const core = overrides.core ?? coreRepository;
  const log = overrides.log ?? console;
  const outbox = () => (lazyOps.outbox ??= overrides.outbox ?? createDynamoOutboxStore());
  const auditor = () => (lazyOps.auditor ??= overrides.auditor ?? createLedgerAuditor(createDynamoAuditSource()));
  const metrics = () => (lazyOps.metrics ??= overrides.metrics ?? createEmfEmitterFromEnv());
  const auditChain = () =>
    (lazyOps.auditChain ??=
      overrides.auditChain ??
      (() => {
        const deps = { reader: createAuditReader(), checkpoints: createDynamoCheckpointStore(), now };
        return { verify: (scope: string) => verifyAuditScope(scope, deps) };
      })());
  const sweepOptions: SweepOptions = overrides.sweepOptions ?? {
    minAgeSeconds: Number(process.env.OUTBOX_SWEEP_MIN_AGE_SECONDS ?? DEFAULT_SWEEP_MIN_AGE_SECONDS),
  };

  /** Outbox suprucusu: tum apartmanlar icin tek tur (GSI1 apartmandan bagimsiz). */
  async function runSweep(): Promise<SiteOutcome> {
    try {
      const r = await sweepOutbox({ store: outbox(), publisher: events(), now, log }, sweepOptions);
      metrics().emit(
        { OutboxSweepStale: r.stale, OutboxSweepPublished: r.published, OutboxSweepFailed: r.failed, OutboxSweepInvalid: r.invalid },
        { msg: 'outbox_sweep', truncated: r.truncated },
      );
      metrics().emit({ OutboxOldestPendingSeconds: r.oldestAgeSeconds }, { msg: 'outbox_sweep_age' }, 'Seconds');
      // Yayin hatalari is hatasi sayilmaz (kayit bekleyen kalir, sonraki tur tekrar dener; metrik
      // alarmi uyarir). Altyapi hatasi (sorgu) ise is hatasidir.
      return { apartmentId: '_outbox', status: 'done', detail: { ...r } };
    } catch (err) {
      return { apartmentId: '_outbox', status: 'failed', error: errorText(err) };
    }
  }

  /** P4: geri donen aktarimlar (saglayici listesi; tum apartmanlar icin tek tur). */
  async function runPayoutReturns(): Promise<SiteOutcome> {
    const service = payouts();
    if (!service) return { apartmentId: '_payouts', status: 'skipped', reason: 'payments_disabled' };
    try {
      return { apartmentId: '_payouts', status: 'done', detail: await service.detectReturned() };
    } catch (err) {
      return { apartmentId: '_payouts', status: 'failed', error: errorText(err) };
    }
  }

  /** Salt okunur denetim: sapma bulgudur, is hatasi degildir (tekrar denemek sonucu degistirmez). */
  async function runAudit(apartmentId: string): Promise<SiteOutcome> {
    // Denetim gunlugu zinciri (kurcalama / silme tespiti); bulgular defter sapmasina eklenir.
    // Zincir dogrulamasi defter denetiminden ONCE ve ondan bagimsiz calisir: defter denetimi
    // (veya tersi) hata verse bile diger tarafin kontrol noktasi/metrigi uretilir. Aksi halde tek
    // bir defter hatasi zinciri hic dogrulatmaz ve arayuz "dogrulama guncel degil" gosterir.
    const scope = auditScope(apartmentId);
    let chain: ChainVerification;
    let chainError: string | undefined;
    try {
      chain = await auditChain().verify(scope);
    } catch (err) {
      chainError = errorText(err);
      chain = { scope, checked: 0, findings: [] };
      log.error(JSON.stringify({ level: 'error', msg: 'audit_chain_verify_failed', apartmentId, error: chainError }));
    }
    const report = await auditor().run(apartmentId);
    const drift = report.findings.length + chain.findings.length;
    metrics().emit(
      { LedgerDrift: drift, LedgerAuditUnstable: report.unstable.length, AuditChainBroken: chain.findings.length },
      { msg: 'ledger_audit_metrics', apartmentId },
    );
    // Faz B3: banka mutabakati (kaynak eski surumse alan yok -> metrik de yok).
    const recon = report.bankRecon;
    if (recon) {
      const off = recon.filter((r) => r.unexplainedDiff !== 0);
      metrics().emit({ BankReconDiff: off.reduce((sum, r) => sum + Math.abs(r.unexplainedDiff), 0) }, { msg: 'bank_recon_metrics', apartmentId, accounts: off }, 'None');
      metrics().emit({ BankReconAccountsOff: off.length }, { msg: 'bank_recon_accounts', apartmentId });
    }
    const entry = {
      level: drift > 0 ? 'error' : 'info',
      msg: 'ledger_audit',
      apartmentId,
      counts: { ...report.counts, auditEntriesChecked: chain.checked },
      findings: [...report.findings, ...chain.findings],
      unstable: report.unstable,
      ...(recon ? { bankRecon: recon } : {}),
    };
    if (drift > 0) log.error(JSON.stringify(entry));
    else log.info(JSON.stringify(entry));
    if (chainError) return { apartmentId, status: 'failed', error: `audit_chain: ${chainError}` };
    return { apartmentId, status: 'done', detail: { findings: drift, unstable: report.unstable.length, auditEntriesChecked: chain.checked } };
  }

  /** Platform zinciri (kullanici tercihleri vb.): tum apartmanlar icin calisan gecelik turda bir kez. */
  async function runPlatformChain(): Promise<SiteOutcome> {
    try {
      const chain = await auditChain().verify(PLATFORM_SCOPE);
      metrics().emit({ LedgerDrift: chain.findings.length, AuditChainBroken: chain.findings.length }, { msg: 'ledger_audit_metrics', apartmentId: '_platform' });
      if (chain.findings.length > 0) log.error(JSON.stringify({ level: 'error', msg: 'ledger_audit', apartmentId: '_platform', findings: chain.findings }));
      // Kalp atisi: gece denetimi calisti (alarm: 1 gun boyunca veri yoksa denetim calismiyor).
      metrics().emit({ AuditRun: 1 }, { msg: 'ledger_audit_run' });
      return { apartmentId: '_platform', status: 'done', detail: { findings: chain.findings.length, auditEntriesChecked: chain.checked } };
    } catch (err) {
      return { apartmentId: '_platform', status: 'failed', error: errorText(err) };
    }
  }

  async function runForSite(job: Job, apartmentId: string, day: IsoDate): Promise<SiteOutcome> {
    const site = await core.getSite(apartmentId);
    // Denetim pasif sitelerde de calisir (defter kapanmis olsa da tutarli kalmali).
    if (job === 'ledger_audit') return site ? runAudit(apartmentId) : { apartmentId, status: 'skipped', reason: 'site_missing' };
    if (!site || site.status !== 'active') return { apartmentId, status: 'skipped', reason: 'site_inactive' };
    const settings = site.settings;

    switch (job) {
      case 'monthly_dues': {
        const r = await finance().autoChargeDues(apartmentId, {
          period: day.slice(0, 7),
          plan: settings.monthlyDuesPlan,
          dueDayOfMonth: settings.dueDayOfMonth,
        });
        if (r.status === 'skipped') return { apartmentId, status: 'skipped', reason: r.reason };
        return { apartmentId, status: 'done', detail: { batchId: r.batchId, count: r.count, replayed: r.replayed } };
      }

      case 'late_fees': {
        const period = previousPeriod(day.slice(0, 7));
        const r = await finance().postLateFees(apartmentId, {
          period,
          monthlyBasisPoints: settings.lateFeeMonthlyBasisPoints ?? DEFAULT_LATE_FEE_BASIS_POINTS,
          dueDayOfMonth: settings.dueDayOfMonth,
        });
        // LATE_FEE_POSTED olaylari her tazminat kaydiyla ayni atomik yazimda outbox'a girer
        // (finance.postLateFees); burada ayrica yayin yapilmaz.
        return { apartmentId, status: 'done', detail: { period, count: r.count, totalAmount: r.totalAmount } };
      }

      case 'dues_reminders': {
        const items = await finance().dueReminders(apartmentId, day);
        if (items.length > 0) {
          await events().publish(
            buildEvent(
              {
                eventId: `DUES_REMINDER:${apartmentId}:${day}`,
                type: 'DUES_REMINDER',
                apartmentId,
                actorId: SYSTEM_ACTOR,
                payload: {
                  date: day,
                  items: items.map((i) => ({ ...i, amount: toKurus(i.amount) })),
                },
              },
              now,
            ),
          );
        }
        return { apartmentId, status: 'done', detail: { date: day, reminders: items.length } };
      }

      case 'payment_reconcile': {
        const service = payments();
        if (!service) return { apartmentId, status: 'skipped', reason: 'payments_disabled' };
        const r = await service.reconcile(apartmentId);
        return { apartmentId, status: 'done', detail: r };
      }

      case 'platform_invoices': {
        const service = invoices();
        if (!service) return { apartmentId, status: 'skipped', reason: 'payments_disabled' };
        const r = await service.draftPeriod(apartmentId, previousInvoicePeriod(day));
        return { apartmentId, status: 'done', detail: r };
      }

      case 'installment_plans': {
        // DUES_REMINDER `plan_default` olaylari plan yazimiyla ayni atomik islemde outbox'a girer.
        const r = await plans().checkDefaults(apartmentId, day);
        return { apartmentId, status: 'done', detail: { date: day, ...r } };
      }

      case 'maintenance_tasks': {
        const r = await maintenance().generate(apartmentId, day);
        return { apartmentId, status: 'done', detail: { date: day, ...r } };
      }

      case 'ticket_maintenance': {
        const r = await tickets().runDaily(apartmentId);
        const m = await maintenance().digestItems(apartmentId, day);
        const hasItems = r.breached.length > 0 || m.dueSoon.length > 0 || m.overdue.length > 0 || r.autoClosed > 0;
        if (hasItems) {
          await events().publish(
            buildEvent(
              {
                eventId: `OPS_DIGEST:${apartmentId}:${day}`,
                type: 'OPERATIONS_DIGEST',
                apartmentId,
                actorId: SYSTEM_ACTOR,
                payload: { date: day, slaBreached: r.breached, maintenanceDue: m.dueSoon, maintenanceOverdue: m.overdue, autoClosed: r.autoClosed },
              },
              now,
            ),
          );
        }
        return {
          apartmentId,
          status: 'done',
          detail: { date: day, autoClosed: r.autoClosed, conflicts: r.conflicts, slaBreached: r.breached.length, maintenanceDue: m.dueSoon.length, maintenanceOverdue: m.overdue.length, digest: hasItems },
        };
      }

      // Apartman dongusu disinda islenir (runJob); ledger_audit yukarida ayrilir.
      case 'outbox_sweep':
      case 'payout_returns':
        return { apartmentId, status: 'skipped', reason: 'not_site_job' };
    }
  }

  async function runJob(message: JobMessage): Promise<SiteOutcome[]> {
    if (message.job === 'outbox_sweep') return [await runSweep()];
    if (message.job === 'payout_returns') return [await runPayoutReturns()];
    const day = istanbulDate(message.scheduledTime);
    const ids = message.apartmentId ? [message.apartmentId] : await core.listSiteIds();
    const outcomes: SiteOutcome[] = [];
    for (const apartmentId of ids) {
      try {
        outcomes.push(await runForSite(message.job, apartmentId, day));
      } catch (err) {
        outcomes.push({ apartmentId, status: 'failed', error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown' });
      }
    }
    // Iadeler apartman durumundan bagimsiz (pasif sitedeki iade de tamamlanmali); tek sefer.
    if (message.job === 'ledger_audit' && !message.apartmentId) outcomes.push(await runPlatformChain());
    if (message.job === 'payment_reconcile' && !message.apartmentId) {
      const service = payments();
      if (service) {
        try {
          outcomes.push({ apartmentId: '_refunds', status: 'done', detail: await service.reconcileRefunds() });
        } catch (err) {
          outcomes.push({ apartmentId: '_refunds', status: 'failed', error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown' });
        }
      }
      // P4: yeniden gonderime alinmis geri donen aktarimlar (tum apartmanlar; tek tur).
      const p = payouts();
      if (p) {
        try {
          outcomes.push({ apartmentId: '_payouts', status: 'done', detail: await p.processResends() });
        } catch (err) {
          outcomes.push({ apartmentId: '_payouts', status: 'failed', error: errorText(err) });
        }
      }
    }
    return outcomes;
  }

  const handler = async (sqsEvent: SqsEvent): Promise<SqsBatchResponse> => {
    const failures: SqsBatchResponse['batchItemFailures'] = [];
    for (const record of sqsEvent.Records ?? []) {
      let message: JobMessage | undefined;
      try {
        message = parseJobMessage(record.body);
        const outcomes = await runJob(message);
        const failed = outcomes.filter((o) => o.status === 'failed');
        log.info(
          JSON.stringify({
            msg: 'job_processed',
            messageId: record.messageId,
            job: message.job,
            day: istanbulDate(message.scheduledTime),
            sites: outcomes.length,
            done: outcomes.filter((o) => o.status === 'done').length,
            skipped: outcomes.filter((o) => o.status === 'skipped').length,
            failed: failed.length,
            outcomes,
          }),
        );
        if (failed.length > 0) failures.push({ itemIdentifier: record.messageId });
      } catch (err) {
        log.error(
          JSON.stringify({
            msg: 'job_failed',
            messageId: record.messageId,
            job: message?.job,
            error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown',
          }),
        );
        // Bozuk mesaj tekrar denense de duzelmez; yine de DLQ'ya dusup alarm uretmesi icin
        // hata olarak isaretlenir.
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };

  return Object.assign(handler, { runJob });
}

/** Lambda giris noktasi (Terraform: handler = "scheduler-worker.handler"). */
export const handler = createSchedulerWorker();
