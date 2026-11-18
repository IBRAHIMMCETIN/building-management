import { z } from 'zod';
import { UNIT_TYPES } from '@/types/units';

/** Bos metni undefined'a, "85,5" gibi virgullu girisi sayiya cevirir. */
const optionalNumber = (schema: z.ZodNumber) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const t = v.trim().replace(',', '.');
    return t === '' ? undefined : Number(t);
  }, schema.optional());

const requiredNumber = (schema: z.ZodNumber, message: string) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const t = v.trim().replace(',', '.');
    return t === '' ? undefined : Number(t);
  }, schema.or(z.undefined()).refine((n) => n !== undefined, message));

const NEW_BLOCK = '__new__';
export { NEW_BLOCK };

export const createUnitSchema = z
  .object({
    blockId: z.string().min(1, 'Blok seçin.'),
    newBlockName: z.string().trim().max(60, 'En fazla 60 karakter.').optional(),
    number: z.string().trim().min(1, 'Daire no gerekli.').max(20, 'En fazla 20 karakter.'),
    type: z.enum(UNIT_TYPES),
    floor: optionalNumber(z.number({ error: 'Kat bir tam sayı olmalı.' }).int('Kat bir tam sayı olmalı.').min(-5, 'En az -5.').max(200, 'En fazla 200.')),
    grossAreaM2: requiredNumber(
      z.number({ error: 'Geçerli bir metrekare girin.' }).min(0.1, 'En az 0,1 m².').max(100_000, 'Çok büyük.'),
      'Brüt m² gerekli.',
    ),
    landShareNumerator: optionalNumber(z.number({ error: 'Tam sayı girin.' }).int('Tam sayı girin.').min(1, 'En az 1.')),
    landShareDenominator: optionalNumber(z.number({ error: 'Tam sayı girin.' }).int('Tam sayı girin.').min(1, 'En az 1.')),
  })
  .superRefine((v, ctx) => {
    if (v.blockId === NEW_BLOCK && !v.newBlockName) {
      ctx.addIssue({ code: 'custom', path: ['newBlockName'], message: 'Yeni blok adı gerekli.' });
    }
    const hasNum = v.landShareNumerator !== undefined;
    const hasDen = v.landShareDenominator !== undefined;
    if (hasNum !== hasDen) {
      ctx.addIssue({
        code: 'custom',
        path: [hasNum ? 'landShareDenominator' : 'landShareNumerator'],
        message: 'Arsa payının pay ve paydası birlikte girilmeli.',
      });
    } else if (hasNum && hasDen && (v.landShareNumerator as number) > (v.landShareDenominator as number)) {
      ctx.addIssue({ code: 'custom', path: ['landShareNumerator'], message: 'Pay, paydadan büyük olamaz.' });
    }
  });

export type CreateUnitForm = z.input<typeof createUnitSchema>;
export type CreateUnitValues = z.output<typeof createUnitSchema>;

export const inviteSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, 'Ad soyad gerekli.')
      .max(100, 'En fazla 100 karakter.'),
    // Once kirp/kucult, sonra dogrula (z.email().trim() bicimi kirpmadan once denetler).
    email: z.string().trim().toLowerCase().pipe(z.email('Geçerli bir e-posta adresi girin.')),
    relation: z.enum(['owner', 'tenant']),
    startDate: z.iso.date('Geçerli bir tarih seçin.'),
    residesInUnit: z.boolean(),
    shareNumerator: optionalNumber(z.number({ error: 'Tam sayı girin.' }).int('Tam sayı girin.').min(1, 'En az 1.')),
    shareDenominator: optionalNumber(z.number({ error: 'Tam sayı girin.' }).int('Tam sayı girin.').min(1, 'En az 1.')),
  })
  .superRefine((v, ctx) => {
    const hasNum = v.shareNumerator !== undefined;
    const hasDen = v.shareDenominator !== undefined;
    if (v.relation === 'tenant') return;
    if (hasNum !== hasDen) {
      ctx.addIssue({
        code: 'custom',
        path: [hasNum ? 'shareDenominator' : 'shareNumerator'],
        message: 'Hisse payının pay ve paydası birlikte girilmeli.',
      });
    } else if (hasNum && hasDen && (v.shareNumerator as number) > (v.shareDenominator as number)) {
      ctx.addIssue({ code: 'custom', path: ['shareNumerator'], message: 'Pay, paydadan büyük olamaz.' });
    }
  });

export type InviteForm = z.input<typeof inviteSchema>;
export type InviteValues = z.output<typeof inviteSchema>;

/** Daire muafiyetleri: isaretli gider kalemleri ve (istege bagli) ortak gerekce. */
export const exemptionsSchema = z.object({
  categories: z.array(z.string()),
  reason: z.string().trim().max(200, 'En fazla 200 karakter.'),
});

export type ExemptionsForm = z.input<typeof exemptionsSchema>;
export type ExemptionsValues = z.output<typeof exemptionsSchema>;
