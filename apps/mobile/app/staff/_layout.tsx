import { Stack } from 'expo-router';
import { headerOptions } from '@/navigation/options';
import { useTheme } from '@/theme/useTheme';

/** Bina gorevlisi: sekmeler (İşlerim, Hesabım). */
export default function StaffLayout() {
  const { colors } = useTheme();
  return (
    <Stack screenOptions={{ ...headerOptions(colors), contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}
