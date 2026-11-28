import { ArrowLeftRight, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Dialog, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useFinanceAccounts } from '@/hooks/useFinance';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import {
  useAdvanceOffsetPreview,
  useCreateSupplierAdvance,
  useOffsetSupplierAdvance,
  useReverseAdvanceOffset,
  useReverseSupplierAdvance,
  useSupplierAdvances,
  useSupplierStatement,
} from '@/hooks/useSupplierAdvances';
import { errorMessage } from '@/lib/api/errors';
import type { PayableAccount } from '@/lib/api/finance';
import type { SupplierAdvance } from '@/lib/api/supplierAdvances';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import { ADVANCE_STATUS_LABELS, ADVANCE_STATUS_TONES, STATEMENT_CATEGORY_LABELS, advanceFormState, advanceOffsetFormState } from '@/lib/finance/supplierAdvance';
import { formatTRY, kurusToInput, parseTRYToKurus } from '@/lib/money';
import { reasonError } from '@/lib/restructure/model';

const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

/** Fatura oncesi tedarikciye odeme (avans): kasa/bankadan cikar, tedarikcinin avans alacagi olur. */
export function SupplierAdvanceDialog({ payable, onClose }: { payable: PayableAccount | null; onClose: () => void }) {
  const funds = useFinanceAccounts();
  const create = useCreateSupplierAdvance();
  const [key, renewKey] = useIdempotencyKey();
  const [fundsAccountId, setFundsAccountId] = useState('bank');
  const [amountText, setAmountText] = useState('');
  const [date, setDate] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const fundOptions = useMemo(() => (funds.data ?? []).filter((a) => (a.type === 'bank' || a.type === 'cash') && a.status === 'active'), [funds.data]);

  useEffect(() => {
    if (!payable) return;
    create.reset();
    setAmountText('');
    setDate(todayIso());
    setReference('');
    setDescription('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payable?.accountId]);

  // Varsayilan banka hesabi yoksa (yalnizca kasa) secici ilk kasa/banka hesabini gosterir; durum da onu tutar.
  useEffect(() => {
    if (fundOptions.length > 0 && !fundOptions.some((a) => a.accountId === fundsAccountId)) setFundsAccountId(fundOptions[0]?.accountId ?? '');
  }, [fundOptions, fundsAccountId]);

  if (!payable) return null;
  const amount = parseTRYToKurus(amountText);
  const fundsBalance = fundOptions.find((a) => a.accountId === fundsAccountId)?.balance;
  const state = advanceFormState({ amount, fundsAccountId, fundsBalance, date, today: todayIso() });

  return (
    <Dialog open={Boolean(payable)} onClose={onClose} title={`Tedarikçiye avans · ${payable.name}`}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!state.valid || amount === null) return;
          try {
            await create.mutateAsync({
              idempotencyKey: key,
              payableAccountId: payable.accountId,
              fundsAccountId,
              amount,
              date,
              ...(reference.trim() ? { reference: reference.trim() } : {}),
              ...(description.trim() ? { description: description.trim() } : {}),
            });
            renewKey();
            onClose();
          } catch {
            // asagida gosterilir
          }
        }}
      >
        <p className="text-small text-muted">
          Fatura gelmeden yapılan ödeme tedarikçi borcuna yazılmaz; açık avans olarak izlenir ve fatura geldiğinde “Mahsup et” ile kapatılır.
        </p>
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
        <FormField label="Dekont / referans no (isteğe bağlı)">
          <Input value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} />
        </FormField>
        <FormField label="Açıklama (isteğe bağlı)">
          <Input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="Tedarikçi avansı" />
        </FormField>
        {!state.valid && state.error && amountText !== '' && <Alert tone="danger">{state.error}</Alert>}
        {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!state.valid}>
            Avansı kaydet
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Acik avansi faturalara mahsup: fatura secilirse o faturalar, secilmezse tutar kadar en eski faturalar (FIFO). */
export function AdvanceOffsetDialog({ advance, payableName, onClose }: { advance: SupplierAdvance | null; payableName: string; onClose: () => void }) {
  const preview = useAdvanceOffsetPreview(advance?.advanceId ?? null);
  const offset = useOffsetSupplierAdvance();
  const [key, renewKey] = useIdempotencyKey();
  const [selected, setSelected] = useState<string[]>([]);
  const [amountText, setAmountText] = useState('');
  const [date, setDate] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const pv = preview.data;

  useEffect(() => {
    if (!advance) return;
    offset.reset();
    setSelected([]);
    setDate(todayIso());
    setReason('');
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advance?.advanceId]);
  useEffect(() => {
    if (pv) setAmountText(kurusToInput(pv.maxAmount));
  }, [pv]);

  if (!advance) return null;
  const state = pv
    ? advanceOffsetFormState({
        amount: parseTRYToKurus(amountText),
        selected,
        items: pv.openItems,
        maxAmount: pv.maxAmount,
        advanceDate: advance.date,
        date,
        today: todayIso(),
        reason,
      })
    : undefined;
  const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <Dialog open={Boolean(advance)} onClose={onClose} title={`Avans mahsubu · ${payableName}`} variant="wide">
      {preview.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : preview.isError || !pv || !state ? (
        <Alert tone="danger">{errorMessage(preview.error)}</Alert>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setTouched(true);
            if (!state.valid) return;
            try {
              await offset.mutateAsync({
                advanceId: advance.advanceId,
                input: { idempotencyKey: key, amount: state.amount, date, reason: reason.trim(), ...(state.settles ? { settles: state.settles } : {}) },
              });
              renewKey();
              onClose();
            } catch {
              // asagida gosterilir
            }
          }}
        >
          <p className="text-small text-muted">
            Açık avans {formatTRY(pv.advanceOpen)} · açık borç {formatTRY(pv.openBalance)} · en fazla {formatTRY(pv.maxAmount)} mahsup edilebilir.
          </p>
          {pv.openItems.length === 0 ? (
            <Alert tone="info">Tedarikçinin açık faturası yok.</Alert>
          ) : (
            <fieldset className="flex flex-col gap-1 rounded-md border border-border p-3 text-small">
              <legend className="px-1 text-xs text-muted">Kapatılacak faturalar (seçmezseniz en eskiden başlanır)</legend>
              {pv.openItems.map((i) => (
                <label key={i.transactionId} className="flex items-start justify-between gap-3">
                  <span className="flex items-start gap-2">
                    <input type="checkbox" className="mt-1" checked={selected.includes(i.transactionId)} onChange={() => toggle(i.transactionId)} />
                    <span>
                      {formatDate(i.date)} · {i.description}
                      {i.reference ? ` · ${i.reference}` : ''}
                    </span>
                  </span>
                  <span className="tabular-nums">{formatTRY(i.open)}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Tutar (₺)" error={state.errors.amount} hint={selected.length > 0 ? 'Seçilen faturaların açık kalanı (avansla sınırlı)' : undefined}>
              <Input inputMode="decimal" value={selected.length > 0 ? kurusToInput(state.amount) : amountText} disabled={selected.length > 0} onChange={(e) => setAmountText(e.target.value)} />
            </FormField>
            <FormField label="Mahsup tarihi" error={state.errors.date}>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </FormField>
          </div>
          <FormField label="Gerekçe" error={touched ? state.errors.reason : undefined}>
            <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          {offset.isError && <Alert tone="danger">{errorMessage(offset.error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Vazgeç
            </Button>
            <Button type="submit" loading={offset.isPending} disabled={pv.maxAmount < 1}>
              Mahsup et
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Gerekceli geri alma (ters kayit) satir ici formu. */
function ReverseForm({ label, hint, run, pending, error, onDone }: { label: string; hint: string; run: (reason: string) => Promise<unknown>; pending: boolean; error: unknown; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const err = reasonError(reason);
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border pt-2">
      <p className="text-muted">{hint}</p>
      {error ? <Alert tone="danger">{errorMessage(error)}</Alert> : null}
      <FormField label="Gerekçe" error={touched ? err : undefined}>
        <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="xs" onClick={onDone} disabled={pending}>
          Vazgeç
        </Button>
        <Button
          variant="danger"
          size="xs"
          loading={pending}
          onClick={async () => {
            setTouched(true);
            if (err) return;
            try {
              await run(reason.trim());
              onDone();
            } catch {
              // yukarida gosterilir
            }
          }}
        >
          {label}
        </Button>
      </div>
    </div>
  );
}

function AdvanceItem({ a, canWrite, canOffset, onOffset }: { a: SupplierAdvance; canWrite: boolean; canOffset: boolean; onOffset: () => void }) {
  const reverseAdvance = useReverseSupplierAdvance();
  const reverseOffset = useReverseAdvanceOffset();
  const [form, setForm] = useState<{ kind: 'advance' } | { kind: 'offset'; offsetId: string } | null>(null);
  return (
    <li className="rounded-md border border-border bg-surface p-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span>
          {formatDate(a.date)} · {a.description}
          {a.reference ? ` · ${a.reference}` : ''}
          <span className="block text-muted">
            Avans {formatTRY(a.amount)} · mahsup {formatTRY(a.applied)} · açık <strong className="tabular-nums">{formatTRY(a.open)}</strong>
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={ADVANCE_STATUS_TONES[a.status]}>{ADVANCE_STATUS_LABELS[a.status]}</Badge>
          {canWrite && !form && a.open > 0 && canOffset && (
            <Button size="xs" variant="secondary" onClick={onOffset}>
              <ArrowLeftRight className="size-3.5" aria-hidden="true" />
              Mahsup et
            </Button>
          )}
          {canWrite && !form && a.status === 'open' && a.applied === 0 && (
            <Button size="xs" variant="ghost" onClick={() => setForm({ kind: 'advance' })}>
              İptal et
            </Button>
          )}
        </span>
      </div>
      {a.offsets.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1 border-t border-border pt-1" aria-label="Avans mahsupları">
          {a.offsets.map((o) => (
            <li key={o.offsetId} className="flex flex-wrap items-center justify-between gap-2">
              <span className={cn(o.status === 'reversed' && 'text-muted line-through')}>
                {formatDate(o.date)} · mahsup {formatTRY(o.amount)} · {o.settles.length} fatura · {o.reason}
              </span>
              {o.status === 'reversed' ? (
                <Badge>Geri alındı</Badge>
              ) : (
                canWrite &&
                !form && (
                  <Button size="xs" variant="ghost" onClick={() => setForm({ kind: 'offset', offsetId: o.offsetId })}>
                    <Undo2 className="size-3.5" aria-hidden="true" />
                    Geri al
                  </Button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      {form?.kind === 'advance' && (
        <ReverseForm
          label="Avansı iptal et"
          hint="Avans ters kayıtla iptal edilir; tutar ödeme hesabına geri döner."
          pending={reverseAdvance.isPending}
          error={reverseAdvance.error}
          run={(reason) => reverseAdvance.mutateAsync({ advanceId: a.advanceId, reason })}
          onDone={() => setForm(null)}
        />
      )}
      {form?.kind === 'offset' && (
        <ReverseForm
          label="Mahsubu geri al"
          hint="Mahsup ters kayıtla geri alınır; avans yeniden açık, fatura borcu yeniden ödenecek olur."
          pending={reverseOffset.isPending}
          error={reverseOffset.error}
          run={(reason) => reverseOffset.mutateAsync({ offsetId: form.offsetId, reason })}
          onDone={() => setForm(null)}
        />
      )}
    </li>
  );
}

/** Tedarikci satiri acildiginda: verilen avanslar, mahsuplari ve geri alma. */
export function SupplierAdvancesList({ payable, canWrite }: { payable: PayableAccount; canWrite: boolean }) {
  const advances = useSupplierAdvances(payable.accountId);
  const [offsetting, setOffsetting] = useState<SupplierAdvance | null>(null);
  if (advances.isPending) return <Skeleton className="h-10 w-full" />;
  if (advances.isError) return <Alert tone="danger">{errorMessage(advances.error)}</Alert>;
  const items = advances.data.items;
  if (items.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1 text-xs">
      <p className="font-medium">Verilen avanslar</p>
      <ul className="flex flex-col gap-1">
        {items.map((a) => (
          <AdvanceItem key={a.advanceId} a={a} canWrite={canWrite} canOffset={payable.openBalance > 0} onOffset={() => setOffsetting(a)} />
        ))}
      </ul>
      {canWrite && <AdvanceOffsetDialog advance={offsetting} payableName={payable.name} onClose={() => setOffsetting(null)} />}
    </div>
  );
}

/** Tedarikci ekstresi: faturalar, odemeler, avanslar ve mahsuplar; acik borc / acik avans / net bakiye. */
export function SupplierStatementDialog({ payable, onClose }: { payable: PayableAccount | null; onClose: () => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const range = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const statement = useSupplierStatement(payable?.accountId ?? null, range);
  if (!payable) return null;
  const s = statement.data;
  const signed = (n: number) => (n === 0 ? '—' : `${n > 0 ? '+' : '−'}${formatTRY(Math.abs(n))}`);

  return (
    <Dialog open={Boolean(payable)} onClose={onClose} title={`Tedarikçi ekstresi · ${payable.name}`} variant="wide">
      <div className="flex flex-col gap-3 text-small">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Başlangıç">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </FormField>
          <FormField label="Bitiş">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </FormField>
        </div>
        {statement.isPending && <Skeleton className="h-40 w-full" />}
        {statement.isError && <Alert tone="danger">{errorMessage(statement.error)}</Alert>}
        {s && (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-md bg-surface-muted p-3">
                <dt className="text-muted">Açık borç</dt>
                <dd className="font-semibold tabular-nums">{formatTRY(s.closing.payableBalance)}</dd>
              </div>
              <div className="rounded-md bg-surface-muted p-3">
                <dt className="text-muted">Açık avans</dt>
                <dd className="font-semibold tabular-nums">{formatTRY(s.closing.advanceBalance)}</dd>
              </div>
              <div className="rounded-md bg-surface-muted p-3">
                <dt className="text-muted">Net (borç − avans)</dt>
                <dd className={cn('font-semibold tabular-nums', s.closing.net > 0 ? 'text-warning' : 'text-success')}>{formatTRY(s.closing.net)}</dd>
              </div>
              <div className="rounded-md bg-surface-muted p-3">
                <dt className="text-muted">Mahsup edilen avans</dt>
                <dd className="font-semibold tabular-nums">{formatTRY(s.totals.advanceApplied)}</dd>
              </div>
            </dl>
            {(s.from || s.to) && (
              <p className="text-muted">
                Devir: borç {formatTRY(s.opening.payableBalance)} · avans {formatTRY(s.opening.advanceBalance)}
              </p>
            )}
            {s.rows.length === 0 ? (
              <p className="py-4 text-center text-muted">Bu aralıkta hareket yok.</p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-left">
                  <caption className="sr-only">Tedarikçi ekstresi</caption>
                  <thead className="border-b border-border text-xs text-muted">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">Tarih</th>
                      <th scope="col" className="px-3 py-2 font-medium">Açıklama</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Borç</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Avans</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Net bakiye</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {s.rows.map((r) => (
                      <tr key={r.transactionId} className="align-top">
                        <td className="px-3 py-2 whitespace-nowrap tabular-nums">{formatDate(r.date)}</td>
                        <td className="px-3 py-2">
                          {r.description}
                          <span className="mt-1 flex flex-wrap gap-1">
                            <Badge tone={r.category === 'reversal' ? 'warning' : r.category === 'advance' || r.category === 'advance_offset' ? 'accent' : 'neutral'}>
                              {STATEMENT_CATEGORY_LABELS[r.category]}
                            </Badge>
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{signed(r.payableChange)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{signed(r.advanceChange)}</td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">{formatTRY(r.net)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Kapat
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
