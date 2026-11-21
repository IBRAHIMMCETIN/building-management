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
import { type FinanceService, DEFAULT_LATE_FEE_BASIS_POINTS, SYSTEM_ACTOR, createFinanceService } from '../modules/finance/service.js';
import { membershipRepository } from '../modules/memberships/repository.js';
import { loadPaymentsConfig } from '../modules/payments/config.js';
import { type PaymentsService, createPaymentsService } from '../modules/payments/service.js';
import { portalRepository } from '../modules/portal/repository.js';
import { createPortalService } from '../modules/portal/service.js';
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
 *   outbox_sweep   5 dakikada bir: esikten (varsayilan 2 dk) eski, hala bekleyen outbox
 *                  kayitlarini relay cekirdegiyle yeniden yayinlar (apartman dongusu yok; tek tur).
 *   ledger_audit   her gece 03:40: apartman basina SALT OKUNUR defter denetimi; sapma ->
 *                  log + `LedgerDrift` metrigi + platform alarmi (duzeltme yok). Pasif siteler dahil.
 *
 * Idempotency: her defter yazimi donem bazli anahtar kullanir (auto-dues-<YYYY-MM>,
 * lf-<YYYY-MM>-...), olay kimlikleri deterministiktir ve bildirim worker'i ayni olayi bir kez
 * isler. Bu yuzden mesajin tekrar islenmesi (SQS en az bir kez teslim) guvenlidir.
 *
 * Apartmanlar sirayla islenir; biri hata verirse digerleri devam eder, mesaj sonunda hata
 * olarak isaretlenir ve SQS tekrar dener (tamamlanmis apartmanlar tekrarda atlanir/replay).
 * 5 denemeden sonra DLQ + alarm. Olcek buyudugunde apartman basina mesaja (fan-out) gecilir.
 */

export const JOBS = ['late_fees', 'monthly_dues', 'dues_reminders', 'payment_reconcile', 'outbox_sweep', 'ledger_audit'] as const;
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
  /** null: online odeme kapali. Verilmezse ortam degiskenlerinden kurulur (ilk kullanimda). */
  payments: Pick<PaymentsService, 'reconcile' | 'reconcileRefunds'> | null;
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
  const lazy: { events?: EventPublisher; finance?: SchedulerDeps['finance']; payments?: SchedulerDeps['payments'] } = {};
  const lazyOps: { outbox?: SchedulerDeps['outbox']; auditor?: SchedulerDeps['auditor']; auditChain?: SchedulerDeps['auditChain']; metrics?: MetricsEmitter } = {};
  const now = overrides.now ?? (() => new Date());
  const events = () => (lazy.events ??= overrides.events ?? createEventPublisherFromEnv());
  const finance = () => (lazy.finance ??= overrides.finance ?? createFinanceService({ now, memberships: membershipRepository }));
  const payments = (): SchedulerDeps['payments'] => {
    if (lazy.payments !== undefined) return lazy.payments;
    if (overrides.payments !== undefined) return (lazy.payments = overrides.payments);
    const config = loadPaymentsConfig();
    if (config.providers.list().length === 0) return (lazy.payments = null);
    return (lazy.payments = createPaymentsService({
      portal: createPortalService({ now }),
      ledger: portalRepository,
      finance: createFinanceService({ now, memberships: membershipRepository }),
      // Mutabakat her niyeti kendi saglayicisiyla sorgular (acik tum saglayicilar).
      providers: config.providers,
      apiBaseUrl: config.apiBaseUrl,
      webAppUrl: config.webAppUrl,
      intentTtlMinutes: config.intentTtlMinutes,
      now,
    }));
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

  /** Salt okunur denetim: sapma bulgudur, is hatasi degildir (tekrar denemek sonucu degistirmez). */
  async function runAudit(apartmentId: string): Promise<SiteOutcome> {
    const report = await auditor().run(apartmentId);
    // Denetim gunlugu zinciri (kurcalama / silme tespiti); bulgular defter sapmasina eklenir.
    const chain = await auditChain().verify(auditScope(apartmentId));
    const drift = report.findings.length + chain.findings.length;
    metrics().emit(
      { LedgerDrift: drift, LedgerAuditUnstable: report.unstable.length, AuditChainBroken: chain.findings.length },
      { msg: 'ledger_audit_metrics', apartmentId },
    );
    const entry = {
      level: drift > 0 ? 'error' : 'info',
      msg: 'ledger_audit',
      apartmentId,
      counts: { ...report.counts, auditEntriesChecked: chain.checked },
      findings: [...report.findings, ...chain.findings],
      unstable: report.unstable,
    };
    if (drift > 0) log.error(JSON.stringify(entry));
    else log.info(JSON.stringify(entry));
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

      // Apartman dongusu disinda islenir (runJob); ledger_audit yukarida ayrilir.
      case 'outbox_sweep':
        return { apartmentId, status: 'skipped', reason: 'not_site_job' };
    }
  }

  async function runJob(message: JobMessage): Promise<SiteOutcome[]> {
    if (message.job === 'outbox_sweep') return [await runSweep()];
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
