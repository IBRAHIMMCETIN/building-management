/**
 * Finans 2.4 - Butce / yillik isletme projesi kaydi (model + okuma). Yazim akisi (taslak, onay,
 * aidat planina uygulama) 2.4-4'te `budgets.ts` icinde; raporlar (2.4-3) yalnizca onayli surumu okur.
 *
 *   PK = APT#<apt>, SK = BUDGET#<yyyy>#v<nnn>     (yil icinde surum; onayli surum degismez)
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { getDynamo, queryTenantAll, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import { type AuditDraft, sendWithAudit } from '../audit/log.js';
import type { IsoDate, IsoDateTime, Kurus, LiableParty, TableKeys } from '../core/types.js';

export type BudgetLine = { accountId: string; kind: 'income' | 'expense'; /** 12 ay, kurus. */ months: Kurus[]; note?: string };

export type Budget = TableKeys & {
  entityType: 'BUDGET';
  apartmentId: string;
  budgetId: string;
  year: number;
  revision: number;
  /** `discarded`: silinen taslak (kayit silinmez; DeleteItem yetkisi yok, listede gizlenir). */
  status: 'draft' | 'approved' | 'superseded' | 'discarded';
  title?: string;
  lines: BudgetLine[];
  dues?: { distributionKey: 'equal' | 'area' | 'land_share'; liableParty: LiableParty; incomeAccountId?: string };
  decision?: { ref: string; date: IsoDate };
  approvedAt?: IsoDateTime;
  approvedBy?: string;
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

export const budgetKeys = {
  budget: (apartmentId: string, year: number, revision: number): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: `BUDGET#${year}#v${String(revision).padStart(3, '0')}`,
  }),
  yearPrefix: (year: number) => `BUDGET#${year}#`,
};

export type BudgetReader = {
  /** Yilin gecerli (onayli, en yuksek surum) butcesi. */
  approvedFor(apartmentId: string, year: number): Promise<Budget | undefined>;
};

export const budgetReader: BudgetReader = {
  async approvedFor(apartmentId, year) {
    const items = await queryTenantAll<Budget>(apartmentId, budgetKeys.yearPrefix(year), { ConsistentRead: true });
    return items
      .filter((b) => b.apartmentId === apartmentId && b.status === 'approved')
      .sort((a, b) => b.revision - a.revision)[0];
  },
};

// ---------------------------------------------------------------------------
// Finans 2.4-4 - yazim deposu (surum kosullu Put + denetim kaydi tek islemde)
// ---------------------------------------------------------------------------

export class BudgetConflictError extends Error {
  constructor(message = 'Bütçe başka bir işlemle değişti; sayfayı yenileyin') {
    super(message);
    this.name = 'BudgetConflictError';
  }
}

export type BudgetWrite = {
  /** Yazilacak kayitlar ve beklenen surumleri (0: yeni kayit). */
  puts: { budget: Budget; expectedVersion: number }[];
  audit?: AuditDraft;
};

export type BudgetRepository = BudgetReader & {
  list(apartmentId: string, year?: number): Promise<Budget[]>;
  write(apartmentId: string, w: BudgetWrite): Promise<void>;
};

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

function versionCondition(expected: number) {
  return expected === 0
    ? { ConditionExpression: 'attribute_not_exists(PK)' }
    : {
        ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expected': expected },
      };
}

export const budgetRepository: BudgetRepository = {
  ...budgetReader,
  async list(apartmentId, year) {
    const items = await queryTenantAll<Budget>(apartmentId, year === undefined ? 'BUDGET#' : budgetKeys.yearPrefix(year), { ConsistentRead: true });
    return items.filter((b) => b.apartmentId === apartmentId).sort((a, b) => b.year - a.year || b.revision - a.revision);
  },
  async write(apartmentId, w) {
    if (w.puts.some((p) => p.budget.apartmentId !== apartmentId)) throw new Error('Kiraci uyusmazligi');
    const { client, tableName } = getDynamo();
    const items: TransactItem[] = w.puts.map((p) => ({ Put: { TableName: tableName, Item: p.budget, ...versionCondition(p.expectedVersion) } }));
    try {
      await sendWithAudit(client, items, w.audit);
    } catch (err) {
      if (err instanceof TransactionCanceledException && (err.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed')) {
        throw new BudgetConflictError();
      }
      throw toDataAccessError(err);
    }
  },
};
