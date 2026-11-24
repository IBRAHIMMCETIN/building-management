import { z } from 'zod';
import { parseTRYToKurus } from '@/lib/money';
import {
  COMMON_KEYS,
  LEGAL_PROFILES,
  LIABLE_PARTIES,
  METER_KINDS,
  TEMPLATE_CATEGORIES,
  isLegalDeviation,
  parseIndexText,
  percentToBps,
} from '@/lib/meters/model';

const date = z.iso.date('Geçerli bir tarih seçin.');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `En fazla ${max} karakter.`)
    .transform((v) => (v === '' ? undefined : v));
const reason = z.string().trim().min(3, 'Gerekçe gerekli (en az 3 karakter).').max(300, 'En fazla 300 karakter.');
const scale = z
  .string()
  .regex(/^[0-6]$/, 'Ondalık hane 0-6 arası olmalı.')
  .transform(Number);

/** Endeks metnini (Turkce bicim) form degerinde dogrular; olcekli tam sayiya donusum submit'te yapilir. */
type IssueSink = { addIssue(issue: { code: 'custom'; path: string[]; message: string }): void };

function indexIssue(value: string, s: number, path: string, ctx: IssueSink) {
  const r = parseIndexText(value, s);
  if (!r.ok) ctx.addIssue({ code: 'custom', path: [path], message: r.message });
}

// --- Sayac ekleme ----------------------------------------------------------

export const addMeterSchema = z
  .object({
    unitId: z.string().min(1, 'Daire seçin.'),
    kind: z.enum(METER_KINDS),
    label: z.string().trim().min(1, 'Sayaç adı gerekli (ör. Salon).').max(60, 'En fazla 60 karakter.'),
    serialNo: optionalText(40),
    scale,
    openingIndex: z.string().trim(),
    installedAt: date,
  })
  .superRefine((v, ctx) => indexIssue(v.openingIndex, v.scale, 'openingIndex', ctx));
export type AddMeterForm = z.input<typeof addMeterSchema>;
export type AddMeterValues = z.output<typeof addMeterSchema>;

/** Ture gore makul varsayilan ondalik: pay olcer tam sayi, su/kalorimetre 3 hane. */
export const defaultScaleFor = (kind: (typeof METER_KINDS)[number]) => (kind === 'heat_allocator' ? 0 : 3);

// --- Degisim / sokum -------------------------------------------------------

/** `scale` eski sayacin, `newScale` yeni sayacin olcegi (degisimde farkli olabilir). */
export const swapSchema = z
  .object({
    kind: z.enum(['replacement', 'reset']),
    swapDate: date,
    oldClosingIndex: z.string().trim(),
    newOpeningIndex: z.string().trim(),
    reason,
    newSerialNo: optionalText(40),
    newLabel: optionalText(60),
    scale,
    newScale: scale,
  })
  .superRefine((v, ctx) => {
    indexIssue(v.oldClosingIndex, v.scale, 'oldClosingIndex', ctx);
    indexIssue(v.newOpeningIndex, v.kind === 'replacement' ? v.newScale : v.scale, 'newOpeningIndex', ctx);
  });
export type SwapForm = z.input<typeof swapSchema>;
export type SwapValues = z.output<typeof swapSchema>;

export const retireSchema = z
  .object({ retiredAt: date, closingIndex: z.string().trim(), reason, scale })
  .superRefine((v, ctx) => indexIssue(v.closingIndex, v.scale, 'closingIndex', ctx));
export type RetireForm = z.input<typeof retireSchema>;
export type RetireValues = z.output<typeof retireSchema>;

// --- Dagitim sablonu -------------------------------------------------------

export const templateSchema = z
  .object({
    name: z.string().trim().min(2, 'Şablon adı gerekli.').max(80, 'En fazla 80 karakter.'),
    meterKind: z.enum(METER_KINDS),
    category: z.enum(TEMPLATE_CATEGORIES),
    commonPercent: z.string().trim(),
    commonKey: z.enum(COMMON_KEYS),
    liableParty: z.enum(LIABLE_PARTIES),
    legalProfile: z.enum(LEGAL_PROFILES),
    decisionRef: optionalText(120),
    reason: optionalText(300),
    isDefault: z.boolean(),
  })
  .transform((v, ctx) => {
    const commonShareBps = percentToBps(v.commonPercent);
    if (commonShareBps === null) {
      ctx.addIssue({ code: 'custom', path: ['commonPercent'], message: 'Ortak pay 0 ile 100 arasında olmalı (ör. 30 veya 30,5).' });
      return z.NEVER;
    }
    // Karar 2: yonetmelik disi oran engellenmez; karar referansi + gerekce zorunludur.
    if (isLegalDeviation({ legalProfile: v.legalProfile, commonShareBps, commonKey: v.commonKey })) {
      if (!v.decisionRef) ctx.addIssue({ code: 'custom', path: ['decisionRef'], message: 'Yönetmelik dışı oran için kat malikleri kurulu karar no/tarihi gerekli.' });
      if (!v.reason || v.reason.length < 3) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Yönetmelik dışı oran için gerekçe gerekli.' });
    }
    const { commonPercent: _p, ...rest } = v;
    return { ...rest, commonShareBps };
  });
export type TemplateForm = z.input<typeof templateSchema>;
export type TemplateValues = z.output<typeof templateSchema>;

// --- Dagitim donemi --------------------------------------------------------

export const periodSchema = z
  .object({
    templateId: z.string().min(1, 'Dağıtım şablonu seçin.'),
    name: z.string().trim().min(2, 'Dönem adı gerekli (ör. Kasım 2026).').max(80, 'En fazla 80 karakter.'),
    startDate: date,
    endDate: date,
    dueDate: date,
    source: z.enum(['expenses', 'amount']),
    amount: z.string().trim(),
    expenseIds: z.array(z.string()).max(20, 'Bir döneme en fazla 20 fatura bağlanabilir.'),
  })
  .transform((v, ctx) => {
    if (v.endDate < v.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Bitiş, başlangıçtan önce olamaz.' });
    if (v.dueDate < v.endDate) ctx.addIssue({ code: 'custom', path: ['dueDate'], message: 'Son ödeme tarihi dönem bitişinden önce olamaz.' });
    let totalAmount: number | undefined;
    if (v.source === 'expenses') {
      if (v.expenseIds.length === 0) ctx.addIssue({ code: 'custom', path: ['expenseIds'], message: 'En az bir fatura seçin veya tutarı elle girin.' });
    } else if (v.amount) {
      const k = parseTRYToKurus(v.amount);
      if (k === null) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Tutar geçersiz. Örnek: 125.000,00' });
      else totalAmount = k;
    }
    return {
      templateId: v.templateId,
      name: v.name,
      startDate: v.startDate,
      endDate: v.endDate,
      dueDate: v.dueDate,
      ...(v.source === 'expenses' ? { expenseIds: v.expenseIds } : {}),
      ...(totalAmount !== undefined ? { totalAmount } : {}),
    };
  });
export type PeriodForm = z.input<typeof periodSchema>;
export type PeriodValues = z.output<typeof periodSchema>;

// --- Toplu geri alma -------------------------------------------------------

export const reverseSchema = z.object({ reason, notify: z.boolean() });
export type ReverseForm = z.input<typeof reverseSchema>;
