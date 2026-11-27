import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input, Select, Textarea } from '@/components/ui';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useSaveQuote } from '@/hooks/useTenders';
import { INVOICE_ACCEPT, documentsApi, invoiceFileError } from '@/lib/api/documents';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import type { Quote, Tender } from '@/lib/api/tenders';
import { formatTRY, parseTRYToKurus } from '@/lib/money';
import { VAT_RATES, normalizeQuote } from '@/lib/tenders/model';
import { QUOTE_FIELD_MAP, QUOTE_FORM_FIELDS, type QuoteForm, type QuoteValues, quoteDefaults, quoteFormSchema, toQuoteInput } from './schemas';

type Props = { open: boolean; onClose: () => void; tender: Tender; quote?: Quote };
type Uploaded = { signature: string; value: { uploadId: string; fileName: string } };

const signatureOf = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

/**
 * Teklif ekleme / duzeltme. Belge (PDF veya fotograf, en fazla 10 MB) gider faturasi akisiyla
 * dogrudan S3'e yuklenir; teklif kaydinda ihaleye tasinir. KDV dahil toplam canli onizlenir.
 */
export function QuoteDialog({ open, onClose, tender, quote }: Props) {
  const save = useSaveQuote();
  const [key, renewKey] = useIdempotencyKey();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [uploading, setUploading] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const form = useForm<QuoteForm, unknown, QuoteValues>({ resolver: zodResolver(quoteFormSchema), defaultValues: quoteDefaults(quote) });
  const { errors } = form.formState;
  const amount = form.watch('amount');
  const vatMode = form.watch('vatMode');
  const vatRate = form.watch('vatRate');

  useEffect(() => {
    if (!open) return;
    save.reset();
    renewKey();
    form.reset(quoteDefaults(quote));
    setFile(null);
    setFileError(null);
    setUploaded(null);
    setInputKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open, quote]);

  // Hata sonrasi form degisirse yeni istektir: ayni anahtarla farkli icerik 409 olurdu.
  useEffect(() => {
    const sub = form.watch((_, { type }) => {
      if (type === 'change' && save.isError) renewKey();
    });
    return () => sub.unsubscribe();
  }, [form, save.isError, renewKey]);

  const kurus = parseTRYToKurus(amount ?? '');
  const preview = kurus ? normalizeQuote(kurus, vatMode === 'included', Number(vatRate)) : null;
  const rates = VAT_RATES.map(String).includes(vatRate ?? '') ? VAT_RATES.map(String) : [...VAT_RATES.map(String), vatRate ?? ''];

  const onFileChange = (next: File | null) => {
    setFile(next);
    setFileError(next ? invoiceFileError(next) : null);
    if (save.isError) renewKey();
  };

  const submit = form.handleSubmit(async (v) => {
    let document: Uploaded['value'] | undefined;
    if (file) {
      const invalid = invoiceFileError(file);
      if (invalid) {
        setFileError(invalid);
        return;
      }
      const signature = signatureOf(file);
      if (uploaded?.signature === signature) document = uploaded.value;
      else {
        setUploading(true);
        try {
          document = await documentsApi.uploadInvoice(file);
          setUploaded({ signature, value: document });
        } catch (err) {
          setFileError(errorMessage(err));
          return;
        } finally {
          setUploading(false);
        }
      }
    }
    try {
      await save.mutateAsync({ tenderId: tender.tenderId, ...(quote ? { quoteId: quote.quoteId } : {}), version: tender.version, idempotencyKey: key, input: { ...toQuoteInput(v), ...(document ? { document } : {}) } });
      onClose();
    } catch (err) {
      applyApiFieldError(err, form.setError, QUOTE_FORM_FIELDS, QUOTE_FIELD_MAP);
    }
  });

  const busy = save.isPending || uploading;
  const close = () => !busy && onClose();
  const conflict = save.error instanceof ApiError && save.error.status === 409;

  return (
    <Dialog open={open} onClose={close} title={quote ? 'Teklifi düzenle' : 'Teklif ekle'} variant="wide">
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        {save.isError && !Object.values(errors).some((e) => e?.type === 'server') && (
          <Alert tone="danger">{conflict ? 'İhale bu arada değiştirildi. Pencereyi kapatıp yeniden açın.' : errorMessage(save.error)}</Alert>
        )}
        <FormField label="Firma" error={errors.supplierName?.message}>
          <Input autoComplete="off" maxLength={120} {...form.register('supplierName')} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Teklif tutarı (TL)" error={errors.amount?.message}>
            <Input inputMode="decimal" placeholder="125.000" {...form.register('amount')} />
          </FormField>
          <FormField label="Tutar" error={errors.vatMode?.message}>
            <Select {...form.register('vatMode')}>
              <option value="included">KDV dahil</option>
              <option value="excluded">KDV hariç (+ KDV)</option>
            </Select>
          </FormField>
          <FormField label="KDV oranı" error={errors.vatRate?.message}>
            <Select {...form.register('vatRate')}>
              {rates.map((r) => (
                <option key={r} value={r}>
                  %{r}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        {preview && (
          <p className="rounded-lg bg-surface-muted/40 px-3 py-2 text-small tabular-nums" aria-live="polite">
            KDV dahil toplam <strong>{formatTRY(preview.totalKurus)}</strong> · matrah {formatTRY(preview.netKurus)} · KDV {formatTRY(preview.vatKurus)}
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Geçerlilik (isteğe bağlı)" error={errors.validUntil?.message}>
            <Input type="date" {...form.register('validUntil')} />
          </FormField>
          <FormField label="İş süresi (gün)" error={errors.deliveryDays?.message}>
            <Input inputMode="numeric" placeholder="Örn. 45" {...form.register('deliveryDays')} />
          </FormField>
          <FormField label="Garanti (ay)" error={errors.warrantyMonths?.message}>
            <Input inputMode="numeric" placeholder="Örn. 24" {...form.register('warrantyMonths')} />
          </FormField>
        </div>
        <FormField label="Not (isteğe bağlı)" error={errors.notes?.message} hint="Ödeme şartları, malzeme markası, hariç tutulan işler…">
          <Textarea rows={3} maxLength={1000} {...form.register('notes')} />
        </FormField>
        <FormField
          label={quote?.document ? 'Teklif belgesini değiştir (isteğe bağlı)' : 'Teklif belgesi'}
          error={fileError ?? undefined}
          hint={quote?.document ? `Mevcut: ${quote.document.fileName}. Yeni dosya eskisinin yerine geçer; eskisi kayıtta kalır.` : 'PDF veya fotoğraf, en fazla 10 MB. Yayınlamak için her teklifin belgesi gerekir.'}
        >
          <Input
            key={inputKey}
            type="file"
            accept={INVOICE_ACCEPT}
            className="h-auto py-1.5 file:mr-3 file:rounded-md file:border-0 file:bg-surface-muted file:px-3 file:py-1 file:text-xs file:font-medium file:text-text"
            onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
          />
        </FormField>
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={close} disabled={busy}>
            Vazgeç
          </Button>
          <Button type="submit" loading={busy} disabled={Boolean(file && invoiceFileError(file))}>
            {quote ? 'Kaydet' : 'Teklifi ekle'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
