import { z } from 'zod';
import { apiClient } from './client';

/**
 * Denetim gunlugu (salt okunur).
 *   GET /api/audit?scope=apartment|platform&limit=&cursor=&from=&to=&action=&actorId=
 *   GET /api/audit/integrity?scope=
 *   POST /api/audit/verify?scope=   (yonetici: zinciri gece isini beklemeden dogrula)
 * `platform` kapsami yalnizca platform yoneticisi icindir; apartman kapsami JWT'deki (veya
 * destek oturumundaki) apartmandir.
 */
export type AuditScope = 'apartment' | 'platform';

/** Hash'e giren tum alanlar korunur (passthrough): tarayicida zincir dogrulamasi yapilir. */
export const auditEntrySchema = z
  .object({
    seq: z.number().int().positive(),
    auditId: z.string(),
    at: z.string(),
    action: z.string(),
    actor: z.object({ userId: z.string(), role: z.string(), supportSessionId: z.string().optional() }).passthrough(),
    apartmentId: z.string().optional(),
    target: z.object({ type: z.string(), id: z.string() }).passthrough(),
    reason: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    request: z.object({ requestId: z.string(), ip: z.string().optional(), userAgent: z.string().optional() }).passthrough().optional(),
    prevHash: z.string(),
    hash: z.string(),
  })
  .passthrough();
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditPageSchema = z.object({ items: z.array(auditEntrySchema), cursor: z.string().optional() });
export type AuditPage = z.infer<typeof auditPageSchema>;

export const auditIntegritySchema = z.object({
  status: z.enum(['empty', 'verified', 'pending', 'stale']),
  latestSeq: z.number(),
  latestAt: z.string().optional(),
  verifiedSeq: z.number(),
  verifiedAt: z.string().optional(),
  staleAfterHours: z.number(),
});
export type AuditIntegrity = z.infer<typeof auditIntegritySchema>;

export const auditVerifySchema = z.object({
  checked: z.number(),
  findings: z.number(),
  skipped: z.string().optional(),
  integrity: auditIntegritySchema,
});
export type AuditVerifyResult = z.infer<typeof auditVerifySchema>;

export type AuditFilters = {
  /** ISO tarih-saat (saat dilimli). */
  from?: string;
  to?: string;
  /** Islem on eki: `ledger.`, `mfa.` ... */
  action?: string;
  actorId?: string;
};

export const auditApi = {
  page: (scope: AuditScope, filters: AuditFilters, cursor?: string, signal?: AbortSignal) =>
    apiClient.get('/api/audit', {
      signal,
      query: { scope, limit: 50, cursor, ...filters },
      schema: auditPageSchema,
    }),
  integrity: (scope: AuditScope, signal?: AbortSignal) =>
    apiClient.get('/api/audit/integrity', { signal, query: { scope }, schema: auditIntegritySchema }),
  verify: (scope: AuditScope) => apiClient.post('/api/audit/verify', undefined, { query: { scope }, schema: auditVerifySchema }),
};
