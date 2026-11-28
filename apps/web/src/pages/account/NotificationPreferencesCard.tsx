import { BellRing } from 'lucide-react';
import { useId } from 'react';
import { Alert, Card, CardTitle, Skeleton } from '@/components/ui';
import { useMyDevices, useNotificationPreferences, useSaveNotificationPreferences } from '@/hooks/useTeam';
import { errorMessage } from '@/lib/api/errors';
import { BRAND_NAME } from '@/lib/brand';
import {
  type ChannelPreferencesInput,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_META,
  type NotificationPreferences,
  categoryEnabled,
  channelEnabled,
} from '@/lib/api/notificationPreferences';

/**
 * Hesabim - bildirim tercihleri (`/api/me/notification-preferences`): e-posta ana anahtari ve kategori
 * bazli e-posta (aidat / tahsilat, duyuru, ariza, ziyaretci / kurye, rezervasyon, anket, genel kurul). Tercih
 * kullanici genelidir (tum apartmanlar); her degisiklik YALNIZCA degisen alani gonderir, sunucu
 * digerlerine dokunmaz (iki cihaz / eski sekme birbirini ezmez). Yonetim paneli ve sakin portali ayni
 * karti kullanir. Erisilebilirlik: ad sarmalayan <label>'dan, aciklama `aria-describedby` ile.
 *
 * Mobil bildirim (push): kullanicinin en az bir aktif telefonu varsa (`GET /api/me/devices`) e-posta
 * bolumunun altinda ayni yapida ana anahtar + kategoriler (yalnizca `push` alani gider); yoksa mobil
 * uygulamanin actigini soyleyen kisa not. Mobil uygulamanin Hesabım > Mobil bildirim karti ile ayni metinler.
 */
export function NotificationPreferencesCard() {
  const prefs = useNotificationPreferences();
  const save = useSaveNotificationPreferences();
  // Mobil bildirim bolumu yalnizca kayitli (aktif) bir telefon varsa; yukleniyor / hata: bolum yok, e-posta etkilenmez.
  const devices = useMyDevices();
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
          {devices.data &&
            (devices.data.devices.length > 0 ? (
              <PushSection id={id} prefs={prefs.data} saving={save.isPending} onChange={(push) => save.mutate({ push })} />
            ) : (
              <p className="text-small text-muted">
                Mobil bildirimler, {BRAND_NAME} mobil uygulamasında giriş yapıp bildirimlere izin verdiğinizde açılır; konularını sonra buradan da seçebilirsiniz.
              </p>
            ))}
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

/**
 * Mobil bildirim bolumu: e-posta bolumuyle ayni yapi (ana anahtar + aciklama, girintili konu grubu, kapaliyken
 * not). Konu kutularinin ekran okuyucu adi "<konu>, mobil bildirim": ayni konular e-posta bolumunde de var.
 */
function PushSection({ id, prefs, saving, onChange }: { id: string; prefs: NotificationPreferences; saving: boolean; onChange: (push: ChannelPreferencesInput) => void }) {
  const pushEnabled = channelEnabled(prefs, 'push');
  return (
    <>
      <label className="flex items-start gap-3 text-small">
        <input
          type="checkbox"
          className="mt-0.5"
          name="push.enabled"
          checked={pushEnabled}
          disabled={saving}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          aria-describedby={`${id}-push-desc`}
        />
        <span>
          <span className="font-medium">Mobil bildirimler</span>
          <span id={`${id}-push-desc`} className="block text-muted">
            Mobil uygulamanın kayıtlı olduğu telefonlara giden bildirimlerin tümü. E-posta tercihinden bağımsızdır.
          </span>
        </span>
      </label>
      <div role="group" aria-label="Mobil bildirim konuları" className={`flex flex-col gap-3 pl-6 ${pushEnabled ? '' : 'opacity-60'}`}>
        {NOTIFICATION_CATEGORIES.map((category) => {
          const meta = NOTIFICATION_CATEGORY_META[category];
          const descId = `${id}-push-${category}-desc`;
          return (
            <label key={category} className="flex items-start gap-3 text-small">
              <input
                type="checkbox"
                className="mt-0.5"
                name={`push.${category}`}
                checked={pushEnabled && categoryEnabled(prefs, category, 'push')}
                disabled={saving || !pushEnabled}
                onChange={(e) => onChange({ [category]: e.target.checked })}
                aria-label={`${meta.label}, mobil bildirim`}
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
        {!pushEnabled && <p className="text-small text-muted">Mobil bildirimler kapalıyken bu konularda telefona bildirim gönderilmez.</p>}
      </div>
    </>
  );
}
