import { describe, expect, it } from 'vitest';
import {
  type FeeCharge,
  type FeeCredit,
  computeLateFee,
  dayNumber,
  isPeriod,
  nextPeriod,
  periodBounds,
  periodLabel,
  previousPeriod,
  unpostedLateFee,
} from '../src/modules/finance/lateFee.js';
import { computePartyDues } from '../src/modules/finance/reports.js';

const TL = (n: number) => Math.round(n * 100);

describe('kistelyevm gecikme tazminati (KMK m.20) - bilinen sonuclar', () => {
  it('rehberdeki ornek: 3.000 TL borcun 1.000 TL si ara odeme; odenen kisim icin faiz durur', () => {
    // Vade 10 Ocak. 20 Ocak'ta 1.000 TL odeme. 31 Ocak itibariyla:
    //   3.000 x %5/30 x 10 gun = 50,00 TL  +  2.000 x %5/30 x 11 gun = 36,666.. TL
    const r = computeLateFee({
      charges: [{ id: 'c1', dueDate: '2026-01-10', amount: TL(3000) }],
      credits: [{ date: '2026-01-20', amount: TL(1000) }],
      monthlyBasisPoints: 500,
      asOf: '2026-01-31',
    });
    expect(r.principalDays).toBe(BigInt(TL(1000)) * 10n + BigInt(TL(2000)) * 21n);
    expect(r.fee).toBe(8667); // 86,67 TL
    expect(r.overduePrincipal).toBe(TL(2000));
  });

  it('vade gunu ve oncesinde tazminat yok; vadeden sonraki ilk gun 1 gunluk', () => {
    const base = { charges: [{ id: 'c', dueDate: '2026-03-10', amount: TL(600) }], credits: [], monthlyBasisPoints: 500 };
    expect(computeLateFee({ ...base, asOf: '2026-03-10' }).fee).toBe(0);
    expect(computeLateFee({ ...base, asOf: '2026-03-11' }).fee).toBe(100); // 600 x %5/30 = 1,00 TL
    expect(computeLateFee({ ...base, asOf: '2026-04-09' }).fee).toBe(3000); // 30 gun = tam %5
  });

  it('vade gununde odenen borca tazminat islemez; vadeden once yapilan odeme (avans) de oyle', () => {
    const charges: FeeCharge[] = [{ id: 'c', dueDate: '2026-03-10', amount: TL(500) }];
    expect(computeLateFee({ charges, credits: [{ date: '2026-03-10', amount: TL(500) }], monthlyBasisPoints: 500, asOf: '2026-06-01' }).fee).toBe(0);
    expect(computeLateFee({ charges, credits: [{ date: '2026-02-01', amount: TL(500) }], monthlyBasisPoints: 500, asOf: '2026-06-01' }).fee).toBe(0);
  });

  it('her ay ayri vadeden isler; odeme en eski vadeye sayilir (FIFO, anapara once)', () => {
    const r = computeLateFee({
      charges: [
        { id: 'kasim', dueDate: '2026-11-10', amount: TL(1000) },
        { id: 'ekim', dueDate: '2026-10-10', amount: TL(1000) },
      ],
      // 15 Kasim'da 1.000 TL: Ekim kapanir (36 gun), Kasim 30 Kasim'a kadar acik (20 gun)
      credits: [{ date: '2026-11-15', amount: TL(1000) }],
      monthlyBasisPoints: 500,
      asOf: '2026-11-30',
    });
    expect(r.principalDays).toBe(BigInt(TL(1000)) * 36n + BigInt(TL(1000)) * 20n);
    expect(r.overduePrincipal).toBe(TL(1000));
  });

  it('bilesik degil: suresiz bekleyen borc dogrusal artar', () => {
    const base = { charges: [{ id: 'c', dueDate: '2026-01-01', amount: TL(1000) }], credits: [], monthlyBasisPoints: 500 };
    const d30 = computeLateFee({ ...base, asOf: '2026-01-31' }).fee;
    const d90 = computeLateFee({ ...base, asOf: '2026-04-01' }).fee;
    expect(d30).toBe(TL(50));
    expect(d90).toBe(TL(150));
  });

  it('yarim kurus yukari yuvarlanir, tek sefer', () => {
    // 1,00 TL x 3 gun x %5/30 = 0,5 kurus -> 1 kurus
    const r = computeLateFee({ charges: [{ id: 'c', dueDate: '2026-01-01', amount: 100 }], credits: [], monthlyBasisPoints: 500, asOf: '2026-01-04' });
    expect(r.principalDays).toBe(300n);
    expect(r.fee).toBe(1);
  });

  it('oran 0 ise tazminat 0; ayarlanan oran kullanilir', () => {
    const base = { charges: [{ id: 'c', dueDate: '2026-01-01', amount: TL(1000) }], credits: [], asOf: '2026-01-31' };
    expect(computeLateFee({ ...base, monthlyBasisPoints: 0 }).fee).toBe(0);
    expect(computeLateFee({ ...base, monthlyBasisPoints: 300 }).fee).toBe(TL(30));
    expect(() => computeLateFee({ ...base, monthlyBasisPoints: -1 })).toThrow();
  });

  it('deftere yazilmis tazminat dusulur, eksi fark sifirlanir', () => {
    const ledger = { charges: [{ id: 'c', dueDate: '2026-01-10', amount: TL(3000) }], credits: [{ date: '2026-01-20', amount: TL(1000) }], postedFees: 8000 };
    expect(unpostedLateFee(ledger, 500, '2026-01-31')).toBe(667);
    expect(unpostedLateFee({ ...ledger, postedFees: 20_000 }, 500, '2026-01-31')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ozellik testi: kaba kuvvet gun gun simulasyonla ayni kurus-gun toplami
// ---------------------------------------------------------------------------

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const iso = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

/** Gun d'de tazminat islenen anapara: vadesi d'den once olan ve d'den ONCE odenmemis kisim. */
function bruteForce(charges: FeeCharge[], credits: FeeCredit[], asOf: string): bigint {
  const sorted = [...charges].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
  const start = Math.min(...charges.map((c) => dayNumber(c.dueDate))) + 1;
  let total = 0n;
  for (let d = start; d <= dayNumber(asOf); d++) {
    let paid = credits.filter((c) => dayNumber(c.date) < d).reduce((s, c) => s + c.amount, 0);
    for (const c of sorted) {
      const covered = Math.min(paid, c.amount);
      paid -= covered;
      if (dayNumber(c.dueDate) < d) total += BigInt(c.amount - covered);
    }
  }
  return total;
}

describe('kistelyevm - rastgele senaryolarda kaba kuvvetle ayni sonuc', () => {
  it('500 rastgele senaryo', () => {
    const rnd = lcg(20261109);
    const base = dayNumber('2026-01-01');
    for (let run = 0; run < 500; run++) {
      const charges: FeeCharge[] = Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, i) => ({
        id: `c${i}`,
        dueDate: iso(base + Math.floor(rnd() * 120)),
        amount: 1 + Math.floor(rnd() * 500_000),
      }));
      const credits: FeeCredit[] = Array.from({ length: Math.floor(rnd() * 5) }, () => ({
        date: iso(base + Math.floor(rnd() * 200)),
        amount: 1 + Math.floor(rnd() * 600_000),
      }));
      const asOf = iso(base + 60 + Math.floor(rnd() * 160));
      const r = computeLateFee({ charges, credits, monthlyBasisPoints: 500, asOf });
      expect(r.principalDays).toBe(bruteForce(charges, credits, asOf));
      // Tazminat asla anapara x gun x %5/30'u asmaz ve negatif olmaz.
      expect(r.fee).toBeGreaterThanOrEqual(0);
    }
  });

  it('ek odeme tazminati asla artirmaz (monotonluk)', () => {
    const rnd = lcg(42);
    for (let run = 0; run < 200; run++) {
      const charges: FeeCharge[] = [
        { id: 'a', dueDate: '2026-02-10', amount: 1 + Math.floor(rnd() * 300_000) },
        { id: 'b', dueDate: '2026-03-10', amount: 1 + Math.floor(rnd() * 300_000) },
      ];
      const credits: FeeCredit[] = [{ date: iso(dayNumber('2026-02-01') + Math.floor(rnd() * 90)), amount: Math.floor(rnd() * 400_000) + 1 }];
      const extra: FeeCredit = { date: iso(dayNumber('2026-02-01') + Math.floor(rnd() * 90)), amount: Math.floor(rnd() * 100_000) + 1 };
      const without = computeLateFee({ charges, credits, monthlyBasisPoints: 500, asOf: '2026-06-30' }).fee;
      const withExtra = computeLateFee({ charges, credits: [...credits, extra], monthlyBasisPoints: 500, asOf: '2026-06-30' }).fee;
      expect(withExtra).toBeLessThanOrEqual(without);
    }
  });
});

describe('donem yardimcilari', () => {
  it('ay sinirlari, artik yil, yil donumu', () => {
    expect(periodBounds('2026-11')).toEqual({ first: '2026-11-01', last: '2026-11-30' });
    expect(periodBounds('2026-02').last).toBe('2026-02-28');
    expect(periodBounds('2028-02').last).toBe('2028-02-29');
    expect(nextPeriod('2026-12')).toBe('2027-01');
    expect(previousPeriod('2026-01')).toBe('2025-12');
    expect(periodLabel('2026-12')).toBe('Aralık 2026');
    expect(isPeriod('2026-13')).toBe(false);
    expect(isPeriod('2026-1')).toBe(false);
    expect(() => periodBounds('x')).toThrow();
  });
});

describe('computePartyDues - deftere yazilmis tazminat en son kapanir (karar 2a)', () => {
  it('tahsilat once anaparayi kapatir; tazminat kalemi vadesi gelse bile anaparadan sonra', () => {
    const r = computePartyDues(
      [
        { amount: 500, dueDate: '2026-11-01', fee: true },
        { amount: 10_000, dueDate: '2026-11-05' },
      ],
      10_000,
      '2026-11-20',
    );
    // Odeme anaparayi kapatti; acik kalan tazminat (vadesi gecmis) gecikmede gorunur.
    expect(r.balance).toBe(500);
    expect(r.overdue).toBe(500);
    expect(r.oldestUnpaidDueDate).toBe('2026-11-01');
    expect(r.lateFee).toBe(0);
  });
});
