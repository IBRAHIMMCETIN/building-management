import { z } from 'zod';
import { parseTRYToKurus } from '@/lib/money';

/** TL metni -> kurus (tam sayi). Bos/gecersiz/sifir reddedilir. */
export const moneyField = (label = 'Tutar') =>
  z
    .string()
    .trim()
    .min(1, `${label} gerekli.`)
    .transform((v, ctx) => {
      const kurus = parseTRYToKurus(v);
      if (kurus === null) {
        ctx.addIssue({ code: 'custom', message: `${label} geçersiz. Örnek: 1.500,50` });
        return z.NEVER;
      }
      return kurus;
    });

const date = z.iso.date('Geçerli bir tarih seçin.');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `En fazla ${max} karakter.`)
    .transform((v) => (v === '' ? undefined : v));

export const paymentSchema = z.object({
  unitId: z.string().min(1, 'Daire seçin.'),
  liableParty: z.enum(['occupant', 'owner']),
  /** '' = dairenin ana carisi; dolu = ayrilan sakin/malik carisi (tasinma kapamasi). */
  accountId: z
    .string()
    .default('')
    .transform((v) => (v === '' ? undefined : v)),
  amount: moneyField(),
  method: z.enum(['cash', 'bank_transfer']),
  paidAt: date,
  payerName: optionalText(120),
  note: optionalText(300),
});

export const expenseSchema = z.object({
  expenseAccountId: z.string().min(1, 'Gider kalemi seçin.'),
  creditAccountId: z.string().min(1, 'Ödeme kaynağı seçin.'),
  amount: moneyField(),
  date,
  description: z.string().trim().min(2, 'Açıklama gerekli.').max(200, 'En fazla 200 karakter.'),
  supplier: optionalText(120),
  invoiceNumber: optionalText(60),
});

export const chargeSchema = z
  .object({
    mode: z.enum(['bulk', 'single']),
    distributionKey: z.enum(['equal', 'area', 'land_share']),
    /** Toplu: kapsam disi birakilan bloklar (varsayilan: hepsi dahil). */
    excludedBlockIds: z.array(z.string()),
    /** Toplu: gider kalemi; bos = genel (muafiyet uygulanmaz). */
    expenseCategory: z.string(),
    unitId: z.string(),
    liableParty: z.enum(['occupant', 'owner']),
    amount: moneyField(),
    date,
    dueDate: date,
    description: z.string().trim().min(2, 'Açıklama gerekli.').max(200, 'En fazla 200 karakter.'),
    /** Finans 2.4: gelir hesabi (aidat gelirleri varsayilan). */
    incomeAccountId: z.string().default('income-dues'),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'single' && !v.unitId) ctx.addIssue({ code: 'custom', path: ['unitId'], message: 'Daire seçin.' });
    if (v.dueDate < v.date) ctx.addIssue({ code: 'custom', path: ['dueDate'], message: 'Son ödeme tarihi, tahakkuk tarihinden önce olamaz.' });
  });

export type PaymentForm = z.input<typeof paymentSchema>;
export type PaymentValues = z.output<typeof paymentSchema>;
export type ExpenseForm = z.input<typeof expenseSchema>;
export type ExpenseValues = z.output<typeof expenseSchema>;
export type ChargeForm = z.input<typeof chargeSchema>;
export type ChargeValues = z.output<typeof chargeSchema>;

export const todayIstanbul = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

/** "2026-11-08" -> "Kasım 2026 aidatı" */
export function defaultDuesDescription(isoDate: string): string {
  const [y, m] = isoDate.split('-');
  return `${MONTHS[Number(m) - 1] ?? ''} ${y} aidatı`;
}

/** Ayin 10'u (gecmisse bir sonraki ayin 10'u): KMK'da yaygin son odeme gunu. */
export function defaultDueDate(isoDate: string, day = 10): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1 + (d > day ? 1 : 0), day));
  return date.toISOString().slice(0, 10);
}
