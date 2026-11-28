import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';

/**
 * Adim 2-2: zamanlanmis isin site basina mesajlara bolunmesi (fan-out).
 *
 * `ledger_audit` gibi tum siteleri tek Lambda cagrisinda tarayan isler, siteler buyudukce
 * 300 sn sinirina yaklasir ve tek sitedeki hata tum turu yeniden denetir. Fan-out ile her site
 * ayni `scheduled-jobs` kuyruguna `{ job, scheduledTime, apartmentId }` mesaji olarak birakilir:
 * her site ayri Lambda cagrisinda, ayri yeniden deneme / DLQ ile islenir.
 */
export type JobFanoutMessage = { job: string; scheduledTime: string; apartmentId: string };

export type JobFanout = { enqueue(messages: readonly JobFanoutMessage[]): Promise<{ queued: number }> };

export class JobFanoutError extends Error {
  readonly failed: string[];
  constructor(message: string, failed: string[], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JobFanoutError';
    this.failed = failed;
  }
}

const BATCH = 10; // SQS SendMessageBatch ust siniri

/** SQS (Terraform: `scheduled-jobs` kuyrugu, `SCHEDULED_JOBS_QUEUE_URL`). */
export function createSqsJobFanout(queueUrl: string, client: Pick<SQSClient, 'send'> = new SQSClient({})): JobFanout {
  return {
    async enqueue(messages) {
      let queued = 0;
      const failed: string[] = [];
      for (let i = 0; i < messages.length; i += BATCH) {
        const chunk = messages.slice(i, i + BATCH);
        try {
          const out = await client.send(
            new SendMessageBatchCommand({
              QueueUrl: queueUrl,
              Entries: chunk.map((m, j) => ({ Id: String(j), MessageBody: JSON.stringify(m) })),
            }),
          );
          queued += out.Successful?.length ?? 0;
          for (const f of out.Failed ?? []) {
            const m = chunk[Number(f.Id)];
            if (m) failed.push(m.apartmentId);
          }
        } catch (err) {
          throw new JobFanoutError('Site mesajlari kuyruga birakilamadi', [...failed, ...messages.slice(i).map((m) => m.apartmentId)], { cause: err });
        }
      }
      if (failed.length) throw new JobFanoutError(`${failed.length} site mesaji kuyruga birakilamadi`, failed);
      return { queued };
    },
  };
}

/** `SCHEDULED_JOBS_QUEUE_URL` varsa SQS, yoksa null (yerel/test: siteler ayni cagrida sirayla). */
export function loadJobFanoutFromEnv(env: NodeJS.ProcessEnv = process.env): JobFanout | null {
  const url = env.SCHEDULED_JOBS_QUEUE_URL?.trim();
  return url ? createSqsJobFanout(url) : null;
}

/** Testler: mesajlar biriktirilir. */
export function createMemoryJobFanout() {
  const messages: JobFanoutMessage[] = [];
  const fanout: JobFanout = {
    async enqueue(list) {
      messages.push(...list.map((m) => ({ ...m })));
      return { queued: list.length };
    },
  };
  return { fanout, messages };
}
