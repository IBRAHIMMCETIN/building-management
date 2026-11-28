/**
 * Faz 3 (O1-3) periyodik bakim - saf takvim ve etiket yardimcilari (API: apps/api/src/modules/maintenance).
 * Gorev durumlari, etiketleri ve tonlari web + mobil ortak (packages/shared/src/api/work.ts).
 */
import type { TaskStatus } from '@bm/shared/api/work';

export { TASK_STATUSES, TASK_STATUS_LABELS, TASK_STATUS_TONES, type TaskStatus } from '@bm/shared/api/work';

export const SCHEDULE_UNITS = ['week', 'month', 'year'] as const;
export type ScheduleUnit = (typeof SCHEDULE_UNITS)[number];

export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['scheduled', 'in_progress'];

const UNIT_WORD: Record<ScheduleUnit, string> = { week: 'hafta', month: 'ay', year: 'yıl' };
const UNIT_ADVERB: Record<ScheduleUnit, string> = { week: 'Haftalık', month: 'Aylık', year: 'Yıllık' };

/** "Aylık" / "3 ayda bir" / "2 haftada bir". */
export function scheduleText(s: { every: number; unit: ScheduleUnit }): string {
  if (s.every === 1) return UNIT_ADVERB[s.unit];
  return `${s.every} ${UNIT_WORD[s.unit]}da bir`;
}

/** "2026-11" + n ay. */
export function addMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Ay adi: "Kasım 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/**
 * Pazartesiyle baslayan haftalar; ay disindaki gunler `null`. Her gun `YYYY-MM-DD`.
 */
export function monthGrid(month: string): (string | null)[][] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export const WEEKDAYS_SHORT = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'] as const;

/** Istanbul gunu (YYYY-MM-DD). */
export function istanbulToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(now);
}

/** Gorev kimligi `<dueDate>_<templateId>`. */
export const dueDateOfTask = (taskId: string) => taskId.slice(0, 10);
