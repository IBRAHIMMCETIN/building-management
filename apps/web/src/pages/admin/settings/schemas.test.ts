import { describe, expect, it } from 'vitest';
import type { Site } from '@/lib/api/sites';
import { basisPointsToInput, formDefaults, parsePercentToBasisPoints, settingsSchema, toUpdateInput } from './schemas';

const site = (over: Partial<Site['settings']> = {}): Site => ({
  siteId: 's1',
  name: 'Dev Sitesi',
  version: 4,
  settings: { landShareEnabled: false, dueDayOfMonth: 10, lateFeeMonthlyBasisPoints: 500, ...over },
});

const valid = { dueDayOfMonth: '10', lateFeeRate: '5', planEnabled: true, planAmount: '15.000,00', planKey: 'equal' as const, planParty: 'occupant' as const, planIncomeAccountId: 'income-dues' };

describe('oran donusumleri (kayan nokta yok)', () => {
  it('yuzde metni -> baz puan', () => {
    expect(parsePercentToBasisPoints('5')).toBe(500);
    expect(parsePercentToBasisPoints('%5,5')).toBe(550);
    expect(parsePercentToBasisPoints('2.25')).toBe(225);
    expect(parsePercentToBasisPoints('0')).toBe(0);
    expect(parsePercentToBasisPoints('100')).toBe(10_000);
    expect(parsePercentToBasisPoints('100,01')).toBeNull();
    expect(parsePercentToBasisPoints('5,555')).toBeNull();
    expect(parsePercentToBasisPoints('-1')).toBeNull();
    expect(parsePercentToBasisPoints('')).toBeNull();
  });
  it('baz puan -> yuzde metni', () => {
    expect(basisPointsToInput(500)).toBe('5');
    expect(basisPointsToInput(550)).toBe('5,5');
    expect(basisPointsToInput(225)).toBe('2,25');
    expect(basisPointsToInput(0)).toBe('0');
  });
});

describe('ayarlar formu', () => {
  it('acik plan API govdesine kurus/baz puan olarak gider', () => {
    expect(toUpdateInput(settingsSchema.parse(valid), 4)).toEqual({
      version: 4,
      settings: {
        dueDayOfMonth: 10,
        lateFeeMonthlyBasisPoints: 500,
        monthlyDuesPlan: { enabled: true, totalAmount: 1_500_000, distributionKey: 'equal', liableParty: 'occupant' },
      },
    });
  });

  it('kapatilan plan degerleri korunur; tutar hic yoksa plan kaldirilir', () => {
    expect(toUpdateInput(settingsSchema.parse({ ...valid, planEnabled: false }), 4).settings.monthlyDuesPlan).toMatchObject({ enabled: false, totalAmount: 1_500_000 });
    expect(toUpdateInput(settingsSchema.parse({ ...valid, planEnabled: false, planAmount: '' }), 4).settings.monthlyDuesPlan).toBeNull();
  });

  it('gecersiz gun, oran ve acik planda eksik tutar alan hatasi verir', () => {
    const r = settingsSchema.safeParse({ ...valid, dueDayOfMonth: '31', lateFeeRate: 'bes', planAmount: '' });
    expect(r.error?.issues.map((i) => i.path[0])).toEqual(['dueDayOfMonth', 'lateFeeRate', 'planAmount']);
  });

  it('Finans 2.4: gelir hesabi plana yazilir; butce bagi plan degismedikce korunur', () => {
    const current = { enabled: true, totalAmount: 1_500_000, distributionKey: 'equal' as const, liableParty: 'occupant' as const, incomeAccountId: 'income-heating', budgetId: '2026-r1' };
    const same = toUpdateInput(settingsSchema.parse({ ...valid, planIncomeAccountId: 'income-heating' }), 4, current).settings.monthlyDuesPlan;
    expect(same).toEqual(current);
    const changed = toUpdateInput(settingsSchema.parse({ ...valid, planAmount: '16.000,00', planIncomeAccountId: 'income-heating' }), 4, current).settings.monthlyDuesPlan;
    expect(changed).toEqual({ enabled: true, totalAmount: 1_600_000, distributionKey: 'equal', liableParty: 'occupant', incomeAccountId: 'income-heating' });
    expect(formDefaults(site({ monthlyDuesPlan: current })).planIncomeAccountId).toBe('income-heating');
  });

  it('kayitli ayarlar forma dolar', () => {
    expect(formDefaults(site())).toEqual({ dueDayOfMonth: '10', lateFeeRate: '5', planEnabled: false, planAmount: '', planKey: 'equal', planParty: 'occupant', planIncomeAccountId: 'income-dues' });
    expect(
      formDefaults(site({ lateFeeMonthlyBasisPoints: 250, monthlyDuesPlan: { enabled: true, totalAmount: 1_500_050, distributionKey: 'area', liableParty: 'owner' } })),
    ).toMatchObject({ lateFeeRate: '2,5', planEnabled: true, planAmount: '15000,50', planKey: 'area', planParty: 'owner' });
  });
});
