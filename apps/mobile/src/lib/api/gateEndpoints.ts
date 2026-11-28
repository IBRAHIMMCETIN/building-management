import {
  type CreateCourierInput,
  type GateLogFilter,
  type ManualEntryInput,
  courierListSchema,
  courierOneSchema,
  deskPassOneSchema,
  gateLogPageSchema,
  manualEntryResultSchema,
  plateLookupSchema,
  unitOptionListSchema,
  verifyResultSchema,
} from '@bm/shared/api/gate';
import type { ScanResult } from '@bm/shared/gate/plate';
import type { ApiClient } from './createApiClient';

/*
 * Guvenlik gorevlisi kapi uclari (web: apps/web/src/lib/api/gate.ts `gateDeskApi`). Arac sicili,
 * misafir gecisi listesi ve iptal yalnizca yonetimde: mobilde yok.
 */
const G = '/api/gate';
const enc = encodeURIComponent;
const logQuery = (f: GateLogFilter) => Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as Record<string, string>;

export const gateEndpoints = {
  units: (api: ApiClient, q: string, signal?: AbortSignal) => api.get(`${G}/units`, { query: q ? { q } : undefined, signal, schema: unitOptionListSchema }),
  lookupPlate: (api: ApiClient, q: string, signal?: AbortSignal) => api.get(`${G}/plates`, { query: { q }, signal, schema: plateLookupSchema }),
  verifyPass: (api: ApiClient, input: ScanResult) => api.post(`${G}/passes/verify`, input, { schema: verifyResultSchema }),
  passEntry: (api: ApiClient, id: string, idempotencyKey: string) => api.post(`${G}/passes/${enc(id)}/entry`, { idempotencyKey }, { schema: deskPassOneSchema }),
  passExit: (api: ApiClient, id: string, idempotencyKey: string) => api.post(`${G}/passes/${enc(id)}/exit`, { idempotencyKey }, { schema: deskPassOneSchema }),
  couriers: (api: ApiClient, status: 'open' | 'all', signal?: AbortSignal) => api.get(`${G}/couriers`, { query: { status }, signal, schema: courierListSchema }),
  createCourier: (api: ApiClient, input: CreateCourierInput) => api.post(`${G}/couriers`, input, { schema: courierOneSchema }),
  courierEntry: (api: ApiClient, id: string, idempotencyKey: string) => api.post(`${G}/couriers/${enc(id)}/entry`, { idempotencyKey }, { schema: courierOneSchema }),
  courierExit: (api: ApiClient, id: string, idempotencyKey: string) => api.post(`${G}/couriers/${enc(id)}/exit`, { idempotencyKey }, { schema: courierOneSchema }),
  cancelCourier: (api: ApiClient, id: string, version: number) => api.post(`${G}/couriers/${enc(id)}/cancel`, { version }, { schema: courierOneSchema }),
  manualEntry: (api: ApiClient, input: ManualEntryInput) => api.post(`${G}/log`, input, { schema: manualEntryResultSchema }),
  log: (api: ApiClient, f: GateLogFilter, signal?: AbortSignal) => api.get(`${G}/log`, { query: logQuery(f), signal, schema: gateLogPageSchema }),
};
