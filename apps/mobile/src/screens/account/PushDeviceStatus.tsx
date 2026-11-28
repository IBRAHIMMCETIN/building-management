import { useEffect, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { BellRing, Settings } from '@/components/icons';
import { Alert, AppText, Button } from '@/components/ui';
import { useServices } from '@/services';
import { space } from '@/theme/tokens';

/**
 * Hesabım > Mobil bildirim: bu cihazin durumu. Tercihler hesap geneldir; burada telefonun izni ve
 * kaydi gosterilir: izin hic sorulmadiysa / "Şimdi değil" dendiyse izin dugmesi, kalici reddedildiyse
 * ayarlar baglantisi, web onizlemesi / EAS projesi yoksa kullanilamadigi.
 */
export function PushDeviceStatus() {
  const { push } = useServices();
  const snap = useSyncExternalStore(push.subscribe, push.getSnapshot, push.getSnapshot);

  // Ekran acilinca izin durumu tazelenir (ayarlardan acilmis / kapatilmis olabilir).
  useEffect(() => {
    void push.sync();
  }, [push]);

  if (snap.support === 'web') {
    return (
      <AppText variant="small" tone="muted">
        Mobil bildirimler yalnızca telefon uygulamasında alınır; bu web önizlemesinde kayıt yapılmaz.
      </AppText>
    );
  }
  if (snap.support === 'simulator' || snap.support === 'no_project') {
    return (
      <AppText variant="small" tone="muted">
        Bu derlemede mobil bildirim kaydı yapılamıyor (simülatör veya uygulama mağaza projesi henüz tanımlı değil). Tercihleriniz yine kaydedilir.
      </AppText>
    );
  }
  if (snap.permission === 'granted' && !snap.registered && snap.error) {
    // Kayit basarisiz / gunluk sinir: kendiliginden sonraki giriste veya 6 saat sonra yeniden denenir.
    return <Alert tone="warning">{snap.error}</Alert>;
  }
  if (snap.permission === 'granted') {
    return (
      <AppText variant="small" tone={snap.registered ? 'success' : 'muted'} accessibilityLiveRegion="polite">
        {snap.registered ? 'Bu telefon bildirim almak için kayıtlı.' : 'Bildirim izni verildi; telefon kaydediliyor.'}
      </AppText>
    );
  }
  if (snap.permission === 'denied' && !snap.canAskAgain) {
    return (
      <View style={{ gap: space(2) }}>
        <Alert tone="warning">Bu telefonda bildirim izni kapalı. Bildirim almak için telefonun Ayarlar &gt; YÖNESİST &gt; Bildirimler bölümünden açın.</Alert>
        <Button variant="secondary" icon={Settings} label="Ayarları aç" onPress={() => void push.openSettings()} />
      </View>
    );
  }
  if (snap.permission === 'unknown') return null;
  return (
    <View style={{ gap: space(2) }}>
      <AppText variant="small" tone="muted">
        Bu telefona bildirim gönderilebilmesi için izin gerekiyor.
      </AppText>
      <Button variant="secondary" icon={BellRing} label="Bildirimlere izin ver" loading={snap.busy} onPress={() => void push.accept()} />
      {snap.error && <Alert tone="danger">{snap.error}</Alert>}
    </View>
  );
}
