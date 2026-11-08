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
    <div className={cn('flex flex-col gap-2 rounded-lg border border-border bg-surface p-4', tone === 'warning' && 'border-warning/40')}>
      <dt className="flex items-center justify-between gap-2 text-small text-muted">
        {label}
        <Icon className={cn('size-4', tone === 'warning' ? 'text-warning' : 'text-accent')} aria-hidden="true" />
      </dt>
      <dd className="text-heading font-semibold tabular-nums">{value}</dd>
      {detail && <dd className="text-small text-muted">{detail}</dd>}
    </div>
  );
}

export function SummaryCards() {
  const { data, isPending, isError } = useFinanceSummary();

  if (isPending) {
    return (
      <div role="status" aria-label="Özet yükleniyor" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-6 w-3/4" />
          </div>
        ))}
      </div>
    );
  }
  if (isError || !data) return null;

  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
            ? `${formatTRY(data.overdue)} gecikmede · ${data.overdueUnitCount} daire`
            : data.receivables > 0
              ? 'Gecikmiş borç yok'
              : 'Bekleyen borç yok'
        }
      />
    </dl>
  );
}
