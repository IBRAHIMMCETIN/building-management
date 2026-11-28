import { z } from 'zod';

/*
 * Tanitim sayfasindaki demo talep formu (apps/api/src/modules/demo-requests).
 *   Herkese acik:  POST /api/public/demo-requests   (kimliksiz; IP / ag basina sinirli, 429 + retryAfterSeconds)
 *   Platform:      GET  /api/platform/demo-requests?limit=&cursor=          (yalnizca platform_admin)
 *                  POST /api/platform/demo-requests/:id/erase { status: deleted | spam, reason }
 * Kurallar API semasiyla AYNIDIR (apps/api/src/modules/demo-requests/schema.ts); esitlik
 * apps/api/test/demo-requests-parity.test.ts ile korunur.
 */

export const DEMO_UNIT_RANGES = ['1-20', '21-50', '51-200', '201-500', '500+'] as const;
export type DemoUnitRange = (typeof DEMO_UNIT_RANGES)[number];

export const DEMO_UNIT_RANGE_LABELS: Record<DemoUnitRange, string> = {
  '1-20': '1–20 bağımsız bölüm',
  '21-50': '21–50 bağımsız bölüm',
  '51-200': '51–200 bağımsız bölüm',
  '201-500': '201–500 bağımsız bölüm',
  '500+': '500’den fazla bağımsız bölüm',
};

export const DEMO_LIMITS = { fullName: 100, email: 254, phone: 20, organization: 150, message: 2000 } as const;

/** Bal kupu alaninin adi: anlamsiz (tarayici / parola yoneticisi otomatik doldurmasin). */
export const DEMO_HONEYPOT_FIELD = 'bmCheck';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/** Telefon: rakam, bosluk, +, parantez ve tire; 10-15 rakam. */
export function isValidPhone(value: string): boolean {
  if (!/^\+?[0-9 ()-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, '').length;
  return digits >= 10 && digits <= 15;
}

const singleLine = (min: number, max: number, empty: string) =>
  z
    .string()
    .trim()
    .min(min, empty)
    .max(max, `En fazla ${max} karakter`)
    .refine((v) => !CONTROL.test(v), 'Geçersiz karakter içeriyor');

/** Web formu: bos isteğe bagli alanlar gonderilmez. */
export const demoRequestFormSchema = z.object({
  fullName: singleLine(2, DEMO_LIMITS.fullName, 'Adınızı ve soyadınızı yazın'),
  email: z.string().trim().min(1, 'E-posta adresinizi yazın').max(DEMO_LIMITS.email, `En fazla ${DEMO_LIMITS.email} karakter`).pipe(z.email('Geçerli bir e-posta adresi yazın')),
  phone: z
    .string()
    .trim()
    .max(DEMO_LIMITS.phone, 'Telefon numarası çok uzun')
    .refine((v) => v === '' || isValidPhone(v), 'Telefon numarasını 05xx xxx xx xx biçiminde yazın'),
  organization: singleLine(2, DEMO_LIMITS.organization, 'Site veya firma adını yazın'),
  unitRange: z.union([z.enum(DEMO_UNIT_RANGES), z.literal('')]).refine((v) => v !== '', 'Bağımsız bölüm sayısını seçin'),
  message: z
    .string()
    .trim()
    .max(DEMO_LIMITS.message, `En fazla ${DEMO_LIMITS.message} karakter`)
    .refine((v) => !CONTROL_EXCEPT_NEWLINE.test(v.replace(/\r\n/g, '\n')), 'Geçersiz karakter içeriyor'),
  kvkkConsent: z.boolean().refine((v) => v, 'Devam etmek için aydınlatma metnini okuduğunuzu onaylayın'),
  /** Bal kupu: kullaniciya gorunmez; dolu gelirse sunucu kaydetmeden basarili yanit verir. */
  [DEMO_HONEYPOT_FIELD]: z.string(),
});
export type DemoRequestFormValues = z.input<typeof demoRequestFormSchema>;
export type DemoRequestFormOutput = z.output<typeof demoRequestFormSchema>;

export type DemoRequestPayload = {
  fullName: string;
  email: string;
  phone?: string;
  organization: string;
  unitRange: DemoUnitRange;
  message?: string;
  kvkkConsent: true;
  kvkkVersion: string;
  bmCheck?: string;
};

/** Form degerlerinden API govdesi (bos isteğe bagli alanlar dusurulur). */
export function toDemoRequestPayload(values: DemoRequestFormOutput, kvkkVersion: string): DemoRequestPayload {
  return {
    fullName: values.fullName,
    email: values.email.toLowerCase(),
    ...(values.phone ? { phone: values.phone } : {}),
    organization: values.organization,
    unitRange: values.unitRange as DemoUnitRange,
    ...(values.message ? { message: values.message } : {}),
    kvkkConsent: true,
    kvkkVersion,
    ...(values[DEMO_HONEYPOT_FIELD] ? { [DEMO_HONEYPOT_FIELD]: values[DEMO_HONEYPOT_FIELD] } : {}),
  };
}

export const demoRequestReceivedSchema = z.object({ received: z.literal(true) });

export const demoRequestSchema = z.object({
  requestId: z.string(),
  fullName: z.string(),
  email: z.string(),
  phone: z.string().optional(),
  organization: z.string(),
  unitRange: z.enum(DEMO_UNIT_RANGES),
  message: z.string().optional(),
  kvkkVersion: z.string(),
  status: z.literal('new'),
  /** Platform geneli gunluk olagan hacim asildiginda gelen talep (bot dalgasi olabilir). */
  suspect: z.literal(true).optional(),
  createdAt: z.string(),
  ipMasked: z.string().optional(),
});
export type DemoRequest = z.infer<typeof demoRequestSchema>;

export const demoRequestListSchema = z.object({
  items: z.array(demoRequestSchema),
  nextCursor: z.string().optional(),
});
export type DemoRequestList = z.infer<typeof demoRequestListSchema>;

/** Platform: KVKK silme talebi (`deleted`) veya istenmeyen kayit (`spam`). */
export const DEMO_ERASE_STATUSES = ['deleted', 'spam'] as const;
export type DemoEraseStatus = (typeof DEMO_ERASE_STATUSES)[number];
export const DEMO_ERASE_REASON_MIN = 10;
export const demoRequestErasedSchema = z.object({ requestId: z.string(), status: z.enum(DEMO_ERASE_STATUSES) });
