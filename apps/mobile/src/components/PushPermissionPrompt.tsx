import { useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { BellRing } from '@/components/icons';
import { Sheet } from '@/components/portal/Sheet';
import { AppText, Button } from '@/components/ui';
import { useAuth } from '@/context/AuthProvider';
import { useServices } from '@/services';
import { radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/** Role gore ornekler: kullanici neye izin verdigini bilsin. */
const EXAMPLES: Record<string, string> = {
  resident: 'Aidat ve ödeme hatırlatmaları, duyurular, talebinizdeki gelişmeler ve kapıdaki kurye için onay isteği.',
  building_staff: 'Size atanan arıza ve bakım işleri, talep güncellemeleri ve günlük iş özeti.',
  security_guard: 'Kapıdan açtığınız arıza / talep kayıtlarındaki gelişmeler.',
};

/**
 * Giristen sonra bir kez: bildirim izninin uygulama ici aciklamasi (alttan acilan pencere, Sheet
 * deseni). Sistem istemi yalnizca "Bildirimlere izin ver" ile acilir (acilista hic istenmez); "Şimdi
 * değil" veya pencereyi kapatmak bu kullaniciya yeniden sorulmamasi demektir, Hesabım > Mobil
 * bildirim'den acilabilir.
 */
export function PushPermissionPrompt() {
  const { push } = useServices();
  const { user } = useAuth();
  const { colors } = useTheme();
  const snap = useSyncExternalStore(push.subscribe, push.getSnapshot, push.getSnapshot);
  const visible = snap.promptVisible && !!user?.role;

  return (
    <Sheet open={visible} title="Bildirimleri açın" onClose={() => void push.dismiss()}>
      <View style={[styles.icon, { backgroundColor: colors.surfaceMuted }]}>
        <BellRing size={28} color={colors.accent} aria-hidden />
      </View>
      <AppText variant="small" tone="secondary">
        {EXAMPLES[user?.role ?? ''] ?? 'Duyurular ve size ait işlerdeki gelişmeler telefonunuza bildirim olarak gelsin.'}
      </AppText>
      <AppText variant="small" tone="muted">
        Hangi konularda bildirim alacağınızı Hesabım’dan istediğiniz zaman değiştirebilirsiniz.
      </AppText>
      <Button label="Bildirimlere izin ver" icon={BellRing} block loading={snap.busy} onPress={() => void push.accept()} />
      <Button label="Şimdi değil" variant="ghost" align="center" onPress={() => void push.dismiss()} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  icon: { width: 56, height: 56, borderRadius: radii.full, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: space(1) },
});
