import { portalPollSchema } from '@bm/shared/api/polls';
import { z } from 'zod';
import type { ApiClient } from './createApiClient';

/*
 * Sakin oylamalari (web karsiligi: apps/web/src/lib/api/polls.ts -> portalList / portalGet / vote).
 *   GET  /api/portal/polls?unitId          dairemin gorebildigi oylamalar, oy hakki, kendi oyum
 *   GET  /api/portal/polls/:id?unitId      ayrinti; sonuc bittiyse veya ara sonuc aciksa
 *   POST /api/portal/polls/:id/vote?unitId { optionId } bolumun tek oyu; sonraki oy oncekinin yerine gecer
 * `unitId` yalnizca birden fazla dairesi olan sakin icin gonderilir.
 */

const P = '/api/portal/polls';
const enc = encodeURIComponent;
const unitQuery = (unitId?: string) => (unitId ? { unitId } : undefined);

export const pollsApi = {
  list: (api: ApiClient, unitId: string | undefined, signal?: AbortSignal) =>
    api.get(P, { signal, query: unitQuery(unitId), schema: z.object({ unitId: z.string(), items: z.array(portalPollSchema) }) }),
  get: (api: ApiClient, id: string, unitId: string | undefined, signal?: AbortSignal) =>
    api.get(`${P}/${enc(id)}`, { signal, query: unitQuery(unitId), schema: portalPollSchema }),
  vote: (api: ApiClient, id: string, unitId: string | undefined, optionId: string) =>
    api.post(`${P}/${enc(id)}/vote`, { optionId }, { query: unitQuery(unitId), schema: portalPollSchema }),
};
