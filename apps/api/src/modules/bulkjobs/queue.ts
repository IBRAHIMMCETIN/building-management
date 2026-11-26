import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { BulkJobMessage } from './types.js';

/** Toplu is mesajlarinin gonderildigi kuyruk (API: ilk mesaj, worker: devam mesaji). */
export type BulkJobQueue = { send(message: BulkJobMessage): Promise<void> };

export class BulkJobQueueError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BulkJobQueueError';
  }
}

/** SQS (Terraform: `bulk-jobs` kuyrugu). Kimlik bilgisi Lambda rolunden gelir. */
export function createSqsBulkJobQueue(queueUrl: string, client: Pick<SQSClient, 'send'> = new SQSClient({})): BulkJobQueue {
  return {
    async send(message) {
      try {
        await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message) }));
      } catch (err) {
        throw new BulkJobQueueError('Toplu is kuyruga birakilamadi', { cause: err });
      }
    },
  };
}

/**
 * Yerel gelistirme (kuyruk yok): mesaj ayni surecte, istegi bekletmeden islenir. Devam mesajlari
 * da ayni yoldan gelir; boylece yerelde de ayni parcali akis calisir.
 */
export function createInlineBulkJobQueue(handle: () => (message: BulkJobMessage) => Promise<void>, log: Pick<Console, 'error'> = console): BulkJobQueue {
  return {
    async send(message) {
      setTimeout(() => {
        handle()(message).catch((err: unknown) => log.error(JSON.stringify({ msg: 'bulk_job_inline_failed', jobId: message.jobId, error: err instanceof Error ? err.message : String(err) })));
      }, 0);
    },
  };
}

/** Testler: mesajlar biriktirilir, test kendisi isler. */
export function createMemoryBulkJobQueue() {
  const messages: BulkJobMessage[] = [];
  const queue: BulkJobQueue = {
    async send(message) {
      messages.push(structuredClone(message));
    },
  };
  return { queue, messages };
}

/** `BULK_JOBS_QUEUE_URL` varsa SQS kuyrugu, yoksa `undefined` (cagiran yerel yolu secer). */
export function loadBulkJobQueueFromEnv(env: NodeJS.ProcessEnv = process.env): BulkJobQueue | undefined {
  const url = env.BULK_JOBS_QUEUE_URL?.trim();
  return url ? createSqsBulkJobQueue(url) : undefined;
}

export function parseBulkJobMessage(body: string): BulkJobMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new BulkJobQueueError('Mesaj govdesi JSON degil');
  }
  const o = raw as Partial<BulkJobMessage> | null;
  const id = /^[A-Za-z0-9_-]{1,96}$/;
  if (!o || o.type !== 'bulk_job' || typeof o.apartmentId !== 'string' || !id.test(o.apartmentId) || typeof o.jobId !== 'string' || !id.test(o.jobId)) {
    throw new BulkJobQueueError('Gecersiz toplu is mesaji');
  }
  return { type: 'bulk_job', apartmentId: o.apartmentId, jobId: o.jobId, seq: Number.isInteger(o.seq) ? (o.seq as number) : 0 };
}
