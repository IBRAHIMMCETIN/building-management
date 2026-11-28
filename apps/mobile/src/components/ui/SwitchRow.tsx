import { StyleSheet, Switch, View } from 'react-native';
import { MIN_TOUCH, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { AppText } from './AppText';

type Props = {
  label: string;
  description?: string;
  value: boolean;
  disabled?: boolean;
  onValueChange: (value: boolean) => void;
  /** Ana anahtar kapaliyken alt secenekler soluk gorunur. */
  dimmed?: boolean;
};

/** Etiketli anahtar (web: checkbox + label + aciklama `aria-describedby`). */
export function SwitchRow({ label, description, value, disabled, onValueChange, dimmed }: Props) {
  const { colors } = useTheme();
  return (
    <View style={[styles.row, dimmed && styles.dimmed]}>
      <View style={styles.text}>
        <AppText variant="small" weight="medium">
          {label}
        </AppText>
        {description && (
          <AppText variant="small" tone="muted">
            {description}
          </AppText>
        )}
      </View>
      <Switch
        accessibilityLabel={label}
        accessibilityHint={description}
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ true: colors.accent, false: colors.borderStrong }}
        thumbColor={colors.surface}
        ios_backgroundColor={colors.borderStrong}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: MIN_TOUCH, flexDirection: 'row', alignItems: 'center', gap: space(3) },
  text: { flex: 1, gap: 2 },
  dimmed: { opacity: 0.6 },
});
