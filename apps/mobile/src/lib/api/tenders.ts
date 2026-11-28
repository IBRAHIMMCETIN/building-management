import { signedDownloadSchema } from '@bm/shared/api/documents';
import { tenderResponseSchema, tenderSummarySchema, tenderWriteSchema } from '@bm/shared/api/tenders';
import { z } from 'zod';
import type { ApiClient } from './createApiClient';

/*
 * Sakin ihaleleri (web karsiligi: apps/web/src/lib/api/tenders.ts -> portalTendersApi). Yalnizca
 * yayinlanmis ihaleler; sakin kimlikleri yanitta yoktur.
 *   GET  /api/portal/tenders                               liste
 *   GET  /api/portal/tenders/:id                           teklifler (KDV dahil normalize), karsilastirma, sorular
 *   GET  /api/portal/tenders/:id/quotes/:quoteId/document  teklif belgesi (5 dk imzali link)
 *   POST /api/portal/tenders/:id/comments                  { idempotencyKey, body } (yalnizca yayindayken)
 */

const P = '/api/portal/tenders';
const enc = encodeURIComponent;

export const tendersApi = {
  list: (api: ApiClient, signal?: AbortSignal) => api.get(P, { signal, schema: z.object({ items: z.array(tenderSummarySchema) }) }),
  get: (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`${P}/${enc(id)}`, { signal, schema: tenderResponseSchema }),
  document: (api: ApiClient, id: string, quoteId: string) => api.get(`${P}/${enc(id)}/quotes/${enc(quoteId)}/document`, { schema: signedDownloadSchema }),
  comment: (api: ApiClient, id: string, input: { idempotencyKey: string; body: string }) => api.post(`${P}/${enc(id)}/comments`, input, { schema: tenderWriteSchema }),
};
