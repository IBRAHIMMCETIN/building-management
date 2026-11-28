import { CircleAlert, CircleCheck, Info, TriangleAlert } from '@/components/icons';
import { StyleSheet, View } from 'react-native';
import { radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { AppText } from './AppText';

type Tone = 'info' | 'success' | 'warning' | 'danger';

/** Web Alert: hata/bilgi kutusu. Ekran okuyucuya aninda okunur (role alert / canli bolge). */
export function Alert({ children, tone = 'info' }: { children: string; tone?: Tone }) {
  const { colors } = useTheme();
  const color = { info: colors.accent, success: colors.success, warning: colors.warning, danger: colors.danger }[tone];
  const Icon = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert }[tone];
  return (
    <View
      accessibilityRole={tone === 'danger' ? 'alert' : 'text'}
      accessibilityLiveRegion={tone === 'danger' ? 'assertive' : 'polite'}
      style={[styles.box, { backgroundColor: withAlpha(color, 0.1), borderColor: withAlpha(color, 0.3) }]}
    >
      <Icon size={18} color={color} aria-hidden style={styles.icon} />
      <AppText variant="small" style={[styles.text, { color }]}>
        {children}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    gap: space(2),
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
    paddingHorizontal: space(3),
    paddingVertical: space(2.5),
  },
  icon: { marginTop: 1 },
  text: { flex: 1 },
});
