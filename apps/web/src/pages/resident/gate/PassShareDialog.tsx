import { Check, Copy, Share2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Dialog, Skeleton } from '@/components/ui';
import { useQrDataUrl } from '@/hooks/useQrDataUrl';
import type { MyPass } from '@/lib/api/gate';
import { formatShortCode, passLink, validityText } from '@/lib/gate/plate';

/**
 * Gecisin QR'i ve kisa kodu. Misafire baglanti paylasilir (Web Share API, yoksa kopyala): baglanti
 * yalnizca rastgele jetonu tasir, acildiginda QR tarayicida cizilir. QR'da kisisel veri yoktur.
 */
export function PassShareDialog({ pass, onClose }: { pass: MyPass | undefined; onClose: () => void }) {
  const link = pass?.token ? passLink(window.location.origin, pass.token, pass.shortCode) : undefined;
  const qr = useQrDataUrl(link, 240);
  const [copied, setCopied] = useState<'link' | 'code'>();
  const [shareError, setShareError] = useState<string>();
  const code = pass?.shortCode ? formatShortCode(pass.shortCode) : undefined;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const text = pass && code ? `Site girişi için geçiş kodunuz: ${code} (${validityText(pass.validFrom, pass.validUntil)}). Güvenliğe QR'ı veya kodu gösterin.` : '';
  const copy = async (what: 'link' | 'code') => {
    try {
      await navigator.clipboard.writeText(what === 'link' ? (link ?? '') : (code ?? ''));
      setCopied(what);
    } catch {
      setShareError('Kopyalanamadı; kodu elle not edin.');
    }
  };
  const share = async () => {
    setShareError(undefined);
    try {
      await navigator.share({ title: 'Misafir geçişi', text, ...(link ? { url: link } : {}) });
    } catch (err) {
      // Kullanici paylasimi kapatti: hata degil.
      if (!(err instanceof DOMException && err.name === 'AbortError')) setShareError('Paylaşılamadı; bağlantıyı kopyalayın.');
    }
  };
  const close = () => {
    setCopied(undefined);
    setShareError(undefined);
    onClose();
  };

  return (
    <Dialog open={!!pass} onClose={close} title="Misafir geçişi">
      {pass && (
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-small text-text-secondary">
            <span className="font-semibold text-text">{pass.guestName}</span> · {pass.unitLabel}
            <br />
            {validityText(pass.validFrom, pass.validUntil)} · {pass.entryMode === 'single' ? 'Tek giriş' : 'Çoklu giriş'}
          </p>
          {link ? (
            <>
              {qr ? <img src={qr} alt="Geçiş QR kodu" className="size-60 rounded-lg bg-white p-2" /> : <Skeleton className="size-60" />}
              <p className="flex flex-col gap-1">
                <span className="text-small text-muted">Kısa kod</span>
                <span className="font-mono text-title font-bold tracking-widest">{code}</span>
              </p>
              <div className="grid w-full gap-2">
                {canShare && (
                  <Button className="h-12 text-body" onClick={() => void share()}>
                    <Share2 className="size-5" aria-hidden="true" />
                    Misafirle paylaş
                  </Button>
                )}
                <Button variant={canShare ? 'secondary' : 'primary'} className="h-12 text-body" onClick={() => void copy('link')}>
                  {copied === 'link' ? <Check className="size-5" aria-hidden="true" /> : <Copy className="size-5" aria-hidden="true" />}
                  {copied === 'link' ? 'Bağlantı kopyalandı' : 'Bağlantıyı kopyala'}
                </Button>
                <Button variant="secondary" className="h-12 text-body" onClick={() => void copy('code')}>
                  {copied === 'code' ? <Check className="size-5" aria-hidden="true" /> : <Copy className="size-5" aria-hidden="true" />}
                  {copied === 'code' ? 'Kod kopyalandı' : 'Kodu kopyala'}
                </Button>
              </div>
              {shareError && <Alert tone="danger">{shareError}</Alert>}
              <p className="text-xs text-muted">Bağlantıyı alan herkes bu geçişi kullanabilir; yalnızca misafirinizle paylaşın. Gerekirse geçişi iptal edebilirsiniz.</p>
            </>
          ) : (
            <Alert>Bu geçiş artık kullanılamaz; QR ve kod gösterilmez.</Alert>
          )}
        </div>
      )}
    </Dialog>
  );
}
