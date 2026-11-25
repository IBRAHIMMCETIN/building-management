import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import type { SheetRow } from '@/lib/api/meters';
import { draftItems, estimableRows } from './readingDrafts';
import { addMeterSchema, periodSchema, swapSchema, templateSchema } from './schemas';

const tpl = (over: Record<string, unknown> = {}) => ({
  name: 'Merkezi ısıtma',
  meterKind: 'heat_allocator',
  category: 'heating',
  commonPercent: '30',
  commonKey: 'area',
  liableParty: 'occupant',
  legalProfile: 'central_heating',
  decisionRef: '',
  reason: '',
  isDefault: true,
  incomeAccountId: '',
  ...over,
});

describe('sablon formu: yonetmelik disi oran engellenmez, karar + gerekce ister (karar 2)', () => {
  it('%30 m² merkezi isitma: karar gerekmez; baz puana cevrilir', () => {
    const r = templateSchema.safeParse(tpl());
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ commonShareBps: 3000, commonKey: 'area' });
  });

  it('%40 ortak: karar no ve gerekce zorunlu', () => {
    const r = templateSchema.safeParse(tpl({ commonPercent: '40' }));
    expect(r.success).toBe(false);
    const paths = r.error?.issues.map((i) => i.path[0]);
    expect(paths).toEqual(expect.arrayContaining(['decisionRef', 'reason']));
    const ok = templateSchema.safeParse(tpl({ commonPercent: '40', decisionRef: 'KMK 2026/3', reason: 'Yalıtım farkı' }));
    expect(ok.success).toBe(true);
    expect(ok.data?.commonShareBps).toBe(4000);
  });

  it('su sablonu %0 + %100: sapma yok; gecersiz yuzde reddedilir', () => {
    expect(templateSchema.safeParse(tpl({ commonPercent: '0', legalProfile: 'none', meterKind: 'hot_water', category: 'hot_water' })).success).toBe(true);
    expect(templateSchema.safeParse(tpl({ commonPercent: '120' })).success).toBe(false);
  });
});

describe('donem formu', () => {
  const base = { templateId: 't1', name: 'Kasım 2026', startDate: '2026-11-01', endDate: '2026-11-30', dueDate: '2026-12-15', amount: '', expenseIds: [] as string[] };

  it('fatura secimi: en az bir fatura; tutar gonderilmez', () => {
    expect(periodSchema.safeParse({ ...base, source: 'expenses' }).success).toBe(false);
    const r = periodSchema.safeParse({ ...base, source: 'expenses', expenseIds: ['gas-1'] });
    expect(r.data).toEqual({ templateId: 't1', name: 'Kasım 2026', startDate: '2026-11-01', endDate: '2026-11-30', dueDate: '2026-12-15', expenseIds: ['gas-1'] });
  });

  it('elle tutar kurusa cevrilir; bos tutar serbest; tarih sirasi kontrol edilir', () => {
    expect(periodSchema.safeParse({ ...base, source: 'amount', amount: '1.000,01' }).data).toMatchObject({ totalAmount: 100001 });
    expect(periodSchema.safeParse({ ...base, source: 'amount' }).data).not.toHaveProperty('totalAmount');
    expect(periodSchema.safeParse({ ...base, source: 'amount', amount: 'abc' }).success).toBe(false);
    expect(periodSchema.safeParse({ ...base, source: 'amount', endDate: '2026-10-01' }).success).toBe(false);
  });
});

describe('sayac / degisim formlari endeksi sayacin olcegine gore dogrular', () => {
  it('acilis endeksi', () => {
    const b = { unitId: 'u1', kind: 'hot_water', label: 'Banyo', serialNo: '', installedAt: '2026-01-01' };
    expect(addMeterSchema.safeParse({ ...b, scale: '3', openingIndex: '12,345' }).success).toBe(true);
    expect(addMeterSchema.safeParse({ ...b, scale: '0', openingIndex: '12,3' }).success).toBe(false);
  });

  it('degisimde yeni sayacin olcegi ayri', () => {
    const b = { kind: 'replacement', swapDate: '2026-11-10', oldClosingIndex: '500', reason: 'Arızalı', newSerialNo: '', newLabel: '', scale: '0' };
    expect(swapSchema.safeParse({ ...b, newScale: '3', newOpeningIndex: '0,125' }).success).toBe(true);
    expect(swapSchema.safeParse({ ...b, newScale: '0', newOpeningIndex: '0,125' }).success).toBe(false);
    expect(swapSchema.safeParse({ ...b, kind: 'reset', newScale: '3', newOpeningIndex: '0,125' }).success).toBe(false);
  });
});

const row = (over: Partial<SheetRow>): SheetRow => ({
  meterId: 'm1',
  unitId: 'u1',
  label: 'Salon',
  kind: 'heat_allocator',
  scale: 0,
  inScope: true,
  status: 'missing',
  flags: [],
  ...over,
});

describe('okuma cizelgesi yardimcilari', () => {
  it('yalnizca degisen ve gecerli taslaklar kaydedilir', () => {
    const rows = [row({ meterId: 'm1' }), row({ meterId: 'm2', status: 'ok', endSource: 'reading', endIndex: 50 }), row({ meterId: 'm3' })];
    const { items, invalid } = draftItems(rows, { m1: '120', m2: '50', m3: '1,5' });
    expect(items).toEqual([{ meterId: 'm1', endIndex: 120 }]);
    expect(invalid).toEqual({ m3: 'Bu sayaç ondalık kabul etmez' });
  });

  it('tahmini ortalama: yalnizca onerisi olan eksik ve kapsam ici satirlar', () => {
    const suggestion = { startIndex: 0, suggestedDelta: 10, suggestedEndIndex: 10 };
    const rows = [
      row({ meterId: 'a', suggestion }),
      row({ meterId: 'b' }),
      row({ meterId: 'c', suggestion, inScope: false }),
      row({ meterId: 'd', suggestion, status: 'ok' }),
    ];
    expect(estimableRows(rows).map((r) => r.meterId)).toEqual(['a']);
  });
});
