import { z } from 'zod';
import { ApiError } from './errors';
import { PASS_VERDICTS, gateLogSchema, gateUnitSchema } from './portalGate';

/*
 * Guvenlik kapisi - gorevli (masa) semalari (apps/api/src/modules/gate; web karsiligi:
 * apps/web/src/lib/api/gate.ts `gateDeskApi`). Kurye, kapi gunlugu ve bolum secenegi semalari sakin
 * portaliyla ortaktir (tek kaynak: ./portalGate.ts); burada yalnizca masaya ozgu olanlar (plaka sorgusu,
 * gorevli gecis gorunumu, elle kayit, deneme siniri). Gorevli yanitlarinda sakin adi / iletisim / borc yoktur.
 */
export {
  type Courier,
  type GateLogEntry,
  type GateLogPage,
  courierListSchema,
  courierOneSchema,
  courierSchema,
  gateLogPageSchema,
  gateLogSchema,
} from './portalGate';

/** Bolum secici secenegi (yalnizca etiket). */
export const unitOptionSchema = gateUnitSchema;
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
  verdict: z.enum(PASS_VERDICTS),
  message: z.string().optional(),
  entryCount: z.number(),
  inside: z.boolean(),
  lastEntryAt: z.string().optional(),
  canEnter: z.boolean(),
  canExit: z.boolean(),
  version: z.number(),
});
export type DeskPass = z.infer<typeof deskPassSchema>;

export type GateLogFilter = { from?: string; to?: string; kind?: string; unitId?: string; cursor?: string };

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
