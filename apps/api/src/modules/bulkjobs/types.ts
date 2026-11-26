/**
 * Arka plan toplu islemleri (bulkjobs): buyuk toplu aidat tahakkuku ve sayac donemi onayi HTTP
 * isteginde degil, SQS + worker ile parca parca yazilir.
 *
 * DynamoDB (ana tablo, tenant bolumu):
 *   PK = APT#<apartmentId>, SK = BULKJOB#<jobId>               is kaydi (durum, sayaclar, kira)
 *   PK = APT#<apartmentId>, SK = BULKJOB#<jobId>#L#<0000>      dondurulmus aidat satirlari (250'ser)
 *   PK = APT#<apartmentId>, SK = BULKJOB#<jobId>#R#<00000>     yazilan aidat kalemlerinin sonucu
 * Tum kayitlar `ttl` (90 gun) tasir; defter kayitlari (TX/LE) bu kayitlardan bagimsizdir ve
 * idempotency anahtarlariyla korunur.
 */
import type { Role } from '../../auth/claims.js';
import type { BulkDuesLine, BulkDuesLineResult, BulkDuesSpec } from '../finance/service.js';

export const BULK_JOB_KINDS = ['dues_bulk', 'meter_posting'] as const;
export type BulkJobKind = (typeof BULK_JOB_KINDS)[number];

export const BULK_JOB_STATUSES = ['pending', 'running', 'completed', 'completed_with_errors', 'failed'] as const;
export type BulkJobStatus = (typeof BULK_JOB_STATUSES)[number];
export const TERMINAL_STATUSES: readonly BulkJobStatus[] = ['completed', 'completed_with_errors', 'failed'];

/** Aidat satirlari kayit basina (DynamoDB 400 KB sinirinin cok altinda). */
export const LINE_CHUNK = 250;
/** Is kaydinda saklanan hatali bolum ornegi ust siniri (sayac `failed` tamdir). */
export const MAX_FAILURE_SAMPLES = 50;
/** Is kayitlarinin saklanma suresi. */
export const JOB_TTL_DAYS = 90;

export type BulkJobFailure = { unitId: string; unitNumber?: string; message: string };

export type DuesJobParams = {
  spec: BulkDuesSpec;
  /** Satir kayitlarinin sayisi (`#L#0000` ...). */
  lineChunks: number;
  unitCount: number;
  exemptCount: number;
  vacantCount: number;
};

export type MeterJobParams = { periodId: string; calcHash: string; periodName?: string };

export type BulkJobResult = {
  batchId?: string;
  /** Yazilan (veya daha once yazilmis) kalem sayisi. */
  count?: number;
  distributedAmount?: number;
  exemptCount?: number;
  vacantCount?: number;
  /** Sayac: donemin tahakkuk kalemi sayisi. */
  posted?: number;
  /** Bu isle yeni yazilan (replay olmayan) kalem sayisi. */
  written?: number;
  replayed?: boolean;
};

export type BulkJob = {
  PK: string;
  SK: string;
  entityType: 'BULK_JOB';
  apartmentId: string;
  jobId: string;
  kind: BulkJobKind;
  status: BulkJobStatus;
  /** Sayac: `prepare` (hesap + hash) -> `post` (kalemler) -> `finalize` (ozet, imlec, posted). */
  phase?: 'prepare' | 'post' | 'finalize';
  /** Islenecek bolum (kalem) sayisi; sayacta hazirlik asamasindan sonra kesinlesir. */
  total: number;
  /** Islenen (basarili + hatali) bolum sayisi. */
  processed: number;
  succeeded: number;
  failed: number;
  /** Bu isle yeni yazilan kalem (replay haric). */
  written: number;
  failures: BulkJobFailure[];
  /** Aidat: sonraki islenecek satirin sirasi (dondurulmus satirlar uzerinde). */
  cursor: number;
  params: DuesJobParams | MeterJobParams;
  /** Ayni anahtarla farkli icerikli is acilmasini engeller. */
  fingerprint: string;
  result?: BulkJobResult;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  /** Tek worker kirasi: suresi dolmadan baska worker isi almaz. */
  leaseUntil?: string;
  leaseToken?: string;
  /** Worker cagrisi sayisi (continuation dahil). */
  invocations: number;
  createdAt: string;
  createdBy: string;
  /** Baslatanin rolu (sayac servisinin baglami icin). */
  createdByRole?: Role;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  version: number;
  ttl: number;
};

export type DuesLineChunk = { PK: string; SK: string; entityType: 'BULK_JOB_LINES'; jobId: string; index: number; lines: BulkDuesLine[]; ttl: number };
export type DuesResultChunk = { PK: string; SK: string; entityType: 'BULK_JOB_RESULTS'; jobId: string; start: number; results: BulkDuesLineResult[]; ttl: number };

/** SQS mesaji (bulk-jobs kuyrugu). `seq` yalnizca iz suruleme icindir. */
export type BulkJobMessage = { type: 'bulk_job'; apartmentId: string; jobId: string; seq: number };

export const isTerminal = (status: BulkJobStatus) => TERMINAL_STATUSES.includes(status);
export const isDuesParams = (job: Pick<BulkJob, 'kind'>, p: BulkJob['params']): p is DuesJobParams => job.kind === 'dues_bulk';
