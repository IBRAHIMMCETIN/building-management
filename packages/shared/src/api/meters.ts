import { z } from 'zod';

/*
 * Sayac / endeks dagitimi (Finans 2.3): web + mobil ortak tanimlar ve sakin portali semasi.
 *   GET /api/portal/meters/consumption?unitId=        dairenin donem donem tuketimi, bina / blok ortalamasi
 *   GET /api/portal/meters/statement/:periodId?unitId= Sayac Dagitim Dokumu PDF (5 dk imzali link)
 * Tutarlar kurus (tam sayi). Yonetim semalari ve uclar web'dedir: apps/web/src/lib/api/meters.ts
 * (bu dosyadakileri yeniden disa aktarir), etiketler / yardimcilar apps/web/src/lib/meters/model.ts.
 */

export const METER_KINDS = ['heat_allocator', 'heat_meter', 'hot_water', 'cold_water'] as const;
export type MeterKind = (typeof METER_KINDS)[number];
export const METER_KIND_LABELS: Record<MeterKind, string> = {
  heat_allocator: 'Isı pay ölçer',
  heat_meter: 'Kalorimetre',
  hot_water: 'Sıcak su sayacı',
  cold_water: 'Soğuk su sayacı',
};

export const TEMPLATE_CATEGORIES = ['heating', 'hot_water', 'cold_water'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  heating: 'Isınma',
  hot_water: 'Sıcak su',
  cold_water: 'Soğuk su',
};

const kurus = z.number().int();
const isoDate = z.string();

export const portalPeriodSchema = z.object({
  periodId: z.string(),
  name: z.string(),
  meterKind: z.enum(METER_KINDS),
  category: z.enum(TEMPLATE_CATEGORIES),
  startDate: isoDate,
  endDate: isoDate,
  dueDate: isoDate,
  hasMeter: z.boolean(),
  estimated: z.boolean(),
  consumption: z.number(),
  consumptionText: z.string(),
  commonAmount: kurus,
  consumptionAmount: kurus,
  amount: kurus,
  /** Endeks / tuketim sayacin olcegine gore bicimli metin ("1234,500"). */
  meters: z.array(z.object({ meterId: z.string(), label: z.string(), endIndex: z.string().optional(), delta: z.string().optional(), endDate: isoDate.optional() })).default([]),
  buildingAverage: z.number(),
  blockAverage: z.number().optional(),
  meteredUnits: z.number().int(),
  previous: z.object({ periodId: z.string(), consumption: z.number(), diff: z.number(), percent: z.number().optional() }).optional(),
});

export const consumptionSchema = z.object({
  unitId: z.string(),
  unitNumber: z.string().optional(),
  periods: z.array(portalPeriodSchema),
});

export type PortalPeriod = z.infer<typeof portalPeriodSchema>;
export type ConsumptionHistory = z.infer<typeof consumptionSchema>;

/** Tuketim / endeks gosterimi: "1234,5" (en fazla 3 ondalik). */
export function formatConsumption(value: string | number, maxFraction = 3): string {
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) return String(value);
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: maxFraction }).format(n);
}

/** Yuzde degisim: "+%12,5" / "-%3" / "%0". */
export function formatPercentChange(p: number): string {
  const s = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(Math.abs(p));
  return `${p > 0 ? '+' : p < 0 ? '-' : ''}%${s}`;
}

/** Ortalamaya gore fark yuzdesi (ortalama 0 ise null). */
export function versusAverage(mine: number, average: number): number | null {
  if (!(average > 0)) return null;
  return Math.round(((mine - average) / average) * 1000) / 10;
}
