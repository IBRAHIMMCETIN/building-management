import { createBulkJobService, type Budget, type BulkJobService } from '../modules/bulkjobs/service.js';
import { createDynamoBulkJobRepository } from '../modules/bulkjobs/repository.js';
import { loadBulkJobQueueFromEnv, parseBulkJobMessage } from '../modules/bulkjobs/queue.js';
import { createFinanceService } from '../modules/finance/service.js';
import { membershipRepository } from '../modules/memberships/repository.js';
import { createMeterPostingService } from '../modules/meters/posting.js';
import { createOwnershipReader } from '../modules/ownership/reader.js';
import type { SqsBatchResponse, SqsEvent } from './notification-worker.js';

/**
 * Arka plan toplu is worker'i (SQS `bulk-jobs` tuketicisi).
 *
 * Mesaj: `{ "type": "bulk_job", "apartmentId", "jobId", "seq" }`. Bir cagri isi kiralar ve kalan
 * Lambda suresi `safetyMs` altina dusene (veya cagri basina bolum sinirina) kadar parca parca
 * isler; bitmediyse kirayi birakip ayni kuyruga devam mesaji gonderir. Gecici hatada mesaj hata
 * olarak isaretlenir (SQS tekrar teslim eder; ilerleme is kaydinda). 5 denemeden sonra DLQ + alarm.
 *
 * Terraform: handler = "bulk-worker.handler", zaman asimi 300 sn, batch_size 1.
 */

/** Lambda baglamindan yalnizca kalan sure kullanilir. */
export type LambdaContextLike = { getRemainingTimeInMillis?: () => number };

export function createBulkWorker(deps: { service?: BulkJobService; log?: Pick<Console, 'info' | 'error'> } = {}) {
  const log = deps.log ?? console;
  let service = deps.service;
  const svc = () => {
    if (service) return service;
    const queue = loadBulkJobQueueFromEnv();
    if (!queue) throw new Error('BULK_JOBS_QUEUE_URL tanimli degil');
    const ownership = createOwnershipReader();
    const finance = createFinanceService({ memberships: membershipRepository, ownership });
    service = createBulkJobService({
      repository: createDynamoBulkJobRepository(),
      queue,
      finance,
      meters: createMeterPostingService({ finance, ownership }),
      options: {
        ...(process.env.BULK_JOB_CONCURRENCY ? { concurrency: Number(process.env.BULK_JOB_CONCURRENCY) } : {}),
        ...(process.env.BULK_JOB_BATCH_SIZE ? { batchSize: Number(process.env.BULK_JOB_BATCH_SIZE) } : {}),
      },
      log,
    });
    return service;
  };

  return async (event: SqsEvent, context?: LambdaContextLike): Promise<SqsBatchResponse> => {
    const failures: SqsBatchResponse['batchItemFailures'] = [];
    const budget: Budget = { remainingMs: () => context?.getRemainingTimeInMillis?.() ?? Number.POSITIVE_INFINITY };
    for (const record of event.Records ?? []) {
      try {
        const message = parseBulkJobMessage(record.body);
        const r = await svc().handle(message, budget);
        log.info(JSON.stringify({ msg: 'bulk_job_message', messageId: record.messageId, jobId: message.jobId, seq: message.seq, outcome: r.outcome, status: r.job?.status, processed: r.job?.processed, total: r.job?.total }));
      } catch (err) {
        log.error(JSON.stringify({ msg: 'bulk_job_message_failed', messageId: record.messageId, error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown' }));
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}

/** Lambda giris noktasi (Terraform: handler = "bulk-worker.handler"). */
export const handler = createBulkWorker();
