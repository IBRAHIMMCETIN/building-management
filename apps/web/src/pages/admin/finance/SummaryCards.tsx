import { AlertTriangle, Banknote, Landmark, Wallet } from 'lucide-react';
import type { ComponentType } from 'react';
import { Skeleton } from '@/components/ui';
import { useFinanceSummary } from '@/hooks/useFinance';
import { cn } from '@/lib/cn';
import { formatTRY } from '@/lib/money';

type CardProps = {
  label: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
  detail?: string;
  tone?: 'default' | 'warning';
};

function StatCard({ label, value, icon: Icon, detail, tone = 'default' }: CardProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border border-border bg-surface/60 p-5 shadow-sm backdrop-blur-sm transition-colors hover:border-border-strong',
        tone === 'warning' && 'border-warning/30 hover:border-warning/50',
      )}
    >
      <dt className="flex items-center justify-between gap-2 text-xs font-medium tracking-wide text-muted uppercase">
        {label}
        <span className={cn('grid size-8 place-items-center rounded-lg', tone === 'warning' ? 'bg-warning/10 text-warning' : 'bg-accent/10 text-accent')}>
          <Icon className="size-4" aria-hidden="true" />
        </span>
      </dt>
      <dd className="text-xl font-semibold tracking-tight text-text tabular-nums md:text-2xl">{value}</dd>
      {detail && <dd className="text-xs text-muted">{detail}</dd>}
    </div>
  );
}

export function SummaryCards() {
  const { data, isPending, isError } = useFinanceSummary();

  if (isPending) {
    return (
      <div role="status" aria-label="Özet yükleniyor" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-xl border border-border bg-surface/60 p-5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-6 w-3/4" />
          </div>
        ))}
      </div>
    );
  }
  if (isError || !data) return null;

  return (
    <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard label="Kasa (nakit)" value={formatTRY(data.cash)} icon={Banknote} />
      <StatCard label="Banka" value={formatTRY(data.bank)} icon={Landmark} />
      <StatCard
        label="Toplam mevcut varlık"
        value={formatTRY(data.totalFunds)}
        icon={Wallet}
        detail={data.payables > 0 ? `Tedarikçi borcu: ${formatTRY(data.payables)}` : undefined}
      />
      <StatCard
        label="Bekleyen tahsilat"
        value={formatTRY(data.receivables)}
        icon={AlertTriangle}
        tone={data.overdue > 0 ? 'warning' : 'default'}
        detail={
          data.overdue > 0
            ? `${formatTRY(data.overdue)} gecikmede · ${data.overdueUnitCount} daire${
                data.accruedLateFees > 0 ? ` · +${formatTRY(data.accruedLateFees)} işleyen tazminat` : ''
              }`
            : data.receivables > 0
              ? 'Gecikmiş borç yok'
              : 'Bekleyen borç yok'
        }
      />
    </dl>
  );
}
