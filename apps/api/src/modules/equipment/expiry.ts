/**
 * Ariza & bakim v2 - Ekipman son tarih hatirlatmalari (saf). Tarihler takvim gunu (Istanbul).
 *
 *  - Her tur (garanti, servis sozlesmesi, periyodik kontrol): onumuzdeki `days` gun icinde dolacak
 *    olanlar ve son `days` gun icinde dolmus olanlar.
 *  - `longExpired: true`: servis sozlesmesi ve periyodik kontrolun daha once dolmus olanlari da
 *    (yenilenene / kontrol yapilana kadar yonetimin isi). Yonetim ekrani her zaman, gunluk ozet
 *    yalnizca pazartesi ister: boylece ozet kendiliginden sessizlesir, haftada bir tam liste gider.
 *    Garantinin coktan dolmasi bir islem gerektirmez; hic listelenmez.
 *  - Hizmetten cikarilmis (`retired`) ekipman hatirlatma uretmez.
 */
import type { IsoDate } from '../core/types.js';
import type { Equipment, ExpiryItem, ExpiryKind } from './types.js';

export const EXPIRY_WINDOW_DAYS = 30;

const toUtc = (d: IsoDate) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
export const daysBetween = (from: IsoDate, to: IsoDate) => Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
/** Pazartesi mi (haftalik tam liste gunu)? */
export const isMonday = (d: IsoDate) => new Date(toUtc(d)).getUTCDay() === 1;

const ORDER: Record<ExpiryKind, number> = { inspection: 0, contract: 1, warranty: 2 };

export type ExpiryOptions = { days?: number; longExpired?: boolean };

export function expiryItemsOf(
  e: Pick<Equipment, 'equipmentId' | 'name' | 'status' | 'warrantyEndDate' | 'serviceContractEndDate' | 'nextInspectionDate'>,
  today: IsoDate,
  { days = EXPIRY_WINDOW_DAYS, longExpired = true }: ExpiryOptions = {},
): ExpiryItem[] {
  if (e.status === 'retired') return [];
  const out: ExpiryItem[] = [];
  const add = (kind: ExpiryKind, date: IsoDate | undefined, keepLongExpired: boolean) => {
    if (!date) return;
    const left = daysBetween(today, date);
    if (left > days) return;
    if (left < 0 && -left > days && !keepLongExpired) return;
    out.push({ equipmentId: e.equipmentId, name: e.name, kind, date, expired: left < 0, daysLeft: left });
  };
  add('inspection', e.nextInspectionDate, longExpired);
  add('contract', e.serviceContractEndDate, longExpired);
  add('warranty', e.warrantyEndDate, false);
  return out;
}

/** Tum ekipmanin kalemleri: tarihe gore (once en eski / en cok geciken), sonra tur ve ad. */
export function expiryItems(list: readonly Equipment[], today: IsoDate, opts: ExpiryOptions = {}): ExpiryItem[] {
  return list
    .flatMap((e) => expiryItemsOf(e, today, opts))
    .sort((a, b) => a.date.localeCompare(b.date) || ORDER[a.kind] - ORDER[b.kind] || a.name.localeCompare(b.name, 'tr'));
}
