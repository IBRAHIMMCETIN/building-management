import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, LogOut, ShieldCheck, Smartphone } from 'lucide-react';
import { toDataURL } from 'qrcode';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Alert, Button, Card, CardTitle, Spinner } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/lib/api/errors';
import { beginTotpSetup, fetchMfaStatus, verifyTotp } from '@/lib/api/mfa';
import { formatSecret, mfaGraceDaysLeft } from '@/lib/auth/mfa';
import { homePathForRole } from '@/types/roles';
import { TotpForm } from './TotpForm';

export const mfaStatusQueryKey = (userId: string | undefined) => ['me', 'mfa', userId] as const;

/** otpauth URI -> QR (PNG data URL). Kutuphane yalnizca bu ekranda yuklenir. */
function useQrDataUrl(uri: string | undefined) {
  const [dataUrl, setDataUrl] = useState<string>();
  useEffect(() => {
    if (!uri) return;
    let cancelled = false;
    void toDataURL(uri, { margin: 1, width: 208, errorCorrectionLevel: 'M' }).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [uri]);
  return uri ? dataUrl : undefined;
}

/**
 * Iki adimli dogrulama (TOTP) kurulumu. Zorunlu MFA kapsamindaki rol (platform yoneticisi,
 * yonetim firmasi, apartman yoneticisi, denetci) TOTP kurmadan yonetim ekranlarina gecemez;
 * diger kullanicilar istege bagli kurabilir.
 *
 * Akis: kurulumu baslat (API -> Cognito AssociateSoftwareToken) -> QR'i okut veya anahtari
 * elle gir -> 6 haneli kodu dogrula (VerifySoftwareToken + SetUserMFAPreference) -> token'i
 * yenile (`mfa_enabled` claim'i) -> geldigi sayfaya don.
 */
export function MfaSetupPage() {
  const { user, mfaSetupRequired, refreshSession, signOut } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from;
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);

  const status = useQuery({
    queryKey: mfaStatusQueryKey(user?.sub),
    queryFn: ({ signal }) => fetchMfaStatus(signal),
    staleTime: 0,
  });
  const setup = useMutation({ mutationFn: beginTotpSetup });
  const verify = useMutation({
    mutationFn: (code: string) => verifyTotp({ code }),
    onSuccess: async () => {
      // Yeni token: Pre Token Lambda `mfa_enabled=true` ekler; zorunluluk kalkar.
      const session = await refreshSession();
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      const role = session.claims.role;
      navigate(from ?? (role ? homePathForRole(role) : '/select-context'), { replace: true });
    },
  });
  const qr = useQrDataUrl(setup.data?.otpauthUri);

  const goHome = () => navigate(from ?? (user?.role ? homePathForRole(user.role) : '/'), { replace: true });
  const logout = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };
  const copySecret = async () => {
    if (!setup.data) return;
    try {
      await navigator.clipboard.writeText(setup.data.secretCode);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const daysLeft = mfaGraceDaysLeft(user);
  const required = mfaSetupRequired || status.data?.status === 'required';

  return (
    <Card className="flex flex-col gap-6">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-6 shrink-0 text-accent" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <CardTitle>İki adımlı doğrulama</CardTitle>
          <p className="text-small text-muted">
            Girişte şifrenize ek olarak telefonunuzdaki doğrulayıcı uygulamanın (Google Authenticator, Microsoft
            Authenticator vb.) ürettiği 6 haneli kod istenir.
          </p>
        </div>
      </div>

      {status.isPending && <Spinner label="Durum kontrol ediliyor…" />}
      {status.isError && <Alert tone="danger">{errorMessage(status.error)}</Alert>}

      {status.data?.enabled && !verify.isSuccess && (
        <div className="flex flex-col gap-3">
          <Alert tone="success">İki adımlı doğrulama hesabınızda etkin.</Alert>
          <Button
            onClick={async () => {
              // Yonetici sifirlamasi/kurulum sonrasi eski token'da durum farkli olabilir.
              await refreshSession().catch(() => undefined);
              goHome();
            }}
          >
            Devam et
          </Button>
        </div>
      )}

      {status.data && !status.data.enabled && (
        <>
          {required ? (
            <Alert tone="danger">
              Rolünüz için iki adımlı doğrulama zorunludur. Kurulumu tamamlamadan yönetim ekranlarına geçemezsiniz.
            </Alert>
          ) : status.data.roleRequiresMfa && status.data.mode === 'warn' ? (
            <Alert tone="info">
              Rolünüz için iki adımlı doğrulama zorunlu hale geliyor
              {daysLeft !== undefined ? ` (${daysLeft} gün kaldı)` : ''}. Şimdi kurmanızı öneririz.
            </Alert>
          ) : null}

          {!setup.data && (
            <div className="flex flex-col gap-3">
              {setup.isError && <Alert tone="danger">{errorMessage(setup.error)}</Alert>}
              <Button onClick={() => setup.mutate()} loading={setup.isPending}>
                <Smartphone className="size-4" aria-hidden="true" />
                Kurulumu başlat
              </Button>
            </div>
          )}

          {setup.data && (
            <div className="flex flex-col gap-5">
              <ol className="flex list-decimal flex-col gap-1 pl-5 text-small text-text-secondary">
                <li>Doğrulayıcı uygulamada yeni hesap ekleyin.</li>
                <li>QR kodu okutun veya anahtarı elle girin.</li>
                <li>Uygulamanın gösterdiği 6 haneli kodu aşağıya yazın.</li>
              </ol>

              <div className="flex flex-col items-center gap-3">
                {qr ? (
                  <img
                    src={qr}
                    width={208}
                    height={208}
                    alt={`${setup.data.issuer} doğrulayıcı QR kodu`}
                    className="rounded-md border border-border bg-white p-1"
                  />
                ) : (
                  <div className="grid size-52 place-items-center rounded-md border border-border">
                    <Spinner label="QR kod hazırlanıyor…" />
                  </div>
                )}
                <p className="text-small text-muted">Hesap: {setup.data.account}</p>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-small font-medium">QR okutamıyorsanız anahtar</span>
                <div className="flex items-center gap-2">
                  <code
                    className="min-w-0 flex-1 break-all rounded-md border border-border bg-surface-muted px-3 py-2 font-mono text-small"
                    data-testid="mfa-secret"
                  >
                    {formatSecret(setup.data.secretCode)}
                  </code>
                  <Button variant="secondary" size="sm" onClick={copySecret} aria-label="Anahtarı kopyala">
                    <Copy className="size-4" aria-hidden="true" />
                    {copied ? 'Kopyalandı' : 'Kopyala'}
                  </Button>
                </div>
                <span className="text-small text-muted">Tür: zamana dayalı (TOTP), 6 hane, 30 saniye.</span>
              </div>

              {verify.isError && <Alert tone="danger">{errorMessage(verify.error)}</Alert>}
              <TotpForm pending={verify.isPending} onSubmit={(code) => verify.mutate(code)} />
            </div>
          )}

          {!required && (
            <Button variant="ghost" size="sm" className="self-start" onClick={goHome}>
              Daha sonra
            </Button>
          )}
        </>
      )}

      {required && (
        <Button variant="ghost" size="sm" className="self-start" onClick={logout}>
          <LogOut className="size-4" aria-hidden="true" />
          Çıkış yap
        </Button>
      )}
    </Card>
  );
}
