import { type EventPublisher, buildEvent, createEventPublisherFromEnv } from '../events/publisher.js';
import { type CoreRepository, coreRepository } from '../modules/core/repository.js';
import { type IsoDate, toKurus } from '../modules/core/types.js';
import { previousPeriod } from '../modules/finance/lateFee.js';
import { type FinanceService, DEFAULT_LATE_FEE_BASIS_POINTS, SYSTEM_ACTOR, createFinanceService } from '../modules/finance/service.js';
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
 *   late_fees      ayin 1'i 02:30  onceki ayin gecikme tazminatini kesinlestirir (+LATE_FEE_POSTED)
 *   monthly_dues   ayin 1'i 03:00  aylik aidat planini tahakkuk eder (+DUE_GENERATED)
 *   dues_reminders her gun 10:00   vadeden 3 gun once, 1 ve 7 gun sonra hatirlatir (+DUES_REMINDER)
 *
 * Idempotency: her defter yazimi donem bazli anahtar kullanir (auto-dues-<YYYY-MM>,
 * lf-<YYYY-MM>-...), olay kimlikleri deterministiktir ve bildirim worker'i ayni olayi bir kez
 * isler. Bu yuzden mesajin tekrar islenmesi (SQS en az bir kez teslim) guvenlidir.
 *
 * Apartmanlar sirayla islenir; biri hata verirse digerleri devam eder, mesaj sonunda hata
 * olarak isaretlenir ve SQS tekrar dener (tamamlanmis apartmanlar tekrarda atlanir/replay).
 * 5 denemeden sonra DLQ + alarm. Olcek buyudugunde apartman basina mesaja (fan-out) gecilir.
 */

export const JOBS = ['late_fees', 'monthly_dues', 'dues_reminders'] as const;
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
  events: EventPublisher;
  now: () => Date;
  log: Pick<Console, 'info' | 'error'>;
};

export function createSchedulerWorker(overrides: Partial<SchedulerDeps> = {}) {
  const lazy: { events?: EventPublisher; finance?: SchedulerDeps['finance'] } = {};
  const now = overrides.now ?? (() => new Date());
  const events = () => (lazy.events ??= overrides.events ?? createEventPublisherFromEnv());
  const finance = () => (lazy.finance ??= overrides.finance ?? createFinanceService({ events: events(), now }));
  const core = overrides.core ?? coreRepository;
  const log = overrides.log ?? console;

  async function runForSite(job: Job, apartmentId: string, day: IsoDate): Promise<SiteOutcome> {
    const site = await core.getSite(apartmentId);
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
        const fresh = r.items.filter((i) => !i.replayed);
        const first = fresh[0];
        if (first) {
          // Yarim kalan calisma tekrarlandiginda yalnizca yeni yazilanlar bildirilir (olay kimligi
          // yeni ilk kayda gore degisir; ayni kalem iki kez bildirilmez).
          await events().publish(
            buildEvent(
              {
                eventId: `LATE_FEE_POSTED:${period}:${first.transactionId}`,
                type: 'LATE_FEE_POSTED',
                apartmentId,
                actorId: SYSTEM_ACTOR,
                payload: {
                  period,
                  items: fresh.map(({ unitId, liableParty, amount, transactionId }) => ({ unitId, liableParty, amount, transactionId })),
                },
              },
              now,
            ),
          );
        }
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
    }
  }

  async function runJob(message: JobMessage): Promise<SiteOutcome[]> {
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
