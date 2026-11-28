import { errorMessage } from '@bm/shared/api/errors';
import { ExternalLink, type LucideIcon } from '@/components/icons';
import { useState } from 'react';
import { View } from 'react-native';
import { Alert, AppText, Button } from '@/components/ui';
import { openInAppBrowser, webAppUrl } from '@/lib/openExternal';
import { useServices } from '@/services';
import { space } from '@/theme/tokens';

type Props = {
  path: string;
  label: string;
  icon?: LucideIcon;
  variant?: 'primary' | 'secondary';
  block?: boolean;
  align?: 'start' | 'center';
  /**
   * Uygulama ici tarayici kullanici kapatinca (yalnizca iOS bunu bildirir). Android / web'de tarayici
   * hemen doner; donus uygulamanin one gelmesiyle (AppState, ForegroundRefresh) yakalanir.
   */
  onClosed?: () => void;
};

/**
 * Web uygulamasindaki bir sayfayi uygulama ici tarayicida acar. Web adresi yapilandirilmamissa
 * (EXPO_PUBLIC_WEB_URL bos) dugme yerine aciklama gosterilir.
 */
export function WebLinkButton({ path, label, icon = ExternalLink, variant = 'primary', block, align, onClosed }: Props) {
  const { env } = useServices();
  const [error, setError] = useState<string | null>(null);
  const url = webAppUrl(env.webUrl, path);

  if (!url) {
    return (
      <AppText variant="small" tone="muted">
        Web uygulamasının adresi yapılandırılmadı (EXPO_PUBLIC_WEB_URL).
      </AppText>
    );
  }

  return (
    <View style={{ gap: space(2), alignSelf: align === 'center' ? 'center' : 'stretch' }}>
      <Button
        variant={variant}
        icon={icon}
        label={label}
        block={block}
        align={align}
        accessibilityRole="link"
        accessibilityHint="Uygulama içi tarayıcıda web uygulamasını açar"
        onPress={() => {
          setError(null);
          openInAppBrowser(url)
            .then((result) => {
              if (result === 'closed') onClosed?.();
            })
            .catch((err: unknown) => setError(errorMessage(err)));
        }}
      />
      {error && <Alert tone="danger">{error}</Alert>}
    </View>
  );
}
