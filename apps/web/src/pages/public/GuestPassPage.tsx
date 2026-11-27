import { Building2 } from 'lucide-react';
import { useLocation, useParams } from 'react-router';
import { Alert, Card, Skeleton } from '@/components/ui';
import { useQrDataUrl } from '@/hooks/useQrDataUrl';
import { BRAND_NAME } from '@/lib/brand';
import { formatShortCode, normalizeShortCode, parseScan, passLink } from '@/lib/gate/plate';

/**
 * Misafirin actigi gecis baglantisi (`/gecis/<jeton>#<kod>`). Oturum gerektirmez ve API'ye hicbir
 * istek atmaz: QR, adresteki rastgele jetondan tarayicida cizilir. Sayfada kisisel veri yoktur;
 * gecerlilik ve ev sahibi bilgisi yalnizca gorevli okuttugunda sunucudan gelir.
 */
export function GuestPassPage() {
  const { token = '' } = useParams();
  const { hash } = useLocation();
  const valid = parseScan(`/gecis/${token}`) !== undefined;
  const code = normalizeShortCode(hash.replace(/^#/, ''));
  const qr = useQrDataUrl(valid ? passLink(window.location.origin, token, code) : undefined, 280);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg px-4 py-10">
      <div className="flex items-center gap-2 text-accent">
        <Building2 className="size-7" aria-hidden="true" />
        <span className="text-heading font-semibold text-text">{BRAND_NAME}</span>
      </div>
      <main className="w-full max-w-sm">
        <Card className="flex flex-col items-center gap-4 text-center">
          <h1 className="text-heading font-bold">Misafir geçişi</h1>
          {valid ? (
            <>
              <p className="text-small text-text-secondary">Site girişinde bu QR kodu güvenlik görevlisine gösterin.</p>
              {qr ? <img src={qr} alt="Geçiş QR kodu" className="size-72 rounded-lg bg-white p-2" /> : <Skeleton className="size-72" />}
              {code && (
                <p className="flex flex-col gap-1">
                  <span className="text-small text-muted">QR okunamazsa kısa kod</span>
                  <span className="font-mono text-title font-bold tracking-widest">{formatShortCode(code)}</span>
                </p>
              )}
              <p className="text-xs text-muted">Bu bağlantıyı başkalarıyla paylaşmayın. Geçerlilik ve giriş hakkı güvenlik tarafından kontrol edilir.</p>
            </>
          ) : (
            <Alert tone="danger">Geçiş bağlantısı geçersiz. Sizi davet eden kişiden yeni bir bağlantı isteyin.</Alert>
          )}
        </Card>
      </main>
    </div>
  );
}
