import { describe, expect, it, vi } from 'vitest';
vi.mock('./client', () => ({ apiClient: {} }));
import { intentSchema, managerIntentSchema, quoteSchema } from './payments';

describe('odeme semalari (API yanitlari)', () => {
  it('teklif: requiresGsmNumber eski API yanitinda false varsayilir', () => {
    const q = quoteSchema.parse({
      unitId: 'u1',
      currency: 'TRY',
      onlinePaymentEnabled: false,
      asOf: '2026-11-20',
      lateFeeMonthlyBasisPoints: 500,
      parties: [],
      totalDue: 0,
    });
    expect(q.requiresGsmNumber).toBe(false);
  });

  it('teklif: kurus kesirli olamaz', () => {
    expect(() =>
      quoteSchema.parse({
        unitId: 'u1',
        currency: 'TRY',
        onlinePaymentEnabled: true,
        asOf: '2026-11-20',
        lateFeeMonthlyBasisPoints: 500,
        parties: [],
        totalDue: 10.5,
      }),
    ).toThrow();
  });

  it('odeme niyeti', () => {
    const i = intentSchema.parse({
      intentId: 'PI#20261120120000-abc',
      status: 'PENDING',
      mode: 'total',
      unitId: 'u1',
      currency: 'TRY',
      amount: 450_00,
      allocations: [{ liableParty: 'occupant', principal: 400_00, lateFee: 50_00, amount: 450_00, transactionIds: ['t1'] }],
      paymentPageUrl: 'https://sandbox.iyzipay.com/x',
      expiresAt: '2026-11-20T12:30:00.000Z',
      createdAt: '2026-11-20T12:00:00.000Z',
    });
    expect(i.paymentPageUrl).toContain('iyzipay');
    expect(() => intentSchema.parse({ ...i, status: 'UNKNOWN' })).toThrow();
  });

  it('yonetici gorunumu kart/alici bilgisi tasimaz', () => {
    const keys = Object.keys(managerIntentSchema.shape);
    for (const k of ['gsmNumber', 'identityNumber', 'card', 'buyer']) expect(keys).not.toContain(k);
  });
});
