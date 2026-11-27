import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { quoteSchema } from '@/lib/api/tenders';
import { quoteDefaults, quoteFormSchema, tenderDefaults, tenderFormSchema, toQuoteInput, toTenderInput } from './schemas';

const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  Object.fromEntries((r.error?.issues ?? []).map((i) => [String(i.path[0]), i.message]));

describe('ihale formu', () => {
  it('zorunlu alanlar ve sinirlar; API girdisine cevrilir (bos talep = bagi kaldir)', () => {
    const empty = tenderFormSchema.safeParse(tenderDefaults());
    expect(Object.keys(issues(empty)).sort()).toEqual(['deadline', 'description', 'title']);
    const ok = tenderFormSchema.parse({ ...tenderDefaults(), title: 'Çatı onarımı', description: 'Kiremit değişimi ve izolasyon', deadline: '2026-12-20', minQuotes: '2' });
    expect(toTenderInput(ok)).toEqual({ title: 'Çatı onarımı', description: 'Kiremit değişimi ve izolasyon', category: 'mantolama', deadline: '2026-12-20', minQuotes: 2, ticketId: null });
    expect(issues(tenderFormSchema.safeParse({ ...tenderDefaults(), title: 'Çatı', description: 'Yeterince uzun açıklama', deadline: '2026-12-20', minQuotes: '11' }))).toEqual({ minQuotes: 'Asgari teklif sayısı 1–10 arasında olmalı' });
    expect(tenderDefaults({ title: 'X', description: 'Y', category: 'boya', deadline: '2026-12-01', minQuotes: 4, ticket: { ticketId: 'tk1', number: 'T-1', title: 'Z' } })).toMatchObject({ minQuotes: '4', ticketId: 'tk1' });
  });
});

describe('teklif formu', () => {
  it('TL metni kuruşa; KDV dahil / haric; bos istege bagli alanlar null', () => {
    const v = quoteFormSchema.parse({ ...quoteDefaults(), supplierName: 'Yılmaz Yapı', amount: '125.000,50', vatMode: 'excluded', vatRate: '10' });
    expect(toQuoteInput(v)).toEqual({ supplierName: 'Yılmaz Yapı', amountKurus: 12_500_050, vatIncluded: false, vatRate: 10, validUntil: null, deliveryDays: null, warrantyMonths: null, notes: null });
    const full = quoteFormSchema.parse({ ...quoteDefaults(), supplierName: 'Deniz', amount: '80000', validUntil: '2027-01-31', deliveryDays: '45', warrantyMonths: '24', notes: 'Malzeme dahil' });
    expect(toQuoteInput(full)).toMatchObject({ amountKurus: 8_000_000, vatIncluded: true, vatRate: 20, validUntil: '2027-01-31', deliveryDays: 45, warrantyMonths: 24, notes: 'Malzeme dahil' });
  });

  it('gecersiz tutar, sure ve oranlar Turkce hata verir', () => {
    const bad = quoteFormSchema.safeParse({ ...quoteDefaults(), supplierName: 'K', amount: 'on bin', deliveryDays: '0', warrantyMonths: 'iki', vatRate: '120' });
    expect(issues(bad)).toEqual({
      supplierName: 'Firma adı en az 2 karakter olmalı',
      amount: 'Geçerli bir tutar girin (ör. 125.000 veya 125000,50)',
      deliveryDays: 'İş süresi 1–3650 arasında tam sayı olmalı',
      warrantyMonths: 'Garanti süresi 0–600 arasında tam sayı olmalı',
      vatRate: 'KDV oranı en fazla %100 olabilir',
    });
    expect(issues(quoteFormSchema.safeParse({ ...quoteDefaults(), supplierName: 'Kaya', amount: '' }))).toEqual({ amount: 'Teklif tutarını girin' });
  });

  it('duzenlemede mevcut teklif forma doner (listede olmayan eski KDV orani korunur)', () => {
    const q = quoteSchema.parse({
      quoteId: 'q1',
      supplierName: 'Eski Firma',
      amountKurus: 1_180_000,
      vatIncluded: true,
      vatRate: 18,
      deliveryDays: 30,
      status: 'active',
      createdAt: '2026-11-27T07:00:00.000Z',
      updatedAt: '2026-11-27T07:00:00.000Z',
      netKurus: 1_000_000,
      vatKurus: 180_000,
      totalKurus: 1_180_000,
    });
    const form = quoteDefaults(q);
    expect(form).toEqual({ supplierName: 'Eski Firma', amount: '11800,00', vatMode: 'included', vatRate: '18', validUntil: '', deliveryDays: '30', warrantyMonths: '', notes: '' });
    expect(toQuoteInput(quoteFormSchema.parse(form))).toMatchObject({ amountKurus: 1_180_000, vatRate: 18, deliveryDays: 30 });
  });
});
