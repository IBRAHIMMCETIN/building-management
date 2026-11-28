import { ChevronRight, ExternalLink, type LucideIcon } from '@/components/icons';
import { Pressable, StyleSheet, View } from 'react-native';
import { MIN_TOUCH, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { AppText } from './AppText';

type Props = {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  onPress: () => void;
  /** Uygulama disina (web) gider: ok yerine dis baglanti simgesi. */
  external?: boolean;
  accessibilityHint?: string;
  /** Aktif secim (baglam / daire listeleri). */
  selected?: boolean;
  disabled?: boolean;
  trailing?: React.ReactNode;
};

/** Dokunulabilir liste satiri (web: menu ogesi / secim dugmesi). En az 44 pt yukseklik. */
export function ListRow({ title, subtitle, icon: Icon, onPress, external, accessibilityHint, selected, disabled, trailing }: Props) {
  const { colors } = useTheme();
  const Trailing = external ? ExternalLink : ChevronRight;
  return (
    <Pressable
      accessibilityRole={external ? 'link' : 'button'}
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { borderColor: selected ? colors.accent : colors.border, backgroundColor: pressed || selected ? colors.surfaceMuted : colors.surface },
      ]}
    >
      {Icon && <Icon size={20} color={selected ? colors.accent : colors.muted} aria-hidden />}
      <View style={styles.text}>
        <AppText variant="body" weight="medium">
          {title}
        </AppText>
        {subtitle && (
          <AppText variant="small" tone="muted">
            {subtitle}
          </AppText>
        )}
      </View>
      {trailing ?? <Trailing size={18} color={colors.muted} aria-hidden />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: MIN_TOUCH + 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  text: { flex: 1, gap: 2 },
});
