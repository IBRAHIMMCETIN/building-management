import { z } from 'zod';
import { apiClient } from './client';
import { ApiError } from './errors';

/*
 * Banka ekstresi ve eslestirme (apps/api/src/modules/finance/bank). Tutarlar kurus tam sayi.
 *   B1: POST /api/bank/statements/upload-url | /statements | /statements/:id/commit, GET /templates
 *   B2: GET /queue | /targets | /lines/:id/suggestions | /reconciliation | /accounts
 *       POST /lines/:id/match | /ignore | /unmatch, PUT /accounts/:id/profile
 *   B3: GET|POST /statements/:id/auto-match (toplu onay), POST /lines/:id/expense (cikan satir -> gider),
 *       GET /reconciliation?from&to (ayrintili dokum), GET /statements?bankAccountId
 */

const kurus = z.number().int();
const party = z.enum(['owner', 'occupant']);

export const LINE_STATUSES = ['unmatched', 'matched', 'ignored'] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

export const suggestionSchema = z.object({
  kind: z.enum(['reference', 'payer', 'unit', 'name']),
  confidence: z.number(),
  reasons: z.array(z.string()),
  allocations: z.array(
    z.object({
      accountId: z.string(),
      unitId: z.string(),
      liableParty: party,
      amount: kurus,
      unitLabel: z.string(),
      partyLabel: z.string(),
      former: z.boolean().default(false),
    }),
  ),
});

export const bankLineSchema = z.object({
  lineId: z.string(),
  bankAccountId: z.string(),
  statementId: z.string(),
  sourceRow: z.number().int(),
  date: z.string(),
  valueDate: z.string().optional(),
  direction: z.enum(['in', 'out']),
  amount: kurus,
  balanceAfter: z.number().int().optional(),
  description: z.string(),
  counterpartyName: z.string().optional(),
  counterpartyIbanMasked: z.string().optional(),
  bankReference: z.string().optional(),
  status: z.enum(LINE_STATUSES),
  version: z.number().int(),
  decisionNo: z.number().int().optional(),
  weakFingerprint: z.boolean().optional(),
  suggestion: suggestionSchema.optional(),
});

export const targetSchema = z.object({
  accountId: z.string(),
  unitId: z.string(),
  unitLabel: z.string(),
  liableParty: party,
  partyLabel: z.string(),
  former: z.boolean(),
  holderNames: z.array(z.string()),
  openBalance: kurus,
  closedThrough: z.string().optional(),
  refCode: z.string().optional(),
});

const bucket = z.object({ count: z.number().int(), amount: kurus });
const period = z.object({ from: z.string(), to: z.string() });

export const reconciliationSchema = z.object({
  bankAccountId: z.string(),
  accountName: z.string(),
  ledgerBalance: kurus,
  /** B3: istenen aralik (bossa son ekstre). */
  period: z.object({ from: z.string().optional(), to: z.string().optional() }).default({}),
  statementCount: z.number().int().optional(),
  statement: z
    .object({
      statementId: z.string(),
      fileName: z.string(),
      period: period.optional(),
      closingBalance: z.number().int().optional(),
    })
    .optional(),
  openingStatement: z
    .object({ statementId: z.string(), fileName: z.string(), period: period.optional(), openingBalance: z.number().int().optional() })
    .optional(),
  openingBalance: z.number().int().optional(),
  ledgerBalanceAtStart: z.number().int().optional(),
  closingBalance: z.number().int().optional(),
  asOf: z.string().optional(),
  ledgerBalanceAtStatementEnd: z.number().int().optional(),
  difference: z.number().int().optional(),
  /** B3: eslesmemis satirlarin kapanis gunune kadar net etkisi (giren - cikan). */
  pendingNet: z.number().int().optional(),
  /** B3: farkin bekleyen satirlarla aciklanamayan kismi. */
  unexplainedDiff: z.number().int().optional(),
  lines: z.object({
    unmatchedIn: bucket,
    unmatchedOut: bucket,
    matched: bucket,
    ignored: bucket,
  }),
  breakdown: z
    .object({
      matchedIn: bucket,
      matchedOut: bucket,
      unmatchedIn: bucket,
      unmatchedOut: bucket,
      ignoredIn: bucket,
      ignoredOut: bucket,
    })
    .optional(),
});

export const bankAccountSchema = z.object({
  accountId: z.string(),
  name: z.string(),
  balance: z.number().int(),
  system: z.boolean(),
  profile: z
    .object({
      iban: z.string(),
      accountHolderName: z.string(),
      bankName: z.string().optional(),
      residentVisible: z.boolean(),
      version: z.number().int(),
    })
    .optional(),
});

const BANK_FIELDS = ['date', 'valueDate', 'description', 'amount', 'debit', 'credit', 'direction', 'balance', 'reference', 'counterpartyName', 'counterpartyIban'] as const;
export type BankField = (typeof BANK_FIELDS)[number];
export const AMOUNT_MODES = ['signed', 'debit_credit', 'amount_direction'] as const;
export type AmountMode = (typeof AMOUNT_MODES)[number];

export const formatSpecSchema = z.object({
  templateId: z.string().optional(),
  headerRow: z.number().int().optional(),
  columns: z.partialRecord(z.enum(BANK_FIELDS), z.string()),
  amountMode: z.enum(AMOUNT_MODES),
});
export type FormatSpec = z.infer<typeof formatSpecSchema>;

const totals = z.object({ count: z.number().int(), amount: kurus });
export const statementSchema = z.object({
  statementId: z.string(),
  bankAccountId: z.string(),
  status: z.enum(['previewed', 'committed']),
  version: z.number().int(),
  fileName: z.string(),
  sourceFormat: z.enum(['csv', 'xlsx', 'html']),
  format: formatSpecSchema,
  formatSource: z.enum(['request', 'saved', 'detected']),
  period: z.object({ from: z.string(), to: z.string() }).optional(),
  openingBalance: z.number().int().optional(),
  closingBalance: z.number().int().optional(),
  lineCount: z.number().int(),
  credits: totals,
  debits: totals,
  issues: z.object({
    errors: z.number().int(),
    duplicatesInFile: z.number().int(),
    duplicatesExisting: z.number().int(),
    balanceMismatches: z.number().int(),
    weakFingerprints: z.number().int(),
    overlappingStatements: z.array(z.string()),
    ignoredRows: z.number().int(),
  }),
  committed: z.object({ newLines: z.number().int(), existingLines: z.number().int() }).optional(),
});
export type BankStatement = z.infer<typeof statementSchema>;

export const PREVIEW_FLAGS = ['duplicate_in_file', 'duplicate_existing', 'balance_mismatch', 'weak_fingerprint'] as const;
export type PreviewFlag = (typeof PREVIEW_FLAGS)[number];

export const previewSchema = z.object({
  statement: statementSchema,
  header: z.object({ row: z.number().int(), columns: z.partialRecord(z.enum(BANK_FIELDS), z.string()) }),
  lines: z.array(
    z.object({
      lineId: z.string(),
      sourceRow: z.number().int(),
      date: z.string(),
      direction: z.enum(['in', 'out']),
      amount: kurus,
      balanceAfter: z.number().int().optional(),
      description: z.string(),
      counterpartyName: z.string().optional(),
      counterpartyIbanMasked: z.string().optional(),
      flags: z.array(z.enum(PREVIEW_FLAGS)),
    }),
  ),
  errors: z.array(z.object({ row: z.number().int(), field: z.string(), message: z.string() })),
  warnings: z.array(z.string()),
});
export type StatementPreview = z.infer<typeof previewSchema>;

export type BankLine = z.infer<typeof bankLineSchema>;
export type Suggestion = z.infer<typeof suggestionSchema>;
export type MatchTarget = z.infer<typeof targetSchema>;
export type Reconciliation = z.infer<typeof reconciliationSchema>;
export type BankAccount = z.infer<typeof bankAccountSchema>;

export type MatchInput = {
  bankAccountId: string;
  expectedVersion: number;
  allocations: { accountId: string; amount: number }[];
  reason?: string;
  source?: 'suggestion' | 'manual';
  confidence?: number;
};

const uploadSchema = z.object({
  statementId: z.string(),
  uploadUrl: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  maxBytes: z.number().int(),
});

const matchResultSchema = z.object({
  replayed: z.boolean(),
  line: bankLineSchema,
  payments: z.array(z.object({ paymentId: z.string(), receiptNumber: z.string(), amount: kurus })).optional(),
  lateFees: z.array(z.object({ accountId: z.string(), lateFee: kurus })).optional(),
});
const decisionResultSchema = z.object({ replayed: z.boolean(), line: bankLineSchema });

// ----- B3 -----

export const autoMatchPreviewSchema = z.object({
  statementId: z.string(),
  bankAccountId: z.string(),
  minConfidence: z.number(),
  batchSize: z.number().int(),
  eligibleCount: z.number().int(),
  eligibleAmount: kurus,
  skippedLowConfidence: z.number().int(),
  skippedAmbiguous: z.number().int(),
  skippedClosed: z.number().int(),
  unmatchedIn: z.number().int(),
  unmatchedOut: z.number().int(),
  items: z.array(z.object({ lineId: z.string(), date: z.string(), amount: kurus, description: z.string(), suggestion: suggestionSchema })),
});
export type AutoMatchPreview = z.infer<typeof autoMatchPreviewSchema>;

export const autoMatchResultSchema = z.object({
  replayed: z.boolean(),
  statementId: z.string(),
  minConfidence: z.number(),
  /** Calisma boyunca (ayni anahtarla tum cagrilar) toplam. */
  matchedCount: z.number().int(),
  totalMatchedAmount: kurus,
  skippedLowConfidence: z.number().int(),
  skippedAmbiguous: z.number().int(),
  skippedClosed: z.number().int(),
  skippedConflict: z.number().int(),
  remaining: z.number().int(),
  completed: z.boolean(),
  thisCall: z.object({ matchedCount: z.number().int(), totalMatchedAmount: kurus }),
});
export type AutoMatchResult = z.infer<typeof autoMatchResultSchema>;

const expenseResultSchema = z.object({
  replayed: z.boolean(),
  line: bankLineSchema,
  expense: z.object({ expenseId: z.string(), transactionId: z.string(), amount: kurus.optional(), description: z.string().optional() }),
});

export type BankExpenseInput = {
  bankAccountId: string;
  expectedVersion: number;
  expenseAccountId: string;
  description?: string;
  supplier?: string;
  invoiceNumber?: string;
  reason?: string;
};

/** Tarayicinin bildirdigi tur bossa/uygunsuzsa uzantidan (API imzali URL'de ayni turu bekler). */
export function uploadContentType(file: Pick<File, 'name' | 'type'>): string {
  const allowed = [
    'text/csv',
    'text/plain',
    'text/html',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ];
  if (allowed.includes(file.type)) return file.type;
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'csv') return 'text/csv';
  if (ext === 'txt') return 'text/plain';
  if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === 'xls') return 'application/vnd.ms-excel';
  if (ext === 'html' || ext === 'htm') return 'text/html';
  return 'application/octet-stream';
}

/** Baslik taninmadiginda API'nin dondurdugu ornek satirlar (IBAN'lar maskeli). */
export function sampleRowsFrom(err: unknown): string[][] | null {
  if (!(err instanceof ApiError) || err.status !== 422) return null;
  const rows = err.body?.sampleRows;
  return Array.isArray(rows) ? rows.filter((r): r is string[] => Array.isArray(r)).map((r) => r.map(String)) : null;
}

const enc = encodeURIComponent;

export const bankApi = {
  // ----- B1: ekstre -----
  async uploadStatement(bankAccountId: string, file: File): Promise<{ statementId: string }> {
    const contentType = uploadContentType(file);
    const upload = await apiClient.post(
      '/api/bank/statements/upload-url',
      { bankAccountId, fileName: file.name, contentType, size: file.size },
      { schema: uploadSchema },
    );
    let res: Response;
    try {
      res = await fetch(upload.uploadUrl, { method: 'PUT', headers: upload.headers, body: file });
    } catch {
      throw new ApiError(0, { error: 'upload_failed', message: 'Ekstre yüklenemedi: bağlantı hatası.' });
    }
    if (!res.ok) throw new ApiError(res.status, { error: 'upload_failed', message: `Ekstre yüklenemedi (${res.status}).` });
    return { statementId: upload.statementId };
  },
  preview: (input: { statementId: string; bankAccountId: string; fileName: string; format?: FormatSpec }) =>
    apiClient.post('/api/bank/statements', input, { schema: previewSchema }),
  commit: (statementId: string, input: { expectedVersion: number; acknowledgeWarnings?: boolean }) =>
    apiClient.post(`/api/bank/statements/${enc(statementId)}/commit`, input, {
      schema: z.object({ alreadyCommitted: z.boolean(), written: z.number().int(), existing: z.number().int(), statement: statementSchema }),
    }),

  // ----- B2: eslestirme -----
  accounts: (signal?: AbortSignal) => apiClient.get('/api/bank/accounts', { signal, schema: z.object({ items: z.array(bankAccountSchema) }) }),
  saveProfile: (bankAccountId: string, input: { iban: string; accountHolderName: string; bankName?: string; residentVisible: boolean; expectedVersion?: number }) =>
    apiClient.put(`/api/bank/accounts/${enc(bankAccountId)}/profile`, input),
  reconciliation: (bankAccountId: string, range: { from?: string; to?: string } = {}, signal?: AbortSignal) =>
    apiClient.get('/api/bank/reconciliation', {
      signal,
      query: { bankAccountId, ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) },
      schema: reconciliationSchema,
    }),
  queue: (q: { bankAccountId: string; status?: LineStatus; cursor?: string; limit?: number }, signal?: AbortSignal) =>
    apiClient.get('/api/bank/queue', { signal, query: q, schema: z.object({ items: z.array(bankLineSchema), cursor: z.string().optional() }) }),
  targets: (signal?: AbortSignal) => apiClient.get('/api/bank/targets', { signal, schema: z.object({ items: z.array(targetSchema) }) }),
  suggestions: (bankAccountId: string, lineId: string, signal?: AbortSignal) =>
    apiClient.get(`/api/bank/lines/${enc(lineId)}/suggestions`, {
      signal,
      query: { bankAccountId },
      schema: z.object({ line: bankLineSchema, suggestions: z.array(suggestionSchema) }),
    }),
  match: (lineId: string, input: MatchInput) => apiClient.post(`/api/bank/lines/${enc(lineId)}/match`, input, { schema: matchResultSchema }),
  ignore: (lineId: string, input: { bankAccountId: string; expectedVersion: number; reason: string }) =>
    apiClient.post(`/api/bank/lines/${enc(lineId)}/ignore`, input, { schema: decisionResultSchema }),
  unmatch: (lineId: string, input: { bankAccountId: string; expectedVersion: number; reason: string }) =>
    apiClient.post(`/api/bank/lines/${enc(lineId)}/unmatch`, input, { schema: decisionResultSchema }),

  // ----- B3 -----
  statements: (bankAccountId: string, signal?: AbortSignal) =>
    apiClient.get('/api/bank/statements', { signal, query: { bankAccountId }, schema: z.object({ items: z.array(statementSchema) }) }),
  autoMatchPreview: (statementId: string, minConfidence: number, signal?: AbortSignal) =>
    apiClient.get(`/api/bank/statements/${enc(statementId)}/auto-match`, {
      signal,
      query: { minConfidence: String(minConfidence) },
      schema: autoMatchPreviewSchema,
    }),
  autoMatch: (statementId: string, input: { idempotencyKey: string; minConfidence: number }) =>
    apiClient.post(`/api/bank/statements/${enc(statementId)}/auto-match`, input, { schema: autoMatchResultSchema }),
  expense: (lineId: string, input: BankExpenseInput) => apiClient.post(`/api/bank/lines/${enc(lineId)}/expense`, input, { schema: expenseResultSchema }),
};

/** Kapali cari hatasi (409 account_closed): onerilen ayrilan cariler. */
export function closedAccountFrom(err: unknown): { accountId: string; closedThrough?: string; formerAccounts: { accountId: string; name: string; balance: number }[] } | null {
  if (!(err instanceof ApiError) || err.code !== 'account_closed') return null;
  const raw: unknown = err.body;
  const b: Record<string, unknown> = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const former: unknown[] = Array.isArray(b.formerAccounts) ? (b.formerAccounts as unknown[]) : [];
  const formerAccounts: { accountId: string; name: string; balance: number }[] = [];
  for (const item of former) {
    if (typeof item !== 'object' || item === null) continue;
    const f = item as Record<string, unknown>;
    const accountId = f.accountId;
    if (typeof accountId !== 'string') continue;
    formerAccounts.push({
      accountId,
      name: typeof f.name === 'string' ? f.name : accountId,
      balance: typeof f.balance === 'number' ? f.balance : Number(f.balance ?? 0),
    });
  }
  return {
    accountId: typeof b.accountId === 'string' ? b.accountId : '',
    ...(typeof b.closedThrough === 'string' ? { closedThrough: b.closedThrough } : {}),
    formerAccounts,
  };
}

export const LINE_STATUS_LABELS: Record<LineStatus, string> = {
  unmatched: 'Eşleşmedi',
  matched: 'Eşleşti',
  ignored: 'Yoksayıldı',
};

export const FLAG_LABELS: Record<PreviewFlag, string> = {
  duplicate_in_file: 'Dosyada tekrar',
  duplicate_existing: 'Daha önce aktarıldı',
  balance_mismatch: 'Bakiye tutmuyor',
  weak_fingerprint: 'Zayıf iz',
};
