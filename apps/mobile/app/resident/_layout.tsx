import { Stack } from 'expo-router';
import { PortalUnitProvider } from '@/context/PortalUnitProvider';
import { headerOptions } from '@/navigation/options';
import { useTheme } from '@/theme/useTheme';

/** Sakin alani: sekmeler + ustune acilan ekranlar (duyuru ayrintisi, Hesabım, web'deki ozellikler). */
export default function ResidentLayout() {
  const { colors } = useTheme();
  return (
    <PortalUnitProvider>
      <Stack screenOptions={{ ...headerOptions(colors), contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="announcements/[id]" options={{ title: 'Duyuru' }} />
        <Stack.Screen name="account" options={{ title: 'Hesabım' }} />
        <Stack.Screen name="web/[feature]" options={{ title: '' }} />
      </Stack>
    </PortalUnitProvider>
  );
}
