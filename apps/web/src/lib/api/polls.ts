import { z } from 'zod';
import { apiClient } from './client';
import {
  type CreatePollInput,
  type PollPhaseFilter,
  type UpdatePollInput,
  participationSchema,
  pollResultsSchema,
  pollSchema,
  portalPollSchema,
} from './pollModel';

export * from './pollModel';

const base = '/api/polls';
const portal = '/api/portal/polls';
const enc = encodeURIComponent;
const one = (id: string) => `${base}/${enc(id)}`;
const unitQuery = (unitId: string | undefined) => (unitId ? { unitId } : undefined);

export const pollsApi = {
  list: (status: PollPhaseFilter, signal?: AbortSignal) =>
    apiClient.get(base, { signal, query: { status }, schema: z.object({ items: z.array(pollSchema) }) }),
  create: (input: CreatePollInput) => apiClient.post(base, input, { schema: pollSchema }),
  update: (id: string, input: UpdatePollInput) => apiClient.patch(one(id), input, { schema: pollSchema }),
  publish: (id: string, version: number) => apiClient.post(`${one(id)}/publish`, { version }, { schema: pollSchema }),
  close: (id: string, version: number, reason: string) => apiClient.post(`${one(id)}/close`, { version, reason }, { schema: pollSchema }),
  cancel: (id: string, version: number) => apiClient.post(`${one(id)}/cancel`, { version }, { schema: pollSchema }),
  results: (id: string, signal?: AbortSignal) =>
    // `rollFrozen: false`: planli oylamada ilk oydan once paydalar canli on izlemedir.
    apiClient.get(`${one(id)}/results`, { signal, schema: z.object({ poll: pollSchema, rollFrozen: z.boolean(), results: pollResultsSchema }) }),
  participation: (id: string, signal?: AbortSignal) => apiClient.get(`${one(id)}/participation`, { signal, schema: participationSchema }),

  portalList: (unitId: string | undefined, signal?: AbortSignal) =>
    apiClient.get(portal, { signal, query: unitQuery(unitId), schema: z.object({ unitId: z.string(), items: z.array(portalPollSchema) }) }),
  portalGet: (id: string, unitId: string | undefined, signal?: AbortSignal) =>
    apiClient.get(`${portal}/${enc(id)}`, { signal, query: unitQuery(unitId), schema: portalPollSchema }),
  vote: (id: string, unitId: string | undefined, optionId: string) =>
    apiClient.post(`${portal}/${enc(id)}/vote`, { optionId }, { query: unitQuery(unitId), schema: portalPollSchema }),
};
