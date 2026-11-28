import { StyleSheet, View, type ViewProps } from 'react-native';
import { radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { AppText } from './AppText';

/** Web Card: yuzey zemin, ince kenarlik, genis yaricap. */
export function Card({ style, ...props }: ViewProps) {
  const { colors } = useTheme();
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, style]} {...props} />;
}

/** Kart basligi (web: CardTitle, text-heading). */
export function CardTitle({ children, icon }: { children: string; icon?: React.ReactNode }) {
  return (
    <View style={styles.titleRow}>
      {icon}
      <AppText variant="heading" weight="semibold" accessibilityRole="header">
        {children}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    padding: space(4),
    gap: space(3),
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
});
