import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { type SubMerchantForm, emptySubMerchantForm, subMerchantFormSchema, toSubMerchantInput } from './subMerchant';

const base = (over: Partial<SubMerchantForm> = {}): SubMerchantForm => ({
  ...emptySubMerchantForm(),
  email: 'yonetim@ornek.com',
  gsmNumber: '0532 123 45 67',
  address: 'Atatürk Cad. No:1 Kadıköy İstanbul',
  iban: 'TR33 0006 1005 1978 6457 8413 26',
  taxOffice: 'Kadıköy',
  legalCompanyTitle: 'Örnek Apartmanı Yönetimi',
  platformFee: '1,5',
  ...over,
});

const errorPaths = (v: SubMerchantForm) => {
  const r = subMerchantFormSchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('alt uye isyeri formu', () => {
  it('sahis sirketi: vergi no istege bagli', () => {
    expect(errorPaths(base())).toEqual([]);
    expect(errorPaths(base({ taxNumber: '123' }))).toEqual(['taxNumber']);
  });

  it('Ltd./A.S.: vergi no zorunlu', () => {
    expect(errorPaths(base({ subMerchantType: 'LIMITED_OR_JOINT_STOCK_COMPANY' }))).toEqual(['taxNumber']);
    expect(errorPaths(base({ subMerchantType: 'LIMITED_OR_JOINT_STOCK_COMPANY', taxNumber: '1234567890' }))).toEqual([]);
  });

  it('bireysel: ad, soyad, TCKN zorunlu; sirket alanlari aranmaz', () => {
    const personal = base({ subMerchantType: 'PERSONAL', taxOffice: '', legalCompanyTitle: '' });
    expect(errorPaths(personal).sort()).toEqual(['contactName', 'contactSurname', 'identityNumber']);
    expect(errorPaths({ ...personal, contactName: 'Ayşe', contactSurname: 'Yılmaz', identityNumber: '10000000146' })).toEqual([]);
  });

  it('ortak alanlar: e-posta, telefon, IBAN, pay (%20 ust sinir)', () => {
    expect(errorPaths(base({ email: 'x', gsmNumber: '0212 000 00 00', iban: 'TR00', platformFee: '25' })).sort()).toEqual([
      'email',
      'gsmNumber',
      'iban',
      'platformFee',
    ]);
  });

  it('istek: normalize eder ve tipe ait olmayan alanlari gondermez', () => {
    const input = toSubMerchantInput(base({ contactName: 'gizli', identityNumber: '10000000146' }));
    expect(input).toMatchObject({
      subMerchantType: 'PRIVATE_COMPANY',
      gsmNumber: '+905321234567',
      iban: 'TR330006100519786457841326',
      platformFeeBasisPoints: 150,
      taxOffice: 'Kadıköy',
    });
    expect(input).not.toHaveProperty('identityNumber');
    expect(input).not.toHaveProperty('contactName');
    expect(input.taxNumber).toBeUndefined();

    const personal = toSubMerchantInput(base({ subMerchantType: 'PERSONAL', contactName: 'Ayşe', contactSurname: 'Yılmaz', identityNumber: '10000000146' }));
    expect(personal).not.toHaveProperty('taxOffice');
    expect(personal.identityNumber).toBe('10000000146');
  });
});
