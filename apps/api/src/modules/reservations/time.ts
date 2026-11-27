/**
 * Rezervasyon saat yardimcilari (saf). Acilis saatleri ve rezervasyon baslangici Europe/Istanbul
 * duvar saatiyle (`HH:MM`) girilir; kilit ve kayitlar UTC ISO tutar.
 *
 * Turkiye 2016'dan beri yaz saati uygulamadan sabit UTC+03:00 kullanir (web `lib/dates.ts` ile ayni
 * varsayim): gun baslangici `YYYY-MM-DDT00:00:00+03:00`, takvim gunu `Intl` ile Europe/Istanbul.
 */
import type { IsoDate, IsoDateTime } from '../core/types.js';
import { type Facility, type OpeningWindow, SLOT_STEP_MINUTES, type Weekday } from './types.js';

const MINUTE = 60_000;
const DAY_MINUTES = 1440;

/** "09:30" -> 570; "24:00" -> 1440. Gecersizse undefined. */
export function parseClock(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return undefined;
  return h * 60 + min;
}

/** 570 -> "09:30". */
export function formatClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** ISO hafta gunu (1 = Pazartesi). */
export function weekdayOf(date: IsoDate): Weekday {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return (d === 0 ? 7 : d) as Weekday;
}

export function istanbulDate(at: Date): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(at);
}

/** Istanbul gununun `minutes`. dakikasi (UTC ISO). `minutes` 1440 olabilir (ertesi gun 00:00). */
export function istanbulInstant(date: IsoDate, minutes: number): IsoDateTime {
  return new Date(Date.parse(`${date}T00:00:00.000+03:00`) + minutes * MINUTE).toISOString();
}

/** UTC ISO'nun Istanbul gun ici dakikasi. */
export function istanbulMinutes(iso: IsoDateTime): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MINUTES * MINUTE).toISOString().slice(0, 10);
}

/** b - a (gun). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / (DAY_MINUTES * MINUTE));
}

/** Gunun acik penceresi (dakika); kapaliysa undefined. */
export function windowOn(hours: readonly OpeningWindow[], date: IsoDate): { open: number; close: number } | undefined {
  const w = hours.find((h) => h.day === weekdayOf(date));
  if (!w) return undefined;
  const open = parseClock(w.open);
  const close = parseClock(w.close);
  return open === undefined || close === undefined || close <= open ? undefined : { open, close };
}

/** Gunun rezervasyon izgarasi: acilistan itibaren `slotMinutes` aralikli baslangiclar. */
export function slotGrid(f: Pick<Facility, 'openingHours' | 'slotMinutes'>, date: IsoDate): { start: number; end: number }[] {
  const w = windowOn(f.openingHours, date);
  if (!w) return [];
  const out: { start: number; end: number }[] = [];
  for (let s = w.open; s + f.slotMinutes <= w.close; s += f.slotMinutes) out.push({ start: s, end: s + f.slotMinutes });
  return out;
}

/**
 * Rezervasyon suresinin kurallara uygunlugu (saf): acik gun, acilis/kapanis icinde, izgaraya
 * hizali baslangic, dilim uzunlugunun kati ve en uzun sure. Uygunsa undefined, degilse Turkce neden.
 */
export function bookingTimeError(f: Pick<Facility, 'openingHours' | 'slotMinutes' | 'maxBookingMinutes'>, date: IsoDate, start: number, minutes: number): string | undefined {
  const w = windowOn(f.openingHours, date);
  if (!w) return 'Ortak alan bu gün kapalı';
  if (start < w.open || start + minutes > w.close) return `Rezervasyon açılış saatleri içinde olmalı (${formatClock(w.open)}–${formatClock(w.close)})`;
  if ((start - w.open) % f.slotMinutes !== 0) return `Başlangıç saati ${f.slotMinutes} dakikalık dilimlere uymuyor`;
  if (minutes < f.slotMinutes || minutes % f.slotMinutes !== 0) return `Süre ${f.slotMinutes} dakikanın katı olmalı`;
  if (minutes > f.maxBookingMinutes) return `En fazla ${f.maxBookingMinutes} dakika rezervasyon yapılabilir`;
  return undefined;
}

/** Kilit dilimleri: [start, end) araliginda 30 dakikalik baslangiclar (UTC ISO). */
export function lockSlotsOf(start: IsoDateTime, end: IsoDateTime): IsoDateTime[] {
  const out: IsoDateTime[] = [];
  for (let t = Date.parse(start); t < Date.parse(end); t += SLOT_STEP_MINUTES * MINUTE) out.push(new Date(t).toISOString());
  return out;
}
