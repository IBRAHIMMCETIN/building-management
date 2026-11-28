import { describe, expect, it } from 'vitest';
import type { SiteFeatureView } from '@/lib/api/siteFeatures';
import { FEATURE_KEYS, uniformFeatures } from './catalog';
import { buildFeaturePatch, draftFromView, effectiveValue } from './draft';

const view = (over: Partial<SiteFeatureView> = {}): SiteFeatureView => ({
  apartmentId: 'apt-1',
  version: 7,
  profile: 'simple',
  inherited: false,
  overrides: { 'payments.online': true },
  features: { ...uniformFeatures(false), 'payments.online': true },
  catalog: [],
  ...over,
});

describe('platform ozellik taslagi', () => {
  it('override yoksa varsayilan secimi; varsa acik/kapali', () => {
    const d = draftFromView(view());
    expect(d.choices['payments.online']).toBe('on');
    expect(d.choices['admin.debtRestructure']).toBe('default');
    expect(Object.keys(d.choices)).toHaveLength(FEATURE_KEYS.length);
    expect(effectiveValue(d, 'admin.debtRestructure', { legacy: true, simple: false })).toBe(false);
    expect(effectiveValue({ ...d, profile: 'legacy' }, 'admin.debtRestructure', { legacy: true, simple: false })).toBe(true);
  });

  it('yalnizca degisen alanlar gonderilir; varsayilana donus null', () => {
    const v = view();
    const d = draftFromView(v);
    expect(buildFeaturePatch(v, d, 'x')).toBeNull();
    const patch = buildFeaturePatch(v, { ...d, choices: { ...d.choices, 'payments.online': 'default', 'admin.debtRestructure': 'on' } }, '  Pilot talebi ');
    expect(patch).toEqual({ version: 7, reason: 'Pilot talebi', features: { 'payments.online': null, 'admin.debtRestructure': true } });
    expect(buildFeaturePatch(v, { ...d, profile: 'legacy' }, 'Tam moda geç')).toEqual({ version: 7, reason: 'Tam moda geç', profile: 'legacy' });
  });
});
