import { useSyncExternalStore } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { BellRing } from '@/components/icons';
import { AppText, Button, Card } from '@/components/ui';
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
 * Giristen sonra bir kez: bildirim izninin uygulama ici aciklamasi. Sistem istemi yalnizca "Bildirimlere
 * izin ver" ile acilir (acilista hic istenmez); "Şimdi değil" bu kullaniciya yeniden sorulmaz, Hesabım >
 * Mobil bildirim'den acilabilir.
 */
export function PushPermissionPrompt() {
  const { push } = useServices();
  const { user } = useAuth();
  const { colors } = useTheme();
  const snap = useSyncExternalStore(push.subscribe, push.getSnapshot, push.getSnapshot);
  const visible = snap.promptVisible && !!user?.role;
  if (!visible) return null;

  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => void push.dismiss()} statusBarTranslucent>
      <View style={[styles.scrim, { backgroundColor: colors.scrim }]}>
        <Card style={styles.card} accessibilityViewIsModal>
          <View style={[styles.icon, { backgroundColor: colors.surfaceMuted }]}>
            <BellRing size={28} color={colors.accent} aria-hidden />
          </View>
          <AppText variant="heading" weight="semibold" accessibilityRole="header" style={styles.center}>
            Bildirimleri açın
          </AppText>
          <AppText variant="small" tone="secondary" style={styles.center}>
            {EXAMPLES[user?.role ?? ''] ?? 'Duyurular ve size ait işlerdeki gelişmeler telefonunuza bildirim olarak gelsin.'}
          </AppText>
          <AppText variant="small" tone="muted" style={styles.center}>
            Hangi konularda bildirim alacağınızı Hesabım’dan istediğiniz zaman değiştirebilirsiniz.
          </AppText>
          <Button label="Bildirimlere izin ver" icon={BellRing} block loading={snap.busy} onPress={() => void push.accept()} />
          <Button label="Şimdi değil" variant="ghost" align="center" onPress={() => void push.dismiss()} />
        </Card>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(4) },
  card: { width: '100%', maxWidth: 420, alignItems: 'stretch' },
  icon: { width: 56, height: 56, borderRadius: radii.full, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  center: { textAlign: 'center' },
});
