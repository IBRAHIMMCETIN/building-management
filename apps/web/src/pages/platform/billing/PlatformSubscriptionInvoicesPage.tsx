import { CircleCheck, FileDown, Receipt, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FilterChips, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { useBillingAction, usePlatformSubscriptionInvoices } from '@/hooks/useSubscriptions';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { type InvoicePaymentMethod, PAYMENT_METHODS, type SubscriptionInvoice, type SubscriptionInvoiceStatus, subscriptionsApi } from '@/lib/api/subscriptions';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { noteError } from '@/lib/payments/review';
import { INVOICE_STATUS_LABELS, INVOICE_STATUS_TONES, METHOD_LABELS, PERIOD_LABELS, vatText } from '@/lib/subscriptions/model';

type Filter = 'all' | SubscriptionInvoiceStatus;
const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: 'Tümü' },
  { value: 'issued', label: 'Ödeme bekliyor' },
  { value: 'paid', label: 'Ödendi' },
  { value: 'void', label: 'İptal' },
];

type Action = { kind: 'paid' | 'void'; invoice: SubscriptionInvoice };

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

function ActionDialog({ action, onClose }: { action: Action | null; onClose: () => void }) {
  const mutate = useBillingAction();
  const [method, setMethod] = useState<InvoicePaymentMethod>('bank_transfer');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<{ reference?: string; paidOn?: string; text?: string }>({});
  const inv = action?.invoice;
  const paying = action?.kind === 'paid';

  useEffect(() => {
    setMethod('bank_transfer');
    setReference('');
    setPaidOn(today());
    setText('');
    setErrors({});
    mutate.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [action]);

  const submit = async () => {
    if (!action || !inv) return;
    const next: typeof errors = {};
    if (paying) {
      const ref = reference.trim();
      if (ref.length < 3 || ref.length > 100) next.reference = 'Referans 3-100 karakter olmalı (dekont / işlem no).';
      if (!paidOn || paidOn > today()) next.paidOn = 'Bugün veya önceki bir gün seçin.';
      if (text.trim().length > 500) next.text = 'Not en fazla 500 karakter olabilir.';
    } else {
      next.text = noteError(text);
    }
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    try {
      await mutate.mutateAsync(
        paying
          ? {
              kind: 'paid',
              apartmentId: inv.apartmentId,
              invoiceId: inv.invoiceId,
              input: { version: inv.version, method, reference: reference.trim(), paidOn, ...(text.trim() ? { note: text.trim() } : {}) },
            }
          : { kind: 'void', apartmentId: inv.apartmentId, invoiceId: inv.invoiceId, input: { version: inv.version, reason: text.trim() } },
      );
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.field === 'reference') setErrors((x) => ({ ...x, reference: err.message }));
    }
  };

  return (
    <Dialog open={action !== null} onClose={onClose} title={paying ? 'Ödendi olarak işaretle' : 'Faturayı iptal et'}>
      {inv && (
        <div className="flex flex-col gap-4">
          <p className="text-small text-muted">
            <strong className="text-text">{inv.siteName}</strong> · {inv.invoiceNumber} · toplam {formatTRY(inv.totalKurus)} (KDV {vatText(inv.vatRateBps)} dahil) ·
            son ödeme {formatDate(inv.dueDate)}
          </p>
          {paying ? (
            <>
              <Alert>Ödeme alındıysa kaydedin; gecikmiş veya ödeme nedeniyle askıya alınmış abonelik aynı anda yeniden açılır.</Alert>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Ödeme yöntemi">
                  <Select value={method} onChange={(e) => setMethod(e.target.value as InvoicePaymentMethod)}>
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {METHOD_LABELS[m]}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Ödeme tarihi" error={errors.paidOn}>
                  <Input type="date" max={today()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
                </FormField>
              </div>
              <FormField label="Referans" error={errors.reference} hint="Dekont, EFT sorgu no veya makbuz no.">
                <Input autoComplete="off" spellCheck={false} value={reference} onChange={(e) => setReference(e.target.value)} />
              </FormField>
            </>
          ) : (
            <Alert tone="danger">İptal edilen fatura yeniden açılamaz; kesilmiş resmi fatura için ayrıca iade faturası düzenleyin.</Alert>
          )}
          <FormField label={paying ? 'Not (isteğe bağlı)' : 'Gerekçe'} error={errors.text} hint={paying ? 'Denetim kaydına yazılır.' : 'Denetim kaydına yazılır (5-500 karakter).'}>
            <Textarea
              rows={2}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setErrors((x) => ({ ...x, text: undefined }));
              }}
            />
          </FormField>
          {mutate.isError && !(mutate.error instanceof ApiError && mutate.error.status === 400 && mutate.error.field === 'reference') && (
            <Alert tone="danger">
              {errorMessage(mutate.error)}
              {mutate.error instanceof ApiError && mutate.error.status === 409 && ' Liste yenilendi; faturayı yeniden açın.'}
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Vazgeç
            </Button>
            <Button variant={paying ? 'primary' : 'danger'} loading={mutate.isPending} onClick={() => void submit()}>
              {paying ? 'Ödendi olarak kaydet' : 'İptal et'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

type DocOpener = ReturnType<typeof useOpenDocument>;

function InvoiceRow({ inv, docs, onAction }: { inv: SubscriptionInvoice; docs: DocOpener; onAction: (a: Action) => void }) {
  const id = `${inv.apartmentId}:${inv.invoiceId}`;
  const overdue = inv.status === 'issued' && inv.dueDate < today();
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{inv.siteName}</p>
          <Badge tone={INVOICE_STATUS_TONES[inv.status]}>{INVOICE_STATUS_LABELS[inv.status]}</Badge>
          {overdue && <Badge tone="danger">Vadesi geçti</Badge>}
          <span className="font-semibold tabular-nums">{formatTRY(inv.totalKurus)}</span>
        </div>
        <p className="text-small text-muted">
          {inv.invoiceNumber} · {inv.planName} ({PERIOD_LABELS[inv.billingPeriod].toLocaleLowerCase('tr')}) · {formatDate(inv.periodStart)} –{' '}
          {formatDate(inv.periodEnd)} · {inv.unitCount} bölüm · matrah {formatTRY(inv.netKurus)} · KDV {formatTRY(inv.vatKurus)}
        </p>
        <p className="text-small text-muted">
          {inv.status === 'paid' && inv.paidOn
            ? `Ödendi ${formatDate(inv.paidOn)}${inv.paymentMethod ? ` · ${METHOD_LABELS[inv.paymentMethod]}` : ''}${inv.paymentReference ? ` · ${inv.paymentReference}` : ''}`
            : inv.status === 'void'
              ? `İptal${inv.voidReason ? `: ${inv.voidReason}` : ''}`
              : `Son ödeme ${formatDate(inv.dueDate)}`}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          size="xs"
          variant="subtle"
          loading={docs.pendingId === id}
          onClick={() => void docs.open(id, () => subscriptionsApi.invoicePdf(inv.apartmentId, inv.invoiceId))}
        >
          <FileDown className="size-3.5" aria-hidden="true" />
          PDF
        </Button>
        {inv.status === 'issued' && (
          <>
            <Button size="xs" variant="ghost" onClick={() => onAction({ kind: 'void', invoice: inv })}>
              <XCircle className="size-3.5" aria-hidden="true" />
              İptal
            </Button>
            <Button size="xs" onClick={() => onAction({ kind: 'paid', invoice: inv })}>
              <CircleCheck className="size-3.5" aria-hidden="true" />
              Ödendi
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * Platform yoneticisi: abonelik faturalari (platformun apartman yonetiminden aldigi kullanim bedeli).
 * Faturalar her donem zamanlanmis isle kesilir; odeme simdilik elle (havale / EFT) isaretlenir.
 * Online odemenin platform komisyon faturalari ayri ekrandir.
 */
export function PlatformSubscriptionInvoicesPage() {
  const list = usePlatformSubscriptionInvoices();
  const docs = useOpenDocument();
  const [filter, setFilter] = useState<Filter>('all');
  const [action, setAction] = useState<Action | null>(null);
  const all = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const items = useMemo(() => all.filter((i) => filter === 'all' || i.status === filter), [all, filter]);
  // Tutarlar sunucunun sayfa toplamlarindan (yuklenen sayfalar); vadesi gecen sayi listeden.
  const totals = useMemo(() => {
    const pages = list.data?.pages ?? [];
    return {
      total: pages.reduce((s, p) => s + p.totals.total, 0),
      unpaid: pages.reduce((s, p) => s + p.totals.unpaid, 0),
      overdue: all.filter((i) => i.status === 'issued' && i.dueDate < today()).length,
    };
  }, [list.data, all]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="inline-flex items-center gap-2 text-title font-bold">
          <Receipt className="size-5" aria-hidden="true" />
          Abonelik faturaları
        </h1>
        <p className="text-small text-muted">
          Apartmanlara kesilen kullanım bedeli faturaları (KDV dahil). Ödeme havale / EFT ile alınır ve burada referansıyla işaretlenir; resmi e-Fatura ayrıca
          düzenlenir.
        </p>
      </div>

      {list.isPending ? (
        <div role="status" aria-label="Faturalar yükleniyor">
          <Skeleton className="h-32 w-full" />
        </div>
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
              <p className="text-small text-muted">Toplam (yüklenen, iptaller hariç)</p>
              <p className="text-lg font-semibold tabular-nums">{formatTRY(totals.total)}</p>
            </div>
            <div>
              <p className="text-small text-muted">Ödeme bekleyen (yüklenen)</p>
              <p className="text-lg font-semibold tabular-nums">{formatTRY(totals.unpaid)}</p>
            </div>
            <div>
              <p className="text-small text-muted">Vadesi geçen fatura (yüklenen)</p>
              <p className={`text-lg font-semibold tabular-nums ${totals.overdue > 0 ? 'text-warning' : ''}`}>{totals.overdue}</p>
            </div>
          </div>
          {docs.error && <Alert tone="danger">{docs.error}</Alert>}
          <FilterChips<Filter> label="Fatura durumu" value={filter} onChange={setFilter} options={FILTERS} />
          {items.length === 0 ? (
            <p className="py-4 text-center text-small text-muted">{all.length === 0 ? 'Henüz abonelik faturası yok.' : 'Bu filtreye uyan fatura yok.'}</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Abonelik faturaları">
              {items.map((inv) => (
                <InvoiceRow key={`${inv.apartmentId}:${inv.invoiceId}`} inv={inv} docs={docs} onAction={setAction} />
              ))}
            </ul>
          )}
          {list.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                Daha fazla yükle
              </Button>
            </div>
          )}
        </Card>
      )}
      <ActionDialog action={action} onClose={() => setAction(null)} />
    </div>
  );
}
