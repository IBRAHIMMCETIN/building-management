import { Pressable, StyleSheet, View } from 'react-native';
import { MIN_TOUCH, radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { AppText } from './AppText';

/**
 * `tone`: secili renginin anlami (kontrol listesinde Uygun = basari, Sorunlu = tehlike); varsayilan turkuaz.
 * `accessibilityLabel`: ekran okuyucu adi gorunen etiketten farkliysa (ornek: "10:00–11:00, 1 saat").
 */
export type ChipOption<T extends string> = { value: T; label: string; count?: number; tone?: 'success' | 'danger'; accessibilityLabel?: string };

type Props<T extends string> = {
  /** Grubun ekran okuyucu adi (web FilterChips `label`): "Talep durumu". */
  label: string;
  /** Secili deger; `undefined`: henuz secim yok. */
  value: T | undefined;
  options: readonly ChipOption<T>[];
  onChange: (value: T) => void;
  /**
   * `compact`: kisa secenek listeleri ve gorunum degistirme (Açık / Kapanan, kategori, sure, daire) - gorunen
   * 36 pt, dokunma alani 44 pt. `default`: 44 pt hap. `large`: kapi islemleri gibi buyuk dokunma alanli bolum
   * secimi (web `min-h-14`, izgara).
   */
  size?: 'compact' | 'default' | 'large';
  /** Izgara sutun sayisi (yalnizca `large`). */
  columns?: number;
  disabled?: boolean;
};

/**
 * Tek secimli secenekler (web: components/ui FilterChips ve kapi islem grubu); uygulamadaki tum hap /
 * bolum secimleri bu parcayla. Secili oge kenarlik + acik turkuaz (veya secenek tonu) zemin + metinle belli
 * olur; ekran okuyucuya radyo grubu ve "secili" durumu verilir. Satira sigmayanlar alt satira gecer. Sayi
 * rozeti uyari tonunda.
 */
export function ChipGroup<T extends string>({ label, value, options, onChange, size = 'default', columns, disabled = false }: Props<T>) {
  const { colors } = useTheme();
  const large = size === 'large';
  const compact = size === 'compact';
  const basis = large && columns ? `${Math.floor(100 / columns) - 3}%` : undefined;
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.row}>
      {options.map((o) => {
        const selected = o.value === value;
        const tint = o.tone === 'success' ? colors.success : o.tone === 'danger' ? colors.danger : colors.accent;
        const a11y = o.accessibilityLabel ?? (o.count !== undefined ? `${o.label}, ${o.count}` : o.label);
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityLabel={a11y}
            accessibilityState={{ checked: selected, selected, disabled }}
            disabled={disabled}
            hitSlop={compact ? { top: 4, bottom: 4 } : undefined}
            onPress={() => onChange(o.value)}
            style={({ pressed }) => [
              large ? styles.large : compact ? styles.compact : styles.chip,
              basis ? { flexBasis: basis as `${number}%`, flexGrow: 1 } : null,
              {
                borderColor: selected ? withAlpha(tint, 0.3) : colors.borderStrong,
                backgroundColor: selected ? withAlpha(tint, 0.1) : pressed ? colors.surfaceMuted : colors.surface,
              },
              disabled && styles.disabled,
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

const pill = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: space(1.5),
  paddingHorizontal: space(3),
  borderRadius: radii.full,
  borderWidth: StyleSheet.hairlineWidth * 2,
} as const;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  chip: { ...pill, minHeight: MIN_TOUCH },
  /** Gorunen 36 pt; dikey `hitSlop` ile dokunma alani 44 pt. */
  compact: { ...pill, minHeight: MIN_TOUCH - 8, minWidth: MIN_TOUCH, justifyContent: 'center' },
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
  disabled: { opacity: 0.5 },
});
