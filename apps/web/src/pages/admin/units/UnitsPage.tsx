import { Building, Plus, Search, SearchX, TriangleAlert, X } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { Alert, Button, Card, Input } from '@/components/ui';
import { useBlocks, useCurrentMemberships, usePeople, useUnitPermissions, useUnits } from '@/hooks/useUnits';
import { errorMessage } from '@/lib/api/errors';
import { CreateUnitDialog } from './CreateUnitDialog';
import { ExemptionsDialog } from './ExemptionsDialog';
import { InviteResidentDialog } from './InviteResidentDialog';
import { UnitsTable, UnitsTableSkeleton } from './UnitsTable';
import { type UnitRow, buildUnitRows, filterRows } from './unitRows';

const m2 = (tenths: number) => (tenths / 10).toLocaleString('tr-TR', { maximumFractionDigits: 1 });

export function UnitsPage() {
  const { canReadUnits, canReadResidents, canManage } = useUnitPermissions();
  const units = useUnits();
  const blocks = useBlocks();
  const memberships = useCurrentMemberships();
  const people = usePeople();

  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteRow, setInviteRow] = useState<UnitRow | null>(null);
  const [exemptionsRow, setExemptionsRow] = useState<UnitRow | null>(null);

  // Kisi/uyelik sorgusu basarisiz olsa da daire listesi gosterilir (kisi sutunlari "—").
  const residentsLoading = canReadResidents && (memberships.isPending || people.isPending);
  const rows = useMemo(
    () =>
      units.data && blocks.data
        ? buildUnitRows(
            units.data.items.filter((u) => u.status === 'active'),
            blocks.data,
            canReadResidents ? memberships.data : undefined,
            canReadResidents ? people.data : undefined,
          )
        : [],
    [units.data, blocks.data, memberships.data, people.data, canReadResidents],
  );
  const visible = useMemo(() => filterRows(rows, deferredQuery), [rows, deferredQuery]);

  if (!canReadUnits) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-title font-bold">Daireler</h1>
        <Alert>Bu rol daire listesini görüntüleyemez.</Alert>
      </div>
    );
  }

  const loading = units.isPending || blocks.isPending || residentsLoading;
  const loadError = units.error ?? blocks.error;
  const summary = units.data?.summary;
  const isEmpty = !loading && !loadError && rows.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-title font-bold">Daireler</h1>
          <p className="text-small text-muted">Bağımsız bölümler, malikler ve kiracılar.</p>
        </div>
        {canManage && !isEmpty && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Daire ekle
          </Button>
        )}
      </div>

      {summary && rows.length > 0 && (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-surface/60 p-5 shadow-sm backdrop-blur-sm transition-colors hover:border-border-strong">
            <dt className="text-small text-muted">Aktif bölüm</dt>
            <dd className="text-heading font-semibold tabular-nums">{summary.activeUnitCount}</dd>
          </div>
          <div className="rounded-xl border border-border bg-surface/60 p-5 shadow-sm backdrop-blur-sm transition-colors hover:border-border-strong">
            <dt className="text-small text-muted">Toplam brüt alan</dt>
            <dd className="text-heading font-semibold tabular-nums">{m2(summary.totalGrossAreaTenthsM2)} m²</dd>
          </div>
          <div className="col-span-2 rounded-xl border border-border bg-surface/60 p-5 shadow-sm backdrop-blur-sm transition-colors hover:border-border-strong sm:col-span-1">
            <dt className="text-small text-muted">Arsa payı toplamı</dt>
            <dd className="flex items-center gap-2 text-heading font-semibold tabular-nums">
              {summary.landShare.numerator}/{summary.landShare.denominator}
              {!summary.landShare.isComplete && (
                <span className="inline-flex items-center gap-1 text-small font-normal text-warning" title="Tüm dairelerin arsa payları girildiğinde toplam 1 olmalı.">
                  <TriangleAlert className="size-4" aria-hidden="true" />
                  Eksik
                </span>
              )}
            </dd>
          </div>
        </dl>
      )}

      {loadError && (
        <Card className="flex flex-col items-start gap-3">
          <Alert tone="danger">{errorMessage(loadError)}</Alert>
          <Button
            variant="secondary"
            onClick={() => {
              void units.refetch();
              void blocks.refetch();
            }}
          >
            Tekrar dene
          </Button>
        </Card>
      )}

      {canReadResidents && (memberships.isError || people.isError) && (
        <Alert tone="danger">Malik/kiracı bilgileri yüklenemedi; daire listesi kişi bilgisi olmadan gösteriliyor.</Alert>
      )}

      {isEmpty && (
        <Card className="flex flex-col items-center gap-3 py-12 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-surface-muted text-accent">
            <Building className="size-6" aria-hidden="true" />
          </div>
          <h2 className="text-heading font-semibold">Henüz daire eklenmemiş</h2>
          <p className="max-w-content text-small text-muted">
            {canManage
              ? 'Apartmanınızdaki bağımsız bölümleri ekleyin; ardından her daireye malik ve kiracı davet edebilirsiniz.'
              : 'Yönetici daireleri eklediğinde burada görünecek.'}
          </p>
          {canManage && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              İlk daireyi ekle
            </Button>
          )}
        </Card>
      )}

      {!isEmpty && !loadError && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full sm:max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
              <Input
                type="search"
                aria-label="Daire no ile ara"
                placeholder="Daire no ile ara…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            {!loading && (
              <p className="text-small text-muted" aria-live="polite">
                {deferredQuery.trim() ? `${visible.length} / ${rows.length} daire` : `${rows.length} daire`}
              </p>
            )}
          </div>

          {loading ? (
            <UnitsTableSkeleton showResidents={canReadResidents} />
          ) : visible.length === 0 ? (
            <Card className="flex flex-col items-center gap-2 py-10 text-center">
              <SearchX className="size-8 text-muted" aria-hidden="true" />
              <p className="font-medium">“{deferredQuery.trim()}” ile eşleşen daire yok</p>
              <Button variant="ghost" size="sm" onClick={() => setQuery('')}>
                <X className="size-4" aria-hidden="true" />
                Aramayı temizle
              </Button>
            </Card>
          ) : (
            <UnitsTable rows={visible} showResidents={canReadResidents} canManage={canManage} onInvite={setInviteRow} onExemptions={setExemptionsRow} />
          )}
        </>
      )}

      {canManage && (
        <>
          <CreateUnitDialog open={createOpen} onClose={() => setCreateOpen(false)} />
          <InviteResidentDialog row={inviteRow} onClose={() => setInviteRow(null)} />
          <ExemptionsDialog row={exemptionsRow} onClose={() => setExemptionsRow(null)} />
        </>
      )}
    </div>
  );
}
