import { ENTRY_MODE_TEXT, type MyPass, formatShortCode, passLink, passShareText, validityText } from '@bm/shared/api/portalGate';
import { useState } from 'react';
import { Platform, Share, StyleSheet, View } from 'react-native';
import { QrCode } from '@/components/gate/QrCode';
import { Share2 } from '@/components/icons';
import { Sheet } from '@/components/portal/Sheet';
import { Alert, AppText, Button } from '@/components/ui';
import { useServices } from '@/services';
import { space } from '@/theme/tokens';

/**
 * Gecisin QR'i ve kisa kodu (web: pages/resident/gate/PassShareDialog.tsx). Misafire sistem paylasim
 * sayfasiyla metin + baglanti gonderilir (baglanti yalnizca rastgele jetonu tasir; web'deki
 * /gecis/<jeton> sayfasi QR'i tarayicida cizer). QR'da kisisel veri yoktur. Jeton saklanmaz: bu
 * pencere yalnizca olusturma / "Yeni QR oluştur" yanitiyla acilir.
 */
export function PassShareSheet({ pass, onClose }: { pass: MyPass | undefined; onClose: () => void }) {
  const { env } = useServices();
  const [shareError, setShareError] = useState<string>();
  const link = pass?.token && env.webUrl ? passLink(env.webUrl, pass.token, pass.shortCode) : undefined;
  const code = pass?.shortCode ? formatShortCode(pass.shortCode) : undefined;
  // QR web baglantisini (yoksa ham jetonu) tasir; gorevlinin okuyucusu ikisini de tanir.
  const qrValue = link ?? pass?.token;

  const share = async () => {
    if (!pass || !code) return;
    setShareError(undefined);
    const text = passShareText(code, pass.validFrom, pass.validUntil);
    try {
      await Share.share(Platform.OS === 'ios' && link ? { message: text, url: link } : { message: link ? `${text}\n${link}` : text, title: 'Misafir geçişi' });
    } catch {
      setShareError('Paylaşılamadı; kısa kodu misafirinize kendiniz iletin.');
    }
  };
  const close = () => {
    setShareError(undefined);
    onClose();
  };

  return (
    <Sheet open={!!pass} title="Misafir geçişi" onClose={close}>
      {pass && (
        <View style={styles.body}>
          <AppText variant="small" tone="secondary" style={styles.center}>
            <AppText variant="small" weight="semibold">
              {pass.guestName}
            </AppText>
            {` · ${pass.unitLabel}\n${validityText(pass.validFrom, pass.validUntil)} · ${ENTRY_MODE_TEXT[pass.entryMode]}`}
          </AppText>
          {qrValue && code ? (
            <>
              <QrCode value={qrValue} />
              <View style={styles.code}>
                <AppText variant="small" tone="muted">
                  Kısa kod
                </AppText>
                <AppText variant="title" weight="bold" selectable accessibilityLabel={`Kısa kod ${code.split('').join(' ')}`} style={styles.mono}>
                  {code}
                </AppText>
              </View>
              <Button icon={Share2} label="Misafirle paylaş" block onPress={() => void share()} />
              {shareError && <Alert tone="danger">{shareError}</Alert>}
              <AppText variant="caption" tone="muted" style={styles.center}>
                Bu QR ve kod yalnızca şimdi gösterilir; güvenlik nedeniyle saklanmaz. Kaybederseniz listeden "Yeni QR oluştur"a dokunun (eskisi çalışmaz). Bağlantıyı yalnızca misafirinizle paylaşın.
              </AppText>
            </>
          ) : (
            <Alert>Bu geçişin QR'ı yeniden gösterilemez. Gerekirse listeden "Yeni QR oluştur"a dokunun.</Alert>
          )}
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { alignItems: 'stretch', gap: space(4) },
  center: { textAlign: 'center' },
  code: { alignItems: 'center', gap: space(1) },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), letterSpacing: 4 },
});
