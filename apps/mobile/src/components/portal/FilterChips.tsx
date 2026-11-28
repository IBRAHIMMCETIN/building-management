import { Pressable, StyleSheet, View } from 'react-native';
import { AppText } from '@/components/ui';
import { MIN_TOUCH, radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

type Option<T extends string> = { value: T; label: string; accessibilityLabel?: string };

type Props<T extends string> = {
  /** Grubun adi (ekran okuyucu): "Talep durumu". */
  label: string;
  value: T | undefined;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
};

/**
 * Tek secimli hap dugmeler (web: components/ui/FilterChips.tsx, aria-pressed). Gorunum degistirme
 * (Açık / Kapanan) ve kisa secenek listeleri (kategori, sure, daire). Secili oge vurgulu ve
 * `selected` durumunu bildirir; satira sigmayanlar alt satira gecer. Gorunen yukseklik 36 pt,
 * dokunma alani 44 pt.
 */
export function FilterChips<T extends string>({ label, value, options, onChange, disabled }: Props<T>) {
  const { colors } = useTheme();
  return (
    <View accessibilityLabel={label} style={styles.row}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            accessibilityLabel={o.accessibilityLabel ?? o.label}
            accessibilityState={{ selected, disabled: !!disabled }}
            disabled={disabled}
            hitSlop={{ top: 4, bottom: 4 }}
            onPress={() => onChange(o.value)}
            style={({ pressed }) => [
              styles.chip,
              {
                borderColor: selected ? withAlpha(colors.accent, 0.3) : colors.borderStrong,
                backgroundColor: selected ? withAlpha(colors.accent, 0.1) : pressed ? colors.surfaceMuted : colors.surface,
              },
              disabled && styles.disabled,
            ]}
          >
            <AppText variant="small" weight="medium" tone={selected ? 'accent' : 'secondary'}>
              {o.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  chip: {
    minHeight: MIN_TOUCH - 8,
    minWidth: MIN_TOUCH,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: space(3),
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  disabled: { opacity: 0.5 },
});
