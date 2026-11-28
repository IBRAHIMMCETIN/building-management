import type { LucideIcon } from 'lucide-react-native';
import { ActivityIndicator, Pressable, type PressableProps, StyleSheet, View } from 'react-native';
import { MIN_TOUCH, radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { AppText } from './AppText';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  variant?: Variant;
  icon?: LucideIcon;
  loading?: boolean;
  /** Tam genislik (form butonlari). */
  block?: boolean;
  /** Satir ici dugmenin hizasi (ortalanmis kartlarda 'center'). */
  align?: 'start' | 'center';
};

/** Web Button karsiligi: birincil (dolu lacivert), ikincil (kenarlikli), sessiz, tehlike. En az 44 pt. */
export function Button({ label, variant = 'primary', icon: Icon, loading = false, block = false, align = 'start', disabled, accessibilityLabel, ...props }: ButtonProps) {
  const { colors } = useTheme();
  const inactive = disabled || loading;
  const look = {
    primary: { bg: colors.primary, pressed: colors.primaryHover, fg: colors.onPrimary, border: 'transparent' },
    secondary: { bg: colors.surface, pressed: colors.surfaceMuted, fg: colors.text, border: colors.borderStrong },
    ghost: { bg: 'transparent', pressed: colors.surfaceMuted, fg: colors.accent, border: 'transparent' },
    danger: { bg: colors.danger, pressed: colors.danger, fg: '#ffffff', border: 'transparent' },
  }[variant];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!inactive, busy: loading }}
      disabled={inactive}
      hitSlop={4}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: pressed ? look.pressed : look.bg, borderColor: look.border },
        block ? styles.block : align === 'center' ? styles.center : styles.inline,
        inactive && styles.inactive,
      ]}
      {...props}
    >
      <View style={styles.content}>
        {loading ? <ActivityIndicator size="small" color={look.fg} /> : Icon ? <Icon size={18} color={look.fg} aria-hidden /> : null}
        <AppText variant="small" weight="semibold" style={{ color: look.fg }}>
          {label}
        </AppText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TOUCH,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
    paddingHorizontal: space(4),
    justifyContent: 'center',
  },
  block: { alignSelf: 'stretch' },
  inline: { alignSelf: 'flex-start' },
  center: { alignSelf: 'center' },
  inactive: { opacity: 0.5 },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2) },
});
