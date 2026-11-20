/**
 * Platform yoneticisi: apartmani odeme saglayicisinda alt uye isyeri olarak kaydetme formu.
 * Kurallar API ile ayni (payments/service.ts parseSubMerchant):
 *   - Sahis/sirket (PRIVATE_COMPANY), Ltd./A.S. (LIMITED_OR_JOINT_STOCK_COMPANY): vergi dairesi ve
 *     unvan zorunlu; vergi no Ltd./A.S. icin zorunlu, sahis sirketinde istege bagli.
 *   - Bireysel (PERSONAL): ad, soyad ve T.C. kimlik no zorunlu.
 * KYC verisi saglayiciya iletilir; bizde yalnizca maskeli IBAN, tip ve platform payi kalir.
 */
import { z } from 'zod';
import { SUB_MERCHANT_TYPES, type SubMerchantInput, type SubMerchantType } from '@/lib/api/payments';
import { normalizeIban, parsePercentToBasisPoints } from './manager';
import { isValidTckn, normalizeGsm } from './selection';

export const SUB_MERCHANT_TYPE_LABELS: Record<SubMerchantType, string> = {
  PRIVATE_COMPANY: 'Şahıs şirketi',
  LIMITED_OR_JOINT_STOCK_COMPANY: 'Limited / Anonim şirket',
  PERSONAL: 'Bireysel (şirketsiz)',
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const subMerchantFormSchema = z
  .object({
    subMerchantType: z.enum(SUB_MERCHANT_TYPES),
    name: z.string().trim().max(200, 'En fazla 200 karakter.'),
    email: z.string().trim(),
    gsmNumber: z.string().trim(),
    address: z.string().trim(),
    iban: z.string().trim(),
    taxOffice: z.string().trim(),
    taxNumber: z.string().trim(),
    legalCompanyTitle: z.string().trim(),
    contactName: z.string().trim(),
    contactSurname: z.string().trim(),
    identityNumber: z.string().trim(),
    platformFee: z.string().trim(),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    const between = (path: keyof typeof v, label: string, min: number, max: number) => {
      const s = v[path];
      if (s.length < min || s.length > max) issue(path, `${label} ${min}-${max} karakter olmalı.`);
    };
    if (!EMAIL.test(v.email) || v.email.length > 254) issue('email', 'Geçerli bir e-posta adresi girin.');
    if (!normalizeGsm(v.gsmNumber)) issue('gsmNumber', 'Geçerli bir cep telefonu girin (05xx...).');
    between('address', 'Adres', 5, 500);
    if (!normalizeIban(v.iban)) issue('iban', 'Geçerli bir TR IBAN girin.');
    if (parsePercentToBasisPoints(v.platformFee || '0') === null) issue('platformFee', 'Pay %0 ile %20 arasında olmalı (örn. 1,5).');

    if (v.subMerchantType === 'PERSONAL') {
      between('contactName', 'Ad', 2, 100);
      between('contactSurname', 'Soyad', 2, 100);
      if (!isValidTckn(v.identityNumber)) issue('identityNumber', 'Geçerli bir T.C. kimlik numarası girin.');
    } else {
      between('taxOffice', 'Vergi dairesi', 2, 100);
      between('legalCompanyTitle', 'Ticari unvan', 2, 300);
      const required = v.subMerchantType === 'LIMITED_OR_JOINT_STOCK_COMPANY';
      if ((required || v.taxNumber) && !/^\d{10}$/.test(v.taxNumber)) issue('taxNumber', 'Vergi numarası 10 haneli olmalı.');
    }
  });

export type SubMerchantForm = z.input<typeof subMerchantFormSchema>;

export const emptySubMerchantForm = (): SubMerchantForm => ({
  subMerchantType: 'PRIVATE_COMPANY',
  name: '',
  email: '',
  gsmNumber: '',
  address: '',
  iban: '',
  taxOffice: '',
  taxNumber: '',
  legalCompanyTitle: '',
  contactName: '',
  contactSurname: '',
  identityNumber: '',
  platformFee: '0',
});

/** Dogrulanmis formu API istegine cevirir: tipe ait olmayan alanlar gonderilmez. */
export function toSubMerchantInput(v: SubMerchantForm): SubMerchantInput {
  const opt = (s: string) => (s.trim() === '' ? undefined : s.trim());
  const personal = v.subMerchantType === 'PERSONAL';
  return {
    subMerchantType: v.subMerchantType,
    name: opt(v.name),
    email: v.email.trim(),
    gsmNumber: normalizeGsm(v.gsmNumber) ?? v.gsmNumber.trim(),
    address: v.address.trim(),
    iban: normalizeIban(v.iban) ?? v.iban.trim(),
    platformFeeBasisPoints: parsePercentToBasisPoints(v.platformFee || '0') ?? 0,
    ...(personal
      ? { contactName: opt(v.contactName), contactSurname: opt(v.contactSurname), identityNumber: opt(v.identityNumber) }
      : { taxOffice: opt(v.taxOffice), taxNumber: opt(v.taxNumber), legalCompanyTitle: opt(v.legalCompanyTitle) }),
  };
}

/** API alan adlari form alanlariyla ayni; yalnizca pay farkli. */
export const SUB_MERCHANT_FIELD_MAP = { platformFeeBasisPoints: 'platformFee' } as const;
