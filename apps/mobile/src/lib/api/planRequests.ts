import {
  type CreatePlanRequestInput,
  myPlanRequestsSchema,
  planRequestOptionsSchema,
  planRequestWithdrawSchema,
  planRequestWriteSchema,
} from '@bm/shared/api/planRequests';
import type { ApiClient } from './createApiClient';

/*
 * Sakin taksit (yapilandirma) talebi (web karsiligi: apps/web/src/lib/api/restructure.ts -> planRequest*).
 *   GET  /api/portal/plan-requests/options?unitId   sinirlar ve carilerin durumu
 *   GET  /api/portal/plan-requests                  kendi talepleri
 *   POST /api/portal/plan-requests                  { idempotencyKey, unitId?, liableParty?, installments, note? }
 *   POST /api/portal/plan-requests/:id/withdraw     bekleyen talebi geri ceker
 * Site ozelligi (`resident.restructure`) kapaliysa API 403 doner; kart gizlenir.
 */

const P = '/api/portal/plan-requests';
const unitQuery = (unitId?: string) => (unitId ? { unitId } : undefined);

export const planRequestsApi = {
  options: (api: ApiClient, unitId: string | undefined, signal?: AbortSignal) => api.get(`${P}/options`, { signal, query: unitQuery(unitId), schema: planRequestOptionsSchema }),
  mine: (api: ApiClient, signal?: AbortSignal) => api.get(P, { signal, schema: myPlanRequestsSchema }),
  create: (api: ApiClient, input: CreatePlanRequestInput) => api.post(P, input, { schema: planRequestWriteSchema }),
  withdraw: (api: ApiClient, requestId: string) => api.post(`${P}/${encodeURIComponent(requestId)}/withdraw`, {}, { schema: planRequestWithdrawSchema }),
};
