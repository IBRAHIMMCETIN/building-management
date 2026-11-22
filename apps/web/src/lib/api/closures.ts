import { z } from 'zod';
import { apiClient } from './client';

/*
 * Tasinmada cari kapama (apps/api/src/modules/finance/routes.ts + closures.ts).
 *   GET  /api/finance/units/:unitId/closures/preview?party&moveOutDate   (yazmaz; yonetici)
 *   GET  /api/finance/units/:unitId/closures                             (gecmis; okuma rolleri)
 *   POST /api/finance/units/:unitId/closures                             (atomik kapama)
 *   POST /api/finance/closures/:closureId/reverse                        (geri alma)
 *   GET  /api/finance/former-accounts?all=true                           (ayrilan sakin carileri)
 * Tum tutarlar kurus cinsinden tam sayidir.
 */

const kurus = z.number().int();
const party = z.enum(['owner', 'occupant']);

export const DEBT_TARGETS = ['former', 'owner', 'new_owner'] as const;
export const ADVANCE_TARGETS = ['refund', 'former', 'owner'] as const;
export type DebtTarget = (typeof DEBT_TARGETS)[number];
export type AdvanceTarget = (typeof ADVANCE_TARGETS)[number];

const transferItem = z.object({
  sourceChargeId: z.string(),
  category: z.enum(['principal', 'late_fee']),
  description: z.string(),
  date: z.string(),
  dueDate: z.string(),
  amount: kurus,
});
export type TransferItem = z.infer<typeof transferItem>;

export const closurePreviewSchema = z.object({
  unitId: z.string(),
  party,
  moveOutDate: z.string(),
  sourceAccountId: z.string(),
  closedThrough: z.string().optional(),
  lateFeeMonthlyBasisPoints: z.number().int(),
  lateFee: kurus,
  net: kurus,
  debt: kurus,
  advance: kurus,
  items: z.array(transferItem),
  later: z.object({ charges: z.number().int(), credits: z.number().int(), creditAmount: kurus }),
  memberships: z.array(
    z.object({
      userId: z.string(),
      relation: z.enum(['owner', 'tenant']),
      residesInUnit: z.boolean(),
      startDate: z.string(),
      endDate: z.string().optional(),
      change: z.enum(['ended', 'not_resident']),
    }),
  ),
  incomingOwners: z.array(z.object({ userId: z.string(), startDate: z.string() })),
  targets: z.object({ debt: z.array(z.enum(DEBT_TARGETS)), advance: z.array(z.enum(ADVANCE_TARGETS)) }),
  warnings: z.array(z.string()),
});
export type ClosurePreview = z.infer<typeof closurePreviewSchema>;

export const closureSchema = z.object({
  closureId: z.string(),
  unitId: z.string(),
  party,
  moveOutDate: z.string(),
  sourceAccountId: z.string(),
  userIds: z.array(z.string()),
  debtTo: z.enum(DEBT_TARGETS),
  advanceTo: z.enum(ADVANCE_TARGETS),
  newOwnerUserId: z.string().optional(),
  refundAccountId: z.string().optional(),
  targetAccountId: z.string().optional(),
  lateFee: kurus,
  debt: kurus,
  advance: kurus,
  items: z.array(transferItem),
  membershipChanges: z.array(
    z.object({
      userId: z.string(),
      relation: z.enum(['owner', 'tenant']),
      change: z.enum(['ended', 'not_resident']),
      previousEndDate: z.string().optional(),
    }),
  ),
  status: z.enum(['completed', 'reversed']),
  reason: z.string(),
  reversal: z.object({ at: z.string(), by: z.string(), reason: z.string() }).optional(),
  /** Finans 2.1: mulk/hisse devriyle yapilan kapama (yalnizca devir geri alinarak iptal edilir). */
  ownershipTransferId: z.string().optional(),
  createdAt: z.string(),
  createdBy: z.string(),
});
export type CariClosure = z.infer<typeof closureSchema>;

const holder = z.object({ userIds: z.array(z.string()), periodStart: z.string().optional(), periodEnd: z.string() });

export const formerAccountSchema = z.object({
  accountId: z.string(),
  name: z.string(),
  unitId: z.string(),
  unitNumber: z.string().optional(),
  blockId: z.string().optional(),
  liableParty: party,
  closureId: z.string().optional(),
  holder: holder.optional(),
  /** Pozitif borc, negatif avans. */
  balance: kurus,
  debt: kurus,
  advance: kurus,
  overdue: kurus,
  oldestUnpaidDueDate: z.string().optional(),
  daysOverdue: z.number().int(),
  lateFee: kurus,
  lastPaymentDate: z.string().optional(),
});
export type FormerAccount = z.infer<typeof formerAccountSchema>;

export type CreateClosureInput = {
  idempotencyKey: string;
  party: 'owner' | 'occupant';
  moveOutDate: string;
  userIds: string[];
  debtTo: DebtTarget;
  advanceTo: AdvanceTarget;
  newOwnerUserId?: string;
  refundAccountId?: string;
  reason: string;
};

const base = '/api/finance';
const unitPath = (unitId: string) => `${base}/units/${encodeURIComponent(unitId)}/closures`;

export const closuresApi = {
  preview: (unitId: string, q: { party: 'owner' | 'occupant'; moveOutDate: string }, signal?: AbortSignal) =>
    apiClient.get(`${unitPath(unitId)}/preview`, { signal, query: q, schema: closurePreviewSchema }),
  listForUnit: (unitId: string, signal?: AbortSignal) =>
    apiClient.get(unitPath(unitId), { signal, schema: z.object({ items: z.array(closureSchema) }) }),
  create: (unitId: string, input: CreateClosureInput) =>
    apiClient.post(unitPath(unitId), input, { schema: z.object({ replayed: z.boolean(), closure: closureSchema }) }),
  reverse: (closureId: string, reason: string) =>
    apiClient.post(`${base}/closures/${encodeURIComponent(closureId)}/reverse`, { reason }, { schema: z.object({ closure: closureSchema }) }),
  formerAccounts: (all: boolean, signal?: AbortSignal) =>
    apiClient.get(`${base}/former-accounts`, {
      signal,
      query: all ? { all: 'true' } : {},
      schema: z.object({ asOf: z.string(), items: z.array(formerAccountSchema) }),
    }),
};
