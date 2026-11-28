import { Stack } from 'expo-router';
import { AuthFlowProvider } from '@/context/AuthFlowProvider';
import { useTheme } from '@/theme/useTheme';

/** Giris yigini: giris, sifremi unuttum, yeni sifre, MFA. Adimlar arasi durum AuthFlowProvider'da. */
export default function AuthLayout() {
  const { colors } = useTheme();
  return (
    <AuthFlowProvider>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="login" />
        <Stack.Screen name="forgot-password" />
        <Stack.Screen name="new-password" />
        <Stack.Screen name="mfa" />
      </Stack>
    </AuthFlowProvider>
  );
}
