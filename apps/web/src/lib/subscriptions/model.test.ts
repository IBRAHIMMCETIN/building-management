import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { planSchema } from '@/lib/api/subscriptions';
import { actionsFor, bannerFor, draftFromPlan, emptyPlanDraft, planInputFromDraft, priceSummary, usageText } from './model';

describe('abonelik yardimcilari', () => {
  it('ust bant: denemenin son 7 gunu, gecikme ve salt okunur; legacy ve olagan durumda yok', () => {
    expect(bannerFor({ status: 'legacy', legacy: true, readOnly: false })).toBeNull();
    expect(bannerFor({ status: 'active', legacy: false, readOnly: false })).toBeNull();
    expect(bannerFor({ status: 'trial', legacy: false, readOnly: false, trialEndsAt: '2026-12-30', daysLeft: 20 })).toBeNull();
    expect(bannerFor({ status: 'trial', legacy: false, readOnly: false, trialEndsAt: '2026-12-01', daysLeft: 1 })).toMatchObject({ tone: 'neutral', text: expect.stringMatching(/^yarın/) });
    expect(bannerFor({ status: 'past_due', legacy: false, readOnly: false, suspendOn: '2026-12-26' })?.tone).toBe('warning');
    expect(bannerFor({ status: 'suspended', legacy: false, readOnly: true })).toMatchObject({ tone: 'danger', title: expect.stringContaining('salt okunur') });
    expect(bannerFor({ status: 'cancelled', legacy: false, readOnly: true })?.title).toMatch(/sona erdi/);
  });

  it('fiyat ozeti ve kullanim metni', () => {
    expect(priceSummary({ model: 'flat', monthlyKurus: 0, annualKurus: 0, vatRateBps: 2000 })).toBe('Ücretsiz');
    expect(priceSummary({ model: 'per_unit', monthlyKurus: 25_000, annualKurus: 250_000, perUnitMonthlyKurus: 1_200, perUnitAnnualKurus: 12_000, vatRateBps: 2000 })).toMatch(
      /250,00.*bölüm başı.*12,00.*\/ ay/,
    );
    expect(usageText(12, null)).toBe('12 (sınırsız)');
    expect(usageText(12, 100)).toBe('12 / 100');
  });

  it('islemler durumla sinirli (API ile ayni)', () => {
    expect(actionsFor('trial')).toEqual(['extend_trial', 'activate', 'suspend', 'cancel']);
    expect(actionsFor('suspended')).toEqual(['cancel', 'reactivate']);
    expect(actionsFor('legacy')).toEqual([]);
  });

  it('plan formu: TL metni kayan nokta olmadan kurusa; kademe ve limit dogrulamasi', () => {
    const d = { ...emptyPlanDraft(), code: 'Standart', name: 'Standart', model: 'per_unit' as const, monthly: '250,00', annual: '2.500', perUnitMonthly: '12,5', perUnitAnnual: '120', maxUnits: '500' };
    const { input, errors } = planInputFromDraft(d);
    expect(errors).toEqual({});
    expect(input).toMatchObject({
      code: 'standart',
      pricing: { model: 'per_unit', monthlyKurus: 25_000, annualKurus: 250_000, perUnitMonthlyKurus: 1_250, perUnitAnnualKurus: 12_000, vatRateBps: 2000 },
      limits: { maxUnits: 500, maxStaffUsers: null },
      trialDays: 30,
    });
    expect(planInputFromDraft({ ...d, monthly: '12,345' }).errors.monthly).toBeDefined();
    expect(planInputFromDraft({ ...d, maxUnits: '0' }).errors.maxUnits).toBeDefined();
    const tiered = { ...d, model: 'tiered' as const, tiers: [{ maxUnits: '250', monthly: '1.500', annual: '15.000' }, { maxUnits: '', monthly: '3.500', annual: '35.000' }] };
    expect(planInputFromDraft(tiered).input?.pricing.tiers).toEqual([
      { maxUnits: 250, monthlyKurus: 150_000, annualKurus: 1_500_000 },
      { maxUnits: null, monthlyKurus: 350_000, annualKurus: 3_500_000 },
    ]);
    expect(planInputFromDraft({ ...tiered, tiers: [{ maxUnits: '', monthly: '1', annual: '1' }, { maxUnits: '10', monthly: '1', annual: '1' }] }).errors.tiers).toBeDefined();
    expect(planInputFromDraft({ ...tiered, tiers: [{ maxUnits: '300', monthly: '1', annual: '1' }, { maxUnits: '200', monthly: '1', annual: '1' }] }).errors.tiers).toBeDefined();
  });

  it('kayitli plan forma ve geri ayni girdiye doner', () => {
    const plan = planSchema.parse({
      code: 'temel',
      name: 'Temel',
      pricing: { model: 'per_unit', monthlyKurus: 0, annualKurus: 0, perUnitMonthlyKurus: 1_500, perUnitAnnualKurus: 15_000, vatRateBps: 2000 },
      features: { 'payments.online': true, 'channels.push': true },
      limits: { maxUnits: 100, maxStaffUsers: 5 },
      trialDays: 30,
      status: 'active',
      planVersion: 1,
      updatedAt: '2026-11-28T00:00:00.000Z',
      version: 1,
    });
    const { input } = planInputFromDraft(draftFromPlan(plan));
    expect(input).toMatchObject({ code: 'temel', pricing: plan.pricing, limits: plan.limits, trialDays: 30 });
    expect(input?.features['payments.online']).toBe(true);
    expect(input?.features['modules.tenders']).toBe(false);
  });
});
