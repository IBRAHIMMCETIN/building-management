/**
 * Finans 2.4 - Butce / yillik isletme projesi kaydi (model + okuma). Yazim akisi (taslak, onay,
 * aidat planina uygulama) 2.4-4'te `budgets.ts` icinde; raporlar (2.4-3) yalnizca onayli surumu okur.
 *
 *   PK = APT#<apt>, SK = BUDGET#<yyyy>#v<nnn>     (yil icinde surum; onayli surum degismez)
 */
import { queryTenantAll, tenantPk } from '../../config/dynamodb.js';
import type { IsoDate, IsoDateTime, Kurus, LiableParty, TableKeys } from '../core/types.js';

export type BudgetLine = { accountId: string; kind: 'income' | 'expense'; /** 12 ay, kurus. */ months: Kurus[]; note?: string };

export type Budget = TableKeys & {
  entityType: 'BUDGET';
  apartmentId: string;
  budgetId: string;
  year: number;
  revision: number;
  status: 'draft' | 'approved' | 'superseded';
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
