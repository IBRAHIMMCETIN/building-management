import { zodResolver } from '@hookform/resolvers/zod';
import { Banknote, CheckCircle2, Landmark } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input, Select } from '@/components/ui';
import { useFormerAccounts } from '@/hooks/useClosures';
import { useDuesStatus, useFinanceAccounts, useRecordPayment } from '@/hooks/useFinance';
import { usePeople } from '@/hooks/useUnits';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { type LiableParty, PARTY_LABELS } from '@/lib/api/finance';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { cn } from '@/lib/cn';
import { formatTRY, kurusToInput } from '@/lib/money';
import { type PaymentForm, type PaymentValues, paymentSchema, todayIstanbul } from './schemas';
import { useUnitOptions } from './useUnitOptions';

/** accountId: ayrilan sakin/malik carisinden veya (Finans 2.1) paydas carisinden tahsilat. */
export type PaymentPreset = { unitId: string; liableParty?: LiableParty; accountId?: string; amount?: number };

type Props = { open: boolean; onClose: () => void; preset?: PaymentPreset | null };

const FIELDS = ['unitId', 'liableParty', 'accountId', 'amount', 'method', 'paidAt', 'payerName', 'note'] as const;

const METHODS = [
  { value: 'cash', label: 'Elden nakit', hint: 'Kasaya girer', icon: Banknote },
  { value: 'bank_transfer', label: 'Havale / EFT', hint: 'Bankaya girer', icon: Landmark },
] as const;

export function PaymentDialog({ open, onClose, preset }: Props) {
  const { options, isPending: unitsPending } = useUnitOptions();
  const dues = useDuesStatus();
  const former = useFormerAccounts(false, open);
  // Finans 2.1: `split` dairelerde malik tahsilati paydasin kendi carisine.
  const receivables = useFinanceAccounts('receivable');
  const people = usePeople();
  const pay = useRecordPayment();
  const [idempotencyKey, renewKey] = useIdempotencyKey();

  const form = useForm<PaymentForm, unknown, PaymentValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: { unitId: '', liableParty: 'occupant', accountId: '', amount: '', method: 'cash', paidAt: todayIstanbul(), payerName: '', note: '' },
  });
  const { errors } = form.formState;
  const [unitId, party, accountId] = form.watch(['unitId', 'liableParty', 'accountId']);
  const unitDues = dues.data?.items.find((d) => d.unitId === unitId);
  // Ayrilan cariler: secili dairenin bakiyesi olanlari (+ on secilmis olan, bakiyesi sifirlansa da).
  const formerOptions = (former.data?.items ?? []).filter((a) => a.unitId === unitId);
  const selectedFormer = formerOptions.find((a) => a.accountId === accountId);
  const coOwnerOptions = (receivables.data ?? []).filter((a) => a.coOwner && a.unitId === unitId);
  const selectedCoOwner = coOwnerOptions.find((a) => a.accountId === accountId);
  const personName = (userId: string) => people.data?.find((p) => p.userId === userId)?.fullName ?? 'Paydaş';
  const partyBalance = accountId ? (selectedFormer?.balance ?? selectedCoOwner?.balance) : unitDues ? unitDues[party].balance : undefined;

  useEffect(() => {
    if (!open) return;
    pay.reset();
    renewKey();
    form.reset({
      unitId: preset?.unitId ?? '',
      liableParty: preset?.liableParty ?? 'occupant',
      accountId: preset?.accountId ?? '',
      amount: preset?.amount && preset.amount > 0 ? kurusToInput(preset.amount) : '',
      method: 'cash',
      paidAt: todayIstanbul(),
      payerName: '',
      note: '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open]);

  const submit = form.handleSubmit(async (v) => {
    try {
      // Ayrilan cari secildiyse borclu taraf o carinin tarafidir (API uyumsuzlugu 400 ile reddeder).
      const acc = v.accountId ? former.data?.items.find((a) => a.accountId === v.accountId) : undefined;
      const coOwner = v.accountId ? receivables.data?.find((a) => a.accountId === v.accountId && a.coOwner) : undefined;
      await pay.mutateAsync({ idempotencyKey, ...v, ...(acc ? { liableParty: acc.liableParty } : coOwner ? { liableParty: 'owner' as const } : {}) });
    } catch (err) {
      if (applyApiFieldError(err, form.setError, FIELDS)) return;
      if (err instanceof ApiError && err.code === 'idempotency_conflict') renewKey();
    }
  });

  // Daire degisince ayrilan cari secimi gecersiz olur; ayrilan cari secilince borclu taraf onun tarafidir.
  useEffect(() => {
    const sub = form.watch((v, { name, type }) => {
      if (type !== 'change') return;
      if (name === 'unitId' && v.accountId) form.setValue('accountId', '');
      if (name === 'accountId' && v.accountId) {
        const acc = former.data?.items.find((a) => a.accountId === v.accountId);
        if (acc) form.setValue('liableParty', acc.liableParty);
        if (receivables.data?.some((a) => a.accountId === v.accountId && a.coOwner)) form.setValue('liableParty', 'owner');
      }
    });
    return () => sub.unsubscribe();
  }, [form, former.data, receivables.data]);

  // Form degisirse (farkli tutar/daire) yeni bir islemdir: ayni anahtarla farkli icerik 409 olurdu.
  useEffect(() => {
    const sub = form.watch((_, { type }) => {
      if (type === 'change' && pay.isError) renewKey();
    });
    return () => sub.unsubscribe();
  }, [form, pay.isError, renewKey]);

  const done = pay.data;
  const close = () => !pay.isPending && onClose();

  return (
    <Dialog open={open} onClose={close} title="Tahsilat ekle">
      {done ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <CheckCircle2 className="size-10 text-success" aria-hidden="true" />
          <p className="font-semibold">{formatTRY(done.payment.amount)} tahsil edildi</p>
          <p className="text-small text-muted">
            Makbuz no: <code className="select-all">{done.payment.receiptNumber}</code>
            {done.replayed && ' (bu işlem daha önce kaydedilmişti, tekrar yazılmadı)'}
          </p>
          <div className="flex w-full flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-center">
            <Button
              variant="secondary"
              onClick={() => {
                pay.reset();
                renewKey();
                form.reset({ ...form.getValues(), unitId: '', accountId: '', amount: '', payerName: '', note: '' });
              }}
            >
              Yeni tahsilat
            </Button>
            <Button onClick={onClose}>Tamam</Button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          {pay.isError && !Object.values(errors).some((e) => e?.type === 'server') && (
            <Alert tone="danger">{errorMessage(pay.error)}</Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Daire" error={errors.unitId?.message}>
              <Select disabled={unitsPending} {...form.register('unitId')}>
                <option value="" disabled>
                  {unitsPending ? 'Yükleniyor…' : 'Daire seçin'}
                </option>
                {options.map((o) => (
                  <option key={o.unitId} value={o.unitId}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Borçlu taraf" error={errors.liableParty?.message}>
              <Select {...form.register('liableParty')}>
                <option value="occupant">{PARTY_LABELS.occupant}</option>
                <option value="owner">{PARTY_LABELS.owner}</option>
              </Select>
            </FormField>
          </div>

          {(formerOptions.length > 0 || coOwnerOptions.length > 0 || accountId) && (
            <FormField
              label="Cari"
              error={errors.accountId?.message}
              hint={
                selectedCoOwner
                  ? 'Tahsilat paydaşın kendi carisine yazılır; diğer paydaşların bakiyesini etkilemez.'
                  : accountId
                    ? 'Tahsilat ayrılan kişinin carisine yazılır; yeni sakinin bakiyesini etkilemez.'
                    : undefined
              }
            >
              <Select {...form.register('accountId')}>
                <option value="">Ana cari (güncel sakin / malik)</option>
                {coOwnerOptions.length > 0 && (
                  <optgroup label="Paydaş carileri">
                    {coOwnerOptions.map((a) => (
                      <option key={a.accountId} value={a.accountId}>
                        {personName(a.coOwner?.userId ?? '')}
                        {a.balance > 0 ? ` · ${formatTRY(a.balance)} borç` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                {formerOptions.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.name}
                    {a.balance > 0 ? ` · ${formatTRY(a.balance)} borç` : ''}
                  </option>
                ))}
                {accountId && !selectedFormer && !selectedCoOwner && <option value={accountId}>Seçili cari</option>}
              </Select>
            </FormField>
          )}

          {partyBalance !== undefined && (
            <div className="flex items-center justify-between gap-2 rounded-md bg-surface-muted px-3 py-2 text-small">
              <span>
                {partyBalance > 0 ? 'Güncel borç: ' : partyBalance < 0 ? 'Avans: ' : 'Borç yok'}
                {partyBalance !== 0 && <strong className="tabular-nums">{formatTRY(Math.abs(partyBalance))}</strong>}
              </span>
              {partyBalance > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => form.setValue('amount', kurusToInput(partyBalance), { shouldValidate: true })}
                >
                  Tamamını yaz
                </Button>
              )}
            </div>
          )}

          <FormField label="Tutar (₺)" error={errors.amount?.message}>
            <Input inputMode="decimal" placeholder="Örn. 1.500,00" autoComplete="off" {...form.register('amount')} />
          </FormField>

          <fieldset>
            <legend className="mb-1.5 text-small font-medium">Ödeme şekli</legend>
            <div className="grid grid-cols-2 gap-2">
              {METHODS.map(({ value, label, hint, icon: Icon }) => (
                <label
                  key={value}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2',
                    'has-checked:border-accent has-checked:bg-accent/10',
                    'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent',
                  )}
                >
                  <input type="radio" value={value} className="sr-only" {...form.register('method')} />
                  <Icon className="size-5 shrink-0 text-accent" aria-hidden="true" />
                  <span className="flex flex-col">
                    <span className="text-small font-medium">{label}</span>
                    <span className="text-small text-muted">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Ödeme tarihi" error={errors.paidAt?.message}>
              <Input type="date" max={todayIstanbul()} {...form.register('paidAt')} />
            </FormField>
            <FormField label="Ödeyen (isteğe bağlı)" error={errors.payerName?.message}>
              <Input autoComplete="off" {...form.register('payerName')} />
            </FormField>
          </div>
          <FormField label="Not (isteğe bağlı)" error={errors.note?.message}>
            <Input autoComplete="off" {...form.register('note')} />
          </FormField>

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose} disabled={pay.isPending}>
              Vazgeç
            </Button>
            <Button type="submit" loading={pay.isPending}>
              Tahsilatı kaydet
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
