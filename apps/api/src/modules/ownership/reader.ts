/**
 * Finans 2.1 - Diger modullerin (finans tahakkuku, portal, uyelik) mulkiyet sicilinden okudugu
 * dar arayuz. Finans/portal bu modulun servisine degil yalnizca bu okuyucuya baglidir (dongu yok).
 */
import type { IsoDate } from '../core/types.js';
import { type OwnershipRepository, ownershipRepository } from './repository.js';
import { effectiveRecord } from './register.js';
import type { OwnerShare } from './shares.js';
import type { OwnerBilling } from './types.js';

export type OwnershipReader = {
  /**
   * `split` faturalamali dairede `day` gunu gecerli pay tablosu (malik tahakkuku bu paylarla
   * bolunur). `joint` dairede veya o gun sicil kaydi yoksa `undefined` (ortak malik carisi).
   */
  ownerSplitOn(apartmentId: string, unitId: string, day: IsoDate): Promise<OwnerShare[] | undefined>;
  /** Dairenin faturalama modu (sicil yoksa `joint`). */
  billingOf(apartmentId: string, unitId: string): Promise<OwnerBilling>;
  /** Dairenin mulkiyet sicili var mi? (varsa pay yalnizca devir/sicil duzeltmesiyle degisir) */
  hasRegister(apartmentId: string, unitId: string): Promise<boolean>;
  /** `split` faturalamali bolumler (banka eslestirmesi: malik tahsilati paydas carisine). */
  splitUnits(apartmentId: string): Promise<Set<string>>;
};

export function createOwnershipReader(repo: OwnershipRepository = ownershipRepository): OwnershipReader {
  return {
    async ownerSplitOn(apartmentId, unitId, day) {
      const head = await repo.getHead(apartmentId, unitId);
      if (!head || head.billing !== 'split') return undefined;
      const rec = effectiveRecord(await repo.listRecords(apartmentId, unitId), unitId, day);
      return rec && rec.owners.length > 0 ? rec.owners : undefined;
    },
    async billingOf(apartmentId, unitId) {
      return (await repo.getHead(apartmentId, unitId))?.billing ?? 'joint';
    },
    async hasRegister(apartmentId, unitId) {
      return Boolean(await repo.getHead(apartmentId, unitId));
    },
    async splitUnits(apartmentId) {
      const heads = await repo.listHeads(apartmentId);
      return new Set(heads.filter((h) => h.apartmentId === apartmentId && h.billing === 'split').map((h) => h.unitId));
    },
  };
}
