import { z } from 'zod';
import { apiClient } from './client';
import { ApiError } from './errors';

/*
 * Sakin portali (apps/api/src/modules/portal). Yalnizca `resident` rolu; apartman JWT'den,
 * daire kullanicinin AKTIF uyeliklerinden cozulur. `unitId` yalnizca birden fazla dairesi
 * olan sakin icin gerekir (aksi halde API 400 `unit_selection_required` doner).
 *   GET /api/portal/my-summary | /my-statement?from&to
 */

const kurus = z.number().int();

export const PORTAL_STATUSES = ['no_debt', 'paid', 'pending', 'overdue'] as const;
export type PortalStatus = (typeof PORTAL_STATUSES)[number];

export const mySummarySchema = z.object({
  unitId: z.string(),
  unitLabel: z.string(),
  relationLabel: z.string(),
  asOf: z.string(),
  status: z.enum(PORTAL_STATUSES),
  balance: kurus,
  debt: kurus,
  advance: kurus,
  totalCharged: kurus,
  totalPaid: kurus,
  overdueAmount: kurus,
  oldestOverdueDueDate: z.string().optional(),
  daysOverdue: z.number().int(),
  openCount: z.number().int(),
  nextDue: z.object({ dueDate: z.string(), amount: kurus, description: z.string() }).optional(),
  lastPayment: z.object({ paidAt: z.string(), amount: kurus, receiptNumber: z.string() }).optional(),
});

export const ENTRY_TYPES = ['ACCRUAL', 'COLLECTION', 'REVERSAL', 'OTHER'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

const statementRow = z.object({
  date: z.string(),
  transactionId: z.string(),
  entryType: z.enum(ENTRY_TYPES),
  description: z.string(),
  dueDate: z.string().optional(),
  receiptNumber: z.string().optional(),
  reversed: z.boolean().optional(),
  debit: kurus,
  credit: kurus,
  balance: kurus,
});

export const myStatementSchema = z.object({
  unitId: z.string(),
  period: z.object({ from: z.string(), to: z.string() }),
  accounts: z.array(
    z.object({
      liableParty: z.enum(['owner', 'occupant']),
      label: z.string(),
      openingBalance: kurus,
      totalDebit: kurus,
      totalCredit: kurus,
      closingBalance: kurus,
      entries: z.array(statementRow),
    }),
  ),
  closingBalance: kurus,
});

export type MySummary = z.infer<typeof mySummarySchema>;
export type MyStatement = z.infer<typeof myStatementSchema>;
export type StatementRow = z.infer<typeof statementRow> & { liableParty: 'owner' | 'occupant' };

export type PortalUnitChoice = { unitId: string; label: string; relationLabel?: string };

const unitQuery = (unitId?: string) => (unitId ? { unitId } : undefined);

export const portalApi = {
  mySummary: (unitId: string | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/portal/my-summary', { signal, query: unitQuery(unitId), schema: mySummarySchema }),
  myStatement: (unitId: string | undefined, signal?: AbortSignal) =>
    apiClient.get('/api/portal/my-statement', { signal, query: unitQuery(unitId), schema: myStatementSchema }),
};

/** Birden fazla daire: API secim icin etiketli liste dondurur. */
export function unitChoicesFrom(err: unknown): PortalUnitChoice[] | null {
  if (!(err instanceof ApiError) || err.code !== 'unit_selection_required') return null;
  const units = err.body?.units;
  if (Array.isArray(units)) {
    return units.filter(
      (u): u is PortalUnitChoice => typeof u === 'object' && u !== null && typeof (u as PortalUnitChoice).unitId === 'string',
    );
  }
  const ids = err.body?.unitIds;
  return Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string').map((unitId) => ({ unitId, label: unitId })) : [];
}

/** Sakinin bu apartmanda aktif dairesi yok (yonetici henuz atamamis veya uyelik bitmis). */
export const isNoMembership = (err: unknown) => err instanceof ApiError && err.status === 403;

/** Iki carinin (malik + sakin) satirlarini tek, en yeni once listeye birlestirir. */
export function mergeStatement(statement: MyStatement): StatementRow[] {
  return statement.accounts
    .flatMap((a) => a.entries.map((e) => ({ ...e, liableParty: a.liableParty })))
    .sort((a, b) => b.date.localeCompare(a.date) || b.transactionId.localeCompare(a.transactionId));
}

export const STATUS_LABELS: Record<PortalStatus, string> = {
  no_debt: 'Borç yok',
  paid: 'Ödendi',
  pending: 'Bekliyor',
  overdue: 'Gecikmede',
};
