import type { AuditFields, IsoDate, IsoDateTime, TableKeys } from '../core/types.js';

export type ImportStatus = 'in_progress' | 'completed' | 'rolled_back';
export type ImportKind = 'unit' | 'person' | 'balance' | 'funds';
export type ImportOutcome = 'created' | 'exists' | 'error';
export type InvitationState = 'pending' | 'sent' | 'existing_user' | 'not_pending';

export type ImportCounts = Record<ImportKind, Record<ImportOutcome, number>>;

/**
 * Toplu aktarim islemi (geri alma birimi).
 *   PK = `APT#<apt>`, SK = `IMPORT#<importId>`
 */
export type ImportJob = TableKeys &
  AuditFields & {
    entityType: 'IMPORT';
    importId: string;
    apartmentId: string;
    fileName: string;
    /** Devir tarihi: acilis bakiyelerinin muhasebe tarihi. */
    asOfDate: IsoDate;
    status: ImportStatus;
    totals: { units: number; people: number; balances: number };
    counts?: ImportCounts;
    completedAt?: IsoDateTime;
    rolledBackAt?: IsoDateTime;
    rollbackReport?: { reversed: number; membershipsEnded: number; unitsDeactivated: number; unitsKept: number };
  };

/**
 * Aktarimdaki tek satirin sonucu. Ayni zamanda satir idempotency kaydidir: ayni satir
 * tekrar gonderilirse yeniden islenmez, kayitli sonuc doner.
 *   PK = `APT#<apt>`, SK = `IMPORTITEM#<importId>#<hash(satir anahtari)>`
 */
export type ImportItem = TableKeys & {
  entityType: 'IMPORT_ITEM';
  importId: string;
  apartmentId: string;
  itemKey: string;
  kind: ImportKind;
  row?: number;
  label: string;
  outcome: ImportOutcome;
  message?: string;
  unitId?: string;
  userId?: string;
  email?: string;
  transactionId?: string;
  invitation?: InvitationState;
  rolledBack?: boolean;
  createdAt: IsoDateTime;
  version: number;
};
