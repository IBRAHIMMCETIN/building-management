import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLATFORM_FEE_BASIS_POINTS,
  ZERO_FEES,
  computeSplit,
  feePolicyOf,
  loadPosDefaults,
} from '../src/modules/payments/fees.js';
import { commissionToKurus } from '../src/modules/payments/iyzico/provider.js';

const policy = { platformBasisPoints: 75, posRateBasisPoints: 249, posFixedFeeKurus: 25 };

describe('komisyon hesabi (apartman oder; sakine yansimaz)', () => {
  it('platform payi asagi, POS tahmini yukari; sabit ucret yalnizca ilk kalemde; sakinin tutari degismez', () => {
    const r = computeSplit([100_000, 50_000], policy);
    expect(r.items).toEqual([
      // 1000 TL: platform 7,50; POS 24,90 + 0,25
      { amount: 100_000, platformFee: 750, posEstimate: 2_515, subMerchantPrice: 96_735 },
      // 500 TL: platform 3,75; POS 12,45 (sabit ucret yok)
      { amount: 50_000, platformFee: 375, posEstimate: 1_245, subMerchantPrice: 48_380 },
    ]);
    expect(r).toMatchObject({ amount: 150_000, platformFee: 1_125, posEstimate: 3_760, commission: 4_885, subMerchantTotal: 145_115 });
  });

  it('kurus yuvarlamasi: 100,01 TL -> platform 75 (75,0075 asagi), POS 250 (249,0249 yukari)', () => {
    expect(computeSplit([10_001], { ...policy, posFixedFeeKurus: 0 }).items[0]).toEqual({
      amount: 10_001,
      platformFee: 75,
      posEstimate: 250,
      subMerchantPrice: 9_676,
    });
  });

  it('degismez: her tutar ve oranda komisyon + aktarilan = tahsilat; aktarilan en az 1 kurus', () => {
    for (const amount of [100, 999, 12_345, 100_000, 7_654_321]) {
      for (const bps of [0, 75, 199]) {
        const r = computeSplit([amount], { platformBasisPoints: bps, posRateBasisPoints: 249, posFixedFeeKurus: 25 });
        expect(r.commission + r.subMerchantTotal).toBe(amount);
        expect(r.items[0]!.subMerchantPrice).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('komisyonsuz politika tutari aynen aktarir; komisyonu karsilamayan kucuk tutar reddedilir', () => {
    expect(computeSplit([5_000], ZERO_FEES).items[0]!.subMerchantPrice).toBe(5_000);
    expect(() => computeSplit([25], policy)).toThrow(/çok düşük/);
    expect(() => computeSplit([0], policy)).toThrow();
  });

  it('gecersiz politika ve sinirlar', () => {
    expect(() => computeSplit([100], { ...policy, posRateBasisPoints: 1_001 })).toThrow(/posRateBasisPoints/);
    expect(() => computeSplit([100], { ...policy, posFixedFeeKurus: -1 })).toThrow(/posFixedFeeKurus/);
    expect(() => computeSplit([100], { ...policy, platformBasisPoints: 2.5 })).toThrow(/platformBasisPoints/);
  });

  it('varsayilan platform payi %0,75; POS ortam varsayilani, hesap ayari gecersiz kilar', () => {
    expect(DEFAULT_PLATFORM_FEE_BASIS_POINTS).toBe(75);
    expect(loadPosDefaults({})).toEqual({ posRateBasisPoints: 0, posFixedFeeKurus: 0 });
    const env = { PAYMENTS_POS_RATE_BPS: '249', PAYMENTS_POS_FIXED_FEE_KURUS: '25' };
    expect(loadPosDefaults(env)).toEqual({ posRateBasisPoints: 249, posFixedFeeKurus: 25 });
    expect(() => loadPosDefaults({ PAYMENTS_POS_RATE_BPS: '2.49' })).toThrow(/PAYMENTS_POS_RATE_BPS/);
    expect(() => loadPosDefaults({ PAYMENTS_POS_FIXED_FEE_KURUS: '99999' })).toThrow(/PAYMENTS_POS_FIXED_FEE_KURUS/);

    const defaults = loadPosDefaults(env);
    expect(feePolicyOf({ platformFeeBasisPoints: 75 }, defaults)).toEqual(policy);
    expect(feePolicyOf({ platformFeeBasisPoints: 50, posRateBasisPoints: 199 }, defaults)).toEqual({
      platformBasisPoints: 50,
      posRateBasisPoints: 199,
      posFixedFeeKurus: 25,
    });
  });
});

describe('iyzico komisyon tutarlari (mutabakat)', () => {
  it('kurus alti ondalik yukari yuvarlanir; cozumlenemeyen deger yok sayilir', () => {
    expect(commissionToKurus('2')).toBe(200);
    expect(commissionToKurus(2.125)).toBe(213);
    expect(commissionToKurus('0.028875')).toBe(3);
    expect(commissionToKurus('24.90000000')).toBe(2_490);
    expect(commissionToKurus(undefined)).toBeUndefined();
    expect(commissionToKurus('abc')).toBeUndefined();
  });
});
