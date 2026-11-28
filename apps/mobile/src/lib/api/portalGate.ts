import {
  type CreatePassInput,
  type CreateVehicleInput,
  type UpdateVehicleInput,
  courierListSchema,
  courierOneSchema,
  createdPassSchema,
  gateLogPageSchema,
  myPassListSchema,
  myPassOneSchema,
  portalGateOverviewSchema,
  vehicleListSchema,
  vehicleOneSchema,
} from '@bm/shared/api/portalGate';
import type { ApiClient } from './createApiClient';

/* Sakin kapi uclari (web: apps/web/src/lib/api/gate.ts -> gatePortalApi; ayni istekler): /api/portal/gate. */

const enc = encodeURIComponent;
const P = '/api/portal/gate';

export const portalGateApi = {
  overview: (api: ApiClient, signal?: AbortSignal) => api.get(P, { signal, schema: portalGateOverviewSchema }),
  vehicles: (api: ApiClient, signal?: AbortSignal) => api.get(`${P}/vehicles`, { signal, schema: vehicleListSchema }),
  createVehicle: (api: ApiClient, input: CreateVehicleInput) => api.post(`${P}/vehicles`, input, { schema: vehicleOneSchema }),
  updateVehicle: (api: ApiClient, id: string, input: UpdateVehicleInput) => api.patch(`${P}/vehicles/${enc(id)}`, input, { schema: vehicleOneSchema }),
  passes: (api: ApiClient, signal?: AbortSignal) => api.get(`${P}/passes`, { signal, schema: myPassListSchema }),
  createPass: (api: ApiClient, input: CreatePassInput) => api.post(`${P}/passes`, input, { schema: createdPassSchema }),
  revokePass: (api: ApiClient, id: string, version: number) => api.post(`${P}/passes/${enc(id)}/revoke`, { version }, { schema: myPassOneSchema }),
  rotatePass: (api: ApiClient, id: string, version: number) => api.post(`${P}/passes/${enc(id)}/rotate`, { version }, { schema: myPassOneSchema }),
  couriers: (api: ApiClient, signal?: AbortSignal) => api.get(`${P}/couriers`, { signal, schema: courierListSchema }),
  respondCourier: (api: ApiClient, id: string, input: { version: number; decision: 'approve' | 'decline'; note?: string }) =>
    api.post(`${P}/couriers/${enc(id)}/respond`, input, { schema: courierOneSchema }),
  log: (api: ApiClient, f: { unitId?: string; cursor?: string }, signal?: AbortSignal) =>
    api.get(`${P}/log`, { signal, query: { unitId: f.unitId || undefined, cursor: f.cursor || undefined }, schema: gateLogPageSchema }),
};
