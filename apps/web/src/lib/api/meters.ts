import { z } from 'zod';
import {
  COMMON_KEYS,
  LEGAL_PROFILES,
  LIABLE_PARTIES,
  METER_KINDS,
  METER_STATUSES,
  PERIOD_STATUSES,
  TEMPLATE_CATEGORIES,
  type CommonKey,
  type LegalProfile,
  type LiableParty,
  type MeterKind,
  type TemplateCategory,
} from '@/lib/meters/model';
import { apiClient } from './client';
import { signedDownloadSchema } from './documentModel';
import { ApiError } from './errors';
import { jobAcceptedSchema } from './bulkJobs';

/*
 * Finans 2.3 sayac / endeks dagitimi (apps/api/src/modules/meters):
 *   /api/metering        sicil, degisim, sablon, donem, hesap/onay, geri alma (yonetici; denetci okur)
 *   /api/meter-readings  okuma cizelgesi, toplu aktarim, fotograf (yonetici + bina gorevlisi)
 *   /api/portal/meters   sakin: kendi dairesinin tuketim gecmisi + Sayac Dagitim Dokumu PDF
 * Tutarlar kurus (tam sayi), endeksler olcekli tam sayidir (deger x 10^scale).
 */

const kurus = z.number().int();
const isoDate = z.string();
const rational = z.object({ num: z.number().int(), den: z.number().int() });
const warning = z.object({ code: z.string(), message: z.string().optional() });

export const meterSchema = z.object({
  meterId: z.string(),
  unitId: z.string(),
  kind: z.enum(METER_KINDS),
  label: z.string(),
  serialNo: z.string().optional(),
  scale: z.number().int(),
  factor: rational,
  maxIndex: z.number().optional(),
  openingIndex: z.number(),
  installedAt: isoDate,
  status: z.enum(METER_STATUSES),
  retiredAt: isoDate.optional(),
  closingIndex: z.number().optional(),
  predecessorMeterId: z.string().optional(),
  successorMeterId: z.string().optional(),
  lastReading: z.object({ index: z.number(), date: isoDate, periodId: z.string() }).optional(),
  version: z.number().int(),
});

export const meterEventSchema = z.object({
  eventId: z.string(),
  type: z.string(),
  at: z.string(),
  by: z.string(),
  date: isoDate.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const swapSchema = z.object({
  swapId: z.string(),
  meterId: z.string().optional(),
  unitId: z.string().optional(),
  kind: z.enum(['replacement', 'reset']),
  swapDate: isoDate,
  oldClosingIndex: z.number(),
  newOpeningIndex: z.number(),
  reason: z.string().optional(),
  status: z.string().optional(),
  photoKey: z.string().optional(),
});

export const swapPreviewSchema = z.object({
  oldMeter: meterSchema,
  startIndex: z.number(),
  startDate: isoDate,
  oldClosingIndex: z.number(),
  closingDelta: z.number(),
  newMeter: z.object({ label: z.string(), serialNo: z.string().optional(), scale: z.number(), openingIndex: z.number(), installedAt: isoDate }),
});

const scope = z.object({ blockIds: z.array(z.string()).optional(), exemptionCategory: z.string().optional() });

export const templateSchema = z.object({
  templateId: z.string(),
  name: z.string(),
  meterKind: z.enum(METER_KINDS),
  category: z.enum(TEMPLATE_CATEGORIES),
  commonShareBps: z.number().int(),
  commonKey: z.enum(COMMON_KEYS),
  liableParty: z.enum(LIABLE_PARTIES),
  scope: scope.default({}),
  legalProfile: z.enum(LEGAL_PROFILES),
  decisionRef: z.string().optional(),
  reason: z.string().optional(),
  isDefault: z.boolean().default(false),
  /** Finans 2.4: tahakkukun yazilacagi gelir hesabi (yoksa aidat gelirleri). */
  incomeAccountId: z.string().optional(),
  status: z.enum(['active', 'archived']),
  warnings: z.array(warning).default([]),
  version: z.number().int(),
});

export const presetSchema = z.object({
  preset: z.string(),
  name: z.string(),
  meterKind: z.enum(METER_KINDS),
  category: z.enum(TEMPLATE_CATEGORIES),
  commonShareBps: z.number().int(),
  commonKey: z.enum(COMMON_KEYS),
  liableParty: z.enum(LIABLE_PARTIES),
  legalProfile: z.enum(LEGAL_PROFILES),
  incomeAccountId: z.string().optional(),
  warnings: z.array(warning).default([]),
});

const periodCalc = z.object({
  hash: z.string(),
  calculatedAt: z.string(),
  totalAmount: kurus,
  commonPool: kurus,
  consumptionPool: kurus,
  fallbackToCommon: z.boolean(),
  totalConsumption: z.string(),
  unitCount: z.number().int(),
  chargeCount: z.number().int(),
  warningCodes: z.array(z.string()).default([]),
});

export const periodSchema = z.object({
  periodId: z.string(),
  name: z.string(),
  templateId: z.string(),
  template: z.object({
    templateId: z.string(),
    name: z.string(),
    category: z.enum(TEMPLATE_CATEGORIES),
    commonShareBps: z.number().int(),
    commonKey: z.enum(COMMON_KEYS),
    liableParty: z.enum(LIABLE_PARTIES),
    legalProfile: z.enum(LEGAL_PROFILES),
    decisionRef: z.string().optional(),
  }),
  meterKind: z.enum(METER_KINDS),
  startDate: isoDate,
  endDate: isoDate,
  dueDate: isoDate,
  totalAmount: kurus.optional(),
  expenseIds: z.array(z.string()).default([]),
  status: z.enum(PERIOD_STATUSES),
  calc: periodCalc.optional(),
  batchId: z.string().optional(),
  approvedAt: z.string().optional(),
  postedAt: z.string().optional(),
  chargeCount: z.number().int().optional(),
  reversal: z
    .object({
      key: z.string(),
      reason: z.string(),
      date: isoDate,
      notify: z.boolean(),
      completedAt: z.string().optional(),
      reversedCount: z.number().int().optional(),
    })
    .optional(),
  supersedesPeriodId: z.string().optional(),
  supersededByPeriodId: z.string().optional(),
  version: z.number().int(),
});

/**
 * `GET /api/meter-readings/periods` OZET dondurur (sablon, vade, faturalar yok; bkz.
 * apps/api/src/modules/meters/readings.ts -> listOpenPeriods). Tam `periodSchema` ile
 * dogrulamak 200 yanitini ZodError'a ceviriyordu (BUG-01: "Beklenmeyen bir hata olustu").
 */
export const readingPeriodSchema = z.object({
  periodId: z.string(),
  name: z.string(),
  meterKind: z.enum(METER_KINDS),
  startDate: isoDate,
  endDate: isoDate,
  status: z.enum(PERIOD_STATUSES),
  version: z.number().int(),
});

export const expenseOptionSchema = z.object({
  expenseId: z.string(),
  date: isoDate,
  description: z.string(),
  amount: kurus,
  supplier: z.string().optional(),
  invoiceNumber: z.string().optional(),
  hasInvoice: z.boolean().default(false),
  lockedBy: z.string().optional(),
});

const flag = z.string();

export const sheetRowSchema = z.object({
  meterId: z.string(),
  unitId: z.string(),
  unitNumber: z.string().optional(),
  blockId: z.string().optional(),
  label: z.string(),
  serialNo: z.string().optional(),
  kind: z.enum(METER_KINDS),
  scale: z.number().int(),
  inScope: z.boolean().default(true),
  status: z.enum(['ok', 'missing', 'error', 'auto']),
  startIndex: z.number().optional(),
  startDate: isoDate.optional(),
  startSource: z.string().optional(),
  endIndex: z.number().optional(),
  endSource: z.string().optional(),
  delta: z.number().optional(),
  flags: z.array(flag).default([]),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  suggestion: z.object({ startIndex: z.number(), suggestedDelta: z.number(), suggestedEndIndex: z.number() }).optional(),
  reading: z
    .object({
      estimated: z.boolean(),
      rolloverConfirmed: z.boolean(),
      source: z.string(),
      note: z.string().optional(),
      enteredBy: z.string(),
      enteredAt: z.string(),
      version: z.number().int(),
      rev: z.number().int(),
      hasPhoto: z.boolean().default(false),
    })
    .optional(),
});

export const sheetSchema = z.object({
  period: periodSchema,
  rows: z.array(sheetRowSchema),
  summary: z.object({
    meters: z.number().int(),
    ok: z.number().int(),
    auto: z.number().int(),
    missing: z.number().int(),
    errors: z.number().int(),
    spikes: z.number().int(),
    estimated: z.number().int(),
    outOfScope: z.number().int().default(0),
    warnings: z.array(z.unknown()).default([]),
  }),
});

const blocker = z.object({ code: z.string(), message: z.string(), unitId: z.string().optional(), meterId: z.string().optional() });

const liability = z.object({
  party: z.enum(LIABLE_PARTIES),
  vacant: z.boolean(),
  kind: z.enum(['main', 'former', 'split', 'none']),
  accountId: z.string().optional(),
});

export const lineSchema = z.object({
  unitId: z.string(),
  unitNumber: z.string().optional(),
  hasMeter: z.boolean(),
  estimated: z.boolean(),
  consumption: z.string(),
  commonAmount: kurus,
  consumptionAmount: kurus,
  amount: kurus,
  liability,
  transactionId: z.string().optional(),
  meters: z.array(z.object({ meterId: z.string(), endIndex: z.number(), delta: z.number() })).default([]),
});

const warningItem = z.union([z.string(), warning]);

export const calculateSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    period: periodSchema,
    calcHash: z.string(),
    description: z.string(),
    totals: z.object({
      totalAmount: kurus,
      commonPool: kurus,
      consumptionPool: kurus,
      fallbackToCommon: z.boolean(),
      totalConsumption: z.string(),
      unitCount: z.number().int().optional(),
      chargeCount: z.number().int().optional(),
    }),
    lines: z.array(lineSchema),
    warnings: z.array(warningItem).default([]),
  }),
  z.object({ ok: z.literal(false), period: periodSchema, blockers: z.array(blocker), warnings: z.array(warningItem).default([]) }),
]);

export const approveSyncSchema = z.object({ period: periodSchema, replayed: z.boolean(), posted: z.number().int(), written: z.number().int() });
/** Kucuk donem: senkron sonuc. Buyuk donem (API `SYNC_POSTING_UNITS` ustu): 202 + arka plan isi. */
export const approveSchema = z.union([jobAcceptedSchema, approveSyncSchema]);
export type ApproveResult = z.infer<typeof approveSchema>;

export const reversePreviewSchema = z.object({
  period: periodSchema,
  canReverse: z.boolean(),
  blockers: z.array(blocker.extend({ transactionId: z.string().optional() })),
  items: z.array(
    z.object({
      unitId: z.string(),
      unitNumber: z.string().optional(),
      amount: kurus,
      state: z.string(),
      liability: liability.optional(),
      lateFeeAfter: z.array(z.string()).optional(),
    }),
  ),
  total: kurus,
  lateFeeWarnings: z.array(z.object({ unitId: z.string(), transactionIds: z.array(z.string()).optional() })).default([]),
});

export const reverseResultSchema = z.object({
  period: periodSchema,
  replayed: z.boolean().optional(),
  reversed: z.number().int().optional(),
  written: z.number().int().optional(),
  notified: z.boolean().optional(),
});

const uploadSchema = z.object({
  photoKey: z.string(),
  uploadUrl: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  maxBytes: z.number().int(),
  expiresAt: z.string(),
});

export const saveReadingsSchema = z.object({
  period: periodSchema.optional(),
  items: z.array(
    z.object({ ref: z.number().optional(), meterId: z.string(), unitId: z.string(), endIndex: z.number(), delta: z.number(), flags: z.array(flag).default([]) }),
  ),
  warnings: z.array(z.unknown()).default([]),
});

export type ItemError = z.infer<typeof itemErrorSchema>;

const importRowResult = z.object({
  ref: z.number().int(),
  meterId: z.string(),
  unitId: z.string(),
  unitNumber: z.string().optional(),
  endIndex: z.number(),
  delta: z.number(),
  flags: z.array(flag).default([]),
});
/** Satir hatasi: `ref` dosyadaki satir numarasi (aktarim) veya oge sirasi (elle giris). */
export const itemErrorSchema = z.object({ ref: z.number().int(), meterId: z.string().optional(), code: z.string(), message: z.string() });
const importError = itemErrorSchema;

export const importResultSchema = z.object({
  dryRun: z.boolean().optional(),
  valid: z.number().int().optional(),
  invalid: z.number().int().optional(),
  imported: z.number().int().optional(),
  rows: z.array(importRowResult).default([]),
  errors: z.array(importError).default([]),
});

export const portalPeriodSchema = z.object({
  periodId: z.string(),
  name: z.string(),
  meterKind: z.enum(METER_KINDS),
  category: z.enum(TEMPLATE_CATEGORIES),
  startDate: isoDate,
  endDate: isoDate,
  dueDate: isoDate,
  hasMeter: z.boolean(),
  estimated: z.boolean(),
  consumption: z.number(),
  consumptionText: z.string(),
  commonAmount: kurus,
  consumptionAmount: kurus,
  amount: kurus,
  /** Endeks / tuketim sayacin olcegine gore bicimli metin ("1234,500"). */
  meters: z.array(z.object({ meterId: z.string(), label: z.string(), endIndex: z.string().optional(), delta: z.string().optional(), endDate: isoDate.optional() })).default([]),
  buildingAverage: z.number(),
  blockAverage: z.number().optional(),
  meteredUnits: z.number().int(),
  previous: z.object({ periodId: z.string(), consumption: z.number(), diff: z.number(), percent: z.number().optional() }).optional(),
});

export const consumptionSchema = z.object({
  unitId: z.string(),
  unitNumber: z.string().optional(),
  periods: z.array(portalPeriodSchema),
});

export type Meter = z.infer<typeof meterSchema>;
export type MeterEvent = z.infer<typeof meterEventSchema>;
export type MeterSwap = z.infer<typeof swapSchema>;
export type SwapPreview = z.infer<typeof swapPreviewSchema>;
export type MeterTemplate = z.infer<typeof templateSchema>;
export type TemplatePreset = z.infer<typeof presetSchema>;
export type MeterPeriod = z.infer<typeof periodSchema>;
export type ReadingPeriod = z.infer<typeof readingPeriodSchema>;
export type ExpenseOption = z.infer<typeof expenseOptionSchema>;
export type ReadingSheet = z.infer<typeof sheetSchema>;
export type SheetRow = z.infer<typeof sheetRowSchema>;
export type CalculateResult = z.infer<typeof calculateSchema>;
export type DistributionLine = z.infer<typeof lineSchema>;
export type ReversePreview = z.infer<typeof reversePreviewSchema>;
export type ImportResult = z.infer<typeof importResultSchema>;
export type PortalPeriod = z.infer<typeof portalPeriodSchema>;
export type ConsumptionHistory = z.infer<typeof consumptionSchema>;

export type CreateMeterInput = {
  unitId: string;
  kind: MeterKind;
  label: string;
  serialNo?: string;
  scale?: number;
  maxIndex?: number;
  openingIndex: number;
  installedAt: string;
};
export type SwapInput = {
  idempotencyKey: string;
  meterId: string;
  kind: 'replacement' | 'reset';
  swapDate: string;
  oldClosingIndex: number;
  newOpeningIndex: number;
  reason: string;
  photoKey?: string;
  newSerialNo?: string;
  newLabel?: string;
  newScale?: number;
};
export type RetireInput = { retiredAt: string; closingIndex: number; reason: string; photoKey?: string };
export type TemplateInput = {
  preset?: string;
  name?: string;
  meterKind?: MeterKind;
  category?: TemplateCategory;
  commonShareBps?: number;
  commonKey?: CommonKey;
  liableParty?: LiableParty;
  scope?: { blockIds?: string[]; exemptionCategory?: string };
  legalProfile?: LegalProfile;
  decisionRef?: string;
  reason?: string;
  isDefault?: boolean;
  /** Finans 2.4: null/'' -> varsayilan aidat gelirleri. */
  incomeAccountId?: string | null;
};
export type CreatePeriodInput = {
  templateId: string;
  name: string;
  startDate: string;
  endDate: string;
  dueDate: string;
  totalAmount?: number;
  expenseIds?: string[];
};
export type ReadingItemInput = {
  meterId: string;
  endIndex?: number;
  acceptEstimate?: boolean;
  rolloverConfirmed?: boolean;
  note?: string;
  photoKey?: string | null;
};
export type ImportRowInput = { row: number; meter: string; index: string; note?: string };

const enc = encodeURIComponent;
const M = '/api/metering';
const R = '/api/meter-readings';

/** Imzali S3 linkine dogrudan PUT (dosya API'den gecmez). */
async function putToS3(upload: z.infer<typeof uploadSchema>, file: File): Promise<string> {
  let res: Response;
  try {
    res = await fetch(upload.uploadUrl, { method: 'PUT', headers: upload.headers, body: file });
  } catch {
    throw new ApiError(0, { error: 'upload_failed', message: 'Fotoğraf yüklenemedi: bağlantı hatası.' });
  }
  if (!res.ok) throw new ApiError(res.status, { error: 'upload_failed', message: `Fotoğraf yüklenemedi (${res.status}).` });
  return upload.photoKey;
}

export const metersApi = {
  // Sicil
  listMeters: (q: { unitId?: string; status?: string; kind?: string } = {}, signal?: AbortSignal) =>
    apiClient.get(`${M}/meters`, { query: q, signal, schema: z.object({ items: z.array(meterSchema) }) }),
  getMeter: (meterId: string, signal?: AbortSignal) =>
    apiClient.get(`${M}/meters/${enc(meterId)}`, { signal, schema: z.object({ meter: meterSchema, events: z.array(meterEventSchema) }) }),
  createMeter: (input: CreateMeterInput) => apiClient.post(`${M}/meters`, input, { schema: meterSchema }),
  retireMeter: (meterId: string, input: RetireInput) => apiClient.post(`${M}/meters/${enc(meterId)}/retire`, input, { schema: meterSchema }),
  /** Degisim / sokum kaniti: tarih, kayittaki degisim/sokum tarihiyle ayni olmali. */
  async uploadMeterPhoto(meterId: string, date: string, file: File): Promise<string> {
    const upload = await apiClient.post(`${M}/meters/${enc(meterId)}/photo-upload`, { date, contentType: file.type, size: file.size }, { schema: uploadSchema });
    return putToS3(upload, file);
  },

  // Degisim
  previewSwap: (input: Omit<SwapInput, 'idempotencyKey'>) => apiClient.post(`${M}/swaps/preview`, input, { schema: swapPreviewSchema }),
  createSwap: (input: SwapInput) => apiClient.post(`${M}/swaps`, input, { schema: z.object({ replayed: z.boolean(), swap: swapSchema }) }),
  listSwaps: (q: { unitId?: string; meterId?: string } = {}, signal?: AbortSignal) =>
    apiClient.get(`${M}/swaps`, { query: q, signal, schema: z.object({ items: z.array(swapSchema) }) }),

  // Sablon
  listTemplates: (includeArchived = false, signal?: AbortSignal) =>
    apiClient.get(`${M}/templates`, { query: includeArchived ? { includeArchived: 'true' } : undefined, signal, schema: z.object({ items: z.array(templateSchema) }) }),
  presets: (signal?: AbortSignal) => apiClient.get(`${M}/templates/presets`, { signal, schema: z.object({ items: z.array(presetSchema) }) }),
  createTemplate: (input: TemplateInput) => apiClient.post(`${M}/templates`, input, { schema: templateSchema }),
  updateTemplate: (templateId: string, input: TemplateInput & { version: number }) =>
    apiClient.put(`${M}/templates/${enc(templateId)}`, input, { schema: templateSchema }),
  setDefaultTemplate: (templateId: string) => apiClient.post(`${M}/templates/${enc(templateId)}/default`, {}, { schema: templateSchema }),
  archiveTemplate: (templateId: string, version: number) =>
    apiClient.post(`${M}/templates/${enc(templateId)}/archive`, { version }, { schema: templateSchema }),

  // Donem
  expenseOptions: (signal?: AbortSignal) => apiClient.get(`${M}/expenses`, { signal, schema: z.object({ items: z.array(expenseOptionSchema) }) }),
  listPeriods: (status: string = 'all', signal?: AbortSignal) =>
    apiClient.get(`${M}/periods`, { query: { status }, signal, schema: z.object({ items: z.array(periodSchema) }) }),
  getPeriod: (periodId: string, signal?: AbortSignal) => apiClient.get(`${M}/periods/${enc(periodId)}`, { signal, schema: periodSchema }),
  createPeriod: (input: CreatePeriodInput) => apiClient.post(`${M}/periods`, input, { schema: periodSchema }),
  updatePeriod: (periodId: string, input: Partial<CreatePeriodInput> & { version: number; refreshTemplate?: boolean }) =>
    apiClient.patch(`${M}/periods/${enc(periodId)}`, input, { schema: periodSchema }),
  cancelPeriod: (periodId: string, version: number, reason: string) =>
    apiClient.post(`${M}/periods/${enc(periodId)}/cancel`, { version, reason }, { schema: periodSchema }),
  calculate: (periodId: string) => apiClient.post(`${M}/periods/${enc(periodId)}/calculate`, {}, { schema: calculateSchema }),
  approve: (periodId: string, calcHash: string) => apiClient.post(`${M}/periods/${enc(periodId)}/approve`, { calcHash }, { schema: approveSchema }),
  lines: (periodId: string, signal?: AbortSignal) =>
    apiClient.get(`${M}/periods/${enc(periodId)}/lines`, { signal, schema: z.object({ period: periodSchema, lines: z.array(lineSchema), total: kurus }) }),
  reversePreview: (periodId: string, signal?: AbortSignal) =>
    apiClient.get(`${M}/periods/${enc(periodId)}/reverse/preview`, { signal, schema: reversePreviewSchema }),
  reverse: (periodId: string, input: { idempotencyKey: string; reason: string; notify?: boolean }) =>
    apiClient.post(`${M}/periods/${enc(periodId)}/reverse`, input, { schema: reverseResultSchema }),
  correction: (periodId: string, name?: string) =>
    apiClient.post(`${M}/periods/${enc(periodId)}/correction`, name ? { name } : {}, { schema: z.object({ period: periodSchema }).or(periodSchema) }),
  unitStatement: (periodId: string, unitId: string) =>
    apiClient.get(`${M}/periods/${enc(periodId)}/lines/${enc(unitId)}/statement`, { schema: signedDownloadSchema }),

  // Okuma (yonetici + bina gorevlisi)
  openReadingPeriods: (signal?: AbortSignal) => apiClient.get(`${R}/periods`, { signal, schema: z.object({ items: z.array(readingPeriodSchema) }) }),
  sheet: (periodId: string, signal?: AbortSignal) => apiClient.get(`${R}/periods/${enc(periodId)}`, { signal, schema: sheetSchema }),
  saveReadings: (periodId: string, items: ReadingItemInput[]) => apiClient.put(`${R}/periods/${enc(periodId)}`, { items }, { schema: saveReadingsSchema }),
  importReadings: (periodId: string, rows: ImportRowInput[], dryRun: boolean) =>
    apiClient.post(`${R}/periods/${enc(periodId)}/import`, { rows, dryRun }, { schema: importResultSchema }),
  async uploadReadingPhoto(periodId: string, meterId: string, file: File): Promise<string> {
    const upload = await apiClient.post(
      `${R}/periods/${enc(periodId)}/meters/${enc(meterId)}/photo-upload`,
      { contentType: file.type, size: file.size },
      { schema: uploadSchema },
    );
    return putToS3(upload, file);
  },
  readingPhoto: (periodId: string, meterId: string) =>
    apiClient.get(`${R}/periods/${enc(periodId)}/meters/${enc(meterId)}/photo`, { schema: signedDownloadSchema }),

  // Sakin portali
  myConsumption: (unitId: string, signal?: AbortSignal) =>
    apiClient.get('/api/portal/meters/consumption', { query: { unitId }, signal, schema: consumptionSchema }),
  myStatement: (periodId: string, unitId: string) =>
    apiClient.get(`/api/portal/meters/statement/${enc(periodId)}`, { query: { unitId }, signal: undefined, schema: signedDownloadSchema }),
};

/** 422 govdesindeki satir hatalari (`items`) - okuma kaydi / aktarim. */
export function itemErrorsOf(err: unknown): ItemError[] {
  if (!(err instanceof ApiError) || !Array.isArray(err.body?.items)) return [];
  return (err.body.items as unknown[]).flatMap((v) => {
    const r = itemErrorSchema.safeParse(v);
    return r.success ? [r.data] : [];
  });
}

export type Blocker = { code: string; message: string; unitId?: string; meterId?: string };

/** 422 govdesindeki engeller (`blockers`) - onay / geri alma. */
export function blockersOf(err: unknown): Blocker[] {
  if (!(err instanceof ApiError) || !Array.isArray(err.body?.blockers)) return [];
  return (err.body.blockers as unknown[]).flatMap((v) => {
    const r = blocker.safeParse(v);
    return r.success ? [r.data] : [];
  });
}

/** Onizleme-onay kilidi bozuldu mu (409 + guncel `calcHash`). */
export function isStaleCalc(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && typeof err.body?.calcHash === 'string';
}
