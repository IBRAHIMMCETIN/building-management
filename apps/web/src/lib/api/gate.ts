import { z } from 'zod';
import { apiClient } from './client';

/*
 * Guvenlik kapisi (apps/api/src/modules/gate):
 *   /api/gate          yonetim (tam) + guvenlik gorevlisi (plaka sorgusu, gecis okutma, kurye, gunluk)
 *   /api/portal/gate   sakin: oturdugu bolumlerin araclari, misafir gecisleri, kuryeleri, kapi kayitlari
 * Gorevli yanitlarinda sakin adi / iletisim / borc yoktur; QR jetonu yalnizca sakine doner.
 */

const verdict = z.enum(['valid', 'not_yet_valid', 'expired', 'used', 'revoked', 'host_left']);

export const unitOptionSchema = z.object({ unitId: z.string(), label: z.string() });

export const vehicleSchema = z.object({
  vehicleId: z.string(),
  unitId: z.string(),
  unitLabel: z.string(),
  plate: z.string(),
  plateDisplay: z.string(),
  note: z.string().optional(),
  status: z.enum(['active', 'inactive']),
  /** Sahibi bolumden tasindi: gorevliye pasif gorunur. */
  ownerLeft: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdByRole: z.string(),
  version: z.number(),
});
export type Vehicle = z.infer<typeof vehicleSchema>;

export const plateHitSchema = z.object({
  plate: z.string(),
  plateDisplay: z.string(),
  unitId: z.string(),
  unitLabel: z.string(),
  registered: z.boolean(),
  active: z.boolean(),
  exact: z.boolean(),
  note: z.string().optional(),
});
export const plateLookupSchema = z.object({ query: z.string(), queryDisplay: z.string(), items: z.array(plateHitSchema) });
export type PlateLookup = z.infer<typeof plateLookupSchema>;

/** Sakin gorunumu. Jeton / kod kayitta tutulmaz: yalnizca olusturma ve yenileme yanitinda gelir. */
export const myPassSchema = z.object({
  passId: z.string(),
  unitId: z.string(),
  unitLabel: z.string(),
  guestName: z.string(),
  validFrom: z.string(),
  validUntil: z.string(),
  entryMode: z.enum(['single', 'multi']),
  plate: z.string().optional(),
  plateDisplay: z.string().optional(),
  note: z.string().optional(),
  status: z.enum(['active', 'used', 'revoked']),
  verdict,
  token: z.string().optional(),
  shortCode: z.string().optional(),
  entryCount: z.number(),
  inside: z.boolean(),
  lastEntryAt: z.string().optional(),
  lastExitAt: z.string().optional(),
  revokedAt: z.string().optional(),
  createdAt: z.string(),
  mine: z.boolean(),
  canRevoke: z.boolean(),
  /** "Yeni QR olustur" (eski QR / kod gecersiz olur). */
  canRotate: z.boolean(),
  version: z.number(),
});
export type MyPass = z.infer<typeof myPassSchema>;

export const managerPassSchema = myPassSchema.omit({ token: true, shortCode: true, mine: true, note: true, lastExitAt: true, revokedAt: true, canRotate: true });
export type ManagerPass = z.infer<typeof managerPassSchema>;

/** Gorevli gorunumu: misafir, ev sahibi bolum, gecerlilik, karar. */
export const deskPassSchema = z.object({
  passId: z.string(),
  unitId: z.string(),
  unitLabel: z.string(),
  guestName: z.string(),
  validFrom: z.string(),
  validUntil: z.string(),
  entryMode: z.enum(['single', 'multi']),
  plate: z.string().optional(),
  plateDisplay: z.string().optional(),
  note: z.string().optional(),
  verdict,
  message: z.string().optional(),
  entryCount: z.number(),
  inside: z.boolean(),
  lastEntryAt: z.string().optional(),
  canEnter: z.boolean(),
  canExit: z.boolean(),
  version: z.number(),
});
export type DeskPass = z.infer<typeof deskPassSchema>;

export const courierSchema = z.object({
  courierId: z.string(),
  unitId: z.string(),
  unitLabel: z.string(),
  company: z.string().optional(),
  note: z.string().optional(),
  status: z.enum(['waiting', 'approved', 'declined', 'cancelled']),
  expired: z.boolean(),
  respondBy: z.string(),
  respondedAt: z.string().optional(),
  responseNote: z.string().optional(),
  enteredAt: z.string().optional(),
  exitedAt: z.string().optional(),
  /** Onaylanan kuryenin iceri alinabilecegi son an (onay suresi). */
  enterBy: z.string().optional(),
  approvalExpired: z.boolean().optional(),
  createdAt: z.string(),
  canRespond: z.boolean(),
  canEnter: z.boolean(),
  canExit: z.boolean(),
  canCancel: z.boolean(),
  version: z.number(),
});
export type Courier = z.infer<typeof courierSchema>;

export const gateLogSchema = z.object({
  logId: z.string(),
  at: z.string(),
  direction: z.enum(['entry', 'exit']),
  kind: z.enum(['guest', 'courier', 'manual']),
  unitId: z.string().optional(),
  unitLabel: z.string().optional(),
  passId: z.string().optional(),
  courierId: z.string().optional(),
  visitorName: z.string().optional(),
  company: z.string().optional(),
  plate: z.string().optional(),
  plateDisplay: z.string().optional(),
  note: z.string().optional(),
  /** Yalnizca yonetim / gorevli. */
  recordedBy: z.string().optional(),
  recordedByName: z.string().optional(),
});
export type GateLogEntry = z.infer<typeof gateLogSchema>;
export const gateLogPageSchema = z.object({ items: z.array(gateLogSchema), from: z.string(), to: z.string(), nextCursor: z.string().optional() });
export type GateLogPage = z.infer<typeof gateLogPageSchema>;
export type GateLogFilter = { from?: string; to?: string; kind?: string; unitId?: string; cursor?: string };

export const portalOverviewSchema = z.object({
  units: z.array(unitOptionSchema),
  limits: z.object({ maxVehiclesPerUnit: z.number(), maxPassDays: z.number(), maxPassLeadDays: z.number(), courierResponseMinutes: z.number() }),
});

export type CreatePassInput = {
  idempotencyKey: string;
  unitId: string;
  guestName: string;
  validFrom: string;
  validUntil?: string;
  entryMode: 'single' | 'multi';
  plate?: string;
  note?: string;
};
/** `ownerUserId`: yonetici kaydinda zorunlu (bolumde oturan uye); sakinde kendisi. */
export type CreateVehicleInput = { unitId: string; plate: string; note?: string; ownerUserId?: string };
export type UpdateVehicleInput = { version: number; status?: 'active' | 'inactive'; note?: string | null };
export type ManualEntryInput = { idempotencyKey: string; direction: 'entry' | 'exit'; visitorName: string; unitId?: string; plate?: string; note?: string };

const enc = encodeURIComponent;
const G = '/api/gate';
const P = '/api/portal/gate';
const vehicleOne = z.object({ vehicle: vehicleSchema });
const vehicleList = z.object({ items: z.array(vehicleSchema), maxPerUnit: z.number() });
const courierOne = z.object({ courier: courierSchema, replayed: z.boolean().optional(), log: gateLogSchema.optional() });
const courierList = z.object({ items: z.array(courierSchema), pollSeconds: z.number() });
const deskPassOne = z.object({ pass: deskPassSchema, replayed: z.boolean().optional(), log: gateLogSchema.optional() });
const logQuery = (f: GateLogFilter) => Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as Record<string, string>;

/** Yonetim + guvenlik gorevlisi. */
export const gateDeskApi = {
  units: (q: string, signal?: AbortSignal) => apiClient.get(`${G}/units`, { query: q ? { q } : undefined, signal, schema: z.object({ items: z.array(unitOptionSchema), total: z.number().optional() }) }),
  unitResidents: (unitId: string, signal?: AbortSignal) => apiClient.get(`${G}/units/${enc(unitId)}/residents`, { signal, schema: z.object({ items: z.array(z.object({ userId: z.string(), name: z.string() })) }) }),
  lookupPlate: (q: string, signal?: AbortSignal) => apiClient.get(`${G}/plates`, { query: { q }, signal, schema: plateLookupSchema }),
  vehicles: (signal?: AbortSignal) => apiClient.get(`${G}/vehicles`, { signal, schema: vehicleList }),
  createVehicle: (input: CreateVehicleInput) => apiClient.post(`${G}/vehicles`, input, { schema: vehicleOne }),
  updateVehicle: (id: string, input: UpdateVehicleInput) => apiClient.patch(`${G}/vehicles/${enc(id)}`, input, { schema: vehicleOne }),
  passes: (status: string, signal?: AbortSignal) => apiClient.get(`${G}/passes`, { query: status ? { status } : undefined, signal, schema: z.object({ items: z.array(managerPassSchema) }) }),
  revokePass: (id: string, version: number) => apiClient.post(`${G}/passes/${enc(id)}/revoke`, { version }, { schema: z.object({ pass: managerPassSchema }) }),
  verifyPass: (input: { token: string } | { code: string }) => apiClient.post(`${G}/passes/verify`, input, { schema: z.object({ pass: deskPassSchema }) }),
  passEntry: (id: string, idempotencyKey: string) => apiClient.post(`${G}/passes/${enc(id)}/entry`, { idempotencyKey }, { schema: deskPassOne }),
  passExit: (id: string, idempotencyKey: string) => apiClient.post(`${G}/passes/${enc(id)}/exit`, { idempotencyKey }, { schema: deskPassOne }),
  couriers: (status: 'open' | 'all', signal?: AbortSignal) => apiClient.get(`${G}/couriers`, { query: { status }, signal, schema: courierList }),
  createCourier: (input: { idempotencyKey: string; unitId: string; company?: string; note?: string }) => apiClient.post(`${G}/couriers`, input, { schema: courierOne }),
  courierEntry: (id: string, idempotencyKey: string) => apiClient.post(`${G}/couriers/${enc(id)}/entry`, { idempotencyKey }, { schema: courierOne }),
  courierExit: (id: string, idempotencyKey: string) => apiClient.post(`${G}/couriers/${enc(id)}/exit`, { idempotencyKey }, { schema: courierOne }),
  cancelCourier: (id: string, version: number) => apiClient.post(`${G}/couriers/${enc(id)}/cancel`, { version }, { schema: courierOne }),
  manualEntry: (input: ManualEntryInput) => apiClient.post(`${G}/log`, input, { schema: z.object({ log: gateLogSchema, replayed: z.boolean() }) }),
  log: (f: GateLogFilter, signal?: AbortSignal) => apiClient.get(`${G}/log`, { query: logQuery(f), signal, schema: gateLogPageSchema }),
};

/** Sakin portali. */
export const gatePortalApi = {
  overview: (signal?: AbortSignal) => apiClient.get(P, { signal, schema: portalOverviewSchema }),
  vehicles: (signal?: AbortSignal) => apiClient.get(`${P}/vehicles`, { signal, schema: vehicleList }),
  createVehicle: (input: CreateVehicleInput) => apiClient.post(`${P}/vehicles`, input, { schema: vehicleOne }),
  updateVehicle: (id: string, input: UpdateVehicleInput) => apiClient.patch(`${P}/vehicles/${enc(id)}`, input, { schema: vehicleOne }),
  passes: (signal?: AbortSignal) => apiClient.get(`${P}/passes`, { signal, schema: z.object({ items: z.array(myPassSchema) }) }),
  createPass: (input: CreatePassInput) => apiClient.post(`${P}/passes`, input, { schema: z.object({ pass: myPassSchema, replayed: z.boolean() }) }),
  revokePass: (id: string, version: number) => apiClient.post(`${P}/passes/${enc(id)}/revoke`, { version }, { schema: z.object({ pass: myPassSchema }) }),
  rotatePass: (id: string, version: number) => apiClient.post(`${P}/passes/${enc(id)}/rotate`, { version }, { schema: z.object({ pass: myPassSchema }) }),
  couriers: (signal?: AbortSignal) => apiClient.get(`${P}/couriers`, { signal, schema: courierList }),
  respondCourier: (id: string, input: { version: number; decision: 'approve' | 'decline'; note?: string }) => apiClient.post(`${P}/couriers/${enc(id)}/respond`, input, { schema: courierOne }),
  log: (f: GateLogFilter, signal?: AbortSignal) => apiClient.get(`${P}/log`, { query: logQuery(f), signal, schema: gateLogPageSchema }),
};
