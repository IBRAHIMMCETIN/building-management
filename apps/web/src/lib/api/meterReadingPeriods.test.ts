import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { periodSchema, readingPeriodSchema } from './meters';

/**
 * BUG-01 regresyonu: `GET /api/meter-readings/periods` ozet doner (sablon / vade / fatura yok;
 * apps/api/src/modules/meters/readings.ts -> listOpenPeriods). Tam donem semasiyla dogrulama
 * 200 yanitini ZodError'a ceviriyor, Sayac Okuma ekrani "Beklenmeyen bir hata olustu." diyordu.
 */
const API_RESPONSE = {
  items: [
    { periodId: 'p-corr', name: 'Ekim 2026 (düzeltme)', meterKind: 'heat_allocator', startDate: '2026-10-01', endDate: '2026-10-31', status: 'draft', version: 1 },
    { periodId: 'p-empty', name: 'Kasım 2026', meterKind: 'cold_water', startDate: '2026-11-01', endDate: '2026-11-30', status: 'calculated', version: 3 },
  ],
};

describe('okumaya acik donem listesi semasi', () => {
  it('API ozet bicimini kabul eder', () => {
    const parsed = z.object({ items: z.array(readingPeriodSchema) }).parse(API_RESPONSE);
    expect(parsed.items.map((p) => p.periodId)).toEqual(['p-corr', 'p-empty']);
  });

  it('tam donem semasi bu yaniti reddeder (hatanin kok nedeni)', () => {
    expect(z.object({ items: z.array(periodSchema) }).safeParse(API_RESPONSE).success).toBe(false);
  });
});
