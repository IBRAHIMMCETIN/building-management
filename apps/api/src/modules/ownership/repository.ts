/**
 * Finans 2.1 - Mulkiyet sicili deposu (okuma). Yazimlar finans defteriyle AYNI atomik islemde
 * yapilir (`FinanceRepository.postBatch`: `newDocs` / `replaceRecords`), bu yuzden burada yalnizca
 * okuma vardir. Ayni tablo, ayni partition (`APT#<apartmentId>`): ek IAM izni gerekmez.
 */
import { getTenantItem, queryTenantAll, skKey, tenantPk } from '../../config/dynamodb.js';
import type { IsoDate, TableKeys } from '../core/types.js';
import type { OwnershipHead, OwnershipRecord, OwnershipTransfer } from './types.js';

/** Sicil sirasi sabit genislikte: SK siralamasi = (validFrom, seq) siralamasi. */
export const seqKey = (seq: number) => String(seq).padStart(6, '0');

export const ownershipKeys = {
  head: (apartmentId: string, unitId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('OWNERHEAD', unitId) }),
  record: (apartmentId: string, unitId: string, validFrom: IsoDate, seq: number): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('OWNERSHIP', unitId, validFrom, seqKey(seq)),
  }),
  transfer: (apartmentId: string, transferId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('OWNXFER', transferId) }),
};

export type OwnershipRepository = {
  getHead(apartmentId: string, unitId: string): Promise<OwnershipHead | undefined>;
  listHeads(apartmentId: string): Promise<OwnershipHead[]>;
  /** Dairenin tum sicil kayitlari; `unitId` verilmezse apartmanin tumu. */
  listRecords(apartmentId: string, unitId?: string): Promise<OwnershipRecord[]>;
  getTransfer(apartmentId: string, transferId: string): Promise<OwnershipTransfer | undefined>;
  listTransfers(apartmentId: string): Promise<OwnershipTransfer[]>;
};

export const ownershipRepository: OwnershipRepository = {
  getHead: (apartmentId, unitId) => getTenantItem<OwnershipHead>(ownershipKeys.head(apartmentId, unitId)),
  listHeads: (apartmentId) => queryTenantAll<OwnershipHead>(apartmentId, 'OWNERHEAD#', { ConsistentRead: true }),
  listRecords: (apartmentId, unitId) =>
    queryTenantAll<OwnershipRecord>(apartmentId, unitId ? `OWNERSHIP#${unitId}#` : 'OWNERSHIP#', { ConsistentRead: true }),
  getTransfer: (apartmentId, transferId) => getTenantItem<OwnershipTransfer>(ownershipKeys.transfer(apartmentId, transferId)),
  listTransfers: (apartmentId) => queryTenantAll<OwnershipTransfer>(apartmentId, 'OWNXFER#', { ConsistentRead: true }),
};
