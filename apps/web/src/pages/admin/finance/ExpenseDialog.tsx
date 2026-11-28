import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input, Select, Textarea } from '@/components/ui';
import { useFinanceAccounts, useFinanceSummary, useRecordExpense } from '@/hooks/useFinance';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { INVOICE_ACCEPT, documentsApi, invoiceFileError } from '@/lib/api/documents';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import type { RecordExpenseInput } from '@/lib/api/finance';
import { formatTRY, kurusToInput } from '@/lib/money';
import { type ExpenseForm, type ExpenseValues, expenseSchema, todayIstanbul } from './schemas';

/**
 * On dolum (ornek: karara baglanmis ihale). Tutar kurus. `creditAccountId` / `creditAccountName`:
 * eslestirilmis tedarikci (vadeli borc) hesabi; secenek listesine eklenir ve varsayilan olur.
 */
export type ExpensePreset = { expenseAccountId?: string; amount?: number; date?: string; description?: string; supplier?: string; creditAccountId?: string; creditAccountName?: string };

/** Baglantili kayitta ek alan: karar tutari asiminda gerekce (ihale hakedisi). */
export type LinkedExpenseInput = RecordExpenseInput & { overrunReason?: string };

type Props = {
  open: boolean;
  onClose: () => void;
  /** Acilista forma yazilir; kullanici degistirebilir. */
  preset?: ExpensePreset;
  /**
   * Gider baska bir modulun ucundan kaydedilir (ornek: `POST /api/tenders/:id/expense`; ayni Finans
   * gider servisi). Verilmezse `POST /api/finance/expenses`. Bu modda "Yeni gider" sunulmaz.
   */
  onRecord?: (input: LinkedExpenseInput) => Promise<{ amount: number }>;
  title?: string;
};

const FIELDS = ['expenseAccountId', 'creditAccountId', 'amount', 'date', 'description', 'supplier', 'invoiceNumber'] as const;

const PAYABLE = 'payable';

type Uploaded = { signature: string; value: { uploadId: string; fileName: string } };
const signatureOf = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

export function ExpenseDialog({ open, onClose, preset, onRecord, title = 'Gider kaydı ekle' }: Props) {
  const expenseAccounts = useFinanceAccounts('expense');
  const summary = useFinanceSummary();
  const financeRecord = useRecordExpense();
  const linkedRecord = useMutation({
    mutationFn: async (input: LinkedExpenseInput) => ({ expense: await (onRecord as NonNullable<Props['onRecord']>)(input) }),
  });
  // Ihale hakedisi: gecerli giderler karar tutarini asarsa API 422 `overBudget` doner; gerekce istenir.
  const [overrun, setOverrun] = useState(false);
  const [overrunReason, setOverrunReason] = useState('');
  const record = onRecord ? linkedRecord : financeRecord;
  const [idempotencyKey, renewKey] = useIdempotencyKey();
  // Fatura dosyasi: secilen dosya, ayni modal icinde yeniden denemede tekrar yuklenmesin diye
  // yukleme sonucu ve input'u sifirlamak icin anahtar.
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [uploading, setUploading] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);

  const initial = (): ExpenseForm => ({
    expenseAccountId: preset?.expenseAccountId ?? '',
    creditAccountId: preset?.creditAccountId ?? 'cash',
    amount: preset?.amount ? kurusToInput(preset.amount) : '',
    date: preset?.date ?? todayIstanbul(),
    description: preset?.description ?? '',
    supplier: preset?.supplier ?? '',
    invoiceNumber: '',
  });
  const form = useForm<ExpenseForm, unknown, ExpenseValues>({
    resolver: zodResolver(expenseSchema),
    defaultValues: initial(),
  });
  const { errors } = form.formState;
  const source = form.watch('creditAccountId');
  const sourceAccount = summary.data?.fundsAccounts.find((a) => a.accountId === source);

  useEffect(() => {
    if (!open) return;
    record.reset();
    renewKey();
    form.reset(initial());
    clearFile();
    setOverrun(false);
    setOverrunReason('');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open]);

  function clearFile() {
    setFile(null);
    setFileError(null);
    setUploaded(null);
    setFileInputKey((k) => k + 1);
  }

  function onFileChange(next: File | null) {
    setFile(next);
    setFileError(next ? invoiceFileError(next) : null);
    // Farkli dosya = farkli istek: onceki denemenin anahtariyla gonderilirse 409 olurdu.
    if (record.isError) renewKey();
  }

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
    let invoiceUpload: Uploaded['value'] | undefined;
    if (file) {
      const invalid = invoiceFileError(file);
      if (invalid) {
        setFileError(invalid);
        return;
      }
      const signature = signatureOf(file);
      if (uploaded?.signature === signature) {
        invoiceUpload = uploaded.value;
      } else {
        setUploading(true);
        try {
          invoiceUpload = await documentsApi.uploadInvoice(file);
          setUploaded({ signature, value: invoiceUpload });
        } catch (err) {
          setFileError(errorMessage(err));
          return;
        } finally {
          setUploading(false);
        }
      }
    }
    if (overrun && overrunReason.trim().length < 10) return;
    const input: LinkedExpenseInput = { idempotencyKey, ...v, invoiceUpload, ...(overrun ? { overrunReason: overrunReason.trim() } : {}) };
    try {
      await record.mutateAsync(input);
    } catch (err) {
      if (onRecord && err instanceof ApiError && err.body?.overBudget === true && !overrun) {
        setOverrun(true);
        return;
      }
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
    <Dialog open={open} onClose={() => !record.isPending && !uploading && onClose()} title={title}>
      {done ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <CheckCircle2 className="size-10 text-success" aria-hidden="true" />
          <p className="font-semibold">{formatTRY(done.expense.amount)} gider kaydedildi</p>
          <div className="flex w-full flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-center">
            {!onRecord && (
              <Button
                variant="secondary"
                onClick={() => {
                  record.reset();
                  renewKey();
                  form.reset({ ...form.getValues(), amount: '', description: '', supplier: '', invoiceNumber: '' });
                  clearFile();
                }}
              >
                Yeni gider
              </Button>
            )}
            <Button onClick={onClose}>Tamam</Button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          {record.isError && !Object.values(errors).some((e) => e?.type === 'server') && (
            <Alert tone={overrun ? 'info' : 'danger'}>{errorMessage(record.error)}</Alert>
          )}
          {overrun && (
            <FormField label="Aşım gerekçesi" hint="Geçerli giderler karar tutarını aşıyor; gerekçe denetim günlüğüne ve hakediş kaydına yazılır (en az 10 karakter).">
              <Textarea rows={2} maxLength={500} value={overrunReason} onChange={(e) => setOverrunReason(e.target.value)} />
            </FormField>
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
              source === PAYABLE || (preset?.creditAccountId && source === preset.creditAccountId)
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
              {preset?.creditAccountId && preset.creditAccountId !== PAYABLE && !funds.some((a) => a.accountId === preset.creditAccountId) && (
                <option value={preset.creditAccountId}>Vadeli: {preset.creditAccountName ?? 'eşleştirilmiş tedarikçi'}</option>
              )}
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

          <FormField label="Fatura dosyası (isteğe bağlı)" error={fileError ?? undefined} hint="PDF veya fotoğraf, en fazla 10 MB. Denetçiler görüntüleyebilir.">
            <Input
              key={fileInputKey}
              type="file"
              accept={INVOICE_ACCEPT}
              className="h-auto py-1.5 file:mr-3 file:rounded-md file:border-0 file:bg-surface-muted file:px-3 file:py-1 file:text-xs file:font-medium file:text-text"
              onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
            />
          </FormField>
          {file && (
            <button type="button" onClick={clearFile} className="-mt-2 self-start text-xs text-muted underline-offset-4 hover:text-text hover:underline">
              Dosyayı kaldır
            </button>
          )}

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose} disabled={record.isPending || uploading}>
              Vazgeç
            </Button>
            <Button type="submit" loading={record.isPending || uploading} disabled={Boolean(file && invoiceFileError(file)) || (overrun && overrunReason.trim().length < 10)}>
              {overrun ? 'Gerekçeyle kaydet' : 'Gideri kaydet'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
