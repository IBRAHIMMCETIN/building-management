import { useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Info, TriangleAlert, X } from '@/components/icons';
import { AppText } from '@/components/ui';
import { useServices } from '@/services';
import { MIN_TOUCH, radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/** Uygulama geneli bilgi notu (lib/notices.ts): ustte, kapatilana kadar; ekran okuyucuya hemen okunur. */
export function NoticeBanner() {
  const { notices } = useServices();
  const notice = useSyncExternalStore(notices.subscribe, notices.get, notices.get);
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  if (!notice) return null;
  const color = notice.tone === 'warning' ? colors.warning : colors.accent;
  const Icon = notice.tone === 'warning' ? TriangleAlert : Info;

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + space(2) }]}>
      <View
        accessibilityRole="alert"
        accessibilityLiveRegion="assertive"
        style={[styles.banner, { backgroundColor: colors.surface, borderColor: withAlpha(color, 0.4) }]}
      >
        <Icon size={18} color={color} aria-hidden />
        <AppText variant="small" style={[styles.text, { color: colors.text }]}>
          {notice.message}
        </AppText>
        <Pressable accessibilityRole="button" accessibilityLabel="Bildirimi kapat" hitSlop={6} onPress={() => notices.dismiss()} style={styles.close}>
          <X size={18} color={colors.muted} aria-hidden />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: space(4), right: space(4), alignItems: 'center' },
  banner: {
    width: '100%',
    maxWidth: 560,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    paddingLeft: space(3),
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  text: { flex: 1, paddingVertical: space(2.5) },
  close: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
});
