import { z } from 'zod';
import { ApiError } from './errors';

/*
 * Sakin portali (apps/api/src/modules/portal). Yalnizca `resident` rolu; apartman JWT'den,
 * daire kullanicinin AKTIF uyeliklerinden cozulur. `unitId` yalnizca birden fazla dairesi
 * olan sakin icin gerekir (aksi halde API 400 `unit_selection_required` doner).
 *   GET /api/portal/my-summary | /my-statement?from&to
 * Semalar ve saf yardimcilar (web + mobil). Uclar: apps/web/src/lib/api/portal.ts, apps/mobile/src/lib/api/portal.ts.
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
  /** Islemis, henuz cariye yazilmamis gecikme tazminati (eski API'de yok). */
  accruedLateFee: kurus.default(0),
  oldestOverdueDueDate: z.string().optional(),
  daysOverdue: z.number().int(),
  openCount: z.number().int(),
  nextDue: z.object({ dueDate: z.string(), amount: kurus, description: z.string() }).optional(),
  lastPayment: z.object({ paidAt: z.string(), amount: kurus, receiptNumber: z.string() }).optional(),
});

export const ENTRY_TYPES = ['ACCRUAL', 'COLLECTION', 'REVERSAL', 'LATE_FEE', 'OTHER'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

const statementRow = z.object({
  date: z.string(),
  transactionId: z.string(),
  entryType: z.enum(ENTRY_TYPES),
  description: z.string(),
  dueDate: z.string().optional(),
  receiptNumber: z.string().optional(),
  /** Tahsilat satiri: makbuz PDF'i (eski API'de yok). */
  paymentId: z.string().optional(),
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

/** Havale / EFT: apartmanin tahsilat IBAN'i ve sakinin alt cari odeme referans kodlari. */
export const myPaymentReferenceSchema = z.object({
  unitId: z.string(),
  unitLabel: z.string(),
  bank: z.object({ iban: z.string(), accountHolderName: z.string(), bankName: z.string().optional() }).nullable(),
  references: z.array(z.object({ liableParty: z.enum(['owner', 'occupant']), label: z.string(), code: z.string() })),
});
export type MyPaymentReference = z.infer<typeof myPaymentReferenceSchema>;

/** Sakinin makbuzlari (en yeni once): `GET /api/portal/my-receipts` (Adim 2 daire makbuz dizini). */
export const myReceiptsSchema = z.object({
  unitId: z.string(),
  items: z.array(
    z.object({
      paymentId: z.string(),
      receiptNumber: z.string(),
      paidAt: z.string(),
      amount: kurus,
      method: z.enum(['cash', 'bank_transfer', 'card']),
      liableParty: z.enum(['owner', 'occupant']),
      status: z.enum(['valid', 'reversed']),
    }),
  ),
});
export type MyReceipts = z.infer<typeof myReceiptsSchema>;

/**
 * Adim 3: sitenin aylik gider dagilimi (`GET /api/portal/expense-breakdown?month=YYYY-AA`).
 * Yalnizca sade kategori adlari ve ikon anahtarlari; kisi / tedarikci adi yok. `shareBp` toplami
 * tam 10.000 (%100,00).
 */
export const EXPENSE_CATEGORIES = ['electricity', 'water', 'heating', 'cleaning', 'maintenance', 'security', 'garden', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const expenseBreakdownSchema = z.object({
  month: z.string(),
  total: kurus,
  empty: z.boolean(),
  items: z.array(
    z.object({
      category: z.enum(EXPENSE_CATEGORIES),
      label: z.string(),
      icon: z.string(),
      amount: kurus,
      shareBp: z.number().int(),
      percent: z.number(),
    }),
  ),
});
export type ExpenseBreakdown = z.infer<typeof expenseBreakdownSchema>;

/** Son `count` ay (en yeni once, YYYY-AA), `current` dahil. */
export function recentMonths(current: string, count: number): string[] {
  const [y, m] = current.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

export type MySummary = z.infer<typeof mySummarySchema>;
export type MyStatement = z.infer<typeof myStatementSchema>;
export type StatementRow = z.infer<typeof statementRow> & { liableParty: 'owner' | 'occupant' };

export type PortalUnitChoice = { unitId: string; label: string; relationLabel?: string };

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
