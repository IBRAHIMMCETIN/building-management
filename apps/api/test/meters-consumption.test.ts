import { describe, expect, it } from 'vitest';
import {
  type ApprovedReading,
  type MeterRecord,
  type MeterSwapRecord,
  type PeriodReading,
  type ResolveInput,
  calculateDistribution,
  daysBetween,
  resolveSegments,
  suggestEstimate,
} from '../src/modules/meters/engine/index.js';

const PERIOD = { startDate: '2026-11-01', endDate: '2026-11-30' };

const meter = (meterId: string, unitId = 'u1', over: Partial<MeterRecord> = {}): MeterRecord => ({
  meterId,
  unitId,
  kind: 'heat_allocator',
  scale: 0,
  openingIndex: 0,
  installedAt: '2026-01-01',
  ...over,
});

const swap = (swapId: string, oldMeterId: string, newMeterId: string, swapDate: string, oldClosingIndex: number, newOpeningIndex: number, status: 'active' | 'reversed' = 'active'): MeterSwapRecord => ({
  swapId,
  oldMeterId,
  newMeterId,
  swapDate,
  oldClosingIndex,
  newOpeningIndex,
  status,
});

function input(p: {
  meters: MeterRecord[];
  swaps?: MeterSwapRecord[];
  last?: Record<string, ApprovedReading>;
  readings?: Record<string, PeriodReading>;
}): ResolveInput {
  return {
    kind: 'heat_allocator',
    period: PERIOD,
    meters: p.meters,
    swaps: p.swaps ?? [],
    lastApproved: new Map(Object.entries(p.last ?? {})),
    readings: new Map(Object.entries(p.readings ?? {})),
  };
}

const brief = (segs: ReturnType<typeof resolveSegments>['segments']) =>
  segs.map((s) => ({ meterId: s.meterId, start: s.startIndex, end: s.endIndex, startSource: s.startSource, endSource: s.endSource }));

describe('sayac parcalari - temel', () => {
  it('son onayli okuma baslangic, donem okumasi bitis', () => {
    const r = resolveSegments(input({ meters: [meter('m1')], last: { m1: { index: 500, date: '2026-10-31' } }, readings: { m1: { endIndex: 620 } } }));
    expect(r.errors).toEqual([]);
    expect(brief(r.segments)).toEqual([{ meterId: 'm1', start: 500, end: 620, startSource: 'last_reading', endSource: 'reading' }]);
    expect(r.segments[0]?.days).toBe(30);
  });

  it('onayli okuma yoksa acilis endeksi; okuma yoksa bitis tanimsiz (dagitimda engelleyici)', () => {
    const r = resolveSegments(input({ meters: [meter('m1', 'u1', { openingIndex: 40, installedAt: '2026-11-10' })] }));
    expect(brief(r.segments)).toEqual([{ meterId: 'm1', start: 40, end: undefined, startSource: 'opening', endSource: undefined }]);
    const d = calculateDistribution({
      totalAmount: 100,
      template: { commonShareBps: 3000, commonKey: 'area', meterKind: 'heat_allocator' },
      units: [{ unitId: 'u1', grossAreaTenthsM2: 900 }],
      segments: r.segments,
    });
    expect(d.ok ? [] : d.errors.map((e) => e.code)).toEqual(['missing_reading']);
  });

  it('donemden sonra takilan ve baska turdeki sayaclar dahil edilmez', () => {
    const r = resolveSegments(
      input({
        meters: [meter('m1'), meter('late', 'u1', { installedAt: '2026-12-02' }), meter('w1', 'u1', { kind: 'hot_water' })],
        readings: { m1: { endIndex: 10 } },
      }),
    );
    expect(r.segments.map((s) => s.meterId)).toEqual(['m1']);
  });

  it('sonraki donemin onayli okumasi varsa hata (once o donem geri alinmali)', () => {
    const r = resolveSegments(input({ meters: [meter('m1')], last: { m1: { index: 700, date: '2026-12-31' } }, readings: { m1: { endIndex: 620 } } }));
    expect(r.errors.map((e) => e.code)).toEqual(['already_read']);
    expect(r.segments).toEqual([]);
  });
});

describe('sayac degisimi / sifirlanmasi (kural 3)', () => {
  const units = [{ unitId: 'u1', grossAreaTenthsM2: 1000 }];
  const consumptionOf = (r: ReturnType<typeof resolveSegments>) => {
    const d = calculateDistribution({ totalAmount: 100, template: { commonShareBps: 0, commonKey: 'area', meterKind: 'heat_allocator' }, units, segments: r.segments });
    if (!d.ok) throw new Error(JSON.stringify(d.errors));
    return d.lines[0]?.consumption;
  };

  it('donem icinde degisim: (eski kapanis - baslangic) + (son okuma - yeni acilis)', () => {
    const r = resolveSegments(
      input({
        meters: [meter('m1'), meter('m2', 'u1', { installedAt: '2026-11-15' })],
        swaps: [swap('s1', 'm1', 'm2', '2026-11-15', 560, 0)],
        last: { m1: { index: 500, date: '2026-10-31' } },
        readings: { m1: { endIndex: 999 }, m2: { endIndex: 40 } },
      }),
    );
    expect(brief(r.segments)).toEqual([
      { meterId: 'm1', start: 500, end: 560, startSource: 'last_reading', endSource: 'swap_closing' },
      { meterId: 'm2', start: 0, end: 40, startSource: 'swap_opening', endSource: 'reading' },
    ]);
    expect(r.warnings.map((w) => [w.code, w.meterId])).toEqual([['reading_ignored_replaced', 'm1']]);
    expect(consumptionOf(r)).toBe('100');
  });

  it('art arda iki degisim (sifirlama dahil) zincir olarak toplanir', () => {
    const r = resolveSegments(
      input({
        meters: [meter('m1'), meter('m2', 'u1', { installedAt: '2026-11-10' }), meter('m3', 'u1', { installedAt: '2026-11-20' })],
        swaps: [swap('s1', 'm1', 'm2', '2026-11-10', 520, 0), swap('s2', 'm2', 'm3', '2026-11-20', 30, 5)],
        last: { m1: { index: 500, date: '2026-10-31' } },
        readings: { m3: { endIndex: 15 } },
      }),
    );
    expect(brief(r.segments).map((s) => [s.meterId, s.start, s.end])).toEqual([
      ['m1', 500, 520],
      ['m2', 0, 30],
      ['m3', 5, 15],
    ]);
    expect(consumptionOf(r)).toBe('60');
  });

  it('onceki donemde sayilmis degisim tekrar sayilmaz; yeni sayac son onayli okumadan baslar', () => {
    const r = resolveSegments(
      input({
        meters: [meter('m1'), meter('m2', 'u1', { installedAt: '2026-10-20' })],
        swaps: [swap('s1', 'm1', 'm2', '2026-10-20', 560, 0)],
        last: { m1: { index: 560, date: '2026-10-31' }, m2: { index: 40, date: '2026-10-31' } },
        readings: { m2: { endIndex: 90 } },
      }),
    );
    expect(brief(r.segments).map((s) => [s.meterId, s.start, s.end, s.startSource])).toEqual([['m2', 40, 90, 'last_reading']]);
  });

  it('geri alinmis degisim kaydi yok sayilir', () => {
    const r = resolveSegments(
      input({
        meters: [meter('m1'), meter('m2', 'u1', { installedAt: '2026-11-15' })],
        swaps: [swap('s1', 'm1', 'm2', '2026-11-15', 560, 0, 'reversed')],
        last: { m1: { index: 500, date: '2026-10-31' } },
        readings: { m1: { endIndex: 610 }, m2: { endIndex: 40 } },
      }),
    );
    expect(brief(r.segments).map((s) => [s.meterId, s.start, s.end, s.endSource])).toEqual([
      ['m1', 500, 610, 'reading'],
      ['m2', 0, 40, 'reading'],
    ]);
  });

  it('donem sonrasindaki degisim bu donemi etkilemez (eski sayac okunur)', () => {
    const r = resolveSegments(
      input({
        meters: [meter('m1'), meter('m2', 'u1', { installedAt: '2026-12-05' })],
        swaps: [swap('s1', 'm1', 'm2', '2026-12-05', 700, 0)],
        last: { m1: { index: 500, date: '2026-10-31' } },
        readings: { m1: { endIndex: 650 } },
      }),
    );
    expect(brief(r.segments).map((s) => [s.meterId, s.start, s.end, s.endSource])).toEqual([['m1', 500, 650, 'reading']]);
  });

  it('emekliye ayrilan sayac kapanis endeksiyle biter', () => {
    const r = resolveSegments(
      input({
        meters: [meter('m1', 'u1', { retiredAt: '2026-11-12', closingIndex: 530 })],
        last: { m1: { index: 500, date: '2026-10-31' } },
      }),
    );
    expect(brief(r.segments)).toEqual([{ meterId: 'm1', start: 500, end: 530, startSource: 'last_reading', endSource: 'retire_closing' }]);
  });

  it('ayni sayacin iki etkin degisim kaydi hata', () => {
    const r = resolveSegments(
      input({
        meters: [meter('m1'), meter('m2'), meter('m3')],
        swaps: [swap('s1', 'm1', 'm2', '2026-11-10', 520, 0), swap('s2', 'm1', 'm3', '2026-11-12', 525, 0)],
      }),
    );
    expect(r.errors.map((e) => e.code)).toEqual(['invalid_chain']);
  });
});

describe('yardimcilar', () => {
  it('daysBetween', () => {
    expect(daysBetween('2026-10-31', '2026-11-30')).toBe(30);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2); // yaz saati gecisinden etkilenmez
    expect(() => daysBetween('2026-1-1', '2026-01-02')).toThrow();
  });

  it('tahmin onerisi: gunluk ortalama x gun, yarim yukari; gecmis yoksa tanimsiz', () => {
    expect(suggestEstimate([{ delta: 300, days: 30 }, { delta: 200, days: 31 }, { delta: 100, days: 29 }], 30)).toBe(200);
    expect(suggestEstimate([{ delta: 10, days: 3 }], 1)).toBe(3);
    expect(suggestEstimate([{ delta: 5, days: 2 }], 1)).toBe(3);
    expect(suggestEstimate([], 30)).toBeUndefined();
    expect(suggestEstimate(undefined, 30)).toBeUndefined();
  });
});
