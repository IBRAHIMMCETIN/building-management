import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input, Select } from '@/components/ui';
import { useChargeDues, useDuesPreview } from '@/hooks/useFinance';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { type DuesBulkInput, EXPENSE_CATEGORIES, PARTY_LABELS, expenseCategoryLabel } from '@/lib/api/finance';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { cn } from '@/lib/cn';
import { formatTRY, parseTRYToKurus } from '@/lib/money';
import { type ChargeForm, type ChargeValues, chargeSchema, defaultDueDate, defaultDuesDescription, todayIstanbul } from './schemas';
import { useUnitOptions } from './useUnitOptions';
import { vacancyNotes } from './vacancy';

type Props = { open: boolean; onClose: () => void };

const KEYS = [
  { value: 'equal', label: 'Eşit', hint: 'Daire başı aynı tutar' },
  { value: 'area', label: 'Metrekare', hint: 'Brüt m² oranında' },
  { value: 'land_share', label: 'Arsa payı', hint: 'Tapudaki pay oranında' },
] as const;

const FIELDS = ['unitId', 'liableParty', 'amount', 'date', 'dueDate', 'description', 'distributionKey', 'expenseCategory'] as const;

/** Onizleme yalnizca kapsam ve muafiyeti olcer; tutar/aciklama degistikce istek atilmaz. */
const PREVIEW_TOTAL = 100_000;

function initial(): ChargeForm {
  const today = todayIstanbul();
  return {
    mode: 'bulk',
    distributionKey: 'equal',
    excludedBlockIds: [],
    expenseCategory: '',
    unitId: '',
    liableParty: 'occupant',
    amount: '',
    date: today,
    dueDate: defaultDueDate(today),
    description: defaultDuesDescription(today),
  };
}

export function ChargeDuesDialog({ open, onClose }: Props) {
  const { options, activeCount, activeBlocks, blockName } = useUnitOptions();
  const charge = useChargeDues();
  const [idempotencyKey, renewKey] = useIdempotencyKey();
  const form = useForm<ChargeForm, unknown, ChargeValues>({ resolver: zodResolver(chargeSchema), defaultValues: initial() });
  const { errors } = form.formState;
  const [mode, key, amountText, party, excludedBlockIds, expenseCategory, date] = form.watch([
    'mode',
    'distributionKey',
    'amount',
    'liableParty',
    'excludedBlockIds',
    'expenseCategory',
    'date',
  ]);
  const perUnitEqual = mode === 'bulk' && key === 'equal';
  const amount = parseTRYToKurus(amountText);

  // Kapsam: bir blok bile disarida birakildiysa dahil olanlar gonderilir; hepsi dahilse kapsam yok.
  const includedBlockIds = activeBlocks.map((b) => b.blockId).filter((id) => !excludedBlockIds.includes(id));
  const scope = excludedBlockIds.length > 0 ? includedBlockIds : undefined;
  const noBlockSelected = activeBlocks.length > 0 && includedBlockIds.length === 0;
  const previewInput = useMemo<DuesBulkInput | null>(
    () =>
      open && mode === 'bulk' && !noBlockSelected && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? {
            liableParty: party,
            totalAmount: PREVIEW_TOTAL,
            distributionKey: key,
            date,
            dueDate: date,
            description: 'Önizleme',
            ...(scope ? { blockIds: scope } : {}),
            ...(expenseCategory ? { expenseCategory } : {}),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scope icerigine gore
    [open, mode, noBlockSelected, date, party, key, scope?.join(','), expenseCategory],
  );
  const preview = useDuesPreview(previewInput);
  const count = preview.data?.count;
  const unitLabel = (u: { blockId: string; number: string }) => [blockName.get(u.blockId), u.number].filter(Boolean).join(' · ');

  const toggleBlock = (blockId: string, included: boolean) => {
    const next = included ? excludedBlockIds.filter((id) => id !== blockId) : [...excludedBlockIds, blockId];
    form.setValue('excludedBlockIds', next, { shouldDirty: true });
  };

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
        if (count === undefined || count === 0) return;
        // Esit dagitimda daire basi tutar girilir; API toplam tutar bekler. Daire sayisi
        // kapsamdaki ve muaf olmayan daireler (onizleme).
        const totalAmount = v.distributionKey === 'equal' ? v.amount * count : v.amount;
        await charge.mutateAsync({
          ...common,
          totalAmount,
          distributionKey: v.distributionKey,
          ...(scope ? { blockIds: scope } : {}),
          ...(v.expenseCategory ? { expenseCategory: v.expenseCategory } : {}),
        });
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
          {done.mode === 'bulk' && done.exempt.length > 0 && (
            <p className="text-small text-muted">{done.exempt.length} daire muaf tutuldu.</p>
          )}
          {done.mode === 'bulk' && done.vacant.length > 0 && (
            <p className="text-small text-muted">{done.vacant.length} boş daire için borç kat malikine yazıldı.</p>
          )}
          {done.mode === 'single' && done.transaction.vacant && (
            <p className="text-small text-muted">Tahakkuk tarihinde dairede oturan olmadığı için borç kat malikine yazıldı.</p>
          )}
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
                  ['bulk', `Toplu (${activeCount} daire)`],
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
            <>
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

              {activeBlocks.length > 1 && (
                <fieldset>
                  <legend className="mb-1.5 text-small font-medium">Bloklar</legend>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {activeBlocks.map((b) => (
                      <label
                        key={b.blockId}
                        className={cn(
                          'flex cursor-pointer items-center justify-center rounded-md border border-border px-3 py-2 text-small font-medium',
                          'has-checked:border-accent has-checked:bg-accent/10 has-checked:text-accent',
                          'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={!excludedBlockIds.includes(b.blockId)}
                          onChange={(e) => toggleBlock(b.blockId, e.target.checked)}
                        />
                        {b.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              <FormField
                label="Gider kalemi"
                error={errors.expenseCategory?.message}
                hint="Seçilen kalemden muaf tutulan daireler (Daireler ekranı) bu borçtan pay almaz."
              >
                <Select {...form.register('expenseCategory')}>
                  <option value="">Genel (muafiyet uygulanmaz)</option>
                  {EXPENSE_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </FormField>

              <p role="status" className={cn('text-small', preview.isError || noBlockSelected ? 'text-danger' : 'text-muted')}>
                {noBlockSelected
                  ? 'En az bir blok seçin.'
                  : preview.isError
                    ? errorMessage(preview.error)
                    : count === undefined
                      ? 'Kapsam hesaplanıyor…'
                      : [
                          `${count} daireye dağıtılacak`,
                          preview.data && preview.data.exempt.length > 0
                            ? `${preview.data.exempt.length} muaf (${expenseCategoryLabel(expenseCategory)}): ${preview.data.exempt
                                .slice(0, 5)
                                .map((u) => (u.reason ? `${unitLabel(u)} (${u.reason})` : unitLabel(u)))
                                .join(', ')}${preview.data.exempt.length > 5 ? ` ve ${preview.data.exempt.length - 5} daire daha` : ''}`
                            : null,
                          ...(preview.data ? vacancyNotes(preview.data, unitLabel) : []),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
              </p>
            </>
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
              amount && mode === 'bulk' && count
                ? perUnitEqual
                  ? `${count} daire × ${formatTRY(amount)} = ${formatTRY(amount * count)}`
                  : `${formatTRY(amount)}, ${count} daireye ${key === 'area' ? 'metrekare' : 'arsa payı'} oranında paylaştırılır.`
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
                ? 'İşletme giderleri (aidat, ısınma, temizlik): oturan kişiye yazılır; tahakkuk tarihinde daire boşsa kat malikine.'
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
            <Button type="submit" loading={charge.isPending} disabled={mode === 'bulk' && (activeCount === 0 || noBlockSelected || !count)}>
              Borç yaz
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
