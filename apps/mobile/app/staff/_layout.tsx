import { Stack } from 'expo-router';
import { headerOptions } from '@/navigation/options';
import { useTheme } from '@/theme/useTheme';

/** Bina gorevlisi: sekmeler (İşlerim, Sayaç okuma, Hesabım) + ustune acilan talep / bakim ayrintisi. */
export default function StaffLayout() {
  const { colors } = useTheme();
  return (
    <Stack screenOptions={{ ...headerOptions(colors), contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="ticket/[id]" options={{ title: 'Talep' }} />
      <Stack.Screen name="task/[id]" options={{ title: 'Bakım görevi' }} />
    </Stack>
  );
}
