import { ROLE_LABELS } from '@bm/shared/roles';
import { useRouter } from 'expo-router';
import { ArrowLeftRight, BellRing, LogOut, UserRound } from '@/components/icons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { AppText, Button, Card, CardTitle, Screen } from '@/components/ui';
import { useAuth } from '@/context/AuthProvider';
import { useFeature, useSiteFeatures } from '@/context/SiteFeaturesProvider';
import { useActiveApartmentName, useContexts } from '@/hooks/useContexts';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { AppLockCard } from './AppLockCard';
import { NotificationPreferencesCard } from './NotificationPreferencesCard';
import { PushDeviceStatus } from './PushDeviceStatus';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText variant="small" tone="muted">
        {label}
      </AppText>
      <AppText variant="small">{value}</AppText>
    </View>
  );
}

/**
 * Hesabım (web: pages/account/AccountPage.tsx): profil ve aktif baglam, baglam degistirme, e-posta
 * ve mobil bildirim tercihleri (bu telefonun izni / kaydi ile), cikis. Sakin, bina gorevlisi ve guvenlik ayni ekrani kullanir. Iki adimli
 * dogrulama kurulumu bu rollerde zorunlu olmadigindan mobilde yoktur (web Hesabım'da). Sakinde tercih kartlari
 * `resident.notificationPrefs` site ozelligine baglidir (sade modda yalnizca telefonun bildirim izni).
 */
export function AccountScreen({ showTitle = true }: { showTitle?: boolean }) {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const apartmentName = useActiveApartmentName();
  const contexts = useContexts();
  const { colors } = useTheme();
  const [signingOut, setSigningOut] = useState(false);
  const canSwitch = (contexts.data?.contexts.length ?? 0) > 1;
  // Adim 1: sakinde bildirim tercihleri site ozelligine bagli (kapaliyken API de 403 doner); diger roller etkilenmez.
  const residentPrefsOn = useFeature('resident.notificationPrefs');
  const featuresStatus = useSiteFeatures().status;
  const isResident = user?.role === 'resident';
  const showPrefs = !isResident || residentPrefsOn;
  // Sakinde ozellikler okunurken bildirim bolumu cizilmez (sade kart -> tercih kartlari sicramasi yok).
  const prefsPending = isResident && featuresStatus === 'loading';

  if (!user) return null;

  return (
    <Screen title={showTitle ? 'Hesabım' : undefined}>
      <Card>
        <CardTitle icon={<UserRound size={20} color={colors.muted} aria-hidden />}>Profil</CardTitle>
        <Field label="E-posta" value={user.email ?? '—'} />
        <Field label="Aktif rol" value={user.role ? ROLE_LABELS[user.role] : 'Bağlam seçilmedi'} />
        <Field label="Apartman" value={apartmentName ?? '—'} />
        <AppText variant="small" tone="muted">
          Ad ve e-posta değişikliği için apartman yönetiminize başvurun.
        </AppText>
        {canSwitch && <Button variant="secondary" icon={ArrowLeftRight} label="Apartman / rol değiştir" onPress={() => router.push('/select-context')} />}
      </Card>

      <AppLockCard />

      {prefsPending ? null : showPrefs ? (
        <>
          <NotificationPreferencesCard />
          <NotificationPreferencesCard channel="push">
            <PushDeviceStatus />
          </NotificationPreferencesCard>
        </>
      ) : (
        // Sade mod: tercih anahtarlari yok; yalnizca bu telefonun bildirim izni (izin ver / Ayarlar).
        <Card>
          <CardTitle icon={<BellRing size={20} color={colors.muted} aria-hidden />}>Bildirimler</CardTitle>
          <PushDeviceStatus />
        </Card>
      )}

      <Button
        variant="secondary"
        icon={LogOut}
        label="Çıkış yap"
        block
        loading={signingOut}
        onPress={() => {
          setSigningOut(true);
          void signOut().finally(() => setSigningOut(false));
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  field: { gap: 2 },
});
