import { ChevronDown, ChevronRight, FileText, HandCoins, Wallet } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Dialog, FormField, Input, Select, Skeleton } from '@/components/ui';
import { useFinanceAccounts, usePayables, useRecordPayablePayment } from '@/hooks/useFinance';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { errorMessage } from '@/lib/api/errors';
import type { PayableAccount } from '@/lib/api/finance';
import { payablePaymentState } from '@/lib/bank/payable';
import { formatDate } from '@/lib/dates';
import { formatTRY, kurusToInput, parseTRYToKurus } from '@/lib/money';
import { SupplierAdvanceDialog, SupplierAdvancesList, SupplierStatementDialog } from './SupplierAdvances';

const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

/**
 * Faz B3.5 - Tedarikci bakiyeleri: vadeli giderlerden dogan acik borclar ve acik faturalar.
 * Odeme banka ekstresinden ("Tedarikci Odemesi") veya buradan elle kaydedilir. Finans 2.2 sonrasi:
 * fatura oncesi odeme avans olarak verilir, faturaya mahsup edilir; ekstre avanslari da gosterir.
 */
export function PayablesPanel({ canWrite }: { canWrite: boolean }) {
  const payables = usePayables();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [paying, setPaying] = useState<PayableAccount | null>(null);
  const [advancing, setAdvancing] = useState<PayableAccount | null>(null);
  const [statement, setStatement] = useState<PayableAccount | null>(null);

  if (payables.isPending) return <Skeleton className="h-40 w-full" />;
  if (payables.isError) return <Alert tone="danger">{errorMessage(payables.error)}</Alert>;
  const items = payables.data.items;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-6">
          <div>
            <p className="text-small text-muted">Toplam açık tedarikçi borcu</p>
            <p className="text-xl font-semibold tabular-nums">{formatTRY(payables.data.totalOpen)}</p>
          </div>
          {payables.data.totalAdvanceOpen > 0 && (
            <div>
              <p className="text-small text-muted">Mahsup bekleyen avans</p>
              <p className="text-xl font-semibold tabular-nums">{formatTRY(payables.data.totalAdvanceOpen)}</p>
            </div>
          )}
        </div>
        <p className="max-w-md text-xs text-muted">
          Tedarikçi borcu, “Gider ekle” ile ödeme hesabı olarak tedarikçi (vadeli) seçildiğinde oluşur. Bankadan yapılan ödemeyi Banka sekmesindeki
          kuyrukta “Tedarikçi Ödemesi” ile eşleştirin. Fatura gelmeden yapılan ödemeyi “Avans ver” ile kaydedin.
        </p>
      </Card>

      {items.length === 0 ? (
        <Alert tone="info">Tedarikçi hesabı yok.</Alert>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-left text-small">
            <caption className="sr-only">Tedarikçi bakiyeleri</caption>
            <thead className="border-b border-border text-xs text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Tedarikçi</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Faturalanan</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Ödenen</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Açık borç</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Açık avans</th>
                <th scope="col" className="px-4 py-2 font-medium">Son ödeme</th>
                <th scope="col" className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((p) => {
                const isOpen = expanded === p.accountId;
                return (
                  <PayableRows
                    key={p.accountId}
                    payable={p}
                    isOpen={isOpen}
                    canWrite={canWrite}
                    onToggle={() => setExpanded(isOpen ? null : p.accountId)}
                    onPay={() => setPaying(p)}
                    onAdvance={() => setAdvancing(p)}
                    onStatement={() => setStatement(p)}
                  />
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {canWrite && <PayablePaymentDialog payable={paying} onClose={() => setPaying(null)} />}
      {canWrite && <SupplierAdvanceDialog payable={advancing} onClose={() => setAdvancing(null)} />}
      <SupplierStatementDialog payable={statement} onClose={() => setStatement(null)} />
    </div>
  );
}

function PayableRows(props: {
  payable: PayableAccount;
  isOpen: boolean;
  canWrite: boolean;
  onToggle: () => void;
  onPay: () => void;
  onAdvance: () => void;
  onStatement: () => void;
}) {
  const p = props.payable;
  return (
    <>
      <tr>
        <td className="px-4 py-2">
          <button type="button" className="flex items-center gap-1 font-medium" aria-expanded={props.isOpen} onClick={props.onToggle}>
            {props.isOpen ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
            {p.name}
            {p.status !== 'active' && <span className="text-xs text-muted"> (pasif)</span>}
          </button>
        </td>
        <td className="px-4 py-2 text-right tabular-nums">{p.billed !== undefined ? formatTRY(p.billed) : '—'}</td>
        <td className="px-4 py-2 text-right tabular-nums">{p.paid !== undefined ? formatTRY(p.paid) : '—'}</td>
        <td className={`px-4 py-2 text-right font-semibold tabular-nums ${p.openBalance > 0 ? 'text-warning' : 'text-success'}`}>{formatTRY(p.openBalance)}</td>
        <td className="px-4 py-2 text-right tabular-nums">{p.advanceOpen > 0 ? formatTRY(p.advanceOpen) : <span className="text-muted">—</span>}</td>
        <td className="px-4 py-2 text-muted">{p.lastPaymentDate ? formatDate(p.lastPaymentDate) : '—'}</td>
        <td className="px-4 py-2 text-right">
          <span className="flex flex-wrap justify-end gap-2">
            {props.canWrite && p.openBalance > 0 && p.status === 'active' && (
              <Button size="xs" variant="secondary" onClick={props.onPay}>
                <Wallet className="size-3.5" aria-hidden="true" />
                Ödeme yap
              </Button>
            )}
            {props.canWrite && p.status === 'active' && (
              <Button size="xs" variant="ghost" onClick={props.onAdvance}>
                <HandCoins className="size-3.5" aria-hidden="true" />
                Avans ver
              </Button>
            )}
            <Button size="xs" variant="ghost" onClick={props.onStatement}>
              <FileText className="size-3.5" aria-hidden="true" />
              Ekstre
            </Button>
          </span>
        </td>
      </tr>
      {props.isOpen && (
        <tr>
          <td colSpan={7} className="bg-surface-muted/40 px-6 py-2">
            {p.openItems.length === 0 ? (
              <p className="text-xs text-muted">Açık fatura yok.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-xs">
                {p.openItems.map((i) => (
                  <li key={i.transactionId} className="flex justify-between gap-3">
                    <span>
                      {formatDate(i.date)} · {i.description}
                      {i.reference ? ` · ${i.reference}` : ''}
                    </span>
                    <span className="tabular-nums">
                      {formatTRY(i.open)}
                      {i.open !== i.amount ? ` / ${formatTRY(i.amount)}` : ''}
                      {i.advanceApplied ? <span className="block text-right text-muted">avans mahsubu {formatTRY(i.advanceApplied)}</span> : null}
                    </span>
                  </li>
                ))}
                {(p.openItemCount ?? 0) > p.openItems.length && <li className="text-muted">… ve {(p.openItemCount ?? 0) - p.openItems.length} fatura daha</li>}
              </ul>
            )}
            <SupplierAdvancesList payable={p} canWrite={props.canWrite} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Elle tedarikci odemesi (kasa veya bankadan). Fazla odeme reddedilir. */
function PayablePaymentDialog({ payable, onClose }: { payable: PayableAccount | null; onClose: () => void }) {
  const funds = useFinanceAccounts();
  const record = useRecordPayablePayment();
  const [key, renewKey] = useIdempotencyKey();
  const [fundsAccountId, setFundsAccountId] = useState('bank');
  const [amountText, setAmountText] = useState('');
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState('');
  const fundOptions = useMemo(() => (funds.data ?? []).filter((a) => a.type === 'bank' || a.type === 'cash'), [funds.data]);

  useEffect(() => {
    if (!payable) return;
    record.reset();
    setAmountText(kurusToInput(payable.openBalance));
    setDate(todayIso());
    setDescription('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payable?.accountId]);

  if (!payable) return null;
  const amount = parseTRYToKurus(amountText);
  const state = payablePaymentState({ amount, openBalance: payable.openBalance, fundsAccountId, date });

  return (
    <Dialog open={Boolean(payable)} onClose={onClose} title={`Tedarikçi ödemesi · ${payable.name}`}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!state.valid || amount === null) return;
          try {
            await record.mutateAsync({
              accountId: payable.accountId,
              input: { idempotencyKey: key, fundsAccountId, amount, date, ...(description.trim() ? { description: description.trim() } : {}) },
            });
            renewKey();
            onClose();
          } catch {
            // asagida gosterilir
          }
        }}
      >
        <p className="text-small text-muted">Açık borç: {formatTRY(payable.openBalance)}</p>
        <FormField label="Ödeme hesabı">
          <Select value={fundsAccountId} onChange={(e) => setFundsAccountId(e.target.value)}>
            {fundOptions.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name} ({formatTRY(a.balance)})
              </option>
            ))}
          </Select>
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Tutar (₺)">
            <Input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
          </FormField>
          <FormField label="Tarih">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Açıklama (isteğe bağlı)">
          <Input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
        {!state.valid && state.error && amountText !== '' && <Alert tone="danger">{state.error}</Alert>}
        {record.isError && <Alert tone="danger">{errorMessage(record.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button type="submit" loading={record.isPending} disabled={!state.valid}>
            Ödemeyi kaydet
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
