import { type FeatureKey, featureLabel } from '@bm/shared/features/catalog';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Lock } from '@/components/icons';
import { AppText, Button, Card, Screen, Spinner } from '@/components/ui';
import { useSiteFeatures } from '@/context/SiteFeaturesProvider';
import { moreItemForRoute } from '@/lib/nav';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/**
 * Kapali ozellik ekrani (web: components/features/FeatureDisabledNotice.tsx). Kapali bir ekrana
 * bildirim / derin baglantiyla gelindiginde gosterilir. Metin sade: sakin cogunlukla teknik degil.
 * Ozellikler yuklenirken yalnizca bekleme gostergesi (yanlis "kapalı" demez).
 */
export function FeatureDisabledNotice({ feature, title }: { feature: FeatureKey; title?: string }) {
  const { status, catalog, retry } = useSiteFeatures();
  const { colors } = useTheme();
  if (status === 'loading') return <Spinner label="Yükleniyor" />;
  return (
    <Card style={styles.card}>
      <View style={[styles.icon, { backgroundColor: colors.surfaceMuted }]}>
        <Lock size={24} color={colors.muted} aria-hidden />
      </View>
      <AppText variant="heading" weight="semibold" accessibilityRole="header" style={styles.center}>
        {title ?? featureLabel(feature, catalog)}
      </AppText>
      <AppText variant="small" tone="muted" style={styles.center}>
        {status === 'error' ? 'Bilgiler şu an yüklenemedi. Biraz sonra tekrar deneyin.' : 'Bu özellik sitenizde kapalı. Açılmasını isterseniz site yönetiminize söyleyebilirsiniz.'}
      </AppText>
      {status === 'error' && <Button variant="secondary" label="Tekrar dene" align="center" onPress={retry} />}
    </Card>
  );
}

/** Ekran duzeyinde kapi: ozellik aciksa ekran, degilse kapali ozellik notu (tam ekran). */
export function FeatureGate({ feature, title, children }: { feature: FeatureKey; title?: string; children: ReactNode }) {
  const { isEnabled } = useSiteFeatures();
  if (isEnabled(feature)) return children;
  return (
    <Screen>
      <FeatureDisabledNotice feature={feature} {...(title ? { title } : {})} />
    </Screen>
  );
}

/**
 * Sakin yigini (`app/resident/_layout.tsx` `screenLayout`): ekran bir "Diğer" ogesine bagliysa ve o ogenin
 * site ozelligi kapaliysa ekran yerine not. "Diğer" listesi ayni kuralla gizler (residentMoreFor); bu kapi
 * bildirim / derin baglantiyla dogrudan gelinen yolu kapatir.
 */
export function ResidentRouteGate({ routeName, params, children }: { routeName: string; params?: object; children: ReactNode }) {
  const item = moreItemForRoute(routeName, params);
  if (!item?.feature) return children;
  return (
    <FeatureGate feature={item.feature} title={item.label}>
      {children}
    </FeatureGate>
  );
}

const styles = StyleSheet.create({
  card: { alignItems: 'center', gap: space(3), paddingVertical: space(8) },
  icon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center' },
});
