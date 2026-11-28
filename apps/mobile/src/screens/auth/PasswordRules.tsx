import { PASSWORD_RULES } from '@bm/shared/auth/forms';
import { Check, Circle } from '@/components/icons';
import { StyleSheet, View } from 'react-native';
import { AppText } from '@/components/ui';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/** Yeni sifre yazilirken Cognito parola kurallarini canli gosterir (web: pages/auth/PasswordRules.tsx). */
export function PasswordRules({ value }: { value: string }) {
  const { colors } = useTheme();
  return (
    <View accessibilityLabel="Şifre kuralları" style={styles.list}>
      {PASSWORD_RULES.map((rule) => {
        const ok = rule.test(value);
        const Icon = ok ? Check : Circle;
        return (
          <View key={rule.label} style={styles.row} accessible accessibilityLabel={`${rule.label}${ok ? ' (sağlandı)' : ' (eksik)'}`}>
            <Icon size={14} color={ok ? colors.success : colors.muted} aria-hidden />
            <AppText variant="small" tone={ok ? 'success' : 'muted'}>
              {rule.label}
            </AppText>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space(1) },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
});
