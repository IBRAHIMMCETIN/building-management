import { Outlet } from 'react-router';
import { FeatureDisabledNotice } from '@/components/features/FeatureDisabledNotice';
import { useSiteFeatures } from '@/context/SiteFeaturesContext';
import type { FeatureKey } from '@/lib/features/catalog';

/**
 * Rota korumasi (Adim 1): ozellik sitede kapaliysa sayfa yerine kapali ozellik gorunumu.
 * Yalnizca arayuz; asil kontrol API'de (403 feature_disabled).
 */
export function RequireFeature({ feature, title }: { feature: FeatureKey; title?: string }) {
  const { isEnabled } = useSiteFeatures();
  if (!isEnabled(feature)) return <FeatureDisabledNotice feature={feature} {...(title ? { title } : {})} />;
  return <Outlet />;
}
