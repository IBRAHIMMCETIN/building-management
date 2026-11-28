import type { LucideIcon } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { AppText } from './AppText';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'accent' | 'danger';

/** Web Badge: belirgin zemin + ince kenarlik; durum yalnizca renkle degil metinle de tasinir. */
export function Badge({ label, tone = 'neutral', icon: Icon }: { label: string; tone?: BadgeTone; icon?: LucideIcon }) {
  const { colors } = useTheme();
  const base = { neutral: colors.muted, success: colors.success, warning: colors.warning, accent: colors.accent, danger: colors.danger }[tone];
  const bg = tone === 'neutral' ? colors.surfaceMuted : withAlpha(base, 0.1);
  const border = tone === 'neutral' ? colors.borderStrong : withAlpha(base, 0.25);
  return (
    <View style={[styles.badge, { backgroundColor: bg, borderColor: border }]}>
      {Icon && <Icon size={14} color={base} aria-hidden />}
      <AppText variant="caption" weight="medium" style={{ color: base }}>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space(1),
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth * 2,
    paddingHorizontal: space(2),
    paddingVertical: 2,
  },
});
