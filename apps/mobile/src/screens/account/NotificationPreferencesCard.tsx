import { errorMessage } from '@bm/shared/api/errors';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_META,
  type NotificationChannel,
  categoryEnabled,
  channelEnabled,
} from '@bm/shared/api/notificationPreferences';
import type { ReactNode } from 'react';
import { BellRing } from '@/components/icons';
import { StyleSheet, View } from 'react-native';
import { Alert, AppText, Card, CardTitle, Skeleton, SwitchRow } from '@/components/ui';
import { useNotificationPreferences, useSaveNotificationPreferences } from '@/hooks/usePortal';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

const COPY: Record<NotificationChannel, { title: string; master: string; masterDescription: string; group: string; off: string }> = {
  email: {
    title: 'Bildirimler',
    master: 'E-posta bildirimleri',
    masterDescription: 'Aşağıdaki konulardaki e-postaların tümü. Güvenlik ve davet e-postaları her zaman gönderilir.',
    group: 'E-posta konuları',
    off: 'E-posta bildirimleri kapalıyken bu konularda e-posta gönderilmez.',
  },
  push: {
    title: 'Mobil bildirim',
    master: 'Mobil bildirimler',
    masterDescription: 'Bu uygulamanın kayıtlı olduğu telefonlara giden bildirimlerin tümü. E-posta tercihinden bağımsızdır.',
    group: 'Mobil bildirim konuları',
    off: 'Mobil bildirimler kapalıyken bu konularda telefona bildirim gönderilmez.',
  },
};

/**
 * Hesabım - bildirim tercihleri (web: pages/account/NotificationPreferencesCard.tsx). Kanal basina ana
 * anahtar ve web ile ayni kategoriler; her degisiklik YALNIZCA degisen alani gonderir (`{ email: {...} }`
 * veya `{ push: {...} }`; sunucu digerlerine dokunmaz). Tercih kullanici geneldir (tum apartmanlar).
 * Hesabım ikisini de gosterir; `children` kanalin cihaz durumu (push: bu telefonun izni / kaydi) icindir.
 */
export function NotificationPreferencesCard({ channel = 'email', children }: { channel?: NotificationChannel; children?: ReactNode }) {
  const prefs = useNotificationPreferences();
  const save = useSaveNotificationPreferences();
  const { colors } = useTheme();
  const copy = COPY[channel];
  const enabled = prefs.data ? channelEnabled(prefs.data, channel) : true;

  return (
    <Card>
      <CardTitle icon={<BellRing size={20} color={colors.muted} aria-hidden />}>{copy.title}</CardTitle>
      {children}
      {prefs.isPending && <Skeleton height={32} />}
      {prefs.isError && <Alert tone="danger">{errorMessage(prefs.error)}</Alert>}
      {prefs.data && (
        <>
          <SwitchRow
            label={copy.master}
            description={copy.masterDescription}
            value={enabled}
            disabled={save.isPending}
            onValueChange={(v) => save.mutate({ [channel]: { enabled: v } })}
          />
          <View accessibilityLabel={copy.group} style={[styles.group, { borderLeftColor: colors.border }]}>
            {NOTIFICATION_CATEGORIES.map((category) => {
              const meta = NOTIFICATION_CATEGORY_META[category];
              return (
                <SwitchRow
                  key={category}
                  label={meta.label}
                  accessibilityLabel={channel === 'push' ? `${meta.label}, mobil bildirim` : undefined}
                  description={meta.description}
                  value={enabled && categoryEnabled(prefs.data, category, channel)}
                  disabled={save.isPending || !enabled}
                  dimmed={!enabled}
                  onValueChange={(v) => save.mutate({ [channel]: { [category]: v } })}
                />
              );
            })}
            {!enabled && (
              <AppText variant="small" tone="muted">
                {copy.off}
              </AppText>
            )}
          </View>
        </>
      )}
      {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
      {save.isSuccess && (
        <AppText variant="small" tone="success" accessibilityLiveRegion="polite" accessibilityRole="text">
          Tercihiniz kaydedildi.
        </AppText>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  group: { gap: space(3), paddingLeft: space(3), borderLeftWidth: 2 },
});
