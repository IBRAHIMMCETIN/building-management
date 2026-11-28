import { StyleSheet, View } from 'react-native';
import { WifiOff } from '@/components/icons';
import { AppText } from '@/components/ui/AppText';
import { useIsOnline } from '@/hooks/useNetwork';
import { radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

export const OFFLINE_BANNER_TEXT = 'Çevrimdışısınız. Son yüklenen bilgiler gösteriliyor; değişiklikler bağlantı gelince yapılabilir.';

/**
 * Cevrimdisi notu (Alert uyari gorunumu, wifi-off ikonu): her ekranin en ustunde (Screen ve kendi listesini
 * kaydiran ekranlar), cevrim iciyken hic yer kaplamaz. Ekran okuyucuya degisince okunur.
 */
export function OfflineBanner() {
  const online = useIsOnline();
  const { colors } = useTheme();
  if (online) return null;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.box, { backgroundColor: withAlpha(colors.warning, 0.1), borderColor: withAlpha(colors.warning, 0.3) }]}
    >
      <WifiOff size={18} color={colors.warning} aria-hidden style={styles.icon} />
      <AppText variant="small" style={[styles.text, { color: colors.warning }]}>
        {OFFLINE_BANNER_TEXT}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  // Alert ile ayni kutu.
  box: { flexDirection: 'row', gap: space(2), borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth * 2, paddingHorizontal: space(3), paddingVertical: space(2.5) },
  icon: { marginTop: 1 },
  text: { flex: 1 },
});
