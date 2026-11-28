import { Stack } from 'expo-router';
import { PortalUnitProvider } from '@/context/PortalUnitProvider';
import { PortalForegroundRefresh } from '@/hooks/useAppForeground';
import { headerOptions } from '@/navigation/options';
import { useTheme } from '@/theme/useTheme';

/**
 * Sakin alani: sekmeler + ustune acilan ekranlar (duyuru ve talep ayrintisi, yeni talep, Ziyaretçi,
 * Rezervasyon, Hesabım, web'deki ozellikler).
 */
export default function ResidentLayout() {
  const { colors } = useTheme();
  return (
    <PortalUnitProvider>
      <PortalForegroundRefresh />
      <Stack screenOptions={{ ...headerOptions(colors), contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="announcements/[id]" options={{ title: 'Duyuru' }} />
        <Stack.Screen name="tickets/[id]" options={{ title: 'Talep' }} />
        <Stack.Screen name="tickets/new" options={{ title: 'Yeni talep' }} />
        <Stack.Screen name="gate" options={{ title: 'Ziyaretçi' }} />
        <Stack.Screen name="reservations/index" options={{ title: 'Rezervasyon' }} />
        <Stack.Screen name="reservations/[facilityId]" options={{ title: 'Rezervasyon' }} />
        <Stack.Screen name="account" options={{ title: 'Hesabım' }} />
        <Stack.Screen name="web/[feature]" options={{ title: '' }} />
      </Stack>
    </PortalUnitProvider>
  );
}
