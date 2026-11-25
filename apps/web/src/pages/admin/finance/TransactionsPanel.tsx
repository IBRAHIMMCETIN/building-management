import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, FileText, Paperclip, ReceiptText, Undo2 } from 'lucide-react';
import { type ComponentType, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FilterChips, FormField, Skeleton, Textarea } from '@/components/ui';
import { useAccountLabels } from '@/hooks/useAccountLabels';
import { useFinancePermissions, useTransactions } from '@/hooks/useFinance';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { useOffsets, useReverseOffset } from '@/hooks/useRestructure';
import { documentsApi } from '@/lib/api/documents';
import { errorMessage } from '@/lib/api/errors';
import { CATEGORY_LABELS, type LedgerTransaction, type TransactionCategory } from '@/lib/api/finance';
import type { AccountOffset } from '@/lib/api/restructure';
import { cn } from '@/lib/cn';
import { PARTY_LABELS } from '@/lib/finance/accountLabel';
import { formatSignedTRY, formatTRY } from '@/lib/money';
import { reasonError } from '@/lib/restructure/model';
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

type Labels = ReturnType<typeof useAccountLabels>;
/** Islemle iliskili mahsup kaydi: mahsup islemi mi (`offset`), onun ters kaydi mi (`reversal`). */
type OffsetLink = { offset: AccountOffset; role: 'offset' | 'reversal' };

/** UX-01: "İlgili Hesap" sutunu; ham kimlik yerine "Blok · Daire Taraf". */
function accountLabel(tx: LedgerTransaction, labels: Labels, link?: OffsetLink): string {
  if (link) return `${labels.unitLabel(link.offset.sourceUnitId)} → ${labels.unitLabel(link.offset.targetUnitId)}`;
  if (tx.funds.length === 0) {
    if (!tx.unitId && !tx.unitNumber) return 'Cari hesap';
    const unit = labels.unitLabel(tx.unitId, tx.unitNumber ? `Daire ${tx.unitNumber}` : undefined);
    return tx.liableParty ? `${unit} ${PARTY_LABELS[tx.liableParty]}` : `${unit} cari`;
  }
  return [...new Set(tx.funds.map((f) => labels.text(f.accountName)))].join(' → ');
}

/** UX-01: aciklamadaki daire / kisi kimlikleri cozulur; mahsupta kaynak → hedef cari etiketiyle yeniden yazilir. */
function describe(tx: LedgerTransaction, labels: Labels, link?: OffsetLink): string {
  if (!link) return labels.text(tx.description);
  const base = `Avans mahsubu: ${labels.labelOf(link.offset.sourceAccountId)} → ${labels.labelOf(link.offset.targetAccountId)}`;
  return link.role === 'reversal' ? `Ters kayıt: ${base}` : base;
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

function Details({ tx, labels, link }: { tx: LedgerTransaction; labels: Labels; link?: OffsetLink }) {
  const bits = [
    // Tahsilat aciklamasi daireyi zaten icerir; digerlerinde (ters kayit vb.) goster.
    tx.unitNumber && tx.funds.length > 0 && tx.kind !== 'payment' ? labels.unitLabel(tx.unitId, `Daire ${tx.unitNumber}`) : undefined,
    tx.dueDate ? `Son ödeme ${formatDate(tx.dueDate)}` : undefined,
    // Referans yalnizca giderde fatura numarasidir (mahsup / online tahsilat referanslari teknik).
    tx.reference && (tx.kind === 'expense' || tx.kind === 'payable_payment') ? `Fatura ${tx.reference}` : undefined,
    tx.reason ? `Neden: ${labels.text(tx.reason)}` : undefined,
    link?.role === 'offset' && link.offset.status === 'reversed' ? 'Ters kayıtla geri alındı' : undefined,
  ].filter(Boolean);
  return bits.length ? <span className="block text-small text-muted">{bits.join(' · ')}</span> : null;
}

type DocOpener = ReturnType<typeof useOpenDocument>;

/** Makbuz (tahsilat) ve fatura (gider) baglantilari. Yoksa hicbir sey cizilmez. */
function DocumentButtons({ tx, docs }: { tx: LedgerTransaction; docs: DocOpener }) {
  if (!tx.hasReceipt && !tx.invoice) return null;
  const busy = docs.pendingId === tx.transactionId;
  return (
    <span className="mt-1.5 -ml-2.5 flex flex-wrap gap-1">
      {tx.hasReceipt && (
        <Button
          size="xs"
          variant="subtle"
          loading={busy}
          onClick={() => void docs.open(tx.transactionId, () => documentsApi.receiptForTransaction(tx.transactionId))}
        >
          {!busy && <ReceiptText className="size-3.5" aria-hidden="true" />}
          Makbuz
        </Button>
      )}
      {tx.invoice && (
        <Button
          size="xs"
          variant="subtle"
          loading={busy}
          title={tx.invoice.fileName}
          onClick={() => void docs.open(tx.transactionId, () => documentsApi.invoiceForTransaction(tx.transactionId))}
        >
          {!busy && <Paperclip className="size-3.5" aria-hidden="true" />}
          Fatura
        </Button>
      )}
    </span>
  );
}

/**
 * UX-03: mahsup satirindan dogrudan ters kayit. Sunucu (offsets.reverse) kaynak avansi ve hedef
 * borcu / taksit kalanlarini eski haline getirir; kapanmis caride reddeder.
 */
function ReverseOffsetDialog({ offset, description, onClose }: { offset: AccountOffset | null; description: string; onClose: () => void }) {
  const reverse = useReverseOffset();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!offset) return;
    setReason('');
    setTouched(false);
    reverse.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [offset?.offsetId]);

  const submit = async () => {
    setTouched(true);
    if (!offset || reasonError(reason)) return;
    try {
      await reverse.mutateAsync({ offsetId: offset.offsetId, reason: reason.trim() });
      onClose();
    } catch {
      // asagida gosterilir
    }
  };

  return (
    <Dialog open={!!offset} onClose={() => !reverse.isPending && onClose()} title="Mahsubu ters kayıtla geri al" className="max-w-lg">
      {offset && (
        <div className="flex flex-col gap-3">
          <p className="text-small">
            {description} · <strong className="tabular-nums">{formatTRY(offset.amount)}</strong> ({formatDate(offset.date)})
          </p>
          <p className="text-small text-muted">
            Mahsup kaydı silinmez; aynı tutarda ters kayıt yazılır. Kaynak carinin avansı ve hedef carinin açık borcu / taksit kalanları mahsup öncesi
            tutarlarına döner.
          </p>
          <FormField label="Gerekçe" error={touched ? reasonError(reason) : undefined}>
            <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Örn. Yanlış cariye mahsup edildi" />
          </FormField>
          {reverse.isError && <Alert tone="danger">{errorMessage(reverse.error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={reverse.isPending}>
              Vazgeç
            </Button>
            <Button variant="danger" loading={reverse.isPending} onClick={() => void submit()}>
              <Undo2 className="size-4" aria-hidden="true" />
              Ters kaydı yaz
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function ReverseButton({ link, canWrite, onReverse }: { link?: OffsetLink; canWrite: boolean; onReverse: (o: AccountOffset) => void }) {
  if (!canWrite || link?.role !== 'offset' || link.offset.status !== 'completed') return null;
  return (
    <Button size="xs" variant="ghost" onClick={() => onReverse(link.offset)}>
      <Undo2 className="size-3.5" aria-hidden="true" />
      Ters kayıt
    </Button>
  );
}

export function TransactionsPanel() {
  const [filter, setFilter] = useState<Filter>('all');
  const { canWrite } = useFinancePermissions();
  const docs = useOpenDocument();
  const query = useTransactions();
  const labels = useAccountLabels();
  const offsets = useOffsets();
  const [reversing, setReversing] = useState<AccountOffset | null>(null);
  const all = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const visible = filter === 'all' ? all : all.filter((t) => t.category === filter);
  const links = useMemo(() => {
    const m = new Map<string, OffsetLink>();
    for (const o of offsets.data ?? []) {
      m.set(o.transactionId, { offset: o, role: 'offset' });
      if (o.reversal) m.set(o.reversal.transactionId, { offset: o, role: 'reversal' });
    }
    return m;
  }, [offsets.data]);
  const linkOf = (tx: LedgerTransaction) => links.get(tx.transactionId);

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
      {docs.error && <Alert tone="danger">{docs.error}</Alert>}
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
          <div className="hidden overflow-x-auto rounded-xl border border-border bg-surface/60 shadow-sm backdrop-blur-sm md:block">
            <table className="w-full text-left text-small">
              <caption className="sr-only">Defter hareketleri</caption>
              <thead className="border-b border-border bg-surface-muted/50 text-xs tracking-wide text-muted uppercase">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Tarih</th>
                  <th scope="col" className="px-4 py-3 font-medium">Açıklama</th>
                  <th scope="col" className="px-4 py-3 font-medium">İlgili Hesap</th>
                  <th scope="col" className="px-4 py-3 font-medium">Tür</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Tutar</th>
                  {canWrite && (
                    <th scope="col" className="px-4 py-3">
                      <span className="sr-only">İşlem</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-text-secondary [&>tr]:transition-colors [&>tr:hover]:bg-surface-muted/40">
                {visible.map((tx) => (
                  <tr key={tx.transactionId} className="align-top">
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums">{formatDate(tx.date)}</td>
                    <td className="px-4 py-3">
                      {describe(tx, labels, linkOf(tx))}
                      <Details tx={tx} labels={labels} link={linkOf(tx)} />
                      <DocumentButtons tx={tx} docs={docs} />
                    </td>
                    <td className="px-4 py-3">{accountLabel(tx, labels, linkOf(tx))}</td>
                    <td className="px-4 py-3">
                      <CategoryBadge category={tx.category} />
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <Amount tx={tx} />
                    </td>
                    {canWrite && (
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <ReverseButton link={linkOf(tx)} canWrite={canWrite} onReverse={setReversing} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="flex flex-col gap-2 md:hidden" aria-label="Defter hareketleri">
            {visible.map((tx) => (
              <li key={tx.transactionId} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface/60 p-4 shadow-sm backdrop-blur-sm transition-colors hover:border-border-strong">
                <div className="min-w-0">
                  <p className="truncate font-medium">{describe(tx, labels, linkOf(tx))}</p>
                  <p className="text-small text-muted">
                    {formatDate(tx.date)} · {accountLabel(tx, labels, linkOf(tx))}
                  </p>
                  <div className="mt-1.5">
                    <CategoryBadge category={tx.category} />
                  </div>
                  <DocumentButtons tx={tx} docs={docs} />
                  <ReverseButton link={linkOf(tx)} canWrite={canWrite} onReverse={setReversing} />
                </div>
                <div className="shrink-0 text-right">
                  <Amount tx={tx} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <ReverseOffsetDialog
        offset={reversing}
        description={reversing ? `Avans mahsubu: ${labels.labelOf(reversing.sourceAccountId)} → ${labels.labelOf(reversing.targetAccountId)}` : ''}
        onClose={() => setReversing(null)}
      />

      {query.hasNextPage && (
        <Button variant="secondary" className="self-center" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          Daha eski hareketleri yükle
        </Button>
      )}
    </div>
  );
}
