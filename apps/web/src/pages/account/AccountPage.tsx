import { useQuery } from '@tanstack/react-query';
import { BellRing, ShieldCheck, UserRound } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Alert, Badge, Button, Card, CardTitle, Skeleton } from '@/components/ui';
import { useActiveApartmentName } from '@/hooks/useActiveContextLabel';
import { useAuth } from '@/hooks/useAuth';
import { useNotificationPreferences, useSaveNotificationPreferences } from '@/hooks/useTeam';
import { errorMessage } from '@/lib/api/errors';
import { ticketEmailsEnabled } from '@/lib/api/notificationPreferences';
import { type MfaStatus, fetchMfaStatus } from '@/lib/api/mfa';
import { MFA_SETUP_PATH } from '@/lib/auth/mfa';
import { formatDateTime } from '@/lib/dates';
import { ROLE_LABELS } from '@/types/roles';

const MFA_STATUS_META: Record<MfaStatus['status'], { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  enabled: { label: 'Açık', tone: 'success' },
  not_required: { label: 'Kapalı (isteğe bağlı)', tone: 'neutral' },
  grace: { label: 'Kurulum bekleniyor', tone: 'warning' },
  required: { label: 'Kurulum zorunlu', tone: 'danger' },
};

/**
 * Faz 1 - Hesabim: profil ve aktif baglam, e-posta bildirim tercihi
 * (`/api/me/notification-preferences`) ve iki adimli dogrulama durumu (`/api/me/mfa`).
 * Yonetim paneli (/admin/account) ve sakin portali (/app/account) ayni ekrani kullanir.
 */
export function AccountPage() {
  const { user } = useAuth();
  const apartmentName = useActiveApartmentName();
  const navigate = useNavigate();
  const prefs = useNotificationPreferences();
  const save = useSaveNotificationPreferences();
  const mfa = useQuery({ queryKey: ['me', 'mfa', user?.sub], queryFn: ({ signal }) => fetchMfaStatus(signal), enabled: !!user });

  if (!user) return null;
  const emailEnabled = prefs.data?.email.enabled ?? true;
  const mfaMeta = mfa.data ? MFA_STATUS_META[mfa.data.status] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <h1 className="text-title font-bold">Hesabım</h1>

      <Card className="flex flex-col gap-3">
        <CardTitle className="flex items-center gap-2">
          <UserRound className="size-5 text-muted" aria-hidden="true" />
          Profil
        </CardTitle>
        <dl className="grid gap-2 text-small sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted">E-posta</dt>
          <dd>{user.email ?? '—'}</dd>
          <dt className="text-muted">Aktif rol</dt>
          <dd>{user.role ? ROLE_LABELS[user.role] : 'Bağlam seçilmedi'}</dd>
          <dt className="text-muted">Apartman</dt>
          <dd>{apartmentName ?? '—'}</dd>
        </dl>
        <p className="text-small text-muted">Ad ve e-posta değişikliği için apartman yönetiminize başvurun. Başka bir apartman/rol için üst menüdeki bağlam seçiciyi kullanın.</p>
      </Card>

      <Card className="flex flex-col gap-3">
        <CardTitle className="flex items-center gap-2">
          <BellRing className="size-5 text-muted" aria-hidden="true" />
          Bildirimler
        </CardTitle>
        {prefs.isPending && <Skeleton className="h-8" />}
        {prefs.isError && <Alert tone="danger">{errorMessage(prefs.error)}</Alert>}
        {prefs.data && (
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
              <span className="block text-muted">Tahakkuk, tahsilat makbuzu, hatırlatma ve duyuru e-postaları. Güvenlik ve davet e-postaları her zaman gönderilir.</span>
            </span>
          </label>
        )}
        {prefs.data && (
          <label className={`flex items-start gap-3 pl-6 text-small ${emailEnabled ? '' : 'opacity-60'}`}>
            <input
              type="checkbox"
              className="mt-0.5"
              checked={emailEnabled && ticketEmailsEnabled(prefs.data)}
              disabled={save.isPending || !emailEnabled}
              onChange={(e) => save.mutate({ email: { enabled: emailEnabled, tickets: e.target.checked } })}
              aria-label="Arıza e-postaları"
            />
            <span>
              <span className="font-medium">Arıza e-postaları</span>
              <span className="block text-muted">Arıza / talep açılması, atanması, çözülmesi ve yorum bildirimleri ile günlük operasyon özeti.{!emailEnabled && ' E-posta bildirimleri kapalıyken gönderilmez.'}</span>
            </span>
          </label>
        )}
        {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
        {save.isSuccess && (
          <p role="status" className="text-small text-success">
            Tercihiniz kaydedildi.
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-3">
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-muted" aria-hidden="true" />
          İki adımlı doğrulama
        </CardTitle>
        {mfa.isPending && <Skeleton className="h-8" />}
        {mfa.isError && <Alert tone="danger">{errorMessage(mfa.error)}</Alert>}
        {mfa.data && mfaMeta && (
          <>
            <p className="flex flex-wrap items-center gap-2 text-small">
              Durum: <Badge tone={mfaMeta.tone}>{mfaMeta.label}</Badge>
              {mfa.data.roleRequiresMfa && <span className="text-muted">Bu rolde zorunludur.</span>}
            </p>
            {mfa.data.status === 'grace' && mfa.data.graceUntil && (
              <p className="text-small text-warning">Son kurulum tarihi: {formatDateTime(mfa.data.graceUntil)}</p>
            )}
            {!mfa.data.enabled && (
              <div>
                <Button size="sm" onClick={() => navigate(MFA_SETUP_PATH)}>
                  <ShieldCheck className="size-4" aria-hidden="true" />
                  Doğrulayıcı uygulamayı kur
                </Button>
              </div>
            )}
            {mfa.data.enabled && (
              <p className="text-small text-muted">Telefonunuzu kaybederseniz apartman yöneticiniz veya platform ekibi doğrulamanızı sıfırlayabilir.</p>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
