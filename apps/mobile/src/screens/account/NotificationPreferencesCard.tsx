import { errorMessage } from '@bm/shared/api/errors';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_META, categoryEnabled } from '@bm/shared/api/notificationPreferences';
import { BellRing } from '@/components/icons';
import { StyleSheet, View } from 'react-native';
import { Alert, AppText, Card, CardTitle, Skeleton, SwitchRow } from '@/components/ui';
import { useNotificationPreferences, useSaveNotificationPreferences } from '@/hooks/usePortal';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/**
 * Hesabım - e-posta bildirim tercihleri (web: pages/account/NotificationPreferencesCard.tsx). Ana anahtar
 * ve web ile ayni kategoriler; her degisiklik YALNIZCA degisen alani gonderir (sunucu digerlerine
 * dokunmaz: iki cihaz birbirinin secimini ezmez). Tercih kullanici geneldir (tum apartmanlar).
 */
export function NotificationPreferencesCard() {
  const prefs = useNotificationPreferences();
  const save = useSaveNotificationPreferences();
  const { colors } = useTheme();
  const emailEnabled = prefs.data?.email.enabled ?? true;

  return (
    <Card>
      <CardTitle icon={<BellRing size={20} color={colors.muted} aria-hidden />}>Bildirimler</CardTitle>
      {prefs.isPending && <Skeleton height={32} />}
      {prefs.isError && <Alert tone="danger">{errorMessage(prefs.error)}</Alert>}
      {prefs.data && (
        <>
          <SwitchRow
            label="E-posta bildirimleri"
            description="Aşağıdaki konulardaki e-postaların tümü. Güvenlik ve davet e-postaları her zaman gönderilir."
            value={emailEnabled}
            disabled={save.isPending}
            onValueChange={(v) => save.mutate({ email: { enabled: v } })}
          />
          <View accessibilityLabel="E-posta konuları" style={[styles.group, { borderLeftColor: colors.border }]}>
            {NOTIFICATION_CATEGORIES.map((category) => {
              const meta = NOTIFICATION_CATEGORY_META[category];
              return (
                <SwitchRow
                  key={category}
                  label={meta.label}
                  description={meta.description}
                  value={emailEnabled && categoryEnabled(prefs.data, category)}
                  disabled={save.isPending || !emailEnabled}
                  dimmed={!emailEnabled}
                  onValueChange={(v) => save.mutate({ email: { [category]: v } })}
                />
              );
            })}
            {!emailEnabled && (
              <AppText variant="small" tone="muted">
                E-posta bildirimleri kapalıyken bu konularda e-posta gönderilmez.
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
