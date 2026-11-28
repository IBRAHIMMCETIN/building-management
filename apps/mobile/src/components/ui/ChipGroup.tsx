import { Pressable, StyleSheet, View } from 'react-native';
import { MIN_TOUCH, radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { AppText } from './AppText';

/** `tone`: secili renginin anlami (kontrol listesinde Uygun = basari, Sorunlu = tehlike); varsayilan turkuaz. */
export type ChipOption<T extends string> = { value: T; label: string; count?: number; tone?: 'success' | 'danger' };

type Props<T extends string> = {
  /** Grubun ekran okuyucu adi (web FilterChips `label`). */
  label: string;
  value: T;
  options: readonly ChipOption<T>[];
  onChange: (value: T) => void;
  /** `large`: kapi islemleri gibi buyuk dokunma alanli bolum secimi (web `min-h-14`, ızgara). */
  size?: 'default' | 'large';
  /** Izgara sutun sayisi (yalnizca `large`). */
  columns?: number;
};

/**
 * Tek secimli secenekler (web: components/ui FilterChips ve kapi islem grubu). Secili oge kenarlik +
 * acik turkuaz zemin + metinle belli olur; ekran okuyucuya "secili" durumu verilir. Sayi rozeti uyari tonunda.
 */
export function ChipGroup<T extends string>({ label, value, options, onChange, size = 'default', columns }: Props<T>) {
  const { colors } = useTheme();
  const large = size === 'large';
  const basis = large && columns ? `${Math.floor(100 / columns) - 3}%` : undefined;
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.row}>
      {options.map((o) => {
        const selected = o.value === value;
        const tint = o.tone === 'success' ? colors.success : o.tone === 'danger' ? colors.danger : colors.accent;
        const a11y = o.count !== undefined ? `${o.label}, ${o.count}` : o.label;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityLabel={a11y}
            accessibilityState={{ checked: selected, selected }}
            onPress={() => onChange(o.value)}
            style={({ pressed }) => [
              large ? styles.large : styles.chip,
              basis ? { flexBasis: basis as `${number}%`, flexGrow: 1 } : null,
              {
                borderColor: selected ? withAlpha(tint, 0.4) : colors.borderStrong,
                backgroundColor: selected ? withAlpha(tint, 0.1) : pressed ? colors.surfaceMuted : colors.surface,
              },
            ]}
          >
            <AppText variant={large ? 'body' : 'small'} weight="medium" tone={selected ? (o.tone ?? 'accent') : 'secondary'} style={large ? styles.largeText : undefined}>
              {o.label}
            </AppText>
            {o.count !== undefined && o.count > 0 && (
              <View style={[styles.count, { backgroundColor: withAlpha(colors.warning, 0.15) }]}>
                <AppText variant="small" weight="semibold" tone="warning" tabular>
                  {String(o.count)}
                </AppText>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  chip: {
    minHeight: MIN_TOUCH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
    paddingHorizontal: space(3),
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  large: {
    minHeight: space(14),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space(2),
    paddingHorizontal: space(3),
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  /** Dar ekranda iki satira kayan etiket ortali kalir. */
  largeText: { flexShrink: 1, textAlign: 'center' },
  count: { borderRadius: radii.full, paddingHorizontal: space(2) },
});
