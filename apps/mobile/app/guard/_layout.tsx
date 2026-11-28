import { Stack } from 'expo-router';
import { headerOptions } from '@/navigation/options';
import { useTheme } from '@/theme/useTheme';

/**
 * Bildirim / derin baglantiyla dogrudan bir ust ekran acildiginda (ornek: /oylamalar) altinda
 * sekmeler olsun: Geri dugmesi ve iOS'ta geri kaydirma calisir, kullanici ekranda mahsur kalmaz.
 */
export const unstable_settings = { initialRouteName: '(tabs)' };

/** Guvenlik gorevlisi: sekmeler (Kapı, Hesabım) + ustune acilan elle kapi kaydi. */
export default function GuardLayout() {
  const { colors } = useTheme();
  return (
    <Stack screenOptions={{ ...headerOptions(colors), contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="manual-entry" options={{ title: 'Elle kapı kaydı' }} />
    </Stack>
  );
}
