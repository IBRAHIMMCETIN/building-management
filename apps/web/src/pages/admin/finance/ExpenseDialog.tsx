import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2 } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input, Select } from '@/components/ui';
import { useFinanceAccounts, useFinanceSummary, useRecordExpense } from '@/hooks/useFinance';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { formatTRY } from '@/lib/money';
import { type ExpenseForm, type ExpenseValues, expenseSchema, todayIstanbul } from './schemas';

type Props = { open: boolean; onClose: () => void };

const FIELDS = ['expenseAccountId', 'creditAccountId', 'amount', 'date', 'description', 'supplier', 'invoiceNumber'] as const;

const PAYABLE = 'payable';

export function ExpenseDialog({ open, onClose }: Props) {
  const expenseAccounts = useFinanceAccounts('expense');
  const summary = useFinanceSummary();
  const record = useRecordExpense();
  const [idempotencyKey, renewKey] = useIdempotencyKey();

  const form = useForm<ExpenseForm, unknown, ExpenseValues>({
    resolver: zodResolver(expenseSchema),
    defaultValues: { expenseAccountId: '', creditAccountId: 'cash', amount: '', date: todayIstanbul(), description: '', supplier: '', invoiceNumber: '' },
  });
  const { errors } = form.formState;
  const source = form.watch('creditAccountId');
  const sourceAccount = summary.data?.fundsAccounts.find((a) => a.accountId === source);

  useEffect(() => {
    if (!open) return;
    record.reset();
    renewKey();
    form.reset({ expenseAccountId: '', creditAccountId: 'cash', amount: '', date: todayIstanbul(), description: '', supplier: '', invoiceNumber: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open]);

  // Hata sonrasi form degisirse yeni islemdir: ayni anahtarla farkli icerik 409 olurdu.
  useEffect(() => {
    const sub = form.watch((_, { type }) => {
      if (type === 'change' && record.isError) renewKey();
    });
    return () => sub.unsubscribe();
  }, [form, record.isError, renewKey]);

  // Kategori secilince aciklama bossa kategori adiyla doldur.
  const onCategoryChange = (accountId: string) => {
    const name = expenseAccounts.data?.find((a) => a.accountId === accountId)?.name;
    if (name && !form.getValues('description')) form.setValue('description', name);
  };

  const submit = form.handleSubmit(async (v) => {
    try {
      await record.mutateAsync({ idempotencyKey, ...v });
    } catch (err) {
      if (applyApiFieldError(err, form.setError, FIELDS)) return;
      if (err instanceof ApiError && err.code === 'insufficient_funds') {
        form.setError(
          'amount',
          {
            type: 'server',
            message: `${sourceAccount?.name ?? 'Hesap'} bakiyesi yetersiz${sourceAccount ? ` (mevcut: ${formatTRY(sourceAccount.balance)})` : ''}. Farklı kaynak seçin veya vadeli kaydedin.`,
          },
          { shouldFocus: true },
        );
      }
    }
  });

  const done = record.data;
  const funds = summary.data?.fundsAccounts ?? [];

  return (
    <Dialog open={open} onClose={() => !record.isPending && onClose()} title="Gider kaydı ekle">
      {done ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <CheckCircle2 className="size-10 text-success" aria-hidden="true" />
          <p className="font-semibold">{formatTRY(done.expense.amount)} gider kaydedildi</p>
          <div className="flex w-full flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-center">
            <Button
              variant="secondary"
              onClick={() => {
                record.reset();
                renewKey();
                form.reset({ ...form.getValues(), amount: '', description: '', supplier: '', invoiceNumber: '' });
              }}
            >
              Yeni gider
            </Button>
            <Button onClick={onClose}>Tamam</Button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          {record.isError && !Object.values(errors).some((e) => e?.type === 'server') && (
            <Alert tone="danger">{errorMessage(record.error)}</Alert>
          )}

          <FormField label="Gider kalemi" error={errors.expenseAccountId?.message}>
            <Select
              disabled={expenseAccounts.isPending}
              {...form.register('expenseAccountId', { onChange: (e) => onCategoryChange(e.target.value) })}
            >
              <option value="" disabled>
                {expenseAccounts.isPending ? 'Yükleniyor…' : 'Kalem seçin'}
              </option>
              {expenseAccounts.data?.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.name}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="Açıklama" error={errors.description?.message}>
            <Input autoComplete="off" placeholder="Örn. Kasım ayı asansör periyodik bakımı" {...form.register('description')} />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Tutar (₺)" error={errors.amount?.message}>
              <Input inputMode="decimal" placeholder="Örn. 2.750,00" autoComplete="off" {...form.register('amount')} />
            </FormField>
            <FormField label="Tarih" error={errors.date?.message}>
              <Input type="date" max={todayIstanbul()} {...form.register('date')} />
            </FormField>
          </div>

          <FormField
            label="Ödeme kaynağı"
            error={errors.creditAccountId?.message}
            hint={
              source === PAYABLE
                ? 'Fatura tedarikçiye borç olarak yazılır; kasa/banka değişmez.'
                : sourceAccount
                  ? `Mevcut bakiye: ${formatTRY(sourceAccount.balance)}`
                  : undefined
            }
          >
            <Select {...form.register('creditAccountId')}>
              {funds.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.name} ({a.type === 'cash' ? 'peşin, nakit' : 'peşin, banka'})
                </option>
              ))}
              <option value={PAYABLE}>Vadeli (tedarikçiye borç)</option>
            </Select>
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Tedarikçi (isteğe bağlı)" error={errors.supplier?.message}>
              <Input autoComplete="off" {...form.register('supplier')} />
            </FormField>
            <FormField label="Fatura no (isteğe bağlı)" error={errors.invoiceNumber?.message}>
              <Input autoComplete="off" {...form.register('invoiceNumber')} />
            </FormField>
          </div>

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose} disabled={record.isPending}>
              Vazgeç
            </Button>
            <Button type="submit" loading={record.isPending}>
              Gideri kaydet
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
