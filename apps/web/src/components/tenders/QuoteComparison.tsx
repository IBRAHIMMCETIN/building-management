import { FileText, Trophy } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Button } from '@/components/ui';
import type { SignedDownload } from '@/lib/api/documentModel';
import type { Quote, Tender } from '@/lib/api/tenders';
import { cn } from '@/lib/cn';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { comparisonColumns, formatBps, warrantyText } from '@/lib/tenders/model';
import { useOpenDocument } from '@/hooks/useOpenDocument';

type Props = {
  tender: Pick<Tender, 'quotes' | 'comparison' | 'decision'>;
  loadDocument: (quoteId: string) => Promise<SignedDownload>;
  /** Yonetim: teklif basina duzenle / geri cek dugmeleri. */
  actions?: (quote: Quote) => ReactNode;
};

type Row = { label: string; cell: (q: Quote, c: ReturnType<typeof comparisonColumns>['columns'][number]['row']) => ReactNode; strong?: boolean };

const ROWS: Row[] = [
  { label: 'KDV dahil toplam', strong: true, cell: (_q, r) => formatTRY(r.totalKurus) },
  { label: 'KDV hariç (matrah)', cell: (_q, r) => formatTRY(r.netKurus) },
  { label: 'KDV', cell: (q, r) => `${formatTRY(r.vatKurus)} (%${q.vatRate})` },
  { label: 'Teklifteki tutar', cell: (q) => `${formatTRY(q.amountKurus)} ${q.vatIncluded ? 'KDV dahil' : '+ KDV'}` },
  { label: 'En düşüğe göre', cell: (_q, r) => (r.diffKurus ? `+${formatTRY(r.diffKurus)} (${formatBps(r.diffBps)})` : '—') },
  { label: 'İş süresi', cell: (q) => (q.deliveryDays !== undefined ? `${q.deliveryDays} gün` : '—') },
  { label: 'Garanti', cell: (q) => (q.warrantyMonths === undefined ? '—' : q.warrantyMonths ? warrantyText(q.warrantyMonths) : 'Yok') },
  { label: 'Geçerlilik', cell: (q) => (q.validUntil ? formatDate(q.validUntil) : '—') },
  { label: 'Not', cell: (q) => (q.notes ? <span className="whitespace-pre-line break-words">{q.notes}</span> : '—') },
];

/**
 * Teklifler yan yana: her sutun bir teklif (KDV dahil toplama gore artan), en dusuk toplam
 * vurgulu. Farkli KDV oranlari / dahil-haric girisler ayni olcuye (KDV dahil) cevrilmistir.
 * Dar ekranda tablo kendi kutusunda yatay kayar; sayfa kaymaz.
 */
export function QuoteComparison({ tender, loadDocument, actions }: Props) {
  const { columns, withdrawn } = comparisonColumns(tender);
  const doc = useOpenDocument();
  const selectedId = tender.decision?.quoteId;

  if (!columns.length && !withdrawn.length) return <p className="py-6 text-center text-small text-muted">Henüz teklif eklenmedi.</p>;

  return (
    <div className="flex flex-col gap-3">
      {doc.error && <p className="text-small text-danger">{doc.error}</p>}
      {columns.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-max border-collapse text-small">
            <caption className="sr-only">Teklif karşılaştırması (KDV dahil toplama göre sıralı)</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="sticky left-0 z-10 bg-surface px-3 py-2 text-left text-xs font-medium text-muted">
                  Teklif
                </th>
                {columns.map(({ quote, row }) => (
                  <th key={quote.quoteId} scope="col" className={cn('min-w-44 px-3 py-2 text-left align-top', row.isLowest && 'bg-success/10')}>
                    <span className="flex flex-col gap-1">
                      <span className="font-semibold break-words text-text">{quote.supplierName}</span>
                      <span className="flex flex-wrap gap-1">
                        {row.isLowest && (
                          <Badge tone="success">
                            <Trophy className="size-3" aria-hidden="true" />
                            En düşük
                          </Badge>
                        )}
                        {selectedId === quote.quoteId && <Badge tone="accent">Seçilen teklif</Badge>}
                        {!row.isLowest && <span className="text-xs font-normal text-muted">{row.rank}. sırada</span>}
                      </span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.label} className="border-b border-border last:border-b-0">
                  <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-muted">
                    {r.label}
                  </th>
                  {columns.map(({ quote, row }) => (
                    <td key={quote.quoteId} className={cn('px-3 py-2 align-top tabular-nums', row.isLowest && 'bg-success/10', r.strong && 'text-body font-semibold')}>
                      {r.cell(quote, row)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-2 text-left text-xs font-medium text-muted">
                  Belge
                </th>
                {columns.map(({ quote, row }) => (
                  <td key={quote.quoteId} className={cn('px-3 py-2 align-top', row.isLowest && 'bg-success/10')}>
                    <span className="flex flex-col items-start gap-1">
                      {quote.document ? (
                        <Button size="xs" variant="secondary" loading={doc.pendingId === quote.quoteId} onClick={() => void doc.open(quote.quoteId, () => loadDocument(quote.quoteId))}>
                          <FileText className="size-3.5" aria-hidden="true" />
                          Teklifi aç
                        </Button>
                      ) : (
                        <span className="text-xs text-muted">Belge yok</span>
                      )}
                      {actions?.(quote)}
                    </span>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {withdrawn.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-small font-semibold">Geri çekilen teklifler</h3>
          <ul className="flex flex-col gap-2">
            {withdrawn.map((q) => (
              <li key={q.quoteId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-small">
                <span className="font-medium">{q.supplierName}</span>
                <span className="text-muted tabular-nums">{formatTRY(q.totalKurus)} KDV dahil</span>
                {q.withdrawReason && <span className="text-muted">· {q.withdrawReason}</span>}
                {q.withdrawnAt && <span className="text-xs text-muted">{formatDateTime(q.withdrawnAt)}</span>}
                {q.document && (
                  <Button size="xs" variant="subtle" className="ml-auto" loading={doc.pendingId === q.quoteId} onClick={() => void doc.open(q.quoteId, () => loadDocument(q.quoteId))}>
                    <FileText className="size-3.5" aria-hidden="true" />
                    Belge
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
