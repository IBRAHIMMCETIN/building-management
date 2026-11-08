import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, FileText, ReceiptText, Undo2 } from 'lucide-react';
import { type ComponentType, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Skeleton } from '@/components/ui';
import { useTransactions } from '@/hooks/useFinance';
import { errorMessage } from '@/lib/api/errors';
import { CATEGORY_LABELS, type LedgerTransaction, type TransactionCategory } from '@/lib/api/finance';
import { cn } from '@/lib/cn';
import { formatSignedTRY, formatTRY } from '@/lib/money';
import { FilterChips } from './FilterChips';
import { formatDate } from './format';

type Filter = 'all' | 'income' | 'expense' | 'accrual';

const CATEGORY_STYLE: Record<TransactionCategory, { tone: 'success' | 'warning' | 'accent' | 'neutral'; icon: ComponentType<{ className?: string }> }> = {
  income: { tone: 'success', icon: ArrowDownLeft },
  expense: { tone: 'warning', icon: ArrowUpRight },
  transfer: { tone: 'accent', icon: ArrowLeftRight },
  accrual: { tone: 'neutral', icon: FileText },
  reversal: { tone: 'neutral', icon: Undo2 },
};

function CategoryBadge({ category }: { category: TransactionCategory }) {
  const { tone, icon: Icon } = CATEGORY_STYLE[category];
  return (
    <Badge tone={tone}>
      <Icon className="size-3.5" aria-hidden="true" />
      {CATEGORY_LABELS[category]}
    </Badge>
  );
}

function accountLabel(tx: LedgerTransaction): string {
  if (tx.funds.length === 0) return tx.unitNumber ? `Daire ${tx.unitNumber} cari` : 'Cari hesap';
  return [...new Set(tx.funds.map((f) => f.accountName))].join(' → ');
}

/** Kasa/banka etkisi olan islemde isaretli, tahakkukta isaretsiz tutar. */
function Amount({ tx }: { tx: LedgerTransaction }) {
  if (tx.netFundsChange === 0) return <span className="tabular-nums">{formatTRY(tx.amount)}</span>;
  return (
    <span className={cn('font-semibold tabular-nums', tx.netFundsChange > 0 ? 'text-success' : 'text-danger')}>
      {formatSignedTRY(tx.netFundsChange)}
    </span>
  );
}

function Details({ tx }: { tx: LedgerTransaction }) {
  const bits = [
    // Tahsilat aciklamasi daireyi zaten icerir; digerlerinde (ters kayit vb.) goster.
    tx.unitNumber && tx.funds.length > 0 && tx.kind !== 'payment' ? `Daire ${tx.unitNumber}` : undefined,
    tx.dueDate ? `Son ödeme ${formatDate(tx.dueDate)}` : undefined,
    tx.reference ? `Fatura ${tx.reference}` : undefined,
    tx.reason ? `Neden: ${tx.reason}` : undefined,
  ].filter(Boolean);
  return bits.length ? <span className="block text-small text-muted">{bits.join(' · ')}</span> : null;
}

export function TransactionsPanel() {
  const [filter, setFilter] = useState<Filter>('all');
  const query = useTransactions();
  const all = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const visible = filter === 'all' ? all : all.filter((t) => t.category === filter);

  if (query.isPending) {
    return (
      <div role="status" aria-label="Hareketler yükleniyor" className="flex flex-col gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <Alert tone="danger">{errorMessage(query.error)}</Alert>
        <Button variant="secondary" onClick={() => void query.refetch()}>
          Tekrar dene
        </Button>
      </Card>
    );
  }
  if (all.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-2 py-12 text-center">
        <ReceiptText className="size-8 text-muted" aria-hidden="true" />
        <p className="font-medium">Henüz defter hareketi yok</p>
        <p className="max-w-content text-small text-muted">
          Aidat tahakkuku, tahsilat veya gider kaydettiğinizde hareketler burada tarih sırasıyla listelenir.
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <FilterChips<Filter>
        label="Hareket türü"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'Tümü' },
          { value: 'income', label: 'Gelir' },
          { value: 'expense', label: 'Gider' },
          { value: 'accrual', label: 'Tahakkuk' },
        ]}
      />

      {visible.length === 0 ? (
        <p className="py-6 text-center text-small text-muted">Yüklenen hareketler arasında bu türde kayıt yok.</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface md:block">
            <table className="w-full text-left text-small">
              <caption className="sr-only">Defter hareketleri</caption>
              <thead className="border-b border-border bg-surface-muted text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Tarih</th>
                  <th scope="col" className="px-4 py-3 font-medium">Açıklama</th>
                  <th scope="col" className="px-4 py-3 font-medium">İlgili Hesap</th>
                  <th scope="col" className="px-4 py-3 font-medium">Tür</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Tutar</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map((tx) => (
                  <tr key={tx.transactionId} className="align-top">
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums">{formatDate(tx.date)}</td>
                    <td className="px-4 py-3">
                      {tx.description}
                      <Details tx={tx} />
                    </td>
                    <td className="px-4 py-3">{accountLabel(tx)}</td>
                    <td className="px-4 py-3">
                      <CategoryBadge category={tx.category} />
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <Amount tx={tx} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="flex flex-col gap-2 md:hidden" aria-label="Defter hareketleri">
            {visible.map((tx) => (
              <li key={tx.transactionId} className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface p-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{tx.description}</p>
                  <p className="text-small text-muted">
                    {formatDate(tx.date)} · {accountLabel(tx)}
                  </p>
                  <div className="mt-1.5">
                    <CategoryBadge category={tx.category} />
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <Amount tx={tx} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {query.hasNextPage && (
        <Button variant="secondary" className="self-center" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          Daha eski hareketleri yükle
        </Button>
      )}
    </div>
  );
}
