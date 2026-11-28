import { z } from 'zod';
import { ApiError } from './errors';

/*
 * Sayac okuma girisi (yonetici + bina gorevlisi; apps/api/src/modules/meters/readings.ts, web
 * karsiligi: apps/web/src/lib/api/meters.ts + lib/meters/model.ts). Mobilde yalnizca saha girisi:
 * acik donemler, okuma cizelgesi, tek sayac kaydi ve fotograf kaniti. Donem ayrintisi (sablon,
 * faturalar) gorevli ekraninda kullanilmadigi icin gevsek (`loose`) dogrulanir.
 */

export const METER_KINDS = ['heat_allocator', 'heat_meter', 'hot_water', 'cold_water'] as const;
export type MeterKind = (typeof METER_KINDS)[number];
export const METER_KIND_LABELS: Record<MeterKind, string> = {
  heat_allocator: 'Isı pay ölçer',
  heat_meter: 'Kalorimetre',
  hot_water: 'Sıcak su sayacı',
  cold_water: 'Soğuk su sayacı',
};

export type ReadingStatus = 'ok' | 'missing' | 'error' | 'auto';
export const READING_STATUS_META: Record<ReadingStatus, { label: string; tone: 'success' | 'accent' | 'warning' | 'danger' }> = {
  ok: { label: 'Girildi', tone: 'success' },
  auto: { label: 'Otomatik', tone: 'accent' },
  missing: { label: 'Eksik', tone: 'warning' },
  error: { label: 'Hatalı', tone: 'danger' },
};
export const READING_FLAG_LABELS: Record<string, string> = {
  spike: 'Olağan dışı artış',
  rollover: 'Sayaç başa döndü',
  estimated: 'Tahmini',
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const readingPeriodSchema = z.object({
  periodId: z.string(),
  name: z.string(),
  meterKind: z.enum(METER_KINDS),
  startDate: isoDate,
  endDate: isoDate,
  status: z.string(),
  version: z.number().int(),
});
export type ReadingPeriod = z.infer<typeof readingPeriodSchema>;
export const readingPeriodListSchema = z.object({ items: z.array(readingPeriodSchema) });

export const sheetRowSchema = z.object({
  meterId: z.string(),
  unitId: z.string(),
  unitNumber: z.string().optional(),
  blockId: z.string().optional(),
  label: z.string(),
  serialNo: z.string().optional(),
  kind: z.enum(METER_KINDS),
  scale: z.number().int(),
  inScope: z.boolean().default(true),
  status: z.enum(['ok', 'missing', 'error', 'auto']),
  startIndex: z.number().optional(),
  startDate: isoDate.optional(),
  endIndex: z.number().optional(),
  endSource: z.string().optional(),
  flags: z.array(z.string()).default([]),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  reading: z.object({ note: z.string().optional(), enteredAt: z.string(), hasPhoto: z.boolean().default(false) }).loose().optional(),
});
export type SheetRow = z.infer<typeof sheetRowSchema>;

export const sheetSchema = z.object({
  period: z.object({ periodId: z.string(), name: z.string(), startDate: isoDate, endDate: isoDate }).loose(),
  rows: z.array(sheetRowSchema),
  summary: z.object({
    meters: z.number().int(),
    ok: z.number().int(),
    auto: z.number().int(),
    missing: z.number().int(),
    errors: z.number().int(),
  }).loose(),
});
export type ReadingSheet = z.infer<typeof sheetSchema>;

export const readingUploadSchema = z.object({ photoKey: z.string(), uploadUrl: z.string(), headers: z.record(z.string(), z.string()).default({}) });

export const saveReadingsSchema = z.object({
  items: z.array(z.object({ meterId: z.string(), endIndex: z.number(), delta: z.number(), flags: z.array(z.string()).default([]) }).loose()),
});

export type ReadingItemInput = { meterId: string; endIndex: number; note?: string; photoKey?: string };

/** Toplu kayit hatasinda kalem bazli mesajlar (`422 { items: [{ meterId, message }] }`). */
export function itemErrorMessage(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const items = err.body?.items;
  if (!Array.isArray(items)) return undefined;
  const first = items[0] as { message?: unknown } | undefined;
  return typeof first?.message === 'string' ? first.message : undefined;
}

export type IndexParse = { ok: true; value: number } | { ok: false; message: string };

/**
 * Endeks metnini olcekli tam sayiya cevirir (API `parseIndexText` ile birebir ayni). Kabul: "1234",
 * "1234,5", "1.234,567", "1234.5" (olcek > 0 iken nokta ondalik), "1.234" (olcek 0 iken binlik).
 */
export function parseIndexText(text: string | undefined, scale: number): IndexParse {
  const raw = (text ?? '').trim().replace(/\s+/g, '');
  if (!raw) return { ok: false, message: 'Endeks boş' };
  if (!/^[0-9.,]+$/.test(raw)) return { ok: false, message: 'Endeks yalnızca rakam, nokta ve virgül içerebilir' };
  let intPart: string;
  let frac = '';
  const hasDot = raw.includes('.');
  const hasComma = raw.includes(',');
  if (hasDot && hasComma) {
    if (raw.lastIndexOf('.') > raw.indexOf(',') || raw.split(',').length > 2) return { ok: false, message: 'Endeks biçimi geçersiz' };
    const [i, f] = raw.split(',');
    if (!/^\d{1,3}(\.\d{3})+$/.test(i ?? '')) return { ok: false, message: 'Binlik ayırıcı biçimi geçersiz' };
    intPart = (i ?? '').replaceAll('.', '');
    frac = f ?? '';
  } else if (hasComma) {
    const parts = raw.split(',');
    if (parts.length > 2) return { ok: false, message: 'Endeks biçimi geçersiz' };
    intPart = parts[0] ?? '';
    frac = parts[1] ?? '';
  } else if (hasDot) {
    const parts = raw.split('.');
    if (scale > 0 && parts.length === 2) {
      intPart = parts[0] ?? '';
      frac = parts[1] ?? '';
    } else if (/^\d{1,3}(\.\d{3})+$/.test(raw)) {
      intPart = raw.replaceAll('.', '');
    } else {
      return { ok: false, message: 'Endeks biçimi geçersiz' };
    }
  } else {
    intPart = raw;
  }
  if (!/^\d+$/.test(intPart)) return { ok: false, message: 'Endeks biçimi geçersiz' };
  if (frac && !/^\d+$/.test(frac)) return { ok: false, message: 'Endeks biçimi geçersiz' };
  if (frac.length > scale) {
    return { ok: false, message: scale === 0 ? 'Bu sayaç ondalık kabul etmez' : `Bu sayaç en fazla ${scale} ondalık hane kabul eder` };
  }
  const digits = `${intPart}${frac.padEnd(scale, '0')}`.replace(/^0+(?=\d)/, '');
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return { ok: false, message: 'Endeks çok büyük' };
  return { ok: true, value };
}

/** Olcekli endeks gosterimi, binlik ayiriciyla: (1234567, 3) -> "1.234,567". */
export function formatIndex(value: number, scale: number): string {
  const s = String(Math.abs(value)).padStart(scale + 1, '0');
  const int = scale === 0 ? s : s.slice(0, -scale);
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = value < 0 ? '-' : '';
  return scale === 0 ? `${sign}${grouped}` : `${sign}${grouped},${s.slice(-scale)}`;
}
