import { FileDown, Gauge } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ChangeUnitLink, PortalQueryState } from '@/components/portal/PortalQueryState';
import { Alert, Badge, Button, Card, FilterChips, Skeleton } from '@/components/ui';
import { usePortalUnit } from '@/context/PortalUnitContext';
import { useMyConsumption } from '@/hooks/useMeters';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { useMySummary } from '@/hooks/usePortal';
import { type PortalPeriod, metersApi } from '@/lib/api/meters';
import { formatDate } from '@/lib/dates';
import { CATEGORY_LABELS, type TemplateCategory, formatConsumption, formatPercentChange } from '@/lib/meters/model';
import { formatTRY } from '@/lib/money';
import { cn } from '@/lib/cn';

/** Ortalamaya gore fark yuzdesi (ortalama 0 ise null). */
export function versusAverage(mine: number, average: number): number | null {
  if (!(average > 0)) return null;
  return Math.round(((mine - average) / average) * 1000) / 10;
}

/**
 * Sakin: dairesinin donem donem sayac tuketimi, ortak / tuketim payi ayrimi, bina ve blok
 * ortalamasiyla karsilastirma ve "Sayac Dagitim Dokumu" PDF'i.
 */
export function ConsumptionPage() {
  const { unitId: selected } = usePortalUnit();
  const summary = useMySummary();
  const unitId = selected ?? summary.data?.unitId;
  const history = useMyConsumption(unitId);
  const docs = useOpenDocument();
  const [category, setCategory] = useState<TemplateCategory | ''>('');

  const periods = history.data?.periods ?? [];
  const categories = useMemo(() => [...new Set(periods.map((p) => p.category))], [periods]);
  const active = category || categories[0] || '';
  const list = periods.filter((p) => p.category === active);
  const latest = list[0];

  if (!unitId && summary.isError) return <PortalQueryState error={summary.error} onRetry={() => void summary.refetch()} />;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-title font-bold">Tüketimim</h1>
          <p className="text-small text-muted">Isınma ve su giderinin sayacınıza göre dağıtımı.</p>
        </div>
        <ChangeUnitLink />
      </div>

      {(history.isPending || (!unitId && summary.isPending)) && (
        <div className="flex flex-col gap-3" role="status" aria-label="Tüketim yükleniyor">
          <Skeleton className="h-28" />
          <Skeleton className="h-40" />
        </div>
      )}
      {history.isError && <PortalQueryState error={history.error} onRetry={() => void history.refetch()} />}
      {history.data && periods.length === 0 && <Alert>Henüz onaylanmış bir sayaç dağıtım dönemi yok.</Alert>}

      {categories.length > 1 && (
        <FilterChips<TemplateCategory>
          label="Gider türü"
          value={active as TemplateCategory}
          onChange={setCategory}
          options={categories.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
        />
      )}

      {latest && <ComparisonCards period={latest} />}
      {list.length > 1 && <TrendCard periods={list} />}
      {docs.error && <Alert tone="danger">{docs.error}</Alert>}

      <div className="flex flex-col gap-3">
        {list.map((p) => (
          <PeriodCard
            key={p.periodId}
            period={p}
            loading={docs.pendingId === p.periodId}
            onPdf={() => void docs.open(p.periodId, () => metersApi.myStatement(p.periodId, unitId ?? ''))}
          />
        ))}
      </div>
    </div>
  );
}

function ComparisonCards({ period: p }: { period: PortalPeriod }) {
  const vsBuilding = p.hasMeter ? versusAverage(p.consumption, p.buildingAverage) : null;
  const vsBlock = p.hasMeter && p.blockAverage !== undefined ? versusAverage(p.consumption, p.blockAverage) : null;
  const tone = (v: number | null) => (v === null ? 'text-muted' : v > 10 ? 'text-warning' : v < -10 ? 'text-success' : 'text-muted');
  return (
    <section aria-label={`${p.name} karşılaştırma`} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Card className="col-span-2 p-4 sm:col-span-1 md:p-4">
        <p className="text-small text-muted">Sizin tüketiminiz · {p.name}</p>
        <p className="text-title font-bold tabular-nums">{p.hasMeter ? formatConsumption(p.consumption) : '—'}</p>
        {p.previous && (
          <p className={cn('text-small', p.previous.diff > 0 ? 'text-warning' : 'text-success')}>
            Önceki döneme göre {p.previous.percent !== undefined ? formatPercentChange(p.previous.percent) : formatConsumption(p.previous.diff)}
          </p>
        )}
        {p.estimated && <Badge tone="accent">Tahmini okuma</Badge>}
      </Card>
      <Card className="p-4 md:p-4">
        <p className="text-small text-muted">Bina ortalaması</p>
        <p className="text-heading font-semibold tabular-nums">{formatConsumption(p.buildingAverage)}</p>
        {vsBuilding !== null && <p className={cn('text-small', tone(vsBuilding))}>Siz: {formatPercentChange(vsBuilding)}</p>}
        <p className="text-small text-muted">{p.meteredUnits} sayaçlı daire</p>
      </Card>
      {p.blockAverage !== undefined && (
        <Card className="p-4 md:p-4">
          <p className="text-small text-muted">Blok ortalaması</p>
          <p className="text-heading font-semibold tabular-nums">{formatConsumption(p.blockAverage)}</p>
          {vsBlock !== null && <p className={cn('text-small', tone(vsBlock))}>Siz: {formatPercentChange(vsBlock)}</p>}
        </Card>
      )}
    </section>
  );
}

/** Son donemlerin tuketimi (yatay cubuk; en yuksek donem = %100). */
function TrendCard({ periods }: { periods: PortalPeriod[] }) {
  const max = Math.max(...periods.map((p) => Math.max(p.consumption, p.buildingAverage)), 0);
  if (!(max > 0)) return null;
  return (
    <Card className="flex flex-col gap-2 p-4 md:p-4">
      <p className="text-small font-medium">Dönem dönem tüketim</p>
      <ul className="flex flex-col gap-2" aria-label="Tüketim geçmişi">
        {periods.map((p) => (
          <li key={p.periodId} className="grid grid-cols-[6rem_1fr_auto] items-center gap-2 text-small">
            <span className="truncate text-muted">{p.name}</span>
            <span className="relative h-3 rounded-full bg-surface-muted" aria-hidden="true">
              <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${(p.consumption / max) * 100}%` }} />
              <span className="absolute inset-y-[-2px] w-0.5 bg-text/50" style={{ left: `${(p.buildingAverage / max) * 100}%` }} title="Bina ortalaması" />
            </span>
            <span className="tabular-nums">{p.hasMeter ? formatConsumption(p.consumption) : '—'}</span>
          </li>
        ))}
      </ul>
      <p className="text-small text-muted">Çizgi: bina ortalaması.</p>
    </Card>
  );
}

function PeriodCard({ period: p, loading, onPdf }: { period: PortalPeriod; loading: boolean; onPdf: () => void }) {
  const commonPct = p.amount > 0 ? Math.round((p.commonAmount / p.amount) * 100) : 0;
  return (
    <Card className="flex flex-col gap-3 p-4 md:p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{p.name}</p>
          <p className="text-small text-muted">
            {CATEGORY_LABELS[p.category]} · {formatDate(p.startDate)} – {formatDate(p.endDate)} · son ödeme {formatDate(p.dueDate)}
          </p>
        </div>
        <p className="text-heading font-bold tabular-nums">{formatTRY(p.amount)}</p>
      </div>

      <div className="flex h-2 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
        <span className="bg-accent/50" style={{ width: `${commonPct}%` }} />
        <span className="bg-accent" style={{ width: `${100 - commonPct}%` }} />
      </div>
      <dl className="grid grid-cols-2 gap-2 text-small">
        <div>
          <dt className="text-muted">Ortak pay</dt>
          <dd className="font-medium tabular-nums">{formatTRY(p.commonAmount)}</dd>
        </div>
        <div>
          <dt className="text-muted">Tüketim payı</dt>
          <dd className="font-medium tabular-nums">{formatTRY(p.consumptionAmount)}</dd>
        </div>
      </dl>

      {p.hasMeter ? (
        <ul className="flex flex-col gap-1 text-small">
          {p.meters.map((m) => (
            <li key={m.meterId} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-muted">
                <Gauge className="size-3.5" aria-hidden="true" />
                {m.label}
              </span>
              <span className="tabular-nums">{m.delta !== undefined ? formatConsumption(m.delta) : '—'}</span>
            </li>
          ))}
          <li className="flex items-center justify-between gap-2 border-t border-border pt-1 font-medium">
            <span>Toplam tüketim</span>
            <span className="tabular-nums">{p.consumptionText ? formatConsumption(p.consumptionText) : formatConsumption(p.consumption)}</span>
          </li>
        </ul>
      ) : (
        <p className="text-small text-muted">Dairenizde sayaç olmadığı için yalnızca ortak pay yansıtıldı.</p>
      )}
      {p.estimated && <p className="text-small text-accent">Bu dönem okuma yapılamadığı için yönetici onaylı tahmini endeks kullanıldı.</p>}

      <div>
        <Button size="sm" variant="secondary" loading={loading} onClick={onPdf}>
          <FileDown className="size-4" aria-hidden="true" />
          Sayaç Dağıtım Dökümü (PDF)
        </Button>
      </div>
    </Card>
  );
}
