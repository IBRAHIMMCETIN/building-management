import { StyleSheet, View } from 'react-native';
import { AppText } from '@/components/ui';
import { radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/**
 * Etiket + deger kutusu (Borçlarım ozetindeki kutuyla ayni gorunum): soluk zemin, kucuk soluk etiket,
 * kalin tablo rakamli deger; ekran okuyucu "etiket: deger" okur. Satirda yan yana ikiser dizilir.
 */
export function StatTile({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.stat, { backgroundColor: colors.surfaceMuted }]} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText variant="small" tone="muted">
        {label}
      </AppText>
      <AppText weight="semibold" tabular>
        {value}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  stat: { flexGrow: 1, flexBasis: '45%', borderRadius: radii.md, padding: space(3), gap: 2 },
});
