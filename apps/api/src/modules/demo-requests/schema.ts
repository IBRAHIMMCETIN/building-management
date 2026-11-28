import { z } from 'zod';

/**
 * Herkese acik demo talep formu (`POST /api/public/demo-requests`). Kimliksiz bir uc oldugu icin
 * sema KATIdir: bilinmeyen alan, kontrol karakteri, sinir disi uzunluk ve gecersiz secim 400 doner.
 * Alan sinirlari web formuyla aynidir (packages/shared/src/api/demoRequests.ts).
 */

export const UNIT_RANGES = ['1-20', '21-50', '51-200', '201-500', '500+'] as const;
export type UnitRange = (typeof UNIT_RANGES)[number];

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
  fullName: singleLine(2, 100, 'Ad soyad'),
  email: z
    .string({ error: 'E-posta metin olmalidir' })
    .trim()
    .toLowerCase()
    .max(254, 'E-posta en fazla 254 karakter olabilir')
    .pipe(z.email('Gecerli bir e-posta adresi girin')),
  phone: z
    .string({ error: 'Telefon metin olmalidir' })
    .trim()
    .max(20, 'Telefon en fazla 20 karakter olabilir')
    .refine(validPhone, 'Telefon 10-15 rakamdan olusmalidir')
    .optional(),
  organization: singleLine(2, 150, 'Site veya firma adi'),
  unitRange: z.enum(UNIT_RANGES, { error: 'Bagimsiz bolum sayisi araligi gecersiz' }),
  message: z
    .string({ error: 'Mesaj metin olmalidir' })
    .trim()
    .max(2000, 'Mesaj en fazla 2000 karakter olabilir')
    .refine((v) => !CONTROL_EXCEPT_NEWLINE.test(v.replace(/\r\n/g, '\n')), 'Mesaj gecersiz karakter iceriyor')
    .optional(),
  kvkkConsent: z.literal(true, { error: 'Aydinlatma metninin okundugu onaylanmalidir' }),
  /** Onaylanan aydinlatma metninin surumu (packages/shared/src/legal/documents.ts). */
  kvkkVersion: z
    .string({ error: 'Aydinlatma metni surumu gerekli' })
    .regex(/^[a-z0-9][a-z0-9.-]{0,39}$/, 'Aydinlatma metni surumu gecersiz'),
  /** Bal kupu: insanlar bos birakir (alan gizli). Dolu gelirse kayit yazilmaz. */
  website: z.string().max(500).optional(),
});

export type DemoRequestInput = z.output<typeof demoRequestInputSchema>;

/** Ilk hatali alan + tum alan mesajlari (istemci alan altinda gosterebilir). */
export function describeIssues(error: z.ZodError): { message: string; field?: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.code === 'unrecognized_keys' ? issue.keys.join(',') : String(issue.path[0] ?? 'govde');
    if (!fields[key]) fields[key] = issue.code === 'unrecognized_keys' ? 'Bilinmeyen alan' : issue.message;
  }
  const first = Object.keys(fields)[0];
  return { message: first ? `${first}: ${fields[first]}` : 'Gecersiz istek', ...(first ? { field: first } : {}), fields };
}
