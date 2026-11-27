import { BellRing } from 'lucide-react';
import { useId } from 'react';
import { Alert, Card, CardTitle, Skeleton } from '@/components/ui';
import { useNotificationPreferences, useSaveNotificationPreferences } from '@/hooks/useTeam';
import { errorMessage } from '@/lib/api/errors';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_META, categoryEnabled } from '@/lib/api/notificationPreferences';

/**
 * Hesabim - bildirim tercihleri (`/api/me/notification-preferences`): e-posta ana anahtari ve kategori
 * bazli e-posta (aidat / tahsilat, duyuru, ariza, ziyaretci / kurye, rezervasyon, anket). Tercih
 * kullanici genelidir (tum apartmanlar); her degisiklik YALNIZCA degisen alani gonderir, sunucu
 * digerlerine dokunmaz (iki cihaz / eski sekme birbirini ezmez). Yonetim paneli ve sakin portali ayni
 * karti kullanir. Erisilebilirlik: ad sarmalayan <label>'dan, aciklama `aria-describedby` ile.
 */
export function NotificationPreferencesCard() {
  const prefs = useNotificationPreferences();
  const save = useSaveNotificationPreferences();
  const id = useId();
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
              name="enabled"
              checked={emailEnabled}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ email: { enabled: e.target.checked } })}
              aria-describedby={`${id}-email-desc`}
            />
            <span>
              <span className="font-medium">E-posta bildirimleri</span>
              <span id={`${id}-email-desc`} className="block text-muted">
                Aşağıdaki konulardaki e-postaların tümü. Güvenlik ve davet e-postaları her zaman gönderilir.
              </span>
            </span>
          </label>
          <div role="group" aria-label="E-posta konuları" className={`flex flex-col gap-3 pl-6 ${emailEnabled ? '' : 'opacity-60'}`}>
            {NOTIFICATION_CATEGORIES.map((category) => {
              const meta = NOTIFICATION_CATEGORY_META[category];
              const descId = `${id}-${category}-desc`;
              return (
                <label key={category} className="flex items-start gap-3 text-small">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    name={category}
                    checked={emailEnabled && categoryEnabled(prefs.data, category)}
                    disabled={save.isPending || !emailEnabled}
                    onChange={(e) => save.mutate({ email: { [category]: e.target.checked } })}
                    aria-describedby={descId}
                  />
                  <span>
                    <span className="font-medium">{meta.label}</span>
                    <span id={descId} className="block text-muted">
                      {meta.description}
                    </span>
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
