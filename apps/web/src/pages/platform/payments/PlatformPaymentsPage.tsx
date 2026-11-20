import { CreditCard, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FilterChips, FormField, Input, Skeleton } from '@/components/ui';
import { usePlatformPaymentApartments, useUpdatePaymentAccount } from '@/hooks/usePayments';
import { errorMessage } from '@/lib/api/errors';
import type { PlatformApartment } from '@/lib/api/payments';
import { formatDateTime } from '@/lib/dates';
import { MAX_PLATFORM_FEE_BASIS_POINTS, formatBasisPoints, parsePercentToBasisPoints } from '@/lib/payments/manager';
import { SUB_MERCHANT_TYPE_LABELS } from '@/lib/payments/subMerchant';
import { ReviewQueue } from './ReviewQueue';
import { SubMerchantDialog } from './SubMerchantDialog';

type Filter = 'all' | 'active' | 'disabled' | 'none';

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: 'Tümü' },
  { value: 'active', label: 'Aktif' },
  { value: 'disabled', label: 'Durdurulmuş' },
  { value: 'none', label: 'Kayıtsız' },
];

const matches = (a: PlatformApartment, filter: Filter, q: string) => {
  const state = a.account?.status ?? 'none';
  if (filter !== 'all' && state !== filter) return false;
  if (!q) return true;
  const hay = `${a.name} ${a.city} ${a.district}`.toLocaleLowerCase('tr');
  return hay.includes(q.toLocaleLowerCase('tr'));
};

function AccountBadge({ a }: { a: PlatformApartment }) {
  if (!a.account) return <Badge>Kayıtsız</Badge>;
  return a.account.status === 'active' ? <Badge tone="success">Aktif</Badge> : <Badge tone="warning">Durduruldu</Badge>;
}

function FeeDialog({ apartment, onClose }: { apartment: PlatformApartment | null; onClose: () => void }) {
  const update = useUpdatePaymentAccount();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const open = apartment !== null;

  useEffect(() => {
    if (!apartment) return;
    setValue(String((apartment.account?.platformFeeBasisPoints ?? 0) / 100).replace('.', ','));
    setError(null);
    update.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [apartment?.apartmentId]);

  const save = async () => {
    if (!apartment) return;
    const bp = parsePercentToBasisPoints(value);
    if (bp === null) {
      setError(`Pay %0 ile ${formatBasisPoints(MAX_PLATFORM_FEE_BASIS_POINTS)} arasında olmalı (örn. 1,5).`);
      return;
    }
    try {
      await update.mutateAsync({ apartmentId: apartment.apartmentId, patch: { platformFeeBasisPoints: bp } });
      onClose();
    } catch {
      // hata asagida gosterilir
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Platform payını değiştir">
      <div className="flex flex-col gap-4">
        <p className="text-small text-muted">
          <strong className="text-text">{apartment?.name}</strong> için yeni pay, bundan sonra başlatılan ödemelere uygulanır.
        </p>
        <FormField label="Platform payı (%)" error={error ?? undefined}>
          <Input
            inputMode="decimal"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
        </FormField>
        {update.isError && <Alert tone="danger">{errorMessage(update.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button loading={update.isPending} onClick={() => void save()}>
            Kaydet
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function StatusToggle({ a, onError }: { a: PlatformApartment; onError: (msg: string) => void }) {
  const update = useUpdatePaymentAccount();
  if (!a.account) return null;
  const active = a.account.status === 'active';
  const toggle = () => {
    const next = active ? 'disabled' : 'active';
    if (active && !window.confirm(`${a.name} için online ödeme durdurulsun mu? Sakinler yeni ödeme başlatamaz.`)) return;
    update.mutate({ apartmentId: a.apartmentId, patch: { status: next } }, { onError: (err) => onError(errorMessage(err)) });
  };
  return (
    <Button variant={active ? 'subtle' : 'secondary'} size="xs" loading={update.isPending} onClick={toggle}>
      {active ? 'Durdur' : 'Etkinleştir'}
    </Button>
  );
}

function Row({
  a,
  onOnboard,
  onFee,
  onError,
}: {
  a: PlatformApartment;
  onOnboard: () => void;
  onFee: () => void;
  onError: (msg: string) => void;
}) {
  const acc = a.account;
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-surface/60 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{a.name}</p>
          <AccountBadge a={a} />
          {a.siteStatus !== 'active' && <Badge>Site: {a.siteStatus}</Badge>}
        </div>
        <p className="text-small text-muted">
          {a.district} / {a.city}
        </p>
        {acc && (
          <p className="text-small text-muted">
            {SUB_MERCHANT_TYPE_LABELS[acc.subMerchantType]} · {acc.ibanMasked ?? 'IBAN —'} · pay {formatBasisPoints(acc.platformFeeBasisPoints)} ·
            güncelleme {formatDateTime(acc.updatedAt)}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {acc ? (
          <>
            <Button variant="secondary" size="xs" onClick={onFee}>
              Payı değiştir
            </Button>
            <StatusToggle a={a} onError={onError} />
          </>
        ) : (
          <Button size="sm" onClick={onOnboard} disabled={a.siteStatus !== 'active'}>
            <CreditCard className="size-4" aria-hidden="true" />
            Ödeme hesabı aç
          </Button>
        )}
      </div>
    </li>
  );
}

/** Platform yoneticisi: apartmanlarin online odeme (alt uye isyeri) hesaplari. */
export function PlatformPaymentsPage() {
  const list = usePlatformPaymentApartments();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [onboarding, setOnboarding] = useState<PlatformApartment | null>(null);
  const [feeFor, setFeeFor] = useState<PlatformApartment | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const items = useMemo(() => (list.data?.items ?? []).filter((a) => matches(a, filter, q.trim())), [list.data, filter, q]);
  const counts = useMemo(() => {
    const all = list.data?.items ?? [];
    return { active: all.filter((a) => a.account?.status === 'active').length, total: all.length };
  }, [list.data]);

  let content;
  if (list.isPending) {
    content = (
      <div role="status" aria-label="Apartmanlar yükleniyor" className="flex flex-col gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  } else if (list.isError) {
    content = (
      <Card className="flex flex-col items-start gap-3">
        <Alert tone="danger">{errorMessage(list.error)}</Alert>
        <Button variant="secondary" onClick={() => void list.refetch()}>
          Tekrar dene
        </Button>
      </Card>
    );
  } else if (!list.data.provider) {
    content = <Alert>Online ödeme sağlayıcısı yapılandırılmamış (Terraform: payments_provider). Hesap açmak için önce sağlayıcıyı etkinleştirin.</Alert>;
  } else {
    content = (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <FilterChips<Filter> label="Hesap durumu" value={filter} onChange={setFilter} options={FILTERS} />
          <label className="relative block sm:w-64">
            <span className="sr-only">Apartman ara</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input className="pl-9" placeholder="Ad, ilçe veya il" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>
        {actionError && <Alert tone="danger">{actionError}</Alert>}
        {items.length === 0 ? (
          <p className="py-6 text-center text-small text-muted">Bu filtreye uyan apartman yok.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Apartman ödeme hesapları">
            {items.map((a) => (
              <Row
                key={a.apartmentId}
                a={a}
                onOnboard={() => setOnboarding(a)}
                onFee={() => setFeeFor(a)}
                onError={setActionError}
              />
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-title font-bold">Online ödeme hesapları</h1>
          <p className="text-small text-muted">
            Apartmanların ödeme sağlayıcısındaki alt üye işyeri kayıtları
            {list.data && ` · ${counts.active}/${counts.total} aktif`}
          </p>
        </div>
        {list.data?.provider && (
          <div className="flex gap-1.5">
            <Badge tone="accent">{list.data.provider}</Badge>
            {list.data.sandbox && <Badge tone="warning">Test ortamı</Badge>}
          </div>
        )}
      </div>
      {list.data?.provider && <ReviewQueue />}
      {content}
      <SubMerchantDialog apartment={onboarding} sandbox={!!list.data?.sandbox} onClose={() => setOnboarding(null)} />
      <FeeDialog apartment={feeFor} onClose={() => setFeeFor(null)} />
    </div>
  );
}
