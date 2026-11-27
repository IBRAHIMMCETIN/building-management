/**
 * Ariza & bakim v2 - Ekipman son tarih hatirlatmalari (saf). Tarihler takvim gunu (Istanbul).
 *
 *  - Garanti: onumuzdeki `days` gun icinde bitecek olanlar ve son `days` gun icinde bitmis olanlar.
 *    Garantinin bitmesi bir islem gerektirmez; eski bitisler her gun ozete dusmesin.
 *  - Servis sozlesmesi ve periyodik kontrol: onumuzdeki `days` gun icinde dolacaklar ve tarihi
 *    gecmis olanlarin TUMU (yenilenene / kontrol yapilana kadar yonetimin isidir).
 *  - Hizmetten cikarilmis (`retired`) ekipman hatirlatma uretmez.
 */
import type { IsoDate } from '../core/types.js';
import type { Equipment, ExpiryItem, ExpiryKind } from './types.js';

export const EXPIRY_WINDOW_DAYS = 30;

const toUtc = (d: IsoDate) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
export const daysBetween = (from: IsoDate, to: IsoDate) => Math.round((toUtc(to) - toUtc(from)) / 86_400_000);

const ORDER: Record<ExpiryKind, number> = { inspection: 0, contract: 1, warranty: 2 };

export function expiryItemsOf(e: Pick<Equipment, 'equipmentId' | 'name' | 'status' | 'warrantyEndDate' | 'serviceContractEndDate' | 'nextInspectionDate'>, today: IsoDate, days = EXPIRY_WINDOW_DAYS): ExpiryItem[] {
  if (e.status === 'retired') return [];
  const out: ExpiryItem[] = [];
  const add = (kind: ExpiryKind, date: IsoDate | undefined, keepExpired: boolean) => {
    if (!date) return;
    const left = daysBetween(today, date);
    if (left > days) return;
    if (left < 0 && !keepExpired && -left > days) return;
    out.push({ equipmentId: e.equipmentId, name: e.name, kind, date, expired: left < 0, daysLeft: left });
  };
  add('inspection', e.nextInspectionDate, true);
  add('contract', e.serviceContractEndDate, true);
  add('warranty', e.warrantyEndDate, false);
  return out;
}

/** Tum ekipmanin kalemleri: once tarihi gecenler, sonra en yakin tarih. */
export function expiryItems(list: readonly Equipment[], today: IsoDate, days = EXPIRY_WINDOW_DAYS): ExpiryItem[] {
  return list
    .flatMap((e) => expiryItemsOf(e, today, days))
    .sort((a, b) => a.date.localeCompare(b.date) || ORDER[a.kind] - ORDER[b.kind] || a.name.localeCompare(b.name, 'tr'));
}
