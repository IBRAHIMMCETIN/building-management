import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ChevronRight } from '@/components/icons';
import { radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

type Props = {
  /** Ekran okuyucunun okudugu tam ozet (baslik, tarih, durum). */
  accessibilityLabel: string;
  accessibilityHint: string;
  onPress: () => void;
  children: ReactNode;
};

/**
 * Ayrintiya giden liste karti (Duyurular listesindeki kartla ayni gorunum: yuzey, ince kenarlik,
 * genis yaricap, sagda ok). Icerik ekranlara ozgu; tum kart tek dugmedir.
 */
export function RowLink({ accessibilityLabel, accessibilityHint, onPress, children }: Props) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [styles.card, { backgroundColor: pressed ? colors.surfaceMuted : colors.surface, borderColor: colors.border }]}
    >
      <View style={styles.text}>{children}</View>
      <ChevronRight size={18} color={colors.muted} aria-hidden />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: space(3), borderRadius: radii.xl, borderWidth: StyleSheet.hairlineWidth * 2, padding: space(4) },
  text: { flex: 1, gap: space(1) },
});
