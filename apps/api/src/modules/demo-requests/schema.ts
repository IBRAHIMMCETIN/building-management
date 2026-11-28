import { z } from 'zod';

/**
 * Herkese acik demo talep formu (`POST /api/public/demo-requests`). Kimliksiz bir uc oldugu icin
 * sema KATIdir: bilinmeyen alan, kontrol karakteri, sinir disi uzunluk ve gecersiz secim 400 doner.
 *
 * Kurallar web formuyla AYNIDIR (packages/shared/src/api/demoRequests.ts); API ortak paketi import
 * etmez, esitlik test/demo-requests-parity.test.ts ile korunur (aralik listesi, sinirlar, KVKK
 * surumleri ve ornek girdilerde ayni kabul / ret).
 */

export const UNIT_RANGES = ['1-20', '21-50', '51-200', '201-500', '500+'] as const;
export type UnitRange = (typeof UNIT_RANGES)[number];

export const DEMO_LIMITS = { fullName: 100, email: 254, phone: 20, organization: 150, message: 2000 } as const;

/**
 * Kabul edilen KVKK aydinlatma metni surumleri (packages/shared/src/legal/documents.ts `KVKK_NOTICE`
 * ve `KVKK_ACCEPTED_VERSIONS`). Metin degisince yeni surum buraya da eklenir; eski acik sekmelerden
 * gelen talepler icin onceki surum bir sure listede kalabilir.
 */
export const KVKK_VERSIONS = ['2026-11-28-taslak-2'] as const;

/** Bal kupu alani: insanlar bos birakir (gorunmez, klavyeyle ulasilmaz, otomatik doldurmaya kapali). */
export const HONEYPOT_FIELD = 'bmCheck';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;

const singleLine = (min: number, max: number, label: string) =>
  z
    .string({ error: `${label} metin olmalidir` })
    .trim()
    .min(min, `${label} en az ${min} karakter olmalidir`)
    .max(max, `${label} en fazla ${max} karakter olabilir`)
    .refine((v) => !CONTROL.test(v), `${label} gecersiz karakter iceriyor`);

function validPhone(value: string): boolean {
  if (!/^\+?[0-9 ()-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, '').length;
  return digits >= 10 && digits <= 15;
}

export const demoRequestInputSchema = z.strictObject({
  fullName: singleLine(2, DEMO_LIMITS.fullName, 'Ad soyad'),
  email: z
    .string({ error: 'E-posta metin olmalidir' })
    .trim()
    .toLowerCase()
    .max(DEMO_LIMITS.email, `E-posta en fazla ${DEMO_LIMITS.email} karakter olabilir`)
    .pipe(z.email('Gecerli bir e-posta adresi girin')),
  phone: z
    .string({ error: 'Telefon metin olmalidir' })
    .trim()
    .max(DEMO_LIMITS.phone, `Telefon en fazla ${DEMO_LIMITS.phone} karakter olabilir`)
    .refine(validPhone, 'Telefon 10-15 rakamdan olusmalidir')
    .optional(),
  organization: singleLine(2, DEMO_LIMITS.organization, 'Site veya firma adi'),
  unitRange: z.enum(UNIT_RANGES, { error: 'Bagimsiz bolum sayisi araligi gecersiz' }),
  message: z
    .string({ error: 'Mesaj metin olmalidir' })
    .trim()
    .max(DEMO_LIMITS.message, `Mesaj en fazla ${DEMO_LIMITS.message} karakter olabilir`)
    .refine((v) => !CONTROL_EXCEPT_NEWLINE.test(v.replace(/\r\n/g, '\n')), 'Mesaj gecersiz karakter iceriyor')
    .optional(),
  kvkkConsent: z.literal(true, { error: 'Aydinlatma metninin okundugu onaylanmalidir' }),
  /** Onaylanan aydinlatma metninin surumu: yalnizca bilinen surumler. */
  kvkkVersion: z.enum(KVKK_VERSIONS, { error: 'Aydinlatma metni surumu gecersiz; sayfayi yenileyip tekrar deneyin' }),
  [HONEYPOT_FIELD]: z.string().max(500).optional(),
});

export type DemoRequestInput = z.output<typeof demoRequestInputSchema>;

const KNOWN_FIELDS = new Set<string>(Object.keys(demoRequestInputSchema.shape));

/**
 * Ilk hatali alan + alan mesajlari (istemci alan altinda gosterebilir). Saldirganin gonderdigi bilinmeyen
 * alan ADLARI yanita ve loga yazilmaz: yalnizca `_unknown` + adet.
 */
export function describeIssues(error: z.ZodError): { message: string; field?: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      fields._unknown = `Bilinmeyen alan (${issue.keys.length})`;
      continue;
    }
    const path = String(issue.path[0] ?? '');
    const key = KNOWN_FIELDS.has(path) ? path : '_body';
    if (!fields[key]) fields[key] = key === '_body' ? 'Gecersiz istek govdesi' : issue.message;
  }
  const first = Object.keys(fields)[0];
  return { message: first ? `${first}: ${fields[first]}` : 'Gecersiz istek', ...(first ? { field: first } : {}), fields };
}
