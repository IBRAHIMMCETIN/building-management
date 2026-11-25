import { AlertTriangle, ArrowRight, Lock } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Alert, Card, CardTitle, Skeleton } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { useFinancePermissions } from '@/hooks/useFinance';
import { useFinanceDashboard } from '@/hooks/useFinancePeriods';
import { useOperationsPending } from '@/hooks/useOperationsPending';
import { errorMessage } from '@/lib/api/errors';
import { type FinanceDashboard, formatPeriod, formatPeriodShort } from '@/lib/api/financePeriods';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { ROLE_LABELS } from '@/types/roles';

/** Bekleyen isin acildigi yer. */
const PENDING_LINKS: Record<string, string> = {
  bank_unmatched: '/admin/finance?tab=bank',
  payment_review: '/admin/finance?tab=online',
  offset_requests_pending: '/admin/finance?tab=dues',
  meter_pending: '/admin/meters',
  periods_unclosed: '/admin/finance?tab=closing',
  periods_never_closed: '/admin/finance?tab=closing',
};

/** Finans 2.4: finans rollerine Genel Bakis gostergeleri; diger rollere aktif baglam. */
export function DashboardPage() {
  const { canRead } = useFinancePermissions();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title font-bold">Genel Bakış</h1>
      {canRead ? (
        <FinanceOverview />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ContextCard />
          <OperationsCard />
        </div>
      )}
    </div>
  );
}

function ContextCard() {
  const { user } = useAuth();
  return (
    <Card>
      <CardTitle>Aktif bağlam</CardTitle>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-small">
        <dt className="text-muted">Rol</dt>
        <dd>{user?.role ? ROLE_LABELS[user.role] : '—'}</dd>
        <dt className="text-muted">Apartman</dt>
        <dd>
          <code>{user?.apartmentId ?? '—'}</code>
        </dd>
      </dl>
    </Card>
  );
}

/** O1-5: finans rolu olmayan (gorevli) icin ariza / bakim bekleyen isleri. */
function OperationsCard() {
  const ops = useOperationsPending();
  if (!ops.enabled) return null;
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>Bekleyen işler</CardTitle>
      {ops.isPending ? <Skeleton className="h-16" /> : ops.items.length === 0 ? <p className="text-small text-muted">Bekleyen iş yok.</p> : <PendingList items={ops.items.map((i) => ({ key: i.code, to: i.to, message: i.message, count: i.count }))} />}
    </Card>
  );
}

type PendingRow = { key: string; to: string; message: string; count?: number; urgent?: boolean };

function PendingList({ items }: { items: PendingRow[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border text-small">
      {items.map((p) => (
        <li key={p.key}>
          <Link to={p.to} className="flex items-center gap-2 py-2 hover:text-accent">
            <AlertTriangle className={`size-4 shrink-0 ${p.urgent ? 'text-danger' : 'text-warning'}`} aria-hidden="true" />
            <span className="flex-1">{p.message}</span>
            {p.count !== undefined && <span className="rounded-full bg-surface-muted px-2 text-xs tabular-nums">{p.count}</span>}
            <ArrowRight className="size-3.5 text-muted" aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function FinanceOverview() {
  const d = useFinanceDashboard();
  const ops = useOperationsPending();
  if (d.isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" role="status" aria-label="Göstergeler yükleniyor">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }
  if (d.isError) return <Alert tone="danger">{errorMessage(d.error)}</Alert>;
  const x = d.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Kasa + banka" value={formatTRY(x.funds.total)} detail={`Kasa ${formatTRY(x.funds.cash)} · Banka ${formatTRY(x.funds.bank)}`} />
        <Kpi
          label="Sakin alacakları"
          value={formatTRY(x.receivables)}
          detail={x.overdue > 0 ? `${formatTRY(x.overdue)} vadesi geçmiş · ${x.overdueUnitCount} bölüm` : 'Vadesi geçen borç yok'}
          warn={x.overdue > 0}
        />
        <Kpi
          label={`${formatPeriod(x.thisMonth.period)} tahsilat`}
          value={x.thisMonth.collectionRatePct === undefined ? formatTRY(x.thisMonth.collected) : `%${x.thisMonth.collectionRatePct.toLocaleString('tr-TR')}`}
          detail={`Tahakkuk ${formatTRY(x.thisMonth.charged)} · tahsil ${formatTRY(x.thisMonth.collected)}`}
        />
        {x.budget ? (
          <Kpi
            label={`${x.budget.year} gider bütçesi kullanımı`}
            value={x.budget.utilizationPct === undefined ? '—' : `%${x.budget.utilizationPct.toLocaleString('tr-TR')}`}
            detail={`${formatTRY(x.budget.expenseActualYtd)} / ${formatTRY(x.budget.expenseBudgetYtd)} (yılbaşından)`}
            warn={(x.budget.utilizationPct ?? 0) > 100}
          />
        ) : (
          <Kpi label="Tedarikçi borçları" value={formatTRY(x.payables)} detail="Onaylı bütçe yok" />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card className="flex flex-col gap-3">
          <CardTitle>Son 12 ay gelir ve gider</CardTitle>
          <IncomeExpenseChart series={x.series} />
        </Card>
        <Card className="flex flex-col gap-3">
          <CardTitle>Bekleyen işler</CardTitle>
          {x.pending.length === 0 && ops.items.length === 0 ? (
            <p className="text-small text-muted">Bekleyen iş yok.</p>
          ) : (
            <PendingList
              items={[
                // O1-5: ariza ve bakim kalemleri once (acil / SLA).
                ...ops.items.map((i) => ({ key: i.code, to: i.to, message: i.message, count: i.count, urgent: i.code !== 'maintenance_overdue' })),
                ...x.pending.map((p) => ({ key: p.code, to: PENDING_LINKS[p.code] ?? '/admin/finance', message: p.message, ...(p.code !== 'periods_never_closed' ? { count: p.count } : {}) })),
              ]}
            />
          )}
          <p className="mt-auto flex items-center gap-1.5 text-xs text-muted">
            <Lock className="size-3.5" aria-hidden="true" />
            {x.lockedThrough ? `Defter ${formatDate(x.lockedThrough)} dahil öncesine kilitli` : 'Henüz dönem kapanışı yapılmadı'}
          </p>
        </Card>
      </div>
    </div>
  );
}

function Kpi({ label, value, detail, warn }: { label: string; value: string; detail?: string; warn?: boolean }) {
  return (
    <Card className="flex flex-col gap-1">
      <p className="text-small text-muted">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${warn ? 'text-warning' : ''}`}>{value}</p>
      {detail && <p className="text-xs text-muted">{detail}</p>}
    </Card>
  );
}

const SERIES = [
  { key: 'income', label: 'Gelir', color: 'var(--color-series-1)' },
  { key: 'expense', label: 'Gider', color: 'var(--color-series-2)' },
] as const;

/** Iki serili gruplanmis cubuk: tek eksen, ince cubuklar, ust uclar yuvarlak, uzerine gelince deger. */
export function IncomeExpenseChart({ series }: { series: FinanceDashboard['series'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 220;
  const pad = { top: 12, right: 8, bottom: 24, left: 56 };
  const max = Math.max(1, ...series.flatMap((s) => [s.income, s.expense]));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const band = plotW / Math.max(series.length, 1);
  const bar = Math.min(14, (band - 10) / 2);
  const y = (v: number) => pad.top + plotH - (v / top) * plotH;
  const h = hover === null ? null : series[hover];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4 text-xs text-muted" aria-hidden="true">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <span className="ml-auto tabular-nums text-text-secondary">
          {h ? `${formatPeriod(h.period)} · gelir ${formatTRY(h.income)} · gider ${formatTRY(h.expense)}` : ''}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Son 12 ay gelir ve gider grafiği; ayrıntılar aşağıdaki tabloda">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} stroke="var(--color-border)" strokeWidth={1} />
            <text x={pad.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--color-muted)">
              {compactTRY(t)}
            </text>
          </g>
        ))}
        {series.map((s, i) => {
          const x0 = pad.left + i * band + band / 2 - bar - 1;
          return (
            <g key={s.period} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.left + i * band} y={pad.top} width={band} height={plotH} fill={hover === i ? 'var(--color-surface-muted)' : 'transparent'} />
              {SERIES.map((ser, j) => {
                const v = s[ser.key];
                const barTop = y(v);
                const hgt = pad.top + plotH - barTop;
                return hgt > 0 ? (
                  <path key={ser.key} d={roundedTop(x0 + j * (bar + 2), barTop, bar, hgt, Math.min(4, bar / 2, hgt))} fill={ser.color} />
                ) : null;
              })}
              <text x={pad.left + i * band + band / 2} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--color-muted)">
                {formatPeriodShort(s.period)}
              </text>
            </g>
          );
        })}
      </svg>
      <details className="text-small">
        <summary className="cursor-pointer text-xs text-muted">Tablo olarak göster</summary>
        <table className="mt-2 w-full text-left tabular-nums">
          <caption className="sr-only">Aylık gelir ve gider</caption>
          <thead className="text-xs text-muted">
            <tr>
              <th scope="col" className="py-1 font-medium">Ay</th>
              <th scope="col" className="py-1 text-right font-medium">Gelir</th>
              <th scope="col" className="py-1 text-right font-medium">Gider</th>
              <th scope="col" className="py-1 text-right font-medium">Sonuç</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {series.map((s) => (
              <tr key={s.period}>
                <td className="py-1">{formatPeriod(s.period)}</td>
                <td className="py-1 text-right">{formatTRY(s.income)}</td>
                <td className="py-1 text-right">{formatTRY(s.expense)}</td>
                <td className="py-1 text-right">{s.result < 0 ? `−${formatTRY(-s.result)}` : formatTRY(s.result)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** Yalnizca ust koseleri yuvarlak cubuk (taban eksene oturur). */
function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Eksen adimi (kurus): 1-2-5 x 10^n. */
export function niceStep(raw: number): number {
  if (raw <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** Kurus -> kisa TL etiketi (12 B, 1,5 Mn). */
export function compactTRY(kurus: number): string {
  const tl = kurus / 100;
  if (tl >= 1_000_000) return `${(tl / 1_000_000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} Mn`;
  if (tl >= 1_000) return `${(tl / 1_000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} B`;
  return tl.toLocaleString('tr-TR', { maximumFractionDigits: 0 });
}
