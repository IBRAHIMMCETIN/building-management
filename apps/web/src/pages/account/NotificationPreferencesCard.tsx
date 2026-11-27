import { BellRing } from 'lucide-react';
import { Alert, Card, CardTitle, Skeleton } from '@/components/ui';
import { useNotificationPreferences, useSaveNotificationPreferences } from '@/hooks/useTeam';
import { errorMessage } from '@/lib/api/errors';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_META, categoryEnabled } from '@/lib/api/notificationPreferences';

/**
 * Hesabim - bildirim tercihleri (`/api/me/notification-preferences`): e-posta ana anahtari ve kategori
 * bazli e-posta (aidat / tahsilat, duyuru, ariza, ziyaretci / kurye, rezervasyon, anket). Tercih
 * kullanici genelidir (tum apartmanlar); her degisiklik yalnizca ilgili alani gonderir, sunucu
 * digerlerini korur. Yonetim paneli ve sakin portali ayni karti kullanir.
 */
export function NotificationPreferencesCard() {
  const prefs = useNotificationPreferences();
  const save = useSaveNotificationPreferences();
  const emailEnabled = prefs.data?.email.enabled ?? true;

  return (
    <Card className="flex flex-col gap-3">
      <CardTitle className="flex items-center gap-2">
        <BellRing className="size-5 text-muted" aria-hidden="true" />
        Bildirimler
      </CardTitle>
      {prefs.isPending && <Skeleton className="h-8" />}
      {prefs.isError && <Alert tone="danger">{errorMessage(prefs.error)}</Alert>}
      {prefs.data && (
        <>
          <label className="flex items-start gap-3 text-small">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={emailEnabled}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ email: { enabled: e.target.checked } })}
              aria-label="E-posta bildirimleri"
            />
            <span>
              <span className="font-medium">E-posta bildirimleri</span>
              <span className="block text-muted">Aşağıdaki konulardaki e-postaların tümü. Güvenlik ve davet e-postaları her zaman gönderilir.</span>
            </span>
          </label>
          <div role="group" aria-label="E-posta konuları" className={`flex flex-col gap-3 pl-6 ${emailEnabled ? '' : 'opacity-60'}`}>
            {NOTIFICATION_CATEGORIES.map((category) => {
              const meta = NOTIFICATION_CATEGORY_META[category];
              return (
                <label key={category} className="flex items-start gap-3 text-small">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={emailEnabled && categoryEnabled(prefs.data, category)}
                    disabled={save.isPending || !emailEnabled}
                    onChange={(e) => save.mutate({ email: { enabled: emailEnabled, [category]: e.target.checked } })}
                    aria-label={`${meta.label} e-postaları`}
                  />
                  <span>
                    <span className="font-medium">{meta.label}</span>
                    <span className="block text-muted">{meta.description}</span>
                  </span>
                </label>
              );
            })}
            {!emailEnabled && <p className="text-small text-muted">E-posta bildirimleri kapalıyken bu konularda e-posta gönderilmez.</p>}
          </div>
        </>
      )}
      {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
      {save.isSuccess && (
        <p role="status" className="text-small text-success">
          Tercihiniz kaydedildi.
        </p>
      )}
    </Card>
  );
}
