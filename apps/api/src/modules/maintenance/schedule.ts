/**
 * Faz 3 (O1-3) - Bakim takvimi hesaplari (saf). Tarihler takvim gunu (YYYY-MM-DD, Istanbul).
 */
import type { IsoDate } from '../core/types.js';
import type { MaintenanceSchedule } from './types.js';

const toUtc = (d: IsoDate) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const fromUtc = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10);

export function addDays(d: IsoDate, n: number): IsoDate {
  return fromUtc(toUtc(d) + n * 86_400_000);
}

/** Ay ekler; hedef ayda gun yoksa ayin son gunu (31 Ocak + 1 ay = 28/29 Subat). */
export function addMonthsClamped(d: IsoDate, months: number): IsoDate {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7)) - 1 + months;
  const day = Number(d.slice(8, 10));
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(ty, tm, Math.min(day, last)));
}

/** n. tekrarin tarihi (0 = baslangic). Ay/yil adimi her zaman baslangic gunune gore (kayma birikmez). */
export function occurrenceAt(s: MaintenanceSchedule, n: number): IsoDate {
  switch (s.unit) {
    case 'week':
      return addDays(s.startDate, n * 7 * s.every);
    case 'month':
      return addMonthsClamped(s.startDate, n * s.every);
    case 'year':
      return addMonthsClamped(s.startDate, n * 12 * s.every);
  }
}

/** [from, to] araligina dusen tekrarlar (dahil). En fazla `limit` tane. */
export function occurrences(s: MaintenanceSchedule, from: IsoDate, to: IsoDate, limit = 200): IsoDate[] {
  const out: IsoDate[] = [];
  if (to < s.startDate) return out;
  // Ilk adayi dogrudan tahmin et (uzun gecmisi tek tek yurumeyelim).
  let n = 0;
  if (from > s.startDate) {
    const days = (toUtc(from) - toUtc(s.startDate)) / 86_400_000;
    const per = s.unit === 'week' ? 7 * s.every : s.unit === 'month' ? 28 * s.every : 365 * s.every;
    n = Math.max(0, Math.floor(days / per) - 1);
  }
  for (let guard = 0; guard < 5000 && out.length < limit; guard++, n++) {
    const d = occurrenceAt(s, n);
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out;
}
