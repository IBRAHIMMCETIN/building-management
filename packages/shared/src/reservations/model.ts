import type { AvailabilitySlot, BookingStatus, FeeStatus, OpeningWindow } from '../api/reservations';

/*
 * Rezervasyon ekranlarinin saf yardimcilari. Tarihler "YYYY-AA-GG" (Istanbul takvim gunu), saatler
 * "SS:DD" (Istanbul duvar saati); tarih aritmetigi UTC gun uzerinden yapilir, saat dilimi kaymaz.
 */

export const WEEKDAYS = [
  { day: 1, label: 'Pazartesi', short: 'Pzt' },
  { day: 2, label: 'Salı', short: 'Sal' },
  { day: 3, label: 'Çarşamba', short: 'Çar' },
  { day: 4, label: 'Perşembe', short: 'Per' },
  { day: 5, label: 'Cuma', short: 'Cum' },
  { day: 6, label: 'Cumartesi', short: 'Cmt' },
  { day: 7, label: 'Pazar', short: 'Paz' },
] as const;

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  pending: 'Onay bekliyor',
  confirmed: 'Onaylandı',
  rejected: 'Reddedildi',
  cancelled: 'İptal edildi',
};

export const BOOKING_STATUS_TONES: Record<BookingStatus, 'warning' | 'success' | 'danger' | 'neutral'> = {
  pending: 'warning',
  confirmed: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
};

export const FEE_STATUS_LABELS: Record<FeeStatus, string> = {
  none: 'Ücretsiz',
  pending: 'Onayda tahakkuk edilecek',
  charged: 'Borcunuza eklendi',
  void: 'Tahakkuk edilmedi',
  reversal_pending: 'İade bekliyor',
  reversed: 'İade edildi (ters kayıt)',
  resolved_manually: 'Yönetim tarafından çözüldü',
};

/** Istanbul takvim gunu. */
export function istanbulToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(now);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** ISO hafta gunu (1 = Pazartesi). */
export function weekdayOf(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Tarihin haftasi (Pazartesi - Pazar). */
export function weekOf(date: string): string[] {
  const monday = addDays(date, 1 - weekdayOf(date));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** "2026-11-29" -> "29 Kasım Pazar". */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', timeZone: 'UTC' })} ${WEEKDAYS[weekdayOf(date) - 1]?.label ?? ''}`;
}

/** 90 -> "1 sa 30 dk"; 60 -> "1 saat"; 30 -> "30 dk". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} dk`;
  return m ? `${h} sa ${m} dk` : `${h} saat`;
}

/** Acilis saatleri ozeti: ayni penceredeki ardisik gunler birlesir ("Pzt–Cum 09:00–22:00 · Cmt 10:00–18:00"). */
export function hoursSummary(hours: readonly OpeningWindow[]): string {
  const sorted = [...hours].sort((a, b) => a.day - b.day);
  const groups: { from: number; to: number; text: string }[] = [];
  for (const h of sorted) {
    const text = `${h.open}–${h.close}`;
    const last = groups.at(-1);
    if (last && last.text === text && last.to === h.day - 1) last.to = h.day;
    else groups.push({ from: h.day, to: h.day, text });
  }
  if (!groups.length) return 'Kapalı';
  const short = (d: number) => WEEKDAYS[d - 1]?.short ?? '';
  return groups.map((g) => (g.from === g.to ? `${short(g.from)} ${g.text}` : `${short(g.from)}–${short(g.to)} ${g.text}`)).join(' · ');
}

/**
 * Secilen baslangic diliminden itibaren yapilabilecek sureler: ardisik (bitisik) ve bos dilimler,
 * en uzun sureye kadar. Baslangic dilimi bos degilse bos liste.
 */
export function durationOptions(slots: readonly AvailabilitySlot[], startIndex: number, slotMinutes: number, maxBookingMinutes: number): number[] {
  const out: number[] = [];
  let prevEnd: string | undefined;
  for (let i = startIndex; i < slots.length; i++) {
    const s = slots[i];
    if (!s || s.state !== 'free' || (prevEnd !== undefined && s.start !== prevEnd)) break;
    const minutes = (i - startIndex + 1) * slotMinutes;
    if (minutes > maxBookingMinutes) break;
    out.push(minutes);
    prevEnd = s.end;
  }
  return out;
}

/** "SS:DD" + dakika -> bitis "SS:DD" (gun icinde). */
export function addClock(clock: string, minutes: number): string {
  const [h, m] = clock.split(':').map(Number) as [number, number];
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Ayni gune ait kayitlari tarih sirasiyla gruplar (takvim gorunumu). */
export function groupByDate<T extends { date: string; start: string }>(items: readonly T[], dates: readonly string[]): { date: string; items: T[] }[] {
  return dates.map((date) => ({ date, items: items.filter((i) => i.date === date).sort((a, b) => a.start.localeCompare(b.start)) }));
}
