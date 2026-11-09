import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input, Select } from '@/components/ui';
import { useBlocks, useCreateUnit } from '@/hooks/useUnits';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { UNIT_TYPES, UNIT_TYPE_LABELS, type Unit } from '@/lib/api/units';
import { type CreateUnitForm, type CreateUnitValues, NEW_BLOCK, createUnitSchema } from './schemas';

type Props = { open: boolean; onClose: () => void; onCreated?: (unit: Unit) => void };

const FIELDS = ['blockId', 'newBlockName', 'number', 'type', 'floor', 'grossAreaM2', 'landShareNumerator', 'landShareDenominator'] as const;

const EMPTY: CreateUnitForm = {
  blockId: '',
  newBlockName: '',
  number: '',
  type: 'flat',
  floor: '',
  grossAreaM2: '',
  landShareNumerator: '',
  landShareDenominator: '',
};

export function CreateUnitDialog({ open, onClose, onCreated }: Props) {
  const blocks = useBlocks();
  const createUnit = useCreateUnit();
  const form = useForm<CreateUnitForm, unknown, CreateUnitValues>({
    resolver: zodResolver(createUnitSchema),
    defaultValues: EMPTY,
  });
  const { errors } = form.formState;
  const blockId = form.watch('blockId');
  const activeBlocks = (blocks.data ?? []).filter((b) => b.status === 'active');
  const noBlocks = blocks.isSuccess && activeBlocks.length === 0;

  // Acilista temiz form; tek blok varsa onu, hic blok yoksa "yeni blok" secili gelir.
  useEffect(() => {
    if (!open) return;
    createUnit.reset();
    form.reset({ ...EMPTY, blockId: activeBlocks.length === 1 ? (activeBlocks[0]?.blockId ?? '') : noBlocks ? NEW_BLOCK : '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open, blocks.isSuccess]);

  const submit = form.handleSubmit(async (v) => {
    try {
      const unit = await createUnit.mutateAsync({
        blockId: v.blockId === NEW_BLOCK ? undefined : v.blockId,
        newBlockName: v.blockId === NEW_BLOCK ? v.newBlockName : undefined,
        number: v.number,
        type: v.type,
        grossAreaM2: v.grossAreaM2 as number,
        floor: v.floor,
        landShare:
          v.landShareNumerator !== undefined && v.landShareDenominator !== undefined
            ? { numerator: v.landShareNumerator, denominator: v.landShareDenominator }
            : undefined,
      });
      onCreated?.(unit);
      onClose();
    } catch (err) {
      if (applyApiFieldError(err, form.setError, FIELDS, { landShare: 'landShareNumerator', name: 'newBlockName' })) return;
      // Bilinen cakismalar ilgili alana yazilir; digerleri ustteki hata kutusunda kalir.
      if (err instanceof ApiError && err.status === 409) {
        if (/numarali/i.test(err.message)) {
          form.setError('number', { message: 'Bu blokta aynı numaralı bir daire zaten var.' }, { shouldFocus: true });
        } else if (/arsa payi/i.test(err.message)) {
          form.setError('landShareNumerator', { message: "Apartmanın toplam arsa payı 1'i aşamaz." }, { shouldFocus: true });
        } else if (/blok/i.test(err.message)) {
          form.setError('newBlockName', { message: 'Bu isimde bir blok zaten var.' }, { shouldFocus: true });
        }
      }
    }
  });

  const generalError =
    createUnit.isError &&
    !Object.values(errors).some((e) => e?.type === 'server' || e?.message?.includes('zaten') || e?.message?.includes('aşamaz'));

  return (
    <Dialog open={open} onClose={() => !createUnit.isPending && onClose()} title="Yeni daire ekle">
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        {generalError && <Alert tone="danger">{errorMessage(createUnit.error)}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Blok" error={errors.blockId?.message}>
            <Select disabled={blocks.isPending} {...form.register('blockId')}>
              <option value="" disabled>
                {blocks.isPending ? 'Yükleniyor…' : 'Blok seçin'}
              </option>
              {activeBlocks.map((b) => (
                <option key={b.blockId} value={b.blockId}>
                  {b.name}
                </option>
              ))}
              <option value={NEW_BLOCK}>+ Yeni blok oluştur</option>
            </Select>
          </FormField>
          {blockId === NEW_BLOCK ? (
            <FormField label="Yeni blok adı" error={errors.newBlockName?.message} hint={noBlocks ? 'Apartmanda henüz blok yok.' : undefined}>
              <Input placeholder="Örn. A Blok" {...form.register('newBlockName')} />
            </FormField>
          ) : (
            <FormField label="Tip" error={errors.type?.message}>
              <Select {...form.register('type')}>
                {UNIT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {UNIT_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Daire no" error={errors.number?.message}>
            <Input autoComplete="off" placeholder="Örn. 5 veya 12A" {...form.register('number')} />
          </FormField>
          <FormField label="Kat" error={errors.floor?.message} hint="Zemin 0, bodrum için eksi değer.">
            <Input inputMode="numeric" placeholder="Örn. 3" {...form.register('floor')} />
          </FormField>
        </div>

        {blockId === NEW_BLOCK && (
          <FormField label="Tip" error={errors.type?.message}>
            <Select {...form.register('type')}>
              {UNIT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {UNIT_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </FormField>
        )}

        <FormField label="Brüt alan (m²)" error={errors.grossAreaM2?.message} hint="Metrekare bazlı dağıtımda kullanılır.">
          <Input inputMode="decimal" placeholder="Örn. 112,5" {...form.register('grossAreaM2')} />
        </FormField>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-small font-medium">
            Arsa payı <span className="font-normal text-muted">(isteğe bağlı, tapudaki gibi)</span>
          </legend>
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <Input
                aria-label="Arsa payı (pay)"
                inputMode="numeric"
                placeholder="Pay, örn. 24"
                invalid={!!errors.landShareNumerator}
                {...form.register('landShareNumerator')}
              />
            </div>
            <span className="pt-2 text-muted" aria-hidden="true">
              /
            </span>
            <div className="flex-1">
              <Input
                aria-label="Arsa payı (payda)"
                inputMode="numeric"
                placeholder="Payda, örn. 480"
                invalid={!!errors.landShareDenominator}
                {...form.register('landShareDenominator')}
              />
            </div>
          </div>
          {(errors.landShareNumerator || errors.landShareDenominator) && (
            <p role="alert" className="text-small text-danger">
              {errors.landShareNumerator?.message ?? errors.landShareDenominator?.message}
            </p>
          )}
        </fieldset>

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={createUnit.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={createUnit.isPending}>
            Daireyi ekle
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
