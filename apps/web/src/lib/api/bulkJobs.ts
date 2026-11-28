import { z } from 'zod';
import { apiClient } from './client';

/**
 * Arka plan toplu isleri (buyuk toplu aidat tahakkuku, buyuk sayac donemi onayi / geri alma ve
 * 1.000+ bolumlu donemin dagitim onizlemesi).
 *   GET  /api/jobs/:jobId         durum + ilerleme
 *   POST /api/jobs/:jobId/retry   basarisiz / hatali biten isi yeniden baslatir
 * Baslatan uclar 202 ve `{ mode: 'job', job }` doner.
 */
export const BULK_JOB_STATUSES = ['pending', 'running', 'completed', 'completed_with_errors', 'failed'] as const;
export type BulkJobStatus = (typeof BULK_JOB_STATUSES)[number];
export const TERMINAL_JOB_STATUSES: readonly BulkJobStatus[] = ['completed', 'completed_with_errors', 'failed'];

export const bulkJobSchema = z.object({
  jobId: z.string(),
  kind: z.enum(['dues_bulk', 'meter_posting', 'meter_reversal', 'meter_calculation']),
  status: z.enum(BULK_JOB_STATUSES),
  phase: z.enum(['prepare', 'post', 'finalize']).optional(),
  total: z.number().int(),
  processed: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  written: z.number().int().default(0),
  percent: z.number().int(),
  failures: z.array(z.object({ unitId: z.string(), unitNumber: z.string().optional(), message: z.string() })).default([]),
  result: z
    .object({
      batchId: z.string().optional(),
      count: z.number().int().optional(),
      distributedAmount: z.number().int().optional(),
      exemptCount: z.number().int().optional(),
      vacantCount: z.number().int().optional(),
      posted: z.number().int().optional(),
      reversed: z.number().int().optional(),
      written: z.number().int().optional(),
      replayed: z.boolean().optional(),
      /** Sayac onizlemesi (1.000+ bolum): hesap yapildi mi, calcHash, bolum / tahakkuk / engel sayisi. */
      ok: z.boolean().optional(),
      calcHash: z.string().optional(),
      unitCount: z.number().int().optional(),
      chargeCount: z.number().int().optional(),
      blockerCount: z.number().int().optional(),
    })
    .optional(),
  error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
});
export type BulkJob = z.infer<typeof bulkJobSchema>;

export const jobAcceptedSchema = z.object({ mode: z.literal('job'), created: z.boolean().optional(), job: bulkJobSchema });
export type JobAccepted = z.infer<typeof jobAcceptedSchema>;

export const isTerminalJob = (job: Pick<BulkJob, 'status'> | undefined) => !!job && TERMINAL_JOB_STATUSES.includes(job.status);

const enc = encodeURIComponent;

/** P1-b: donemin suren / son isi (sayfa yenilense de ilerleme izlenir). */
export const periodJobSchema = z.object({ job: bulkJobSchema.nullable() });

export const bulkJobsApi = {
  get: (jobId: string, signal?: AbortSignal) => apiClient.get(`/api/jobs/${enc(jobId)}`, { signal, schema: bulkJobSchema }),
  retry: (jobId: string) => apiClient.post(`/api/jobs/${enc(jobId)}/retry`, undefined, { schema: bulkJobSchema }),
};

/** "İşleniyor: 420 / 1.250 bölüm (%34)" */
export function progressText(job: Pick<BulkJob, 'processed' | 'total' | 'percent' | 'kind' | 'phase' | 'status'>): string {
  if (job.status === 'pending') return 'Sıraya alındı, birazdan başlayacak…';
  if (job.kind === 'meter_calculation' && job.status === 'running') return `Dağıtım hesaplanıyor (${job.total.toLocaleString('tr-TR')} bölüm)…`;
  if (job.kind === 'meter_posting' && job.phase === 'prepare') return 'Dağıtım yeniden hesaplanıyor ve doğrulanıyor…';
  if (job.kind === 'meter_posting' && job.phase === 'finalize' && job.status === 'running') return 'Tahakkuk yazıldı; özet ve sayaç imleçleri güncelleniyor…';
  if (job.kind === 'meter_reversal' && job.phase === 'prepare') return 'Geri alma engelleri kontrol ediliyor…';
  if (job.kind === 'meter_reversal' && job.phase === 'finalize' && job.status === 'running') return 'Ters kayıtlar yazıldı; sayaç imleçleri geri yükleniyor…';
  const fmt = (n: number) => n.toLocaleString('tr-TR');
  return `İşleniyor: ${fmt(job.processed)} / ${fmt(job.total)} bölüm (%${job.percent})`;
}
