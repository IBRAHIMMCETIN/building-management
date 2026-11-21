import { ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Dialog, FormField, Spinner, Textarea } from '@/components/ui';
import { useMfaUser, useResetMfa } from '@/hooks/useSecurity';
import { errorMessage } from '@/lib/api/errors';
import type { MfaUser } from '@/lib/api/mfa';

export const MFA_RESET_REASON_MIN = 10;

/** Cognito hesap durumu -> Turkce. */
export function accountStatusLabel(user: Pick<MfaUser, 'accountEnabled' | 'status'>): string {
  if (!user.accountEnabled) return 'Hesap devre dışı';
  if (user.status === 'FORCE_CHANGE_PASSWORD') return 'Davet edildi, ilk giriş yapılmadı';
  if (user.status === 'RESET_REQUIRED') return 'Şifre sıfırlama bekliyor';
  return 'Aktif';
}

export function MfaStatusBadges({ user }: { user: MfaUser }) {
  return (
    <div className="flex flex-wrap gap-2">
      {user.mfaEnabled ? <Badge tone="success">2FA etkin</Badge> : <Badge>2FA kurulmamış</Badge>}
      <Badge tone={user.accountEnabled ? 'neutral' : 'warning'}>{accountStatusLabel(user)}</Badge>
      {user.isPlatformAdmin && <Badge tone="accent">Platform yöneticisi</Badge>}
    </div>
  );
}

/**
 * Cihaz kaybinda MFA sifirlama. Islem once denetim gunlugune yazilir, ardindan TOTP kapatilir
 * ve kullanicinin tum oturumlari dusurulur. Kullanici bir sonraki giriste (rolu zorunlu
 * kapsamdaysa) yeniden kurulum yapar.
 */
export function MfaResetDialog({
  userId,
  displayName,
  initial,
  onClose,
}: {
  userId: string | undefined;
  displayName?: string;
  /** Platform aramasindan gelen durum (yeniden sorgulanmaz). */
  initial?: MfaUser;
  onClose: () => void;
}) {
  const status = useMfaUser(initial ? undefined : userId);
  const user = initial ?? status.data;
  const reset = useResetMfa();
  const [reason, setReason] = useState('');
  const tooShort = reason.trim().length < MFA_RESET_REASON_MIN;

  const close = () => {
    setReason('');
    reset.reset();
    onClose();
  };

  return (
    <Dialog open={!!userId} onClose={close} title="İki adımlı doğrulamayı sıfırla">
      <div className="flex flex-col gap-4">
        <p className="text-small">
          <span className="font-medium">{displayName ?? user?.email ?? userId}</span>
          {user?.email && displayName ? <span className="text-muted"> · {user.email}</span> : null}
        </p>

        {status.isPending && !initial && <Spinner label="Durum okunuyor…" />}
        {status.isError && <Alert tone="danger">{errorMessage(status.error)}</Alert>}
        {user && <MfaStatusBadges user={user} />}

        {reset.isSuccess ? (
          <>
            <Alert tone="success">
              Doğrulayıcı sıfırlandı ve kullanıcının tüm oturumları kapatıldı. İşlem denetim günlüğüne yazıldı.
            </Alert>
            <Button onClick={close}>Kapat</Button>
          </>
        ) : user && !user.canReset ? (
          <Alert tone="info">{user.blockedReason ?? 'Bu kullanıcının doğrulayıcısını sıfırlama yetkiniz yok.'}</Alert>
        ) : user ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!tooShort) reset.mutate({ userId: user.userId, reason: reason.trim() });
            }}
          >
            {!user.mfaEnabled && (
              <Alert tone="info">Kullanıcıda etkin doğrulayıcı yok; sıfırlama yine de açık oturumları kapatır.</Alert>
            )}
            <FormField
              label="Gerekçe"
              hint={`En az ${MFA_RESET_REASON_MIN} karakter (ör. "Telefon kayboldu, talep #42"). Denetim günlüğüne yazılır.`}
              error={reason.length > 0 && tooShort ? `En az ${MFA_RESET_REASON_MIN} karakter yazın` : undefined}
            >
              <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </FormField>
            {reset.isError && <Alert tone="danger">{errorMessage(reset.error)}</Alert>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close}>
                Vazgeç
              </Button>
              <Button type="submit" variant="danger" disabled={tooShort} loading={reset.isPending}>
                <ShieldOff className="size-4" aria-hidden="true" />
                Sıfırla ve oturumları kapat
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Dialog>
  );
}
