/**
 * "2026-11-08" -> "8 Kas 2026" (saat dilimi kaymasi olmadan). Tam zaman damgasi verilirse
 * ("2026-11-10T21:30:00.000Z") once Istanbul gunune cevrilir (-> "11 Kas 2026"); eskiden bu
 * durumda "Invalid Date" yaziliyordu (talep listeleri createdAt verir).
 */
export function formatDate(iso: string): string {
  const day = iso.length > 10 && iso.includes('T') ? isoToIstanbulLocal(iso).slice(0, 10) : iso;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** "2026-11-10T06:00:00.000Z" -> "10 Kas 2026 09:00" (Istanbul saatiyle). */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('tr-TR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Istanbul',
  });
}

/*
 * <input type="datetime-local"> <-> ISO donusumleri. Turkiye 2016'dan beri yaz saati
 * uygulamadan sabit UTC+03:00 kullanir; donusum tarayicinin saat diliminden bagimsizdir.
 */
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;

/** "2026-11-10T09:00" -> "2026-11-10T09:00:00+03:00" (API saat dilimli ISO ister). */
export function istanbulLocalToIso(local: string): string {
  return `${local.slice(0, 16)}:00+03:00`;
}

/** ISO -> "2026-11-10T09:00" (Istanbul duvar saati; datetime-local degeri). */
export function isoToIstanbulLocal(iso: string): string {
  return new Date(Date.parse(iso) + ISTANBUL_OFFSET_MS).toISOString().slice(0, 16);
}

/** Simdiki Istanbul saati, datetime-local `min` degeri icin. */
export function nowIstanbulLocal(now: Date = new Date()): string {
  return isoToIstanbulLocal(now.toISOString());
}
