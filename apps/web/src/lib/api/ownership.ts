import { z } from 'zod';
import { apiClient } from './client';

/*
 * Finans 2.1 - Hisseli mulkiyet ve mulk/hisse devri (apps/api/src/modules/ownership/routes.ts).
 *   GET  /api/ownership/units/:unitId?date=              pay tablosu, faturalama modu, temsilci, gecmis
 *   PUT  /api/ownership/units/:unitId/register           elle sicil (ilk kayit / duzeltme)
 *   PUT  /api/ownership/units/:unitId/billing            { mode, reason, version }
 *   PUT  /api/ownership/units/:unitId/representative     { userId|null, version }
 *   POST /api/ownership/units/:unitId/transfers/preview  devir onizlemesi (yazmaz)
 *   POST /api/ownership/units/:unitId/transfers          devir (idempotent)
 *   GET  /api/ownership/units/:unitId/transfers
 *   POST /api/ownership/transfers/:transferId/reverse    { reason }
 *   GET  /api/ownership/issues | POST /api/ownership/backfill | GET /api/ownership/voting-roll?date=
 * Paylar kesirdir (pay / payda); `bps` yalnizca gosterim (toplam 10.000). Tutarlar kurus.
 */

const kurus = z.number().int();
export const shareSchema = z.object({ numerator: z.number().int(), denominator: z.number().int() });
export type Share = z.infer<typeof shareSchema>;

export const OWNER_BILLING_MODES = ['joint', 'split'] as const;
export type OwnerBilling = (typeof OWNER_BILLING_MODES)[number];
export const TRANSFER_KINDS = ['sale_full', 'share_partial', 'inheritance'] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];
export const TRANSFER_DEBT_TARGETS = ['former', 'new_owner'] as const;
export type TransferDebtTarget = (typeof TRANSFER_DEBT_TARGETS)[number];

const ownerRow = z.object({ userId: z.string(), share: shareSchema, bps: z.number().int() });
export type OwnerRow = z.infer<typeof ownerRow>;

const recordView = z.object({
  seq: z.number().int(),
  validFrom: z.string(),
  source: z.enum(['backfill', 'manual', 'transfer', 'reversal']),
  transferId: z.string().optional(),
  reason: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
  owners: z.array(ownerRow),
});
export type OwnershipRecordView = z.infer<typeof recordView>;

export const unitOwnershipSchema = z.object({
  unitId: z.string(),
  asOf: z.string(),
  registered: z.boolean(),
  billing: z.enum(OWNER_BILLING_MODES),
  representativeUserId: z.string().optional(),
  version: z.number().int(),
  current: z
    .object({
      source: z.enum(['register', 'memberships']),
      validFrom: z.string().optional(),
      seq: z.number().int().optional(),
      owners: z.array(ownerRow),
    })
    .optional(),
  incomplete: z
    .object({ owners: z.array(z.object({ userId: z.string(), share: shareSchema.optional() })), reason: z.string() })
    .optional(),
  history: z.array(recordView),
  warnings: z.array(z.string()),
});
export type UnitOwnership = z.infer<typeof unitOwnershipSchema>;

const move = z.object({ fromUserId: z.string(), toUserId: z.string(), share: shareSchema });
export type ShareMove = z.infer<typeof move>;

const membershipChange = z.object({
  userId: z.string(),
  change: z.enum(['created', 'reactivated', 'share', 'ended']),
});

const transferItem = z.object({
  sourceChargeId: z.string(),
  category: z.enum(['principal', 'late_fee']),
  description: z.string(),
  date: z.string(),
  dueDate: z.string(),
  amount: kurus,
});

export const transferPreviewSchema = z.object({
  unitId: z.string(),
  kind: z.enum(TRANSFER_KINDS),
  effectiveDate: z.string(),
  cutoff: z.string(),
  billing: z.enum(OWNER_BILLING_MODES),
  before: z.array(ownerRow),
  after: z.array(ownerRow),
  exiting: z.array(z.string()),
  entering: z.array(z.string()),
  changed: z.array(z.string()),
  debtTo: z.enum(TRANSFER_DEBT_TARGETS),
  closures: z.array(
    z.object({
      userIds: z.array(z.string()),
      sourceAccountId: z.string(),
      lateFee: kurus,
      debt: kurus,
      advance: kurus,
      items: z.array(transferItem),
      target: z.enum(TRANSFER_DEBT_TARGETS),
      newOwnerUserId: z.string().optional(),
    }),
  ),
  membershipChanges: z.array(membershipChange),
  representativeUserId: z.string().optional(),
  warnings: z.array(z.string()),
});
export type TransferPreview = z.infer<typeof transferPreviewSchema>;

export const transferSchema = z.object({
  transferId: z.string(),
  unitId: z.string(),
  kind: z.enum(TRANSFER_KINDS),
  effectiveDate: z.string(),
  moves: z.array(move),
  before: z.array(z.object({ userId: z.string(), share: shareSchema })),
  after: z.array(z.object({ userId: z.string(), share: shareSchema })),
  billing: z.enum(OWNER_BILLING_MODES),
  recordSeq: z.number().int(),
  debtTo: z.enum(TRANSFER_DEBT_TARGETS),
  closures: z.array(
    z.object({
      closureId: z.string(),
      userIds: z.array(z.string()),
      sourceAccountId: z.string(),
      targetAccountId: z.string().optional(),
      debtTo: z.enum(TRANSFER_DEBT_TARGETS),
      debt: kurus,
      advance: kurus,
      lateFee: kurus,
    }),
  ),
  membershipChanges: z.array(membershipChange),
  status: z.enum(['completed', 'reversed']),
  reason: z.string(),
  reversal: z.object({ at: z.string(), by: z.string(), reason: z.string() }).optional(),
  createdAt: z.string(),
  createdBy: z.string(),
});
export type OwnershipTransfer = z.infer<typeof transferSchema>;

export const ownershipIssueSchema = z.object({
  unitId: z.string(),
  number: z.string(),
  blockId: z.string(),
  code: z.enum(['register_mismatch', 'no_representative', 'no_owner', 'incomplete_shares', 'not_registered']),
  message: z.string(),
});
export type OwnershipIssue = z.infer<typeof ownershipIssueSchema>;

export const votingRollSchema = z.object({
  asOf: z.string(),
  unitCount: z.number().int(),
  warningCount: z.number().int(),
  items: z.array(
    z.object({
      unitId: z.string(),
      blockId: z.string(),
      number: z.string(),
      vote: z.literal(1),
      landShare: shareSchema.optional(),
      source: z.enum(['register', 'memberships', 'none']),
      owners: z.array(z.object({ userId: z.string(), share: shareSchema.optional(), bps: z.number().int().optional() })),
      representativeUserId: z.string().optional(),
      warnings: z.array(z.string()),
    }),
  ),
});

export type TransferInput = {
  kind: TransferKind;
  effectiveDate: string;
  moves: ShareMove[];
  debtTo: TransferDebtTarget;
  residents?: string[];
};
export type CreateTransferInput = TransferInput & { idempotencyKey: string; reason: string };
export type RegisterInput = { owners: { userId: string; share: Share }[]; validFrom: string; reason: string; version: number };

const base = '/api/ownership';
const unitPath = (unitId: string) => `${base}/units/${encodeURIComponent(unitId)}`;

export const ownershipApi = {
  unit: (unitId: string, signal?: AbortSignal) => apiClient.get(unitPath(unitId), { signal, schema: unitOwnershipSchema }),
  setRegister: (unitId: string, input: RegisterInput) => apiClient.put(`${unitPath(unitId)}/register`, input, { schema: unitOwnershipSchema }),
  setBilling: (unitId: string, input: { mode: OwnerBilling; reason: string; version: number }) =>
    apiClient.put(`${unitPath(unitId)}/billing`, input, { schema: unitOwnershipSchema }),
  setRepresentative: (unitId: string, input: { userId: string | null; version: number }) =>
    apiClient.put(`${unitPath(unitId)}/representative`, input, { schema: unitOwnershipSchema }),
  previewTransfer: (unitId: string, input: TransferInput, signal?: AbortSignal) =>
    apiClient.post(`${unitPath(unitId)}/transfers/preview`, input, { signal, schema: transferPreviewSchema }),
  createTransfer: (unitId: string, input: CreateTransferInput) =>
    apiClient.post(`${unitPath(unitId)}/transfers`, input, {
      schema: z.object({ replayed: z.boolean(), transfer: transferSchema, warnings: z.array(z.string()) }),
    }),
  listTransfers: (unitId: string, signal?: AbortSignal) =>
    apiClient.get(`${unitPath(unitId)}/transfers`, { signal, schema: z.object({ items: z.array(transferSchema) }) }),
  reverseTransfer: (transferId: string, reason: string) =>
    apiClient.post(`${base}/transfers/${encodeURIComponent(transferId)}/reverse`, { reason }, { schema: transferSchema }),
  issues: (signal?: AbortSignal) =>
    apiClient.get(`${base}/issues`, { signal, schema: z.object({ asOf: z.string(), count: z.number().int(), items: z.array(ownershipIssueSchema) }) }),
  backfill: () =>
    apiClient.post(`${base}/backfill`, {}, {
      schema: z.object({
        created: z.array(z.object({ unitId: z.string(), owners: z.number().int(), validFrom: z.string() })),
        skipped: z.array(z.object({ unitId: z.string(), reason: z.string() })),
      }),
    }),
  votingRoll: (date: string | undefined, signal?: AbortSignal) =>
    apiClient.get(`${base}/voting-roll`, { signal, query: date ? { date } : {}, schema: votingRollSchema }),
};
