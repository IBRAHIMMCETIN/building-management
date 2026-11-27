import { z } from 'zod';
import { type Quote, type QuoteInput, TENDER_CATEGORIES, type Tender, type TenderInput } from '@/lib/api/tenders';
import { kurusToInput, parseTRYToKurus } from '@/lib/money';

/*
 * Ihale ve teklif formlari. Sayisal alanlar metin olarak tutulur (bos alan hatasi Turkce), API'ye
 * gonderilirken sayiya cevrilir. Tutar TL metnidir ("125.000" / "125000,50"), kurusa cevrilir.
 * API ile ayni sinirlar (tenders/service.ts).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const optionalInt = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || (/^\d+$/.test(v) && Number(v) >= min && Number(v) <= max), `${label} ${min}–${max} arasında tam sayı olmalı`);

export const tenderFormSchema = z.object({
  title: z.string().trim().min(3, 'Başlık en az 3 karakter olmalı').max(120, 'Başlık en fazla 120 karakter olabilir'),
  description: z.string().trim().min(10, 'İşin kapsamını en az 10 karakterle açıklayın').max(4000, 'Açıklama en fazla 4000 karakter olabilir'),
  category: z.enum(TENDER_CATEGORIES, { message: 'Kategori seçin' }),
  deadline: z.string().regex(ISO_DATE, 'Son teklif tarihini seçin'),
  minQuotes: z
    .string()
    .trim()
    .regex(/^\d+$/, 'Asgari teklif sayısı tam sayı olmalı')
    .refine((v) => Number(v) >= 1 && Number(v) <= 10, 'Asgari teklif sayısı 1–10 arasında olmalı'),
  ticketId: z.string(),
});
export type TenderForm = z.input<typeof tenderFormSchema>;
export type TenderValues = z.output<typeof tenderFormSchema>;
export const TENDER_FORM_FIELDS = ['title', 'description', 'category', 'deadline', 'minQuotes', 'ticketId'] as const;

export function tenderDefaults(t?: Pick<Tender, 'title' | 'description' | 'category' | 'deadline' | 'minQuotes' | 'ticket'>): TenderForm {
  if (!t) return { title: '', description: '', category: 'mantolama', deadline: '', minQuotes: '3', ticketId: '' };
  return { title: t.title, description: t.description, category: t.category, deadline: t.deadline, minQuotes: String(t.minQuotes), ticketId: t.ticket?.ticketId ?? '' };
}

/** Form -> API. Bos talep secimi bagi kaldirir (`null`). */
export function toTenderInput(v: TenderValues): TenderInput {
  return { title: v.title, description: v.description, category: v.category, deadline: v.deadline, minQuotes: Number(v.minQuotes), ticketId: v.ticketId || null };
}

export const quoteFormSchema = z
  .object({
    supplierName: z.string().trim().min(2, 'Firma adı en az 2 karakter olmalı').max(120, 'Firma adı en fazla 120 karakter olabilir'),
    amount: z.string().trim().min(1, 'Teklif tutarını girin'),
    vatMode: z.enum(['included', 'excluded']),
    vatRate: z
      .string()
      .regex(/^\d{1,3}$/, 'KDV oranını seçin')
      .refine((v) => Number(v) <= 100, 'KDV oranı en fazla %100 olabilir'),
    validUntil: z.string().refine((v) => v === '' || ISO_DATE.test(v), 'Geçerli bir tarih seçin'),
    deliveryDays: optionalInt('İş süresi', 1, 3650),
    warrantyMonths: optionalInt('Garanti süresi', 0, 600),
    notes: z.string().trim().max(1000, 'Not en fazla 1000 karakter olabilir'),
  })
  .superRefine((v, ctx) => {
    if (v.amount && parseTRYToKurus(v.amount) === null) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Geçerli bir tutar girin (ör. 125.000 veya 125000,50)' });
  });
export type QuoteForm = z.input<typeof quoteFormSchema>;
export type QuoteValues = z.output<typeof quoteFormSchema>;
export const QUOTE_FORM_FIELDS = ['supplierName', 'amount', 'vatMode', 'vatRate', 'validUntil', 'deliveryDays', 'warrantyMonths', 'notes'] as const;
/** API alan adi -> form alani (400 + field). */
export const QUOTE_FIELD_MAP = { amountKurus: 'amount', vatIncluded: 'vatMode' } as const;

export function quoteDefaults(q?: Quote): QuoteForm {
  if (!q) return { supplierName: '', amount: '', vatMode: 'included', vatRate: '20', validUntil: '', deliveryDays: '', warrantyMonths: '', notes: '' };
  return {
    supplierName: q.supplierName,
    amount: kurusToInput(q.amountKurus),
    vatMode: q.vatIncluded ? 'included' : 'excluded',
    // Listede olmayan eski oran (ornek %18) korunur; secici onu da secenek olarak gosterir.
    vatRate: String(q.vatRate),
    validUntil: q.validUntil ?? '',
    deliveryDays: q.deliveryDays === undefined ? '' : String(q.deliveryDays),
    warrantyMonths: q.warrantyMonths === undefined ? '' : String(q.warrantyMonths),
    notes: q.notes ?? '',
  };
}

/** Form -> API. Bos istege bagli alanlar `null` (duzenlemede temizlenir). */
export function toQuoteInput(v: QuoteValues): QuoteInput {
  return {
    supplierName: v.supplierName,
    amountKurus: parseTRYToKurus(v.amount) ?? 0,
    vatIncluded: v.vatMode === 'included',
    vatRate: Number(v.vatRate),
    validUntil: v.validUntil || null,
    deliveryDays: v.deliveryDays ? Number(v.deliveryDays) : null,
    warrantyMonths: v.warrantyMonths ? Number(v.warrantyMonths) : null,
    notes: v.notes || null,
  };
}
