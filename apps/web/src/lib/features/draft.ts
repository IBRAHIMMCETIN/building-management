import type { SiteFeatureView, UpdateSiteFeaturesInput } from '@/lib/api/siteFeatures';
import { FEATURE_KEYS, type FeatureKey, type FeatureProfile } from './catalog';

/** Platform ekraninda bir anahtarin secimi: profil varsayilani veya acik/kapali override. */
export type FeatureChoice = 'default' | 'on' | 'off';

export type FeatureDraft = { profile: FeatureProfile; choices: Record<FeatureKey, FeatureChoice> };

export const REASON_MIN = 5;

export function draftFromView(view: Pick<SiteFeatureView, 'profile' | 'overrides'>): FeatureDraft {
  const choices = {} as Record<FeatureKey, FeatureChoice>;
  for (const k of FEATURE_KEYS) {
    const o = view.overrides[k];
    choices[k] = o === undefined ? 'default' : o ? 'on' : 'off';
  }
  return { profile: view.profile, choices };
}

/** Taslagin etkin degeri (onizleme): override yoksa secili profilin varsayilani. */
export function effectiveValue(draft: FeatureDraft, key: FeatureKey, defaults: Record<FeatureProfile, boolean>): boolean {
  const c = draft.choices[key];
  return c === 'default' ? defaults[draft.profile] : c === 'on';
}

/** Yalnizca degisen alanlari iceren PATCH govdesi; degisiklik yoksa null. */
export function buildFeaturePatch(view: SiteFeatureView, draft: FeatureDraft, reason: string): UpdateSiteFeaturesInput | null {
  const base = draftFromView(view);
  const features: NonNullable<UpdateSiteFeaturesInput['features']> = {};
  for (const k of FEATURE_KEYS) {
    if (draft.choices[k] === base.choices[k]) continue;
    features[k] = draft.choices[k] === 'default' ? null : draft.choices[k] === 'on';
  }
  const profileChanged = draft.profile !== view.profile;
  const hasFeatures = Object.keys(features).length > 0;
  if (!profileChanged && !hasFeatures) return null;
  return {
    version: view.version,
    reason: reason.trim(),
    ...(profileChanged ? { profile: draft.profile } : {}),
    ...(hasFeatures ? { features } : {}),
  };
}
