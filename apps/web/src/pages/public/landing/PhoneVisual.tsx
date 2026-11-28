import { Copy, Megaphone, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui';
import { BrandWordmark } from '@/components/BrandMark';

/**
 * Mobil uygulama bolumunun gorseli: sakin Ana Sayfa'sinin (borc karti, IBAN kopyalama, Ariza bildir,
 * duyurular) uygulamanin token'lariyla cizilmis temsili bir telefonu. Tutarlar ornektir.
 */
export function PhoneVisual() {
  return (
    <figure className="mx-auto w-full max-w-xs">
      <div aria-hidden="true" className="rounded-xl border-4 border-border-strong bg-bg p-3 shadow-md">
        <div className="flex items-center justify-between border-b border-border pb-2">
          <BrandWordmark className="text-small" />
          <Badge tone="accent">Örnek veri</Badge>
        </div>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-3">
            <p className="text-xs text-muted">Borcunuz</p>
            <p className="text-2xl font-bold tabular-nums">₺1.500,50</p>
            <p className="text-xs text-muted">
              Son ödeme günü: <strong className="text-text">10.12.2026</strong>
            </p>
            <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-surface-muted px-2 py-1.5">
              <span className="truncate font-mono text-xs text-text-secondary">TR00 0000 0000 …</span>
              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent">
                <Copy className="size-3.5" />
                IBAN’ı kopyala
              </span>
            </div>
          </div>
          <div className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 font-semibold text-on-primary">
            <Wrench className="size-5" />
            Arıza bildir
          </div>
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-text">
              <Megaphone className="size-3.5 text-muted" />
              Son duyurular
            </p>
            <p className="text-xs text-text-secondary">Su deposu temizliği, Cumartesi 10:00</p>
            <p className="text-xs text-text-secondary">Olağan genel kurul çağrısı</p>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-xs text-muted">Temsilî ekran: sakin uygulamasının ana sayfası, örnek verilerle.</figcaption>
    </figure>
  );
}
