import { describe, expect, it } from 'vitest';
import {
  type DistributionInput,
  type DistributionResult,
  type DistributionUnit,
  type Segment,
  assertDistributionInvariants,
  calculateDistribution,
  distributionHash,
  formatScaled,
} from '../src/modules/meters/engine/index.js';

/** Basit parca: payolcer, olcek 0, katsayi 1/1, Ekim donemi. */
function seg(unitId: string, meterId: string, startIndex: number, endIndex: number | undefined, extra: Partial<Segment> = {}): Segment {
  return {
    meterId,
    unitId,
    kind: 'heat_allocator',
    scale: 0,
    factor: { num: 1, den: 1 },
    startIndex,
    startDate: '2026-10-01',
    startSource: 'last_reading',
    ...(endIndex !== undefined ? { endIndex, endSource: 'reading' as const } : {}),
    endDate: '2026-10-31',
    days: 30,
    ...extra,
  };
}

const unit = (unitId: string, grossAreaTenthsM2 = 1000, landShare?: { numerator: number; denominator: number }): DistributionUnit => ({
  unitId,
  grossAreaTenthsM2,
  ...(landShare ? { landShare } : {}),
});

function heating(totalAmount: number, units: DistributionUnit[], segments: Segment[], over: Partial<DistributionInput['template']> = {}): DistributionInput {
  return { totalAmount, template: { commonShareBps: 3000, commonKey: 'area', meterKind: 'heat_allocator', ...over }, units, segments };
}

function ok(r: DistributionResult) {
  if (!r.ok) throw new Error(`Beklenmeyen hata: ${JSON.stringify(r.errors)}`);
  return r;
}
const amounts = (r: DistributionResult) => Object.fromEntries(ok(r).lines.map((l) => [l.unitId, l.amount]));
const codes = (list: { code: string }[]) => list.map((x) => x.code);

describe('sayac dagitimi - %30 ortak (m2) + %70 tuketim (kural 1 + 4)', () => {
  it('yonetmelik varsayilani: havuzlar ve en buyuk kalan ile kurusu kurusuna dagitim', () => {
    // T = 1.000,01 TL. Tc = floor(100001 x 0,3) = 30000, Tk = 70001.
    // Ortak (m2 100/100/50): 12000 / 12000 / 6000.
    // Tuketim (100 / 300 / 0): 17500,25 -> 17500 ; 52500,75 -> 52500 ; artan 1 kurus en buyuk kalana (B).
    const r = ok(
      calculateDistribution(
        heating(100001, [unit('A', 1000), unit('B', 1000), unit('C', 500)], [seg('A', 'mA', 1000, 1100), seg('B', 'mB', 2000, 2300), seg('C', 'mC', 50, 50)]),
      ),
    );
    expect(r.totals).toMatchObject({ totalAmount: 100001, commonPool: 30000, consumptionPool: 70001, fallbackToCommon: false, totalConsumption: '400' });
    const byId = Object.fromEntries(r.lines.map((l) => [l.unitId, l]));
    expect(byId.A).toMatchObject({ commonAmount: 12000, consumptionAmount: 17500, amount: 29500, consumption: '100' });
    expect(byId.B).toMatchObject({ commonAmount: 12000, consumptionAmount: 52501, amount: 64501 });
    expect(byId.C).toMatchObject({ commonAmount: 6000, consumptionAmount: 0, amount: 6000, hasMeter: true });
    expect(r.lines.reduce((s, l) => s + l.amount, 0)).toBe(100001);
  });

  it('oran ve ortak anahtar degistirilebilir: %40 esit', () => {
    const r = ok(calculateDistribution(heating(1000, [unit('A', 500), unit('B', 2000)], [seg('A', 'mA', 0, 10), seg('B', 'mB', 0, 30)], { commonShareBps: 4000, commonKey: 'equal' })));
    // Tc = 400 -> 200 / 200 ; Tk = 600 -> 150 / 450
    expect(amounts(r)).toEqual({ A: 350, B: 650 });
  });

  it('esitlikte kalan kurus unitId sirasina gider (girdi sirasindan bagimsiz)', () => {
    const units = [unit('u3'), unit('u1'), unit('u2')];
    const r = ok(calculateDistribution(heating(100, units, [], { commonShareBps: 10000, commonKey: 'equal' })));
    expect(amounts(r)).toEqual({ u1: 34, u2: 33, u3: 33 });
    expect(ok(r).lines.map((l) => l.unitId)).toEqual(['u1', 'u2', 'u3']);
  });

  it('arsa payi farkli paydalarla birebir oranlanir (1/3, 1/6, 1/2)', () => {
    const units = [unit('a', 1000, { numerator: 1, denominator: 3 }), unit('b', 1000, { numerator: 1, denominator: 6 }), unit('c', 1000, { numerator: 1, denominator: 2 })];
    const r = ok(calculateDistribution(heating(1000, units, [seg('a', 'ma', 0, 1)], { commonShareBps: 10000, commonKey: 'land_share' })));
    // agirliklar 2/1/3: 333,33 / 166,67 / 500 -> artan 1 kurus en buyuk kalana (b)
    expect(amounts(r)).toEqual({ a: 333, b: 167, c: 500 });
  });

  it('rastgele 300 senaryoda tek kurus fark yok (degismezler)', () => {
    let seed = 0x2b3c4d;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const keys = ['equal', 'area', 'land_share'] as const;
    for (let run = 0; run < 300; run++) {
      const n = int(1, 40);
      const units: DistributionUnit[] = [];
      const segments: Segment[] = [];
      for (let i = 0; i < n; i++) {
        const id = `u${String(i).padStart(3, '0')}`;
        units.push(unit(id, int(1, 5000), { numerator: int(1, 500), denominator: int(500, 10000) }));
        const meters = rnd() < 0.15 ? 0 : int(1, 3);
        for (let k = 0; k < meters; k++) {
          const start = int(0, 100000);
          const delta = rnd() < 0.3 ? 0 : int(1, 5000);
          const scale = int(0, 3);
          segments.push(seg(id, `${id}-m${k}`, start, start + delta, { scale, factor: { num: int(1, 20), den: int(1, 10) } }));
        }
      }
      const input = heating(int(1, 1_000_000_000), units, segments, { commonShareBps: int(0, 10000), commonKey: keys[int(0, 2)] ?? 'area' });
      const r = ok(calculateDistribution(input));
      expect(r.lines.reduce((s, l) => s + l.amount, 0)).toBe(input.totalAmount);
      expect(r.lines.reduce((s, l) => s + l.commonAmount, 0)).toBe(r.totals.commonPool);
      expect(r.lines.reduce((s, l) => s + l.consumptionAmount, 0)).toBe(r.totals.consumptionPool);
      for (const l of r.lines) {
        expect(l.amount).toBeGreaterThanOrEqual(0);
        if (!l.hasMeter || l.consumptionWeight === 0n) expect(l.consumptionAmount).toBe(0);
      }
      expect(() => assertDistributionInvariants(r)).not.toThrow();
    }
  });
});

describe('sayac dagitimi - politikalar (karar 3 ve 5)', () => {
  it('toplam tuketim sifirsa tutarin tamami ortak anahtarla dagitilir', () => {
    const r = ok(calculateDistribution(heating(1001, [unit('A', 1000), unit('B', 1000)], [seg('A', 'mA', 5, 5), seg('B', 'mB', 9, 9)])));
    expect(r.totals).toMatchObject({ commonPool: 1001, consumptionPool: 0, fallbackToCommon: true });
    expect(amounts(r)).toEqual({ A: 501, B: 500 });
    expect(codes(r.warnings)).toContain('zero_consumption_fallback');
  });

  it('sayaci olmayan daire tuketim havuzuna girmez, yalnizca ortak pay oder', () => {
    const r = ok(calculateDistribution(heating(10000, [unit('A', 1000), unit('B', 1000)], [seg('A', 'mA', 0, 50)])));
    // Tc = 3000 -> 1500 / 1500 ; Tk = 7000 tamamen A'ya
    expect(amounts(r)).toEqual({ A: 8500, B: 1500 });
    expect(r.warnings.find((w) => w.code === 'no_meter_common_only')?.unitId).toBe('B');
  });

  it('su sablonu (%0 ortak): sayacsiz daireye tutar dusmez, uyari verilir', () => {
    const r = ok(
      calculateDistribution({
        totalAmount: 4100,
        template: { commonShareBps: 0, commonKey: 'area', meterKind: 'cold_water' },
        units: [unit('A'), unit('B'), unit('C')],
        segments: [seg('A', 'wA', 0, 300, { kind: 'cold_water' }), seg('B', 'wB', 0, 110, { kind: 'cold_water' })],
      }),
    );
    expect(amounts(r)).toEqual({ A: 3000, B: 1100, C: 0 });
    expect(r.warnings.find((w) => w.code === 'no_meter_zero_charge')?.unitId).toBe('C');
  });

  it('kapsam disi dairenin sayaci yok sayilir', () => {
    const r = ok(calculateDistribution(heating(100, [unit('A')], [seg('A', 'mA', 0, 1), seg('DUKKAN', 'mX', 0, 999)])));
    expect(amounts(r)).toEqual({ A: 100 });
    expect(codes(r.warnings)).toContain('meter_unit_out_of_scope');
  });
});

describe('sayac dagitimi - katsayi, olcek ve gosterim', () => {
  it('katsayi ve farkli olcekler ortak paydaya genisletilir', () => {
    // A: 10 birim x 3/2 = 15,0 ; B: 5,5 m3 (olcek 1) x 1 -> oran 15 : 5,5
    const r = ok(
      calculateDistribution(
        heating(4100, [unit('A'), unit('B')], [seg('A', 'mA', 100, 110, { factor: { num: 3, den: 2 } }), seg('B', 'mB', 1000, 1055, { scale: 1 })], { commonShareBps: 0 }),
      ),
    );
    const byId = Object.fromEntries(r.lines.map((l) => [l.unitId, l]));
    expect(byId.A).toMatchObject({ consumption: '15.0', amount: 3000 });
    expect(byId.B).toMatchObject({ consumption: '5.5', amount: 1100 });
    expect(r.totals).toMatchObject({ totalConsumption: '20.5', consumptionScale: 1, consumptionDenominator: 2n });
  });

  it('formatScaled yarim yukari yuvarlar', () => {
    expect(formatScaled(123456n, 1n, 3)).toBe('123.456');
    expect(formatScaled(5n, 1n, 3)).toBe('0.005');
    expect(formatScaled(7n, 2n, 0)).toBe('4');
    expect(formatScaled(0n, 1n, 2)).toBe('0.00');
  });
});

describe('sayac dagitimi - engelleyici hatalar ve uyarilar', () => {
  it('gecersiz tutar / oran', () => {
    const r1 = calculateDistribution(heating(0, [unit('A')], []));
    const r2 = calculateDistribution(heating(100, [unit('A')], [], { commonShareBps: 10001 }));
    const r3 = calculateDistribution(heating(100, [], []));
    expect(r1.ok || codes(r1.errors)).toEqual(['invalid_total']);
    expect(r2.ok || codes(r2.errors)).toEqual(['invalid_ratio']);
    expect(r3.ok || codes(r3.errors)).toEqual(['no_units']);
  });

  it('m2 / arsa payi eksik daire hesabi engeller', () => {
    const r1 = calculateDistribution(heating(100, [unit('A', 0), unit('B')], []));
    const r2 = calculateDistribution(heating(100, [unit('A')], [], { commonKey: 'land_share' }));
    expect(r1.ok ? [] : r1.errors.map((e) => [e.code, e.unitId])).toEqual([['missing_area', 'A']]);
    expect(r2.ok ? [] : r2.errors.map((e) => [e.code, e.unitId])).toEqual([['missing_land_share', 'A']]);
  });

  it('eksik okuma engeller ve gecmisten tahmin onerir (karar 1)', () => {
    const r = calculateDistribution(heating(100, [unit('A')], [seg('A', 'mA', 500, undefined, { history: [{ delta: 300, days: 30 }] })]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatchObject({ code: 'missing_reading', meterId: 'mA', suggestion: { startIndex: 500, suggestedDelta: 300, suggestedEndIndex: 800 } });
  });

  it('yonetici onayli tahmini okuma hesaplanir ve isaretlenir', () => {
    const r = ok(calculateDistribution(heating(100, [unit('A')], [seg('A', 'mA', 500, 800, { estimated: true })])));
    expect(r.lines[0]?.estimated).toBe(true);
    expect(codes(r.warnings)).toContain('estimated');
  });

  it('negatif fark: degisim / tur atma isaretlenmeden kabul edilmez', () => {
    const r = calculateDistribution(heating(100, [unit('A')], [seg('A', 'mA', 9990, 5)]));
    expect(r.ok || codes(r.errors)).toEqual(['negative_delta']);
  });

  it('tur atma: yonetici onayi + en buyuk endeks ile', () => {
    const r = ok(calculateDistribution(heating(100, [unit('A')], [seg('A', 'mA', 9990, 5, { rolloverConfirmed: true, maxIndex: 9999 })])));
    expect(r.lines[0]?.segments[0]).toMatchObject({ delta: 15, rollover: true });
    expect(codes(r.warnings)).toContain('rollover');
    const bad = calculateDistribution(heating(100, [unit('A')], [seg('A', 'mA', 9990, 5, { rolloverConfirmed: true })]));
    expect(bad.ok || codes(bad.errors)).toEqual(['invalid_rollover']);
  });

  it('sayac turu sablonla uyusmazsa hata', () => {
    const r = calculateDistribution(heating(100, [unit('A')], [seg('A', 'w', 0, 1, { kind: 'hot_water' })]));
    expect(r.ok || codes(r.errors)).toEqual(['kind_mismatch']);
  });

  it('gecersiz katsayi / endeks', () => {
    const r = calculateDistribution(heating(100, [unit('A'), unit('B')], [seg('A', 'mA', 0, 1, { factor: { num: 0, den: 1 } }), seg('B', 'mB', -1, 1)]));
    expect(r.ok || codes(r.errors).sort()).toEqual(['invalid_factor', 'invalid_index']);
  });

  it('sicrama uyarisi: gecmis ortalamanin 3 katini asan tuketim', () => {
    const history = [{ delta: 10, days: 30 }];
    const spike = ok(calculateDistribution(heating(100, [unit('A')], [seg('A', 'mA', 0, 31, { history })])));
    const normal = ok(calculateDistribution(heating(100, [unit('A')], [seg('A', 'mA', 0, 30, { history })])));
    expect(codes(spike.warnings)).toContain('spike');
    expect(codes(normal.warnings)).not.toContain('spike');
  });
});

describe('sayac dagitimi - hesap ozeti (calcHash)', () => {
  it('ayni girdi her sirada ayni hash; okuma degisirse hash degisir', () => {
    const a = heating(100001, [unit('A'), unit('B')], [seg('A', 'mA', 0, 10), seg('B', 'mB', 0, 30)]);
    const b = heating(100001, [unit('B'), unit('A')], [seg('B', 'mB', 0, 30), seg('A', 'mA', 0, 10)]);
    const c = heating(100001, [unit('A'), unit('B')], [seg('A', 'mA', 0, 11), seg('B', 'mB', 0, 30)]);
    const h = (i: DistributionInput) => distributionHash(i, calculateDistribution(i));
    expect(h(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(h(b)).toBe(h(a));
    expect(h(c)).not.toBe(h(a));
  });

  it('hatali hesap icin hash uretilmez', () => {
    const i = heating(0, [unit('A')], []);
    expect(() => distributionHash(i, calculateDistribution(i))).toThrow();
  });
});
