import { z } from 'zod';

/*
 * Tanitim sayfasindaki demo talep formu (apps/api/src/modules/demo-requests).
 *   Herkese acik:  POST /api/public/demo-requests   (kimliksiz; IP basina sinirli, 429 + retryAfterSeconds)
 *   Platform:      GET  /api/platform/demo-requests?limit=&cursor=   (yalnizca platform_admin)
 * Alan sinirlari API semasiyla aynidir (apps/api/src/modules/demo-requests/schema.ts).
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

/** Telefon: rakam, bosluk, +, parantez ve tire; 10-15 rakam. */
export function isValidPhone(value: string): boolean {
  if (!/^\+?[0-9 ()-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, '').length;
  return digits >= 10 && digits <= 15;
}

/** Web formu: bos isteğe bagli alanlar gonderilmez. */
export const demoRequestFormSchema = z.object({
  fullName: z.string().trim().min(2, 'Adınızı ve soyadınızı yazın').max(DEMO_LIMITS.fullName, `En fazla ${DEMO_LIMITS.fullName} karakter`),
  email: z.string().trim().min(1, 'E-posta adresinizi yazın').max(DEMO_LIMITS.email).pipe(z.email('Geçerli bir e-posta adresi yazın')),
  phone: z
    .string()
    .trim()
    .max(DEMO_LIMITS.phone, 'Telefon numarası çok uzun')
    .refine((v) => v === '' || isValidPhone(v), 'Telefon numarasını 05xx xxx xx xx biçiminde yazın'),
  organization: z.string().trim().min(2, 'Site veya firma adını yazın').max(DEMO_LIMITS.organization, `En fazla ${DEMO_LIMITS.organization} karakter`),
  unitRange: z.union([z.enum(DEMO_UNIT_RANGES), z.literal('')]).refine((v) => v !== '', 'Bağımsız bölüm sayısını seçin'),
  message: z.string().trim().max(DEMO_LIMITS.message, `En fazla ${DEMO_LIMITS.message} karakter`),
  kvkkConsent: z.boolean().refine((v) => v, 'Devam etmek için aydınlatma metnini okuduğunuzu onaylayın'),
  /** Bal kupu: kullaniciya gorunmez; dolu gelirse sunucu kaydetmeden basarili yanit verir. */
  website: z.string(),
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
  website?: string;
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
    ...(values.website ? { website: values.website } : {}),
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
  createdAt: z.string(),
  ipMasked: z.string().optional(),
});
export type DemoRequest = z.infer<typeof demoRequestSchema>;

export const demoRequestListSchema = z.object({
  items: z.array(demoRequestSchema),
  nextCursor: z.string().optional(),
});
export type DemoRequestList = z.infer<typeof demoRequestListSchema>;
