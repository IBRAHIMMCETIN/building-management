import type { IsoDate } from '../core/types.js';
import type { BillingPeriod, InvoiceLine, PlanPricing, PlanSnapshot } from './types.js';

/**
 * Abonelik fiyat hesabi (SAF). Tum tutarlar KDV HARIC kurus tam sayidir; KDV toplam matrah
 * uzerinden bir kez, yarim yukari yuvarlanarak hesaplanir (BigInt; kayan nokta yok).
 */

/** KDV: round_half_up(net x oran / 10000). */
export function vatOf(netKurus: number, vatRateBps: number): number {
  if (!Number.isSafeInteger(netKurus) || netKurus < 0) throw new Error(`Matrah gecersiz: ${netKurus}`);
  if (!Number.isSafeInteger(vatRateBps) || vatRateBps < 0 || vatRateBps > 10_000) throw new Error(`KDV orani gecersiz: ${vatRateBps}`);
  return Number((BigInt(netKurus) * BigInt(vatRateBps) + 5_000n) / 10_000n);
}

export function invoiceAmounts(lines: readonly InvoiceLine[], vatRateBps: number) {
  const netKurus = lines.reduce((s, l) => s + l.amountKurus, 0);
  const vatKurus = vatOf(netKurus, vatRateBps);
  return { netKurus, vatRateBps, vatKurus, totalKurus: netKurus + vatKurus };
}

const PERIOD_LABEL: Record<BillingPeriod, string> = { monthly: 'aylık', annual: 'yıllık' };

/** Donem bedelinin satirlari (KDV haric). Bedeli 0 olan satir yazilmaz. */
export function priceLines(plan: Pick<PlanSnapshot, 'name' | 'pricing'>, period: BillingPeriod, units: number): InvoiceLine[] {
  const p: PlanPricing = plan.pricing;
  const annual = period === 'annual';
  const base = annual ? p.annualKurus : p.monthlyKurus;
  const label = `${plan.name} (${PERIOD_LABEL[period]})`;
  const lines: InvoiceLine[] = [];
  if (p.model === 'tiered') {
    const tiers = p.tiers ?? [];
    const tier = tiers.find((t) => t.maxUnits === null || units <= t.maxUnits) ?? tiers[tiers.length - 1];
    if (tier) {
      const amount = annual ? tier.annualKurus : tier.monthlyKurus;
      const range = tier.maxUnits === null ? 'sınırsız bölüm' : `${tier.maxUnits} bölüme kadar`;
      if (amount > 0) lines.push({ description: `${label} - ${range}`, quantity: 1, unitPriceKurus: amount, amountKurus: amount });
    }
    return lines;
  }
  if (base > 0) lines.push({ description: label, quantity: 1, unitPriceKurus: base, amountKurus: base });
  if (p.model === 'per_unit') {
    const per = (annual ? p.perUnitAnnualKurus : p.perUnitMonthlyKurus) ?? 0;
    if (per > 0 && units > 0) lines.push({ description: `Bağımsız bölüm başı (${PERIOD_LABEL[period]})`, quantity: units, unitPriceKurus: per, amountKurus: per * units });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Takvim (Istanbul gunleri, YYYY-MM-DD)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const toUtc = (d: IsoDate) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const fromUtc = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10);

export const addDays = (d: IsoDate, n: number): IsoDate => fromUtc(toUtc(d) + n * DAY_MS);
export const daysBetween = (from: IsoDate, to: IsoDate): number => Math.round((toUtc(to) - toUtc(from)) / DAY_MS);

/** Ay ekler; hedef ayda gun yoksa ayin son gunu (31 Ocak + 1 ay = 28/29 Subat). */
export function addMonths(d: IsoDate, n: number): IsoDate {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7)) - 1 + n;
  const day = Number(d.slice(8, 10));
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(ty, tm, Math.min(day, last)));
}

export const periodMonths = (p: BillingPeriod) => (p === 'annual' ? 12 : 1);

/** `index`. donem (0'dan): [anchor + index*ay, anchor + (index+1)*ay - 1 gun]. Kayma yok. */
export function periodBounds(anchor: IsoDate, index: number, period: BillingPeriod): { start: IsoDate; end: IsoDate } {
  const m = periodMonths(period);
  return { start: addMonths(anchor, index * m), end: addDays(addMonths(anchor, (index + 1) * m), -1) };
}

export function istanbulDay(now: Date): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(now);
}
