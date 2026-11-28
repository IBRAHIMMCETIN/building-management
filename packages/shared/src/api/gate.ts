import { z } from 'zod';
import { ApiError } from './errors';

/*
 * Guvenlik kapisi - gorevli (masa) semalari (apps/api/src/modules/gate; web karsiligi:
 * apps/web/src/lib/api/gate.ts `gateDeskApi`). Gorevli yanitlarinda sakin adi / iletisim / borc yoktur;
 * QR jetonu yalnizca sakine doner. Sakin portali semalari web dosyasindadir (M2 mobil sakin ekranlari).
 */

const verdict = z.enum(['valid', 'not_yet_valid', 'expired', 'used', 'revoked', 'host_left']);

export const unitOptionSchema = z.object({ unitId: z.string(), label: z.string() });
export type UnitOption = z.infer<typeof unitOptionSchema>;
export const unitOptionListSchema = z.object({ items: z.array(unitOptionSchema), total: z.number().optional() });

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
export type PlateHit = z.infer<typeof plateHitSchema>;
export const plateLookupSchema = z.object({ query: z.string(), queryDisplay: z.string(), items: z.array(plateHitSchema) });
export type PlateLookup = z.infer<typeof plateLookupSchema>;

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
  recordedBy: z.string().optional(),
  recordedByName: z.string().optional(),
});
export type GateLogEntry = z.infer<typeof gateLogSchema>;
export const gateLogPageSchema = z.object({ items: z.array(gateLogSchema), from: z.string(), to: z.string(), nextCursor: z.string().optional() });
export type GateLogPage = z.infer<typeof gateLogPageSchema>;
export type GateLogFilter = { from?: string; to?: string; kind?: string; unitId?: string; cursor?: string };

export const courierOneSchema = z.object({ courier: courierSchema, replayed: z.boolean().optional(), log: gateLogSchema.optional() });
export const courierListSchema = z.object({ items: z.array(courierSchema), pollSeconds: z.number() });
export const deskPassOneSchema = z.object({ pass: deskPassSchema, replayed: z.boolean().optional(), log: gateLogSchema.optional() });
export const verifyResultSchema = z.object({ pass: deskPassSchema });
export const manualEntryResultSchema = z.object({ log: gateLogSchema, replayed: z.boolean() });

export type CreateCourierInput = { idempotencyKey: string; unitId: string; company?: string; note?: string };
export type ManualEntryInput = { idempotencyKey: string; direction: 'entry' | 'exit'; visitorName: string; unitId?: string; plate?: string; note?: string };

/**
 * Deneme siniri asildiysa (429 `rate_limited`) kalan bekleme suresi (sn); degilse null. API govdede
 * `retryAfterSeconds` ve `Retry-After` basligi dondurur (gate/errors.ts); istemci basligi da govdeye tasir.
 */
export function rateLimitSeconds(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null;
  const raw = err.body?.retryAfterSeconds;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 60;
}
