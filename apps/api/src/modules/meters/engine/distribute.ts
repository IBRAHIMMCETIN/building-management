/**
 * Finans 2.3 - Sayac / endeks dagitim motoru (saf, I/O yok).
 *
 * Adimlar:
 *  1. Dogrulama (tutar, oran, kapsam, ortak anahtar verisi).
 *  2. Parca tuketimleri (endeks farki, tur atma) ve uyarilar (sicrama, tahmin).
 *  3. Daire tuketim agirligi: Σ delta x 10^(S - scale) x katsayi (ortak paydaya genisletilmis).
 *  4. Havuzlar: Tc = floor(T x bps / 10000), Tk = T - Tc.
 *  5. Tc ortak anahtarla, Tk tuketim agirligiyla en buyuk kalan yontemiyle dagitilir.
 *     Toplam tuketim 0 ise tum T ortak anahtarla dagitilir (karar 3).
 *     Sayaci olmayan daire tuketim havuzuna girmez, yalnizca ortak pay oder (karar 5).
 *  6. Degismezler: Σ tutar = T, Σ ortak = Tc, Σ tuketim = Tk, her tutar >= 0.
 *
 * Esitlikte sira: kalan buyuk olan, sonra `unitId` (alfabetik) - toplu tahakkuk (`distributeKurus`)
 * ve paydas bolmesiyle (`largestRemainder`) ayni kural. Ayni girdi her zaman ayni kurusu uretir.
 */
import { largestRemainder } from '../../ownership/shares.js';
import { isValidFactor, isSpike, segmentDelta } from './consumption.js';
import {
  type DistributionInput,
  type DistributionLine,
  type DistributionResult,
  type DistributionUnit,
  type EngineIssue,
  type SegmentResult,
  BPS_TOTAL,
  COMMON_KEYS,
  METER_KINDS,
} from './types.js';

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};
const lcm = (a: bigint, b: bigint): bigint => (a / gcd(a, b)) * b;

/** `weight / den` degerini `scale` ondalikla (yarim yukari) yazar: (123456n, 1n, 3) -> "123.456". */
export function formatScaled(weight: bigint, den: bigint, scale: number): string {
  if (den <= 0n) throw new Error('Payda pozitif olmali');
  const q = (weight * 2n + den) / (den * 2n);
  if (scale === 0) return q.toString();
  const s = q.toString().padStart(scale + 1, '0');
  return `${s.slice(0, -scale)}.${s.slice(-scale)}`;
}

/** Ortak anahtar agirliklari (`units` sirasiyla). Eksik veri engelleyici hatadir. */
function commonWeights(units: readonly DistributionUnit[], key: (typeof COMMON_KEYS)[number], errors: EngineIssue[]): bigint[] {
  if (key === 'equal') return units.map(() => 1n);
  if (key === 'area') {
    return units.map((u) => {
      if (!Number.isSafeInteger(u.grossAreaTenthsM2) || u.grossAreaTenthsM2 < 1) {
        errors.push({ code: 'missing_area', unitId: u.unitId, message: 'Bağımsız bölümün metrekaresi tanımlı değil' });
        return 0n;
      }
      return BigInt(u.grossAreaTenthsM2);
    });
  }
  // Arsa payi: kesirler ortak paydaya genisletilir (oranlar birebir korunur).
  const fracs = units.map((u) => {
    const ls = u.landShare;
    if (!ls || !Number.isSafeInteger(ls.numerator) || !Number.isSafeInteger(ls.denominator) || ls.numerator < 1 || ls.denominator < 1) {
      errors.push({ code: 'missing_land_share', unitId: u.unitId, message: 'Bağımsız bölümün arsa payı tanımlı değil' });
      return { n: 0n, d: 1n };
    }
    return { n: BigInt(ls.numerator), d: BigInt(ls.denominator) };
  });
  const common = fracs.reduce((acc, f) => lcm(acc, f.d), 1n);
  return fracs.map((f) => f.n * (common / f.d));
}

export function calculateDistribution(input: DistributionInput): DistributionResult {
  const errors: EngineIssue[] = [];
  const warnings: EngineIssue[] = [];
  const { template } = input;
  const T = input.totalAmount;

  if (!Number.isSafeInteger(T) || T < 1) errors.push({ code: 'invalid_total', message: 'Fatura tutarı pozitif tam sayı (kuruş) olmalı' });
  if (!Number.isSafeInteger(template.commonShareBps) || template.commonShareBps < 0 || template.commonShareBps > BPS_TOTAL) {
    errors.push({ code: 'invalid_ratio', message: `Ortak pay 0-${BPS_TOTAL} baz puan olmalı` });
  }
  if (!(COMMON_KEYS as readonly string[]).includes(template.commonKey)) {
    errors.push({ code: 'invalid_ratio', message: `Ortak dağıtım anahtarı geçersiz: ${String(template.commonKey)}` });
  }
  if (!(METER_KINDS as readonly string[]).includes(template.meterKind)) {
    errors.push({ code: 'kind_mismatch', message: `Sayaç türü geçersiz: ${String(template.meterKind)}` });
  }
  if (input.units.length === 0) errors.push({ code: 'no_units', message: 'Dağıtım kapsamında bağımsız bölüm yok' });

  const units = [...input.units].sort((a, b) => a.unitId.localeCompare(b.unitId));
  const unitIndex = new Map<string, number>();
  for (const [i, u] of units.entries()) {
    if (unitIndex.has(u.unitId)) errors.push({ code: 'duplicate_unit', unitId: u.unitId, message: 'Bağımsız bölüm kapsamda birden fazla kez var' });
    unitIndex.set(u.unitId, i);
  }
  if (errors.length) return { ok: false, errors, warnings };

  const cWeights = commonWeights(units, template.commonKey, errors);

  // Parcalar: endeks farki ve uyarilar.
  type Valid = { unit: number; result: SegmentResult };
  const valid: Valid[] = [];
  const segments = [...input.segments].sort((a, b) => a.unitId.localeCompare(b.unitId) || a.meterId.localeCompare(b.meterId));
  for (const seg of segments) {
    const base = { unitId: seg.unitId, meterId: seg.meterId };
    if (seg.kind !== template.meterKind) {
      errors.push({ ...base, code: 'kind_mismatch', message: `Sayaç türü (${seg.kind}) şablonla (${template.meterKind}) uyuşmuyor` });
      continue;
    }
    const ui = unitIndex.get(seg.unitId);
    if (ui === undefined) {
      warnings.push({ ...base, code: 'meter_unit_out_of_scope', message: 'Sayacın bağımsız bölümü dağıtım kapsamında değil; yok sayıldı' });
      continue;
    }
    if (!isValidFactor(seg.factor)) {
      errors.push({ ...base, code: 'invalid_factor', message: 'Katsayı pozitif tam sayı pay/payda olmalı' });
      continue;
    }
    const d = segmentDelta(seg);
    if ('error' in d) {
      errors.push(d.error);
      continue;
    }
    if (d.rollover) warnings.push({ ...base, code: 'rollover', message: 'Sayaç tur attı; fark en büyük endeks üzerinden hesaplandı' });
    if (seg.estimated) warnings.push({ ...base, code: 'estimated', message: 'Tahmini okuma (yönetici onaylı)' });
    if (isSpike(d.delta, seg.history, seg.days)) {
      warnings.push({ ...base, code: 'spike', message: 'Tüketim geçmiş ortalamanın 3 katından fazla; okumayı kontrol edin' });
    }
    valid.push({
      unit: ui,
      result: {
        meterId: seg.meterId,
        startIndex: seg.startIndex,
        endIndex: seg.endIndex as number,
        startSource: seg.startSource,
        endSource: seg.endSource ?? 'reading',
        delta: d.delta,
        rollover: d.rollover,
        estimated: seg.estimated === true,
        factor: seg.factor,
        scale: seg.scale,
      },
    });
  }
  if (errors.length) return { ok: false, errors, warnings };

  // Tuketim agirligi: ortak olcek S ve katsayi ortak paydasi D.
  const S = valid.reduce((m, v) => Math.max(m, v.result.scale), 0);
  const D = valid.reduce((acc, v) => lcm(acc, BigInt(v.result.factor.den)), 1n);
  const consWeights = units.map(() => 0n);
  const perUnit = units.map(() => [] as SegmentResult[]);
  for (const v of valid) {
    const f = v.result.factor;
    const w = BigInt(v.result.delta) * 10n ** BigInt(S - v.result.scale) * BigInt(f.num) * (D / BigInt(f.den));
    consWeights[v.unit] = (consWeights[v.unit] ?? 0n) + w;
    perUnit[v.unit]?.push(v.result);
  }
  const totalCons = consWeights.reduce((s, w) => s + w, 0n);

  // Havuzlar.
  const fallback = totalCons === 0n;
  const commonPool = fallback ? T : Number((BigInt(T) * BigInt(template.commonShareBps)) / BigInt(BPS_TOTAL));
  const consumptionPool = T - commonPool;
  if (fallback) {
    warnings.push({ code: 'zero_consumption_fallback', message: 'Toplam tüketim sıfır; tutarın tamamı ortak anahtarla dağıtıldı' });
  }

  const commonAmounts = largestRemainder(commonPool, cWeights);
  const consumptionAmounts = units.map(() => 0);
  if (!fallback) {
    const idx = units.map((_, i) => i).filter((i) => (consWeights[i] ?? 0n) > 0n);
    const parts = largestRemainder(consumptionPool, idx.map((i) => consWeights[i] ?? 0n));
    idx.forEach((i, k) => {
      consumptionAmounts[i] = parts[k] ?? 0;
    });
  }

  const lines: DistributionLine[] = units.map((u, i) => {
    const segs = perUnit[i] ?? [];
    const hasMeter = segs.length > 0;
    if (!hasMeter) {
      warnings.push(
        template.commonShareBps === 0 && !fallback
          ? { code: 'no_meter_zero_charge', unitId: u.unitId, message: 'Sayacı yok ve ortak pay %0; bu bölüme tutar düşmedi' }
          : { code: 'no_meter_common_only', unitId: u.unitId, message: 'Sayacı yok; yalnızca ortak pay yazıldı' },
      );
    }
    const commonAmount = commonAmounts[i] ?? 0;
    const consumptionAmount = consumptionAmounts[i] ?? 0;
    return {
      unitId: u.unitId,
      hasMeter,
      estimated: segs.some((s) => s.estimated),
      segments: segs,
      consumptionWeight: consWeights[i] ?? 0n,
      consumption: formatScaled(consWeights[i] ?? 0n, D, S),
      commonWeight: cWeights[i] ?? 0n,
      commonAmount,
      consumptionAmount,
      amount: commonAmount + consumptionAmount,
    };
  });

  const result: DistributionResult = {
    ok: true,
    lines,
    totals: {
      totalAmount: T,
      commonPool,
      consumptionPool,
      fallbackToCommon: fallback,
      totalConsumptionWeight: totalCons,
      totalConsumption: formatScaled(totalCons, D, S),
      consumptionScale: S,
      consumptionDenominator: D,
    },
    warnings,
  };
  assertDistributionInvariants(result);
  return result;
}

/**
 * Kural 4: fatura toplami ile dagitilan tutarlar arasinda tek kurus fark olamaz. Yazimdan once ve
 * testlerde cagrilir; ihlal programlama hatasidir (firlatir).
 */
export function assertDistributionInvariants(r: DistributionResult): void {
  if (!r.ok) return;
  const { lines, totals } = r;
  const sum = (f: (l: DistributionLine) => number) => lines.reduce((s, l) => s + f(l), 0);
  if (totals.commonPool + totals.consumptionPool !== totals.totalAmount) throw new Error('Havuz toplamı fatura tutarına eşit değil');
  if (sum((l) => l.amount) !== totals.totalAmount) throw new Error('Dağıtılan toplam fatura tutarına eşit değil');
  if (sum((l) => l.commonAmount) !== totals.commonPool) throw new Error('Ortak pay toplamı havuza eşit değil');
  if (sum((l) => l.consumptionAmount) !== totals.consumptionPool) throw new Error('Tüketim payı toplamı havuza eşit değil');
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amount) || l.amount < 0 || l.commonAmount < 0 || l.consumptionAmount < 0) {
      throw new Error(`Geçersiz satır tutarı: ${l.unitId}`);
    }
    if (l.commonAmount + l.consumptionAmount !== l.amount) throw new Error(`Satır toplamı tutmuyor: ${l.unitId}`);
    if (!l.hasMeter && l.consumptionAmount !== 0) throw new Error(`Sayaçsız bölüme tüketim payı yazıldı: ${l.unitId}`);
  }
}
