import { CreditCard, Lock, ReceiptText } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { Alert, Badge, Button, Card, CardTitle, FilterChips, FormField, Input, Skeleton } from '@/components/ui';
import { usePortalUnit } from '@/context/PortalUnitContext';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useCreatePayment, usePaymentQuote } from '@/hooks/usePayments';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { PartyQuote, PaymentQuote } from '@/lib/api/payments';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { partyLabel } from '@/lib/payments/result';
import {
  type ItemSelection,
  isSelected,
  isValidTckn,
  normalizeGsm,
  receiptCount,
  selectedItems,
  selectedTotal,
  toggleItem,
} from '@/lib/payments/selection';
import { cn } from '@/lib/cn';

type Mode = 'total' | 'items';

const MODES = [
  { value: 'total', label: 'Toplam borcu öde' },
  { value: 'items', label: 'Kalem seçerek öde' },
] as const;

function TotalBreakdown({ quote }: { quote: PaymentQuote }) {
  const parties = quote.parties.filter((p) => p.totalDue > 0);
  return (
    <div className="flex flex-col gap-3">
      {parties.map((p) => (
        <dl key={p.liableParty} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-md bg-surface-muted p-3 text-small">
          <dt className="col-span-2 font-medium text-text">{partyLabel(p.liableParty)} carisi</dt>
          <dt className="text-muted">Açık borç</dt>
          <dd className="text-right tabular-nums">{formatTRY(p.debt)}</dd>
          {p.accruedLateFee > 0 && (
            <>
              <dt className="text-muted">Bugüne kadar işleyen gecikme tazminatı</dt>
              <dd className="text-right text-warning tabular-nums">{formatTRY(p.accruedLateFee)}</dd>
            </>
          )}
          <dt className="font-medium">Ödenecek</dt>
          <dd className="text-right font-semibold tabular-nums">{formatTRY(p.totalDue)}</dd>
        </dl>
      ))}
      {quote.parties.some((p) => p.accruedLateFee > 0) && (
        <p className="text-small text-muted">
          Gecikme tazminatı ödeme gününe kadar hesaplanır ve bu ödemeyle kapanır; ayın 1’inde ayrıca borç yazılmaz.
        </p>
      )}
    </div>
  );
}

function PartyItems({
  party,
  selection,
  onToggle,
}: {
  party: PartyQuote;
  selection: ItemSelection;
  onToggle: (index: number, checked: boolean) => void;
}) {
  if (party.items.length === 0 && party.postedLateFees.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 font-medium">{partyLabel(party.liableParty)} carisi</legend>
      {party.items.length === 0 && <p className="text-small text-muted">Seçilebilir aidat kalemi yok.</p>}
      <ul className="flex flex-col gap-2">
        {party.items.map((it, index) => {
          const checked = isSelected(selection, party.liableParty, index);
          const id = `item-${party.liableParty}-${it.transactionId}`;
          return (
            <li key={it.transactionId}>
              <label
                htmlFor={id}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-md border border-border bg-surface px-3 py-2.5 hover:border-border-strong',
                  checked && 'border-accent/40 bg-accent/5',
                )}
              >
                <input
                  id={id}
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--color-accent)]"
                  checked={checked}
                  onChange={(e) => onToggle(index, e.target.checked)}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium break-words">{it.description}</span>
                  <span className="flex flex-wrap items-center gap-1.5 text-small text-muted">
                    Son ödeme {formatDate(it.dueDate)}
                    {it.overdue && <Badge tone="warning">{it.daysOverdue} gün gecikmede</Badge>}
                    {it.paid > 0 && <span>· {formatTRY(it.paid)} ödendi</span>}
                  </span>
                </span>
                <span className="font-semibold tabular-nums">{formatTRY(it.remaining)}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {(party.postedLateFees.length > 0 || party.accruedLateFee > 0) && (
        <p className="text-small text-muted">
          Gecikme tazminatı kalem seçerek ödenemez; toplam borç ödemesinde kapanır.
          {party.accruedLateFee > 0 && ` Seçtiğiniz kalemler için tazminat ödeme gününde durur.`}
        </p>
      )}
    </fieldset>
  );
}

/** Canli saglayicida istenen alici bilgileri. Saklanmaz; yalnizca odeme saglayicisina iletilir. */
function BuyerFields({
  gsm,
  tckn,
  onGsm,
  onTckn,
  errors,
}: {
  gsm: string;
  tckn: string;
  onGsm: (v: string) => void;
  onTckn: (v: string) => void;
  errors: { gsm?: string; tckn?: string };
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Cep telefonu" error={errors.gsm} hint="Ödeme sağlayıcısı için gereklidir.">
          <Input inputMode="tel" autoComplete="tel" placeholder="05xx xxx xx xx" value={gsm} onChange={(e) => onGsm(e.target.value)} />
        </FormField>
        <FormField label="T.C. kimlik numarası (isteğe bağlı)" error={errors.tckn}>
          <Input inputMode="numeric" maxLength={11} value={tckn} onChange={(e) => onTckn(e.target.value.replace(/\D/g, ''))} />
        </FormField>
      </div>
      <p className="flex items-start gap-2 text-small text-muted">
        <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        Telefon ve kimlik numaranız sistemimizde saklanmaz; yalnızca bu ödeme için ödeme sağlayıcısına iletilir.
      </p>
    </div>
  );
}

function PaymentForm({ quote }: { quote: PaymentQuote }) {
  const { unitId } = usePortalUnit();
  const [mode, setMode] = useState<Mode>('total');
  const [selection, setSelection] = useState<ItemSelection>({});
  const [gsm, setGsm] = useState('');
  const [tckn, setTckn] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ gsm?: string; tckn?: string }>({});
  const [key, renewKey] = useIdempotencyKey();
  const create = useCreatePayment();

  const items = useMemo(() => selectedItems(quote, selection), [quote, selection]);
  const amount = mode === 'total' ? quote.totalDue : selectedTotal(quote, selection);
  const receipts = receiptCount(quote, mode, selection);
  const hasSelectable = quote.parties.some((p) => p.items.length > 0);

  // Secim degisince yeni anahtar: ayni anahtar farkli istekle gonderilirse API 409 doner.
  const fingerprint = mode === 'total' ? 'total' : items.map((i) => `${i.liableParty}:${i.transactionId}`).join(',');
  useEffect(() => {
    renewKey();
    create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca secim degisince
  }, [fingerprint]);

  const submit = async () => {
    const errors: { gsm?: string; tckn?: string } = {};
    let gsmNumber: string | undefined;
    if (quote.requiresGsmNumber) {
      gsmNumber = normalizeGsm(gsm) ?? undefined;
      if (!gsmNumber) errors.gsm = 'Geçerli bir cep telefonu numarası girin (05xx...).';
      if (tckn && !isValidTckn(tckn)) errors.tckn = 'Geçerli bir T.C. kimlik numarası girin veya boş bırakın.';
    }
    setFieldErrors(errors);
    if (errors.gsm || errors.tckn) return;

    try {
      const intent = await create.mutateAsync({
        idempotencyKey: key,
        unitId,
        mode,
        ...(mode === 'items' ? { items } : {}),
        ...(gsmNumber ? { gsmNumber } : {}),
        ...(quote.requiresGsmNumber && tckn ? { identityNumber: tckn } : {}),
      });
      if (intent.status === 'PENDING' && intent.paymentPageUrl) {
        // Kart bilgisi saglayicinin sayfasinda girilir; donuste /app/odeme/sonuc acilir.
        window.location.assign(intent.paymentPageUrl);
        return;
      }
      // Ayni anahtarla daha once sonuclanmis istek: yeni anahtarla tekrar denenebilir.
      renewKey();
    } catch (err) {
      if (err instanceof ApiError && err.field === 'gsmNumber') setFieldErrors({ gsm: err.message });
      else if (err instanceof ApiError && err.field === 'identityNumber') setFieldErrors({ tckn: err.message });
      else if (err instanceof ApiError && err.code === 'provider_unavailable') renewKey();
    }
  };

  const fieldError = create.error instanceof ApiError && (create.error.field === 'gsmNumber' || create.error.field === 'identityNumber');

  return (
    <Card className="flex flex-col gap-5">
      {hasSelectable && (
        <FilterChips label="Ödeme şekli" value={mode} options={MODES} onChange={(v) => setMode(v)} />
      )}

      {mode === 'total' ? (
        <TotalBreakdown quote={quote} />
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-small text-muted">
            Kalemler en eski vadeliden başlayarak seçilir: bir kalemi seçtiğinizde ondan eski kalemler de seçilir.
          </p>
          {quote.parties.map((p) => (
            <PartyItems
              key={p.liableParty}
              party={p}
              selection={selection}
              onToggle={(index, checked) => setSelection((s) => toggleItem(s, p.liableParty, index, checked))}
            />
          ))}
        </div>
      )}

      {quote.requiresGsmNumber && (
        <BuyerFields
          gsm={gsm}
          tckn={tckn}
          onGsm={(v) => {
            setGsm(v);
            setFieldErrors((e) => ({ ...e, gsm: undefined }));
          }}
          onTckn={(v) => {
            setTckn(v);
            setFieldErrors((e) => ({ ...e, tckn: undefined }));
          }}
          errors={fieldErrors}
        />
      )}

      {create.isError && !fieldError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
      {create.data && create.data.status !== 'PENDING' && (
        <Alert tone="danger">Bu ödeme isteği daha önce sonuçlanmış. Lütfen tekrar deneyin.</Alert>
      )}

      <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-small text-muted">Ödenecek tutar</p>
          <p className="text-title font-bold tabular-nums">{formatTRY(amount)}</p>
          {receipts > 1 && <p className="text-small text-muted">Malik ve sakin carileri için iki ayrı makbuz düzenlenir.</p>}
        </div>
        <Button size="md" disabled={amount < 1} loading={create.isPending} onClick={() => void submit()}>
          <CreditCard className="size-4" aria-hidden="true" />
          Kartla güvenli öde
        </Button>
      </div>
      <p className="text-small text-muted">
        Kart bilgilerinizi ödeme sağlayıcısının (iyzico) güvenli sayfasında 3D Secure ile girersiniz; bu uygulama kart bilginizi görmez.
      </p>
    </Card>
  );
}

export function PaymentPage() {
  const quote = usePaymentQuote();

  let content;
  if (quote.isPending) {
    content = (
      <Card role="status" aria-label="Ödeme bilgileri yükleniyor" className="flex flex-col gap-3">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-10 w-1/2" />
      </Card>
    );
  } else if (quote.isError) {
    content = <PortalQueryState error={quote.error} onRetry={() => void quote.refetch()} />;
  } else if (!quote.data.onlinePaymentEnabled) {
    content = (
      <Alert>Apartmanınız için online ödeme henüz aktif değil. Ödemelerinizi yöneticinize elden veya banka havalesiyle yapabilirsiniz.</Alert>
    );
  } else if (quote.data.totalDue < 1) {
    content = (
      <Card className="flex flex-col items-center gap-2 py-10 text-center">
        <ReceiptText className="size-8 text-success" aria-hidden="true" />
        <p className="font-medium">Ödenecek borcunuz bulunmuyor</p>
      </Card>
    );
  } else {
    content = <PaymentForm quote={quote.data} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-title font-bold">Online ödeme</h1>
        <Link to="/app/dues" className="text-small text-accent underline-offset-4 hover:underline">
          ← Borçlarım
        </Link>
      </div>
      {content}
    </div>
  );
}
