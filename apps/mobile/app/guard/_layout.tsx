import { Stack } from 'expo-router';
import { headerOptions } from '@/navigation/options';
import { useTheme } from '@/theme/useTheme';

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
