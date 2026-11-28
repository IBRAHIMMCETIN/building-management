import { useEffect, useState } from 'react';
import { AppState, Modal, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BrandMark } from '@/components/Brand';
import { FingerprintPattern, LogOut, ScanFace } from '@/components/icons';
import { Alert, AppText, Button } from '@/components/ui';
import { useAuth } from '@/context/AuthProvider';
import { biometricName, useAppLock } from '@/hooks/useAppLock';
import { MODAL_ORIENTATIONS } from '@/lib/orientation';
import { useServices } from '@/services';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/**
 * Uygulama kilidi ve gizlilik ortusu (lib/lock/appLock.ts). Kok yerlesimde gezinme yiginin USTUNDE tam
 * ekran pencere: yigin ve taslaklar korunur, kilit acilinca kullanici kaldigi yere doner. Kilit / ortu
 * acikken uygulamanin diger pencereleri (Sheet, daire secici) gizlenir (useModalsSuspended), boylece bu
 * pencere her zaman en ustte kalir. Kilitlenince sistem istemi bir kez kendiliginden acilir; sonraki
 * istemleri servis yalnizca gercek bir arka plan -> on plan gecisinde acar, vazgecilirse "Kilidi aç".
 * "Çıkış yap" oturumu kapatir. Android geri tusu kilidi gecmez.
 */
export function AppLockGate() {
  const { lock } = useServices();
  const state = useAppLock();

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => lock.onAppState(next));
    return () => sub.remove();
  }, [lock]);

  if (state.status === 'unlocked' && !state.covered) return null;
  return (
    <Modal visible animationType="none" statusBarTranslucent supportedOrientations={MODAL_ORIENTATIONS} onRequestClose={() => undefined}>
      {state.status === 'locked' ? <LockScreen /> : <PrivacyCover />}
    </Modal>
  );
}

/** Gizlilik ortusu: uygulama degistirici goruntusunde ve kilit kararindan once yalnizca logo. */
function PrivacyCover() {
  const { colors } = useTheme();
  return (
    <View accessible accessibilityLabel="YÖNESİST" style={[styles.cover, { backgroundColor: colors.bg }]}>
      <BrandMark size={72} />
    </View>
  );
}

function LockScreen() {
  const { lock } = useServices();
  const { user, signOut } = useAuth();
  const state = useAppLock();
  const { colors } = useTheme();
  const [signingOut, setSigningOut] = useState(false);
  const name = biometricName(state.biometric?.kind);
  const Icon = state.biometric?.kind === 'fingerprint' ? FingerprintPattern : ScanFace;

  // Kilitlenince bir kez (uygulama on plandaysa); vazgecilirse istem tekrar kendiliginden acilmaz.
  useEffect(() => {
    if (AppState.currentState === 'active') void lock.unlock();
  }, [lock]);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]} accessibilityViewIsModal>
      <View style={styles.content}>
        <BrandMark size={72} />
        <AppText variant="title" weight="bold" accessibilityRole="header" style={styles.center}>
          Uygulama kilitli
        </AppText>
        <AppText variant="small" tone="secondary" style={styles.center}>
          Devam etmek için {name} ile doğrulayın. Tanınmazsa cihaz şifrenizi kullanabilirsiniz.
        </AppText>
        {user?.email && (
          <AppText variant="small" tone="muted" style={styles.center}>
            {user.email}
          </AppText>
        )}
        {state.error && <Alert tone="danger">{state.error}</Alert>}
        <View style={styles.actions}>
          <Button label="Kilidi aç" icon={Icon} block loading={state.authenticating} onPress={() => void lock.unlock()} />
          <Button
            label="Çıkış yap"
            variant="secondary"
            icon={LogOut}
            block
            loading={signingOut}
            disabled={state.authenticating}
            onPress={() => {
              setSigningOut(true);
              void signOut().finally(() => setSigningOut(false));
            }}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  cover: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space(4), padding: space(6), width: '100%', maxWidth: 420, alignSelf: 'center' },
  center: { textAlign: 'center' },
  actions: { alignSelf: 'stretch', gap: space(3), marginTop: space(2) },
});
