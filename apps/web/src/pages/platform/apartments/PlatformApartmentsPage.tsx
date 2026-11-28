import { Building, CreditCard, LifeBuoy, Search, ShieldAlert, ToggleRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SupportDialog } from '@/components/support/SupportDialog';
import { sessionManager } from '@/lib/auth/sessionManager';
import { Link } from 'react-router';
import { Alert, Badge, Button, Card, FilterChips, Input, Skeleton } from '@/components/ui';
import { usePlatformPaymentApartments, useReviewQueue } from '@/hooks/usePayments';
import { usePlatformApartments } from '@/hooks/usePlatform';
import { errorMessage } from '@/lib/api/errors';
import { SITE_TYPE_LABELS, matchesSiteQuery } from '@/lib/api/platform';
import { formatDate } from '@/lib/dates';
import { FeatureRequestsCard } from './FeatureRequestsCard';
import { SiteFeaturesDialog } from './SiteFeaturesDialog';

type Filter = 'all' | 'active' | 'inactive';

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: 'Tümü' },
  { value: 'active', label: 'Aktif' },
  { value: 'inactive', label: 'Pasif' },
];

function Stat({ label, value, to }: { label: string; value: number | string; to?: string }) {
  const body = (
    <>
      <p className="text-small text-muted">{label}</p>
      <p className="text-title font-bold tabular-nums">{value}</p>
    </>
  );
  return to ? (
    <Link to={to} className="rounded-xl border border-border bg-surface p-4 shadow-sm hover:border-border-strong">
      {body}
    </Link>
  ) : (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-sm">{body}</div>
  );
}

/** Platform yoneticisinin acilis sayfasi: apartman dizini + online odeme ozeti. */
export function PlatformApartmentsPage() {
  const directory = usePlatformApartments();
  const accounts = usePlatformPaymentApartments();
  const review = useReviewQueue();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [supportFor, setSupportFor] = useState<{ siteId: string; name: string }>();
  // Adim 1: site bazli ozellik anahtarlari penceresi.
  const [featuresFor, setFeaturesFor] = useState<{ siteId: string; name: string }>();
  // Destek modu sunucu tarafinda reddedildiyse / suresi dolduysa bir kez bilgi verilir.
  const [supportNotice] = useState(() => sessionManager.consumeSupportNotice());

  // Odeme hesabi durumu ayri uctan gelir; yuklenemezse dizin yine gosterilir.
  const accountOf = useMemo(
    () => new Map((accounts.data?.items ?? []).map((a) => [a.apartmentId, a.account?.status ?? null])),
    [accounts.data],
  );
  const all = directory.data?.items ?? [];
  const items = all.filter((s) => (filter === 'all' || s.status === filter) && matchesSiteQuery(s, q));
  const paymentsOn = Boolean(accounts.data?.provider);
  const waiting = review.data?.items.filter((i) => i.status === 'NEEDS_REVIEW').length ?? 0;

  let list;
  if (directory.isPending) {
    list = (
      <div role="status" aria-label="Apartmanlar yükleniyor" className="flex flex-col gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  } else if (directory.isError) {
    list = (
      <Card className="flex flex-col items-start gap-3">
        <Alert tone="danger">{errorMessage(directory.error)}</Alert>
        <Button variant="secondary" onClick={() => void directory.refetch()}>
          Tekrar dene
        </Button>
      </Card>
    );
  } else if (all.length === 0) {
    list = (
      <Card className="flex flex-col items-center gap-2 py-12 text-center">
        <Building className="size-8 text-muted" aria-hidden="true" />
        <p className="font-medium">Henüz apartman yok</p>
        <p className="max-w-content text-small text-muted">İlk apartman `npm run seed:admin` betiğiyle veya yönetim firması hesabıyla oluşturulur.</p>
      </Card>
    );
  } else if (items.length === 0) {
    list = <p className="py-6 text-center text-small text-muted">Bu filtreye uyan apartman yok.</p>;
  } else {
    list = (
      <ul className="flex flex-col gap-2" aria-label="Apartmanlar">
        {items.map((s) => {
          const acct = accountOf.get(s.siteId);
          return (
            <li
              key={s.siteId}
              className="flex flex-col gap-2 rounded-xl border border-border bg-surface/60 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{s.name}</p>
                  <Badge>{SITE_TYPE_LABELS[s.type]}</Badge>
                  {s.status === 'inactive' && <Badge tone="warning">Pasif</Badge>}
                </div>
                <p className="text-small text-muted">
                  {s.district} / {s.city} · kayıt {formatDate(s.createdAt.slice(0, 10))} · <span className="font-mono text-xs">{s.siteId}</span>
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
              {paymentsOn && (
                <div className="flex shrink-0 items-center gap-2 text-small">
                  <CreditCard className="size-4 text-muted" aria-hidden="true" />
                  {acct === 'active' ? (
                    <Badge tone="success">Online ödeme aktif</Badge>
                  ) : acct === 'disabled' ? (
                    <Badge tone="warning">Online ödeme durduruldu</Badge>
                  ) : (
                    <Badge>Ödeme hesabı yok</Badge>
                  )}
                </div>
              )}
                <Button variant="secondary" size="sm" onClick={() => setFeaturesFor({ siteId: s.siteId, name: s.name })}>
                  <ToggleRight className="size-4" aria-hidden="true" />
                  Özellikler
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setSupportFor({ siteId: s.siteId, name: s.name })}>
                  <LifeBuoy className="size-4" aria-hidden="true" />
                  Destek erişimi
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {supportNotice && (
        <Alert tone="info">
          {supportNotice === 'expired' ? 'Destek oturumunun süresi doldu.' : 'Destek oturumu sunucu tarafından sonlandırıldı.'} Platform
          paneline dönüldü.
        </Alert>
      )}
      <SupportDialog apartment={supportFor} onClose={() => setSupportFor(undefined)} />
      <SiteFeaturesDialog site={featuresFor} onClose={() => setFeaturesFor(undefined)} />
      <div>
        <h1 className="text-title font-bold">Apartmanlar</h1>
        <p className="text-small text-muted">Platformdaki tüm apartman ve siteler. Apartman içi veriler (daire, kişi, finans) yalnızca o apartmanın yöneticilerine açıktır.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Apartman" value={directory.data ? all.filter((s) => s.status === 'active').length : '—'} />
        <Stat
          label="Online ödemesi aktif"
          value={accounts.data ? (accounts.data.items.filter((a) => a.account?.status === 'active').length) : '—'}
          to="/admin/payments"
        />
        <Stat label="İnceleme bekleyen ödeme" value={review.data ? waiting : '—'} to="/admin/payments" />
      </div>

      {waiting > 0 && (
        <Alert tone="danger">
          <span className="inline-flex items-center gap-2">
            <ShieldAlert className="size-4" aria-hidden="true" />
            {waiting} online ödeme karar bekliyor.{' '}
            <Link to="/admin/payments" className="font-medium underline underline-offset-4">
              Ödeme Hesapları
            </Link>
          </span>
        </Alert>
      )}

      <FeatureRequestsCard onOpenSite={setFeaturesFor} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <FilterChips<Filter> label="Durum" value={filter} onChange={setFilter} options={FILTERS} />
        <label className="relative block sm:w-64">
          <span className="sr-only">Apartman ara</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <Input className="pl-9" placeholder="Ad, ilçe veya il" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      {list}
    </div>
  );
}
