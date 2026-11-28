import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BrandMark } from '@/components/Brand';
import { NoticeBanner } from '@/components/NoticeBanner';
import { PushPermissionPrompt } from '@/components/PushPermissionPrompt';
import { AppText, Card, Screen } from '@/components/ui';
import { env, envResult } from '@/config/env';
import { AuthProvider, useAuth } from '@/context/AuthProvider';
import { useReactQueryAppState } from '@/hooks/useAppForeground';
import { createQueryClient } from '@/lib/api/queryClient';
import { areaForRole } from '@/lib/auth/flow';
import { applyOrientationPolicy } from '@/lib/orientation';
import { NotificationObserver } from '@/navigation/NotificationObserver';
import { headerOptions } from '@/navigation/options';
import { ServicesProvider, createServices } from '@/services';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/** Saklanan oturum geri yuklenirken (guvenli depodan okuma / token yenileme). */
function BootScreen() {
  const { colors } = useTheme();
  return (
    <View style={[styles.boot, { backgroundColor: colors.bg }]} accessible accessibilityLabel="Yükleniyor">
      <BrandMark size={72} />
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}

/** Hatali yapilandirma: uygulama acilmaz, eksik degisken acikca gosterilir (web: env.ts hatasi). */
function ConfigErrorScreen({ error }: { error: string }) {
  return (
    <SafeAreaProvider>
      <Screen edges="all">
        <Card>
          <AppText variant="heading" weight="semibold" accessibilityRole="header">
            Uygulama yapılandırması eksik
          </AppText>
          <AppText variant="small" tone="muted">
            EXPO_PUBLIC_* ortam değişkenlerini kontrol edin (apps/mobile/.env.example).
          </AppText>
          <AppText variant="small" tone="danger" selectable>
            {error}
          </AppText>
        </Card>
      </Screen>
    </SafeAreaProvider>
  );
}

/**
 * Korumali ekranlar: oturum / baglam / role gore yalnizca ilgili grup acik. Durum degisince (giris,
 * cikis, baglam degisimi, 401) Expo Router erisilemeyen ekranlari gecmisten siler ve ilk erisilebilir
 * ekrana (index -> role gore yonlendirme) gider.
 */
function RootStack() {
  const { user, isAuthenticated, needsContext } = useAuth();
  const { colors } = useTheme();
  const area = user?.role ? areaForRole(user.role) : null;

  return (
    <>
      {/* Bildirime dokunma / on planda gelen bildirim; giristen sonra izin aciklamasi; genel bilgi notu. */}
      <NotificationObserver />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, ...headerOptions(colors) }}>
        <Stack.Screen name="index" />
        <Stack.Protected guard={!isAuthenticated}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
        <Stack.Protected guard={area === 'resident'}>
          <Stack.Screen name="resident" />
        </Stack.Protected>
        <Stack.Protected guard={area === 'guard'}>
          <Stack.Screen name="guard" />
        </Stack.Protected>
        <Stack.Protected guard={area === 'staff'}>
          <Stack.Screen name="staff" />
        </Stack.Protected>
        <Stack.Protected guard={area === 'panel'}>
          <Stack.Screen name="panel" />
        </Stack.Protected>
        <Stack.Protected guard={isAuthenticated}>
          <Stack.Screen name="select-context" options={{ headerShown: !needsContext, title: 'Apartman / rol seçin' }} />
        </Stack.Protected>
      </Stack>
      <PushPermissionPrompt />
      <NoticeBanner />
    </>
  );
}

function App() {
  const [services] = useState(() => createServices(env));
  const [queryClient] = useState(createQueryClient);
  useReactQueryAppState();
  // Acilista: Android bildirim kanallari + on plan gosterim kurali (izin istemez) ve ekran yonu.
  useEffect(() => {
    void services.notifications.configure();
    void applyOrientationPolicy();
  }, [services]);
  const { scheme, colors } = useTheme();
  const navTheme = useMemo(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: { ...base.colors, primary: colors.accent, background: colors.bg, card: colors.surface, text: colors.text, border: colors.border, notification: colors.brandOrange },
    };
  }, [scheme, colors]);

  return (
    <SafeAreaProvider>
      <ServicesProvider services={services}>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider value={navTheme}>
            <AuthProvider fallback={<BootScreen />}>
              <RootStack />
            </AuthProvider>
            <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
          </ThemeProvider>
        </QueryClientProvider>
      </ServicesProvider>
    </SafeAreaProvider>
  );
}

export default function RootLayout() {
  if (!envResult.ok) return <ConfigErrorScreen error={envResult.error} />;
  return <App />;
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space(6) },
});
