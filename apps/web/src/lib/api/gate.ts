import {
  type DeskPass,
  type GateLogFilter,
  type ManualEntryInput,
  type PlateHit,
  type PlateLookup,
  deskPassOneSchema,
  deskPassSchema,
  manualEntryResultSchema,
  plateHitSchema,
  plateLookupSchema,
  unitOptionListSchema,
  unitOptionSchema,
  verifyResultSchema,
} from '@bm/shared/api/gate';
import {
  type Courier,
  type CreatePassInput,
  type GateLogEntry,
  type GateLogPage,
  type MyPass,
  type UpdateVehicleInput,
  type Vehicle,
  courierListSchema,
  courierOneSchema,
  courierSchema,
  createdPassSchema,
  gateLogPageSchema,
  gateLogSchema,
  myPassListSchema,
  myPassOneSchema,
  myPassSchema,
  portalGateOverviewSchema,
  vehicleListSchema,
  vehicleOneSchema,
  vehicleSchema,
} from '@bm/shared/api/portalGate';
import { z } from 'zod';
import { apiClient } from './client';

/*
 * Guvenlik kapisi (apps/api/src/modules/gate):
 *   /api/gate          yonetim (tam) + guvenlik gorevlisi (plaka sorgusu, gecis okutma, kurye, gunluk)
 *   /api/portal/gate   sakin: oturdugu bolumlerin araclari, misafir gecisleri, kuryeleri, kapi kayitlari
 * Gorevli yanitlarinda sakin adi / iletisim / borc yoktur; QR jetonu yalnizca sakine doner.
 *
 * Semalar web + mobil ortak (tek kaynak): sakin kapi semalari packages/shared/src/api/portalGate.ts,
 * gorevli masasina ozgu olanlar (plaka sorgusu, gorevli gecis gorunumu, elle kayit) api/gate.ts. Bu dosya
 * eski import yollari icin yeniden disa aktarir; yalnizca yonetime ozgu sema (`managerPassSchema`,
 * yonetici arac kaydi) ve uclar burada.
 */
export {
  type Courier,
  type CreatePassInput,
  type DeskPass,
  type GateLogEntry,
  type GateLogFilter,
  type GateLogPage,
  type ManualEntryInput,
  type MyPass,
  type PlateHit,
  type PlateLookup,
  type UpdateVehicleInput,
  type Vehicle,
  courierSchema,
  deskPassSchema,
  gateLogPageSchema,
  gateLogSchema,
  myPassSchema,
  plateHitSchema,
  plateLookupSchema,
  unitOptionSchema,
  vehicleSchema,
};

/** Sakin portali ozeti (bolumler ve sinirlar). Eski ad. */
export const portalOverviewSchema = portalGateOverviewSchema;

export const managerPassSchema = myPassSchema
  .omit({ token: true, shortCode: true, mine: true, note: true, lastExitAt: true, revokedAt: true, canRotate: true })
  /** Sistem iptali nedeni (`taşınma`: gecisi olusturan sakinin uyeligi bitti). */
  .extend({ revokeReason: z.string().optional() });
export type ManagerPass = z.infer<typeof managerPassSchema>;

/**
 * Yonetim arac listesi: sistemin koydugu pasif nedeni de okunur (`taşınma`: sahibi tasindi, kayit
 * otomatik pasife alindi). Sakin semasi (ortak paket, gateParity.test.ts) bu alani tasimaz.
 */
export const managerVehicleSchema = vehicleSchema.extend({ inactiveReason: z.string().optional() });
export type ManagerVehicle = z.infer<typeof managerVehicleSchema>;

/** `ownerUserId`: yonetici kaydinda zorunlu (bolumde oturan uye); sakinde kendisi. */
export type CreateVehicleInput = { unitId: string; plate: string; note?: string; ownerUserId?: string };

const enc = encodeURIComponent;
const G = '/api/gate';
const P = '/api/portal/gate';
const managerVehicleOne = z.object({ vehicle: managerVehicleSchema });
const managerVehicleList = z.object({ items: z.array(managerVehicleSchema), maxPerUnit: z.number() });
const logQuery = (f: GateLogFilter) => Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as Record<string, string>;

/** Yonetim + guvenlik gorevlisi. */
export const gateDeskApi = {
  units: (q: string, signal?: AbortSignal) => apiClient.get(`${G}/units`, { query: q ? { q } : undefined, signal, schema: unitOptionListSchema }),
  unitResidents: (unitId: string, signal?: AbortSignal) => apiClient.get(`${G}/units/${enc(unitId)}/residents`, { signal, schema: z.object({ items: z.array(z.object({ userId: z.string(), name: z.string() })) }) }),
  lookupPlate: (q: string, signal?: AbortSignal) => apiClient.get(`${G}/plates`, { query: { q }, signal, schema: plateLookupSchema }),
  vehicles: (signal?: AbortSignal) => apiClient.get(`${G}/vehicles`, { signal, schema: managerVehicleList }),
  createVehicle: (input: CreateVehicleInput) => apiClient.post(`${G}/vehicles`, input, { schema: managerVehicleOne }),
  updateVehicle: (id: string, input: UpdateVehicleInput) => apiClient.patch(`${G}/vehicles/${enc(id)}`, input, { schema: managerVehicleOne }),
  passes: (status: string, signal?: AbortSignal) => apiClient.get(`${G}/passes`, { query: status ? { status } : undefined, signal, schema: z.object({ items: z.array(managerPassSchema) }) }),
  revokePass: (id: string, version: number) => apiClient.post(`${G}/passes/${enc(id)}/revoke`, { version }, { schema: z.object({ pass: managerPassSchema }) }),
  verifyPass: (input: { token: string } | { code: string }) => apiClient.post(`${G}/passes/verify`, input, { schema: verifyResultSchema }),
  passEntry: (id: string, idempotencyKey: string) => apiClient.post(`${G}/passes/${enc(id)}/entry`, { idempotencyKey }, { schema: deskPassOneSchema }),
  passExit: (id: string, idempotencyKey: string) => apiClient.post(`${G}/passes/${enc(id)}/exit`, { idempotencyKey }, { schema: deskPassOneSchema }),
  couriers: (status: 'open' | 'all', signal?: AbortSignal) => apiClient.get(`${G}/couriers`, { query: { status }, signal, schema: courierListSchema }),
  createCourier: (input: { idempotencyKey: string; unitId: string; company?: string; note?: string }) => apiClient.post(`${G}/couriers`, input, { schema: courierOneSchema }),
  courierEntry: (id: string, idempotencyKey: string) => apiClient.post(`${G}/couriers/${enc(id)}/entry`, { idempotencyKey }, { schema: courierOneSchema }),
  courierExit: (id: string, idempotencyKey: string) => apiClient.post(`${G}/couriers/${enc(id)}/exit`, { idempotencyKey }, { schema: courierOneSchema }),
  cancelCourier: (id: string, version: number) => apiClient.post(`${G}/couriers/${enc(id)}/cancel`, { version }, { schema: courierOneSchema }),
  manualEntry: (input: ManualEntryInput) => apiClient.post(`${G}/log`, input, { schema: manualEntryResultSchema }),
  log: (f: GateLogFilter, signal?: AbortSignal) => apiClient.get(`${G}/log`, { query: logQuery(f), signal, schema: gateLogPageSchema }),
};

/** Sakin portali. */
export const gatePortalApi = {
  overview: (signal?: AbortSignal) => apiClient.get(P, { signal, schema: portalGateOverviewSchema }),
  vehicles: (signal?: AbortSignal) => apiClient.get(`${P}/vehicles`, { signal, schema: vehicleListSchema }),
  createVehicle: (input: CreateVehicleInput) => apiClient.post(`${P}/vehicles`, input, { schema: vehicleOneSchema }),
  updateVehicle: (id: string, input: UpdateVehicleInput) => apiClient.patch(`${P}/vehicles/${enc(id)}`, input, { schema: vehicleOneSchema }),
  passes: (signal?: AbortSignal) => apiClient.get(`${P}/passes`, { signal, schema: myPassListSchema }),
  createPass: (input: CreatePassInput) => apiClient.post(`${P}/passes`, input, { schema: createdPassSchema }),
  revokePass: (id: string, version: number) => apiClient.post(`${P}/passes/${enc(id)}/revoke`, { version }, { schema: myPassOneSchema }),
  rotatePass: (id: string, version: number) => apiClient.post(`${P}/passes/${enc(id)}/rotate`, { version }, { schema: myPassOneSchema }),
  couriers: (signal?: AbortSignal) => apiClient.get(`${P}/couriers`, { signal, schema: courierListSchema }),
  respondCourier: (id: string, input: { version: number; decision: 'approve' | 'decline'; note?: string }) => apiClient.post(`${P}/couriers/${enc(id)}/respond`, input, { schema: courierOneSchema }),
  log: (f: GateLogFilter, signal?: AbortSignal) => apiClient.get(`${P}/log`, { query: logQuery(f), signal, schema: gateLogPageSchema }),
};
