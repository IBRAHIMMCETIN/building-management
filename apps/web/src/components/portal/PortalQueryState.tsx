import { Building2, Home } from 'lucide-react';
import { useEffect } from 'react';
import { Alert, Button, Card } from '@/components/ui';
import { usePortalUnit } from '@/context/PortalUnitContext';
import { errorMessage } from '@/lib/api/errors';
import { isNoMembership, unitChoicesFrom } from '@/lib/api/portal';

type Props = { error: unknown; onRetry: () => void };

/**
 * Portal sorgusunun hata durumlari:
 *  - Birden fazla daire  -> daire secici
 *  - Kayitli secim artik gecersiz (403 + secili daire) -> secim sifirlanir, otomatik yeniden denenir
 *  - Aktif daire yok     -> bilgilendirici bos durum
 *  - Diger               -> hata + tekrar dene
 */
export function PortalQueryState({ error, onRetry }: Props) {
  const { unitId, selectUnit } = usePortalUnit();
  const choices = unitChoicesFrom(error);
  const staleSelection = isNoMembership(error) && unitId !== undefined;

  useEffect(() => {
    if (staleSelection) selectUnit(undefined);
  }, [staleSelection, selectUnit]);

  if (staleSelection) return null;

  if (choices) {
    return (
      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-heading font-semibold">Daire seçin</h2>
          <p className="text-small text-muted">Bu apartmanda birden fazla daireniz var. Hangisinin hesabını görmek istersiniz?</p>
        </div>
        <ul className="flex flex-col gap-2">
          {choices.map((c) => (
            <li key={c.unitId}>
              <button
                type="button"
                onClick={() => selectUnit(c.unitId)}
                className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3 text-left hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <span className="flex items-center gap-3">
                  <Home className="size-4 text-accent" aria-hidden="true" />
                  <span className="font-medium">{c.label}</span>
                </span>
                {c.relationLabel && <span className="text-small text-muted">{c.relationLabel}</span>}
              </button>
            </li>
          ))}
        </ul>
      </Card>
    );
  }

  if (isNoMembership(error)) {
    return (
      <Card className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="grid size-12 place-items-center rounded-full bg-surface-muted text-accent">
          <Building2 className="size-6" aria-hidden="true" />
        </div>
        <h2 className="text-heading font-semibold">Henüz bir daireye atanmadınız</h2>
        <p className="max-w-content text-small text-muted">
          Borç ve ödeme bilgileriniz, apartman yöneticiniz sizi dairenize malik veya kiracı olarak eklediğinde burada görünecek.
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col items-start gap-3">
      <Alert tone="danger">{errorMessage(error)}</Alert>
      <Button variant="secondary" onClick={onRetry}>
        Tekrar dene
      </Button>
    </Card>
  );
}

/** Secili daire varken baska daireye gecis baglantisi (secim sifirlanir, secici acilir). */
export function ChangeUnitLink() {
  const { unitId, selectUnit } = usePortalUnit();
  if (!unitId) return null;
  return (
    <button type="button" onClick={() => selectUnit(undefined)} className="text-small text-accent underline-offset-4 hover:underline">
      Daire değiştir
    </button>
  );
}
