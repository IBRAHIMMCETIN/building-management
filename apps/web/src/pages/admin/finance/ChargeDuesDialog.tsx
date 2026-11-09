import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2 } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input, Select } from '@/components/ui';
import { useChargeDues } from '@/hooks/useFinance';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { PARTY_LABELS } from '@/lib/api/finance';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { cn } from '@/lib/cn';
import { formatTRY, parseTRYToKurus } from '@/lib/money';
import { type ChargeForm, type ChargeValues, chargeSchema, defaultDueDate, defaultDuesDescription, todayIstanbul } from './schemas';
import { useUnitOptions } from './useUnitOptions';

type Props = { open: boolean; onClose: () => void };

const KEYS = [
  { value: 'equal', label: 'Eşit', hint: 'Daire başı aynı tutar' },
  { value: 'area', label: 'Metrekare', hint: 'Brüt m² oranında' },
  { value: 'land_share', label: 'Arsa payı', hint: 'Tapudaki pay oranında' },
] as const;

const FIELDS = ['unitId', 'liableParty', 'amount', 'date', 'dueDate', 'description', 'distributionKey'] as const;

function initial(): ChargeForm {
  const today = todayIstanbul();
  return {
    mode: 'bulk',
    distributionKey: 'equal',
    unitId: '',
    liableParty: 'occupant',
    amount: '',
    date: today,
    dueDate: defaultDueDate(today),
    description: defaultDuesDescription(today),
  };
}

export function ChargeDuesDialog({ open, onClose }: Props) {
  const { options, activeCount } = useUnitOptions();
  const charge = useChargeDues();
  const [idempotencyKey, renewKey] = useIdempotencyKey();
  const form = useForm<ChargeForm, unknown, ChargeValues>({ resolver: zodResolver(chargeSchema), defaultValues: initial() });
  const { errors } = form.formState;
  const [mode, key, amountText, party] = form.watch(['mode', 'distributionKey', 'amount', 'liableParty']);
  const perUnitEqual = mode === 'bulk' && key === 'equal';
  const amount = parseTRYToKurus(amountText);

  useEffect(() => {
    if (!open) return;
    charge.reset();
    renewKey();
    form.reset(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open]);

  useEffect(() => {
    const sub = form.watch((_, { type }) => {
      if (type === 'change' && charge.isError) renewKey();
    });
    return () => sub.unsubscribe();
  }, [form, charge.isError, renewKey]);

  const submit = form.handleSubmit(async (v) => {
    const common = { idempotencyKey, liableParty: v.liableParty, date: v.date, dueDate: v.dueDate, description: v.description };
    try {
      if (v.mode === 'single') {
        await charge.mutateAsync({ ...common, unitId: v.unitId, amount: v.amount });
      } else {
        // Esit dagitimda daire basi tutar girilir; API toplam tutar bekler.
        const totalAmount = v.distributionKey === 'equal' ? v.amount * activeCount : v.amount;
        await charge.mutateAsync({ ...common, totalAmount, distributionKey: v.distributionKey });
      }
    } catch (err) {
      applyApiFieldError(err, form.setError, FIELDS, { totalAmount: 'amount' });
    }
  });

  const done = charge.data;
  const landShareMissing = charge.error instanceof ApiError && /arsa payi/i.test(charge.error.message);

  return (
    <Dialog open={open} onClose={() => !charge.isPending && onClose()} title="Aidat tahakkuk et">
      {done ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <CheckCircle2 className="size-10 text-success" aria-hidden="true" />
          <p className="font-semibold">
            {done.mode === 'bulk'
              ? `${done.count} daireye toplam ${formatTRY(done.distributedAmount)} borç yazıldı`
              : 'Daireye borç yazıldı'}
          </p>
          {done.replayed && <p className="text-small text-muted">Bu tahakkuk daha önce yapılmıştı; tekrar yazılmadı.</p>}
          <Button onClick={onClose}>Tamam</Button>
        </div>
      ) : (
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          {charge.isError && !Object.values(errors).some((e) => e?.type === 'server') && (
            <Alert tone="danger">
              {landShareMissing
                ? 'Arsa payıyla dağıtım için tüm dairelerin arsa payı girilmiş olmalı. Daireler ekranından eksikleri tamamlayın.'
                : errorMessage(charge.error)}
            </Alert>
          )}

          <fieldset>
            <legend className="mb-1.5 text-small font-medium">Kapsam</legend>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['bulk', `Tüm daireler (${activeCount})`],
                  ['single', 'Tek daire'],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className={cn(
                    'flex cursor-pointer items-center justify-center rounded-md border border-border px-3 py-2 text-small font-medium',
                    'has-checked:border-accent has-checked:bg-accent/10 has-checked:text-accent',
                    'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent',
                  )}
                >
                  <input type="radio" value={value} className="sr-only" {...form.register('mode')} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          {mode === 'bulk' ? (
            <fieldset>
              <legend className="mb-1.5 text-small font-medium">Dağıtım anahtarı</legend>
              <div className="grid grid-cols-3 gap-2">
                {KEYS.map((k) => (
                  <label
                    key={k.value}
                    className={cn(
                      'flex cursor-pointer flex-col rounded-md border border-border px-3 py-2',
                      'has-checked:border-accent has-checked:bg-accent/10',
                      'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent',
                    )}
                  >
                    <input type="radio" value={k.value} className="sr-only" {...form.register('distributionKey')} />
                    <span className="text-small font-medium">{k.label}</span>
                    <span className="text-small text-muted">{k.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <FormField label="Daire" error={errors.unitId?.message}>
              <Select {...form.register('unitId')}>
                <option value="" disabled>
                  Daire seçin
                </option>
                {options.map((o) => (
                  <option key={o.unitId} value={o.unitId}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </FormField>
          )}

          <FormField
            label={perUnitEqual ? 'Daire başı tutar (₺)' : mode === 'bulk' ? 'Toplam tutar (₺)' : 'Tutar (₺)'}
            error={errors.amount?.message}
            hint={
              amount && mode === 'bulk'
                ? perUnitEqual
                  ? `${activeCount} daire × ${formatTRY(amount)} = ${formatTRY(amount * activeCount)}`
                  : `${formatTRY(amount)}, ${activeCount} daireye ${key === 'area' ? 'metrekare' : 'arsa payı'} oranında paylaştırılır.`
                : undefined
            }
          >
            <Input inputMode="decimal" placeholder="Örn. 1.500,00" autoComplete="off" {...form.register('amount')} />
          </FormField>

          <FormField label="Açıklama" error={errors.description?.message}>
            <Input autoComplete="off" {...form.register('description')} />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Tahakkuk tarihi" error={errors.date?.message}>
              <Input type="date" {...form.register('date')} />
            </FormField>
            <FormField label="Son ödeme tarihi" error={errors.dueDate?.message}>
              <Input type="date" {...form.register('dueDate')} />
            </FormField>
          </div>

          <FormField
            label="Borçlu taraf"
            error={errors.liableParty?.message}
            hint={
              party === 'occupant'
                ? 'İşletme giderleri (aidat, ısınma, temizlik): oturan kişiye yazılır.'
                : 'Demirbaş ve yatırım giderleri (mantolama, asansör yenileme): kat malikine yazılır.'
            }
          >
            <Select {...form.register('liableParty')}>
              <option value="occupant">{PARTY_LABELS.occupant}</option>
              <option value="owner">{PARTY_LABELS.owner}</option>
            </Select>
          </FormField>

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose} disabled={charge.isPending}>
              Vazgeç
            </Button>
            <Button type="submit" loading={charge.isPending} disabled={mode === 'bulk' && activeCount === 0}>
              Borç yaz
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
