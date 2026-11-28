import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Lock } from '@/components/icons';
import { Alert, AppText, Card, CardTitle, ChipGroup, SwitchRow } from '@/components/ui';
import { biometricName, useAppLock } from '@/hooks/useAppLock';
import { LOCK_TIMEOUT_OPTIONS } from '@/lib/lock/appLock';
import { useServices } from '@/services';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

const TIMEOUT_LABEL = (m: number) => `${m} dk`;

/**
 * Hesabım > Uygulama kilidi (lib/lock/appLock.ts): istege bagli, bu kullanici ve bu cihaz icin. Acarken
 * once sistem dogrulamasi istenir; cihazda kayitli yuz / parmak izi yoksa anahtar kapali kalir ve nedeni
 * yazilir. Kimlik bilgisi saklanmaz. Web onizlemesinde gosterilmez.
 */
export function AppLockCard() {
  const { lock } = useServices();
  const state = useAppLock();
  const { colors } = useTheme();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Ekran acilinca cihaz durumu tazelenir (ayarlardan yuz / parmak izi eklenmis ya da silinmis olabilir).
  useEffect(() => {
    void lock.refreshBiometric();
  }, [lock]);

  if (Platform.OS === 'web') return null;

  const bio = state.biometric;
  const usable = !!bio?.hardware && !!bio.enrolled;
  const name = biometricName(bio?.kind);
  const { enabled, timeoutMinutes } = state.settings;
  const hint = !bio
    ? null
    : bio.error
      ? 'Cihazın Face ID / parmak izi durumu şu an okunamadı. Biraz sonra tekrar deneyin.'
      : !bio.hardware
      ? 'Bu cihazda Face ID / parmak izi doğrulaması yok.'
      : !bio.enrolled
        ? 'Cihazda kayıtlı Face ID / parmak izi yok. Önce cihaz ayarlarından ekleyin.'
        : null;

  return (
    <Card>
      <CardTitle icon={<Lock size={20} color={colors.muted} aria-hidden />}>Uygulama kilidi</CardTitle>
      <SwitchRow
        label="Face ID / parmak izi ile kilit"
        description={`Uygulama açılırken ve arka planda bir süre kaldıktan sonra ${name} istenir; tanınmazsa cihaz şifresi kullanılır. Şifreniz bu telefonda saklanmaz.`}
        value={enabled}
        disabled={busy || state.authenticating || (!enabled && !usable)}
        onValueChange={(next) => {
          setMessage(null);
          setBusy(true);
          void lock
            .setEnabled(next)
            .then((r) => setMessage(r.ok ? null : r.message))
            .finally(() => setBusy(false));
        }}
      />
      {hint && !enabled && (
        <AppText variant="small" tone="muted">
          {hint}
        </AppText>
      )}
      {message && <Alert tone="warning">{message}</Alert>}
      {enabled && (
        <View style={styles.timeout}>
          <AppText variant="small" weight="medium">
            Arka planda kalınca kilitle
          </AppText>
          <ChipGroup
            label="Arka planda kalınca kilitle"
            value={String(timeoutMinutes)}
            options={LOCK_TIMEOUT_OPTIONS.map((m) => ({ value: String(m), label: TIMEOUT_LABEL(m) }))}
            onChange={(v) => void lock.setTimeoutMinutes(Number(v))}
          />
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  timeout: { gap: space(2) },
});
