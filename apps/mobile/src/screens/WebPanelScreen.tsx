import { ROLE_LABELS } from '@bm/shared/roles';
import { useRouter } from 'expo-router';
import { ArrowLeftRight, LogOut, Monitor } from '@/components/icons';
import { StyleSheet, View } from 'react-native';
import { BrandMark } from '@/components/Brand';
import { WebLinkButton } from '@/components/WebLinkButton';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { useAuth } from '@/context/AuthProvider';
import { useActiveApartmentName, useContexts } from '@/hooks/useContexts';
import { radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/**
 * Yonetim rolleri (apartman yoneticisi, yonetim firmasi, denetci, platform yoneticisi): yonetim
 * paneli web'dedir. Uygulama ici tarayicida acma, baglam degistirme ve cikis.
 */
export function WebPanelScreen() {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const apartmentName = useActiveApartmentName();
  const contexts = useContexts();
  const { colors } = useTheme();
  const canSwitch = (contexts.data?.contexts.length ?? 0) > 1;

  return (
    <Screen edges="all">
      <View style={styles.brand}>
        <BrandMark size={48} />
      </View>
      <Card style={styles.card}>
        <View style={[styles.icon, { backgroundColor: colors.surfaceMuted }]}>
          <Monitor size={28} color={colors.accent} aria-hidden />
        </View>
        <AppText variant="heading" weight="semibold" accessibilityRole="header" style={styles.center}>
          Yönetim paneli web'de
        </AppText>
        <AppText variant="small" tone="muted" style={styles.center}>
          {`${user?.role ? ROLE_LABELS[user.role] : 'Bu rol'}${apartmentName ? ` · ${apartmentName}` : ''}`}
        </AppText>
        <AppText variant="small" tone="secondary" style={styles.center}>
          Mobil uygulama sakinler, bina görevlileri ve güvenlik içindir. Yönetim ekranlarını web uygulamasından kullanabilirsiniz.
        </AppText>
        <WebLinkButton path="/admin" label="Paneli web'de aç" align="center" />
        {canSwitch && <Button variant="secondary" icon={ArrowLeftRight} label="Apartman / rol değiştir" align="center" onPress={() => router.push('/select-context')} />}
        <Button variant="ghost" icon={LogOut} label="Çıkış yap" align="center" onPress={() => void signOut()} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  brand: { alignItems: 'center', paddingTop: space(6) },
  card: { alignItems: 'center', paddingVertical: space(8) },
  icon: { width: 56, height: 56, borderRadius: radii.full, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center' },
});
