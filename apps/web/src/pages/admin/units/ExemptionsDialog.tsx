import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input } from '@/components/ui';
import { useUpdateUnitExemptions } from '@/hooks/useUnits';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { EXPENSE_CATEGORIES } from '@/lib/api/finance';
import type { UnitExemption } from '@/lib/api/units';
import { cn } from '@/lib/cn';
import { type ExemptionsForm, type ExemptionsValues, exemptionsSchema } from './schemas';
import type { UnitRow } from './unitRows';

type Props = { row: UnitRow | null; onClose: () => void };

const KNOWN = new Set<string>(EXPENSE_CATEGORIES.map((c) => c.value));

function friendlyMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) return 'Daire bu arada değişti. Pencereyi kapatıp yeniden açın.';
  return errorMessage(err);
}

/**
 * Isaretli gider kalemleri yazilir. Bu ekranda olmayan (API / toplu aktarimla girilmis)
 * kalemler korunur; zaten var olan kalemin gecerlilik tarihleri korunur.
 */
function nextExemptions(current: UnitExemption[], v: ExemptionsValues): UnitExemption[] {
  const reason = v.reason || undefined;
  const kept = current.filter((e) => !KNOWN.has(e.expenseCategory));
  const checked = v.categories.map((category) => {
    const existing = current.find((e) => e.expenseCategory === category);
    return { ...existing, expenseCategory: category, reason };
  });
  return [...kept, ...checked];
}

export function ExemptionsDialog({ row, onClose }: Props) {
  const update = useUpdateUnitExemptions();
  const form = useForm<ExemptionsForm, unknown, ExemptionsValues>({
    resolver: zodResolver(exemptionsSchema),
    defaultValues: { categories: [], reason: '' },
  });
  const { errors } = form.formState;

  useEffect(() => {
    if (!row) return;
    update.reset();
    const current = row.unit.exemptions.filter((e) => KNOWN.has(e.expenseCategory));
    form.reset({ categories: current.map((e) => e.expenseCategory), reason: current.find((e) => e.reason)?.reason ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca daire degisince
  }, [row?.unit.unitId]);

  const submit = form.handleSubmit(async (v) => {
    if (!row) return;
    try {
      await update.mutateAsync({
        unitId: row.unit.unitId,
        version: row.unit.version,
        exemptions: nextExemptions(row.unit.exemptions, v),
      });
      onClose();
    } catch {
      // Hata asagidaki uyarida gosterilir.
    }
  });

  const title = row ? `Muafiyetler · ${row.blockName} / ${row.unit.number}` : 'Muafiyetler';

  return (
    <Dialog open={row !== null} onClose={() => !update.isPending && onClose()} title={title}>
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        {update.isError && <Alert tone="danger">{friendlyMessage(update.error)}</Alert>}

        <fieldset>
          <legend className="mb-1.5 text-small font-medium">Bu daire şu giderlerden pay almaz</legend>
          <div className="grid grid-cols-2 gap-2">
            {EXPENSE_CATEGORIES.map((c) => (
              <label
                key={c.value}
                className={cn(
                  'flex cursor-pointer items-center justify-center rounded-md border border-border px-3 py-2 text-small font-medium',
                  'has-checked:border-accent has-checked:bg-accent/10 has-checked:text-accent',
                  'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent',
                )}
              >
                <input type="checkbox" value={c.value} className="sr-only" {...form.register('categories')} />
                {c.label}
              </label>
            ))}
          </div>
        </fieldset>

        <FormField
          label="Gerekçe (isteğe bağlı)"
          error={errors.reason?.message}
          hint="Toplu borçlandırma özetinde muaf dairenin yanında görünür."
        >
          <Input placeholder="Örn. Zemin kat dükkan" autoComplete="off" {...form.register('reason')} />
        </FormField>

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={update.isPending}>
            Kaydet
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
