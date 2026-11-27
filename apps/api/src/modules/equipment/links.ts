/**
 * Ariza & bakim v2 - Talep ve bakim sablonunun ekipman baglantisi (ortak dogrulama).
 *
 * Ekipman, istegi yapanin JWT'deki apartmani altinda aranir (`APT#<apartmentId>` + `EQUIP#<id>`):
 * baska apartmanin ekipman kimligi bu anahtarda yoktur ve "bulunamadi" ile reddedilir. Hizmetten
 * cikarilmis ekipmana yeni baglanti kurulamaz; mevcut baglanti korunur.
 */
import { assertId } from '../core/validation.js';
import { TicketError } from '../tickets/errors.js';
import type { EquipmentRepository } from './repository.js';
import type { Equipment } from './types.js';

export type EquipmentLookup = Pick<EquipmentRepository, 'get'>;

/**
 * `undefined`: degisiklik yok (`current` doner); `null` / `''`: baglanti kaldirilir; kimlik:
 * ayni apartmandaki ekipman olmali.
 */
export async function resolveEquipmentLink(
  lookup: EquipmentLookup,
  apartmentId: string,
  value: unknown,
  current?: string,
  field = 'equipmentId',
): Promise<{ equipmentId: string | undefined; equipment?: Equipment }> {
  if (value === undefined) return { equipmentId: current };
  if (value === null || value === '') return { equipmentId: undefined };
  const equipmentId = assertId(value, field);
  const equipment = await lookup.get(apartmentId, equipmentId);
  if (!equipment || equipment.apartmentId !== apartmentId) throw new TicketError('not_found', 'Ekipman bulunamadı');
  if (equipment.status === 'retired' && equipmentId !== current) throw new TicketError('unprocessable', 'Hizmetten çıkarılmış ekipmana bağlantı kurulamaz');
  return { equipmentId, equipment };
}
