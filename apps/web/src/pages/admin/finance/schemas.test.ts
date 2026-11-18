import { describe, expect, it } from 'vitest';
import { chargeSchema, defaultDueDate, defaultDuesDescription, expenseSchema, paymentSchema } from './schemas';

describe('tarih varsayilanlari', () => {
  it('son odeme: ayin 10u, gecmisse sonraki ay (yil donumu dahil)', () => {
    expect(defaultDueDate('2026-11-08')).toBe('2026-11-10');
    expect(defaultDueDate('2026-11-10')).toBe('2026-11-10');
    expect(defaultDueDate('2026-11-11')).toBe('2026-12-10');
    expect(defaultDueDate('2026-12-20')).toBe('2027-01-10');
  });
  it('aciklama', () => {
    expect(defaultDuesDescription('2026-11-08')).toBe('Kasım 2026 aidatı');
  });
});

describe('form semalari', () => {
  it('tutar kurusa cevrilir, bos opsiyoneller undefined olur', () => {
    const v = paymentSchema.parse({ unitId: 'u1', liableParty: 'occupant', amount: '1.500,50', method: 'cash', paidAt: '2026-11-08', payerName: ' ', note: '' });
    expect(v).toMatchObject({ amount: 150050, payerName: undefined, note: undefined });
  });
  it('gecersiz tutar anlamli mesaj verir', () => {
    const r = expenseSchema.safeParse({ expenseAccountId: 'exp-1', creditAccountId: 'cash', amount: '12,345', date: '2026-11-08', description: 'Temizlik', supplier: '', invoiceNumber: '' });
    expect(r.error?.issues[0]).toMatchObject({ path: ['amount'], message: expect.stringContaining('geçersiz') });
  });
  it('tahakkuk: tek dairede daire zorunlu, vade tahakkuktan once olamaz', () => {
    const base = { mode: 'single', distributionKey: 'equal', excludedBlockIds: [], expenseCategory: '', unitId: '', liableParty: 'occupant', amount: '100', date: '2026-11-08', dueDate: '2026-11-01', description: 'Aidat' };
    const paths = chargeSchema.safeParse(base).error?.issues.map((i) => i.path[0]);
    expect(paths).toEqual(expect.arrayContaining(['unitId', 'dueDate']));
    expect(chargeSchema.safeParse({ ...base, mode: 'bulk', dueDate: '2026-11-10' }).success).toBe(true);
  });
});
