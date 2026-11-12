import { z } from 'zod';
import type { ImportRow, SheetKind } from '@/lib/import/sheetModel';
import { apiClient } from './client';

/*
 * Toplu aktarim (apps/api/src/modules/imports). Okuma: yonetici/firma/denetci; yazma: yonetici/firma.
 *   POST /api/imports/preview              { asOfDate, units, people, balances } -> onizleme (yazmaz)
 *   POST /api/imports                      { importId, asOfDate, fileName, totals } -> is (idempotent)
 *   POST /api/imports/:id/rows             { units | people | balances } (<= 25 satir; idempotent)
 *   POST /api/imports/:id/funds            { cash?, bank? } (kasa/banka devir; metin tutar)
 *   POST /api/imports/:id/complete
 *   GET  /api/imports | /api/imports/:id
 *   POST /api/imports/:id/invitations      -> { sent, remaining }  (parca parca)
 *   POST /api/imports/:id/rollback         -> { remaining, report, status } (parca parca)
 */

const sheetEnum = z.enum(['units', 'people', 'balances']);
const outcomeEnum = z.enum(['created', 'exists', 'error']);
const statusEnum = z.enum(['in_progress', 'completed', 'rolled_back']);
const countRow = z.object({ created: z.number(), exists: z.number(), error: z.number() });
const countsSchema = z.record(z.enum(['unit', 'person', 'balance', 'funds']), countRow);

export const previewSchema = z.object({
  asOfDate: z.string(),
  ok: z.boolean(),
  counts: z.record(sheetEnum, z.object({ create: z.number(), exists: z.number(), error: z.number() })),
  blocksToCreate: z.array(z.string()),
  globalErrors: z.array(z.string()),
  rows: z.array(
    z.object({
      sheet: sheetEnum,
      row: z.number(),
      label: z.string(),
      status: z.enum(['create', 'exists', 'error']),
      errors: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
    }),
  ),
});

const rollbackReportSchema = z.object({
  reversed: z.number(),
  membershipsEnded: z.number(),
  unitsDeactivated: z.number(),
  unitsKept: z.number(),
});

export const importJobSchema = z.object({
  importId: z.string(),
  fileName: z.string(),
  asOfDate: z.string(),
  status: statusEnum,
  totals: z.object({ units: z.number(), people: z.number(), balances: z.number() }),
  counts: countsSchema.optional(),
  createdAt: z.string(),
  createdBy: z.string().optional(),
  completedAt: z.string().optional(),
  rolledBackAt: z.string().optional(),
  rollbackReport: rollbackReportSchema.optional(),
  version: z.number(),
});

export const importDetailSchema = importJobSchema.extend({
  counts: countsSchema,
  pendingInvitations: z.number(),
  errors: z.array(
    z.object({
      kind: z.enum(['unit', 'person', 'balance', 'funds']),
      row: z.number().optional(),
      label: z.string(),
      message: z.string().optional(),
    }),
  ),
});

const rowResultSchema = z.object({
  sheet: sheetEnum,
  row: z.number(),
  label: z.string(),
  outcome: outcomeEnum,
  message: z.string().optional(),
});
const rowsResponseSchema = z.object({ importId: z.string(), results: z.array(rowResultSchema) });
const fundsResponseSchema = z.object({
  importId: z.string(),
  funds: z.array(z.object({ account: z.enum(['cash', 'bank']), outcome: outcomeEnum, message: z.string().optional() })),
});
const invitationsSchema = z.object({ sent: z.number(), remaining: z.number() });
const rollbackSchema = z.object({ remaining: z.number(), report: rollbackReportSchema, status: statusEnum });

export type ImportPreview = z.infer<typeof previewSchema>;
export type ImportJob = z.infer<typeof importJobSchema>;
export type ImportDetail = z.infer<typeof importDetailSchema>;
export type ImportRowResult = z.infer<typeof rowResultSchema>;
export type ImportStatus = z.infer<typeof statusEnum>;

export type PreviewInput = { asOfDate: string } & Record<SheetKind, ImportRow[]>;
export type StartImportInput = {
  importId: string;
  asOfDate: string;
  fileName: string;
  totals: Record<SheetKind, number>;
};

const base = '/api/imports';
const one = (id: string) => `${base}/${encodeURIComponent(id)}`;

export const importsApi = {
  list: (signal?: AbortSignal) => apiClient.get(base, { signal, schema: z.object({ items: z.array(importJobSchema) }) }),
  get: (id: string, signal?: AbortSignal) => apiClient.get(one(id), { signal, schema: importDetailSchema }),
  preview: (input: PreviewInput) => apiClient.post(`${base}/preview`, input, { schema: previewSchema }),
  start: (input: StartImportInput) => apiClient.post(base, input, { schema: importJobSchema }),
  rows: (id: string, kind: SheetKind, rows: ImportRow[]) => apiClient.post(`${one(id)}/rows`, { [kind]: rows }, { schema: rowsResponseSchema }),
  funds: (id: string, input: { cash?: string; bank?: string }) => apiClient.post(`${one(id)}/funds`, input, { schema: fundsResponseSchema }),
  complete: (id: string) => apiClient.post(`${one(id)}/complete`, {}, { schema: importJobSchema }),
  sendInvitations: (id: string) => apiClient.post(`${one(id)}/invitations`, {}, { schema: invitationsSchema }),
  rollback: (id: string, reason?: string) => apiClient.post(`${one(id)}/rollback`, reason ? { reason } : {}, { schema: rollbackSchema }),
};
