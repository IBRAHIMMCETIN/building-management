import { BRAND_NAME } from '@bm/shared/brand';
import { StyleSheet, View } from 'react-native';
import { AppText, Badge } from '@/components/ui';
import { useActiveApartmentName } from '@/hooks/useContexts';
import { useServices } from '@/services';
import { space } from '@/theme/tokens';
import { BrandMark } from './Brand';

/** Ust cubuk basligi: logo + aktif sitenin adi (yuklenmemisse marka). Web: ResidentLayout PortalBrand. */
export function HeaderBrand() {
  const siteName = useActiveApartmentName();
  return (
    <View style={styles.row} accessible accessibilityRole="header" accessibilityLabel={siteName ? `${siteName}, ${BRAND_NAME}` : BRAND_NAME}>
      <BrandMark size={26} />
      <AppText weight="semibold" numberOfLines={1} style={styles.name}>
        {siteName ?? BRAND_NAME}
      </AppText>
    </View>
  );
}

/** Yerel gelistirme isareti: mock kimlik / demo veri (gercek hesap ve veri olmadigi acikca gorunur). */
export function DevModeBadge() {
  const { env } = useServices();
  if (env.apiMode === 'demo') return <Badge tone="warning" label="Demo verisi" />;
  if (env.authMode === 'mock') return <Badge tone="warning" label="Mock" />;
  return null;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space(2), maxWidth: 220 },
  name: { flexShrink: 1 },
});
