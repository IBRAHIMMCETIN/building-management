import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { Alert, Button, Dialog, FormField, Input, Select, Textarea } from '@/components/ui';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useSaveTender } from '@/hooks/useTenders';
import { useTicketList } from '@/hooks/useTickets';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { TENDER_CATEGORIES, type Tender } from '@/lib/api/tenders';
import { istanbulToday } from '@/lib/reservations/model';
import { TENDER_CATEGORY_LABELS } from '@/lib/tenders/model';
import { TENDER_FORM_FIELDS, type TenderForm, type TenderValues, tenderDefaults, tenderFormSchema, toTenderInput } from './schemas';

type Props = { open: boolean; onClose: () => void; tender?: Tender };

/** Yeni ihale (taslak) veya taslak / toplama asamasindaki ihalenin bilgilerini duzenleme. */
export function TenderDialog({ open, onClose, tender }: Props) {
  const save = useSaveTender();
  const navigate = useNavigate();
  const [key, renewKey] = useIdempotencyKey();
  const tickets = useTicketList({ limit: 50 });
  const form = useForm<TenderForm, unknown, TenderValues>({ resolver: zodResolver(tenderFormSchema), defaultValues: tenderDefaults(tender) });
  const { errors } = form.formState;

  useEffect(() => {
    if (!open) return;
    save.reset();
    renewKey();
    form.reset(tenderDefaults(tender));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open, tender]);

  const submit = form.handleSubmit(async (v) => {
    try {
      const r = await save.mutateAsync({ ...(tender ? { id: tender.tenderId, version: tender.version } : {}), idempotencyKey: key, input: toTenderInput(v) });
      onClose();
      if (!tender) navigate(`/admin/tenders/${encodeURIComponent(r.tender.tenderId)}`);
    } catch (err) {
      applyApiFieldError(err, form.setError, TENDER_FORM_FIELDS);
    }
  });

  const conflict = save.error instanceof ApiError && save.error.status === 409;
  const close = () => !save.isPending && onClose();
  const ticketOptions = tickets.data?.items ?? [];
  const linked = tender?.ticket;

  return (
    <Dialog open={open} onClose={close} title={tender ? 'İhaleyi düzenle' : 'Yeni ihale'} variant="wide">
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        {save.isError && !Object.values(errors).some((e) => e?.type === 'server') && (
          <Alert tone="danger">{conflict ? 'İhale bu arada değiştirildi. Pencereyi kapatıp yeniden açın.' : errorMessage(save.error)}</Alert>
        )}
        <FormField label="İşin adı" error={errors.title?.message}>
          <Input autoComplete="off" maxLength={120} placeholder="Örn. A Blok dış cephe mantolama" {...form.register('title')} />
        </FormField>
        <FormField label="İşin kapsamı" error={errors.description?.message} hint="Firmalardan istenen işi, metrajı ve şartları yazın. Sakinler yayından sonra görür.">
          <Textarea rows={5} maxLength={4000} {...form.register('description')} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Kategori" error={errors.category?.message}>
            <Select {...form.register('category')}>
              {TENDER_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {TENDER_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Son teklif tarihi" error={errors.deadline?.message}>
            <Input type="date" min={istanbulToday()} {...form.register('deadline')} />
          </FormField>
          <FormField label="Asgari teklif sayısı" error={errors.minQuotes?.message} hint="Altında yayınlamak için gerekçe istenir.">
            <Input inputMode="numeric" {...form.register('minQuotes')} />
          </FormField>
        </div>
        {(ticketOptions.length > 0 || linked) && (
          <FormField label="İlgili arıza / bakım talebi (isteğe bağlı)" error={errors.ticketId?.message}>
            <Select {...form.register('ticketId')}>
              <option value="">Bağlı talep yok</option>
              {linked && !ticketOptions.some((t) => t.ticketId === linked.ticketId) && (
                <option value={linked.ticketId}>
                  {linked.number} · {linked.title}
                </option>
              )}
              {ticketOptions.map((t) => (
                <option key={t.ticketId} value={t.ticketId}>
                  {t.number} · {t.title}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={close} disabled={save.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={save.isPending}>
            {tender ? 'Kaydet' : 'Taslağı oluştur'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
