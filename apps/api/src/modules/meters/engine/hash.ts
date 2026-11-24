/**
 * Finans 2.3 - Hesap ozeti (calcHash): onay istegi onizlemede gorulen hesabin hash'ini tasir;
 * girdi veya sonuc degistiyse onay 409 ile reddedilir. Kanonik JSON (anahtarlar sirali), BigInt
 * degerler ondalik metin olarak yazilir.
 */
import { createHash } from 'node:crypto';
import type { DistributionInput, DistributionResult } from './types.js';

export const CALC_HASH_VERSION = 1;

export function canonical(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v === undefined ? null : v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/** Girdi + basarili sonuc ozeti (sha256 hex). Sonuc hatali ise hash uretilmez. */
export function distributionHash(input: DistributionInput, result: DistributionResult): string {
  if (!result.ok) throw new Error('Hatalı hesap için hash üretilmez');
  const payload = {
    v: CALC_HASH_VERSION,
    input: {
      totalAmount: input.totalAmount,
      template: input.template,
      units: [...input.units].sort((a, b) => a.unitId.localeCompare(b.unitId)),
      segments: [...input.segments].sort((a, b) => a.unitId.localeCompare(b.unitId) || a.meterId.localeCompare(b.meterId)),
    },
    lines: result.lines,
    totals: result.totals,
  };
  return createHash('sha256').update(canonical(payload)).digest('hex');
}
