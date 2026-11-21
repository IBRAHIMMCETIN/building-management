import { FileText, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FilterChips, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useInvoiceAction, usePlatformInvoices } from '@/hooks/usePayments';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { InvoiceStatus, PlatformInvoice } from '@/lib/api/payments';
import { formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { invoiceNumberError, invoiceStatusLabel, invoiceStatusTone, periodLabel, recentPeriods, vatLabel } from '@/lib/payments/platform';
import { noteError } from '@/lib/payments/review';

type Filter = 'all' | InvoiceStatus;
const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: 'Tümü' },
  { value: 'NEEDS_RECIPIENT', label: 'VKN eksik' },
  { value: 'DRAFT', label: 'Taslak' },
  { value: 'ISSUED', label: 'Kesildi' },
  { value: 'CANCELLED', label: 'İptal' },
];

type Action = { kind: 'issue' | 'cancel'; invoice: PlatformInvoice };

function ActionDialog({ action, onClose }: { action: Action | null; onClose: () => void }) {
  const mutate = useInvoiceAction();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();
  const inv = action?.invoice;
  const issuing = action?.kind === 'issue';

  useEffect(() => {
    setText('');
    setError(undefined);
    mutate.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [action]);

  const submit = async () => {
    if (!action || !inv) return;
    const e = issuing ? invoiceNumberError(text) : noteError(text);
    if (e) {
      setError(e);
      return;
    }
    try {
      await mutate.mutateAsync(
        issuing
          ? { kind: 'issue', apartmentId: inv.apartmentId, invoiceId: inv.invoiceId, expectedVersion: inv.version, invoiceNumber: text.trim() }
          : { kind: 'cancel', apartmentId: inv.apartmentId, invoiceId: inv.invoiceId, expectedVersion: inv.version, reason: text.trim() },
      );
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.field) setError(err.message);
    }
  };

  return (
    <Dialog open={action !== null} onClose={onClose} title={issuing ? 'Kesildi olarak işaretle' : 'Taslağı iptal et'}>
      {inv && (
        <div className="flex flex-col gap-4">
          <p className="text-small text-muted">
            <strong className="text-text">{inv.apartmentName ?? inv.apartmentId}</strong> · {inv.invoiceId} · toplam {formatTRY(inv.totalAmount)} (
            {vatLabel(inv.vatMode, inv.vatRateBasisPoints)})
          </p>
          {issuing ? (
            <>
              <Alert>
                Faturayı e-Fatura / e-Arşiv portalında (veya muhasebe yazılımında) aşağıdaki tutarlarla kestikten sonra numarasını girin. Muhatap:{' '}
                {inv.recipient ? `${inv.recipient.title} · VKN ${inv.recipient.taxNumber} · ${inv.recipient.taxOffice}` : '—'}. Matrah{' '}
                {formatTRY(inv.netAmount)}, KDV {formatTRY(inv.vatAmount)}, toplam {formatTRY(inv.totalAmount)}.
              </Alert>
              <FormField label="Fatura numarası" error={error} hint="Örn. ABC2026000000123 (3-40 karakter; harf, rakam, / _ -)">
                <Input
                  autoComplete="off"
                  spellCheck={false}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setError(undefined);
                  }}
                />
              </FormField>
            </>
          ) : (
            <FormField label="Gerekçe" error={error} hint="Yalnızca kesilmemiş taslak iptal edilir; kesilmiş fatura için iade faturası düzenleyin.">
              <Textarea
                rows={3}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setError(undefined);
                }}
              />
            </FormField>
          )}
          {mutate.isError && !(mutate.error instanceof ApiError && mutate.error.status === 400 && mutate.error.field) && (
            <Alert tone="danger">{errorMessage(mutate.error)}</Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Vazgeç
            </Button>
            <Button variant={issuing ? 'primary' : 'danger'} loading={mutate.isPending} onClick={() => void submit()}>
              {issuing ? 'Kesildi olarak kaydet' : 'İptal et'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function InvoiceRow({ inv, onAction, onError }: { inv: PlatformInvoice; onAction: (a: Action) => void; onError: (m: string | null) => void }) {
  const redraft = useInvoiceAction();
  const open = inv.status === 'DRAFT' || inv.status === 'NEEDS_RECIPIENT';
  const regenerate = () => {
    onError(null);
    redraft.mutate({ kind: 'draft', apartmentId: inv.apartmentId, period: inv.period }, { onError: (err) => onError(errorMessage(err)) });
  };
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{inv.apartmentName ?? inv.apartmentId}</p>
          <Badge tone={invoiceStatusTone(inv.status)}>{invoiceStatusLabel(inv.status)}</Badge>
          <Badge>{inv.mode === 'monthly' ? 'Aylık' : 'Ödeme bazlı'}</Badge>
          <span className="font-semibold tabular-nums">{formatTRY(inv.totalAmount)}</span>
        </div>
        <p className="text-small text-muted">
          {inv.invoiceId} · {inv.lines.length} ödeme · matrah {formatTRY(inv.netAmount)} · KDV {formatTRY(inv.vatAmount)} ·{' '}
          {vatLabel(inv.vatMode, inv.vatRateBasisPoints)}
        </p>
        {inv.status === 'NEEDS_RECIPIENT' && (
          <p className="text-small text-warning">
            Fatura muhatabı (VKN) eksik. Ödeme Hesapları ekranında “Ayarlar”dan VKN girip taslağı yenileyin.
          </p>
        )}
        {inv.status === 'ISSUED' && (
          <p className="text-small text-muted">
            No {inv.invoiceNumber} · {inv.issuedAt && formatDateTime(inv.issuedAt)}
          </p>
        )}
        {inv.status === 'CANCELLED' && inv.cancelReason && <p className="text-small text-muted">İptal: {inv.cancelReason}</p>}
      </div>
      {open && (
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button size="xs" variant="subtle" loading={redraft.isPending} onClick={regenerate}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Taslağı yenile
          </Button>
          <Button size="xs" variant="ghost" onClick={() => onAction({ kind: 'cancel', invoice: inv })}>
            İptal
          </Button>
          <Button size="xs" disabled={inv.status !== 'DRAFT'} onClick={() => onAction({ kind: 'issue', invoice: inv })}>
            Kesildi
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Platform yoneticisi: platform komisyon faturasi taslaklari. Taslaklar aylik (veya odeme bazli)
 * zamanlanmis gorevle uretilir; fatura disarida kesilir, numarasi burada girilir.
 */
export function PlatformInvoicesPage() {
  const periods = useMemo(() => recentPeriods(new Date(), 13), []);
  // Varsayilan: gecen ay (aylik taslak ay basinda olusur).
  const [period, setPeriod] = useState(periods[1] ?? periods[0] ?? '');
  const [filter, setFilter] = useState<Filter>('all');
  const [action, setAction] = useState<Action | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const list = usePlatformInvoices(period);

  const items = useMemo(() => (list.data?.items ?? []).filter((i) => filter === 'all' || i.status === filter), [list.data, filter]);
  const missing = (list.data?.items ?? []).filter((i) => i.status === 'NEEDS_RECIPIENT').length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="inline-flex items-center gap-2 text-title font-bold">
            <FileText className="size-5" aria-hidden="true" />
            Komisyon faturaları
          </h1>
          <p className="text-small text-muted">
            Online ödemelerden kesilen platform payının apartmanlara faturası. Varsayılan: kesilen pay KDV dahil; fatura toplamı apartman defterindeki
            platform payı gideriyle aynıdır.
          </p>
        </div>
        <label className="flex items-center gap-2 text-small sm:w-56">
          <span className="shrink-0 text-muted">Dönem</span>
          <Select value={period} onChange={(e) => setPeriod(e.target.value)}>
            {periods.map((p) => (
              <option key={p} value={p}>
                {periodLabel(p)}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {list.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : list.isError ? (
        <Card className="flex flex-col items-start gap-3">
          <Alert tone="danger">{errorMessage(list.error)}</Alert>
          <Button variant="secondary" onClick={() => void list.refetch()}>
            Tekrar dene
          </Button>
        </Card>
      ) : (
        <Card className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <p className="text-small text-muted">Matrah</p>
              <p className="text-lg font-semibold tabular-nums">{formatTRY(list.data.totals.net)}</p>
            </div>
            <div>
              <p className="text-small text-muted">KDV</p>
              <p className="text-lg font-semibold tabular-nums">{formatTRY(list.data.totals.vat)}</p>
            </div>
            <div>
              <p className="text-small text-muted">Toplam (iptaller hariç)</p>
              <p className="text-lg font-semibold tabular-nums">{formatTRY(list.data.totals.total)}</p>
            </div>
          </div>
          {missing > 0 && <Alert tone="danger">{missing} apartmanın fatura muhatabı (VKN) eksik; bu taslaklar kesilemez.</Alert>}
          {rowError && <Alert tone="danger">{rowError}</Alert>}
          <FilterChips<Filter> label="Fatura durumu" value={filter} onChange={setFilter} options={FILTERS} />
          {items.length === 0 ? (
            <p className="py-4 text-center text-small text-muted">
              {list.data.items.length === 0 ? `${periodLabel(period)} için taslak yok.` : 'Bu filtreye uyan fatura yok.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Komisyon faturaları">
              {items.map((inv) => (
                <InvoiceRow key={`${inv.apartmentId}:${inv.invoiceId}`} inv={inv} onAction={setAction} onError={setRowError} />
              ))}
            </ul>
          )}
        </Card>
      )}
      <ActionDialog action={action} onClose={() => setAction(null)} />
    </div>
  );
}
