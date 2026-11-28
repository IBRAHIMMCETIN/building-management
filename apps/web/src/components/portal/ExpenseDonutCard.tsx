import { Droplets, Ellipsis, Flame, PieChart, Shield, Sparkles, Trees, Wrench, Zap } from 'lucide-react';
import { type ComponentType, useMemo, useState } from 'react';
import { Card, Select, Skeleton } from '@/components/ui';
import { useFeature } from '@/context/SiteFeaturesContext';
import { useExpenseBreakdown } from '@/hooks/usePortal';
import { type ExpenseCategory, recentMonths } from '@/lib/api/portal';
import { formatTRY } from '@/lib/money';
import { CATEGORY_COLOR, currentIstanbulMonth, donutSegments, formatShare, monthLabel } from '@/lib/portal/expenseChart';

const ICONS: Record<ExpenseCategory, ComponentType<{ className?: string }>> = {
  electricity: Zap,
  water: Droplets,
  heating: Flame,
  cleaning: Sparkles,
  maintenance: Wrench,
  security: Shield,
  garden: Trees,
  other: Ellipsis,
};

const SIZE = 200;
const STROKE = 28;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;

/**
 * Adim 3 - "Aidatınız nereye gidiyor?" halka grafigi. `resident.expenseChart` kapaliysa hic
 * cizilmez. Sitenin o ayki toplam giderleri sade kategorilerle (kisi / firma adi yok); her
 * kategorinin adi, yuzdesi ve tutari listede de yazili (renk tek basina anlam tasimaz).
 */
export function ExpenseDonutCard({ now }: { now?: Date }) {
  const on = useFeature('resident.expenseChart');
  const current = currentIstanbulMonth(now);
  const months = useMemo(() => recentMonths(current, 12), [current]);
  const [month, setMonth] = useState(current);
  const [active, setActive] = useState<ExpenseCategory | null>(null);
  const q = useExpenseBreakdown(month);

  if (!on) return null;
  const data = q.data;
  const segments = data ? donutSegments(data.items, C) : [];
  const focused = data?.items.find((i) => i.category === active);

  return (
    <Card className="flex flex-col gap-4" aria-labelledby="expense-chart-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <PieChart className="mt-0.5 size-5 text-accent" aria-hidden="true" />
          <div>
            <h2 id="expense-chart-title" className="text-heading font-semibold">
              Aidatınız nereye gidiyor?
            </h2>
            <p className="text-small text-muted">Sitenin bu ayki giderleri.</p>
          </div>
        </div>
        <label className="flex flex-col gap-1 text-small">
          <span className="sr-only">Ay seçin</span>
          <Select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Ay seçin" className="w-44">
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {q.isPending && (
        <div role="status" aria-label="Gider dağılımı yükleniyor" className="flex flex-col items-center gap-3">
          <Skeleton className="size-48 rounded-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}
      {q.isError && !data && <p className="text-small text-muted">Gider bilgisi şu an gösterilemiyor. Lütfen daha sonra tekrar deneyin.</p>}

      {data && data.empty && (
        <p className="rounded-md bg-surface-muted px-4 py-6 text-center text-small text-muted">{monthLabel(data.month)} için henüz gider girilmedi.</p>
      )}

      {data && !data.empty && (
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
          <svg
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="size-48 shrink-0 sm:size-52"
            role="img"
            aria-label={`${monthLabel(data.month)} gider dağılımı, toplam ${formatTRY(data.total)}. Kategoriler yandaki listede.`}
          >
            <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
              {segments.map((s) => (
                <circle
                  key={s.category}
                  data-category={s.category}
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={R}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={active === s.category ? STROKE + 4 : STROKE}
                  strokeDasharray={`${s.length} ${C - s.length}`}
                  strokeDashoffset={-s.offset}
                  opacity={active && active !== s.category ? 0.45 : 1}
                  onMouseEnter={() => setActive(s.category)}
                  onMouseLeave={() => setActive(null)}
                />
              ))}
            </g>
            <text x="50%" y="46%" textAnchor="middle" fontSize={13} fill="var(--color-muted)">
              {focused ? focused.label : 'Toplam'}
            </text>
            <text x="50%" y="58%" textAnchor="middle" fontSize={17} fontWeight={700} fill="var(--color-text)">
              {formatTRY(focused ? focused.amount : data.total)}
            </text>
          </svg>

          <ul className="flex w-full flex-col divide-y divide-border" aria-label={`${monthLabel(data.month)} gider kalemleri`}>
            {data.items.map((i) => {
              const Icon = ICONS[i.category];
              return (
                <li
                  key={i.category}
                  data-category={i.category}
                  tabIndex={0}
                  onMouseEnter={() => setActive(i.category)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(i.category)}
                  onBlur={() => setActive(null)}
                  className="flex items-center gap-3 py-2 outline-none focus-visible:bg-surface-muted"
                >
                  <span className="size-3 shrink-0 rounded-sm" style={{ background: CATEGORY_COLOR[i.category] }} aria-hidden="true" />
                  <Icon className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1 font-medium">{i.label}</span>
                  <span className="w-14 text-right text-small tabular-nums text-muted">{formatShare(i.shareBp)}</span>
                  <span className="w-28 text-right font-semibold tabular-nums">{formatTRY(i.amount)}</span>
                </li>
              );
            })}
            <li className="flex items-center justify-between gap-3 pt-2 text-small">
              <span className="text-muted">Toplam</span>
              <span className="font-semibold tabular-nums">{formatTRY(data.total)}</span>
            </li>
          </ul>
        </div>
      )}
    </Card>
  );
}
