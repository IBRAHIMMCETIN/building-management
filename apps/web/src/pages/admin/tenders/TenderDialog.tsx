import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
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

/**
 * Yeni ihale (taslak) veya taslak / toplama asamasindaki ihalenin bilgilerini duzenleme. Form ve
 * surum pencere acildiginda alinir (yeniden cekme formu ve 409 uyarisini silmez); 409 sonrasi
 * ayni pencereden tekrar gonderilmez, pencere kapatilip yeniden acilmalidir.
 */
export function TenderDialog({ open, onClose, tender }: Props) {
  const save = useSaveTender();
  const latest = useRef(tender);
  latest.current = tender;
  const [opened, setOpened] = useState<Tender | undefined>(tender);
  const navigate = useNavigate();
  const [key, renewKey] = useIdempotencyKey();
  const tickets = useTicketList({ limit: 50 });
  const form = useForm<TenderForm, unknown, TenderValues>({ resolver: zodResolver(tenderFormSchema), defaultValues: tenderDefaults(tender) });
  const { errors } = form.formState;

  useEffect(() => {
    if (!open) return;
    setOpened(latest.current);
    save.reset();
    renewKey();
    form.reset(tenderDefaults(latest.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista (yeniden cekme formu sifirlamaz)
  }, [open]);

  const stale = save.error instanceof ApiError && save.error.status === 409 && save.error.code === 'conflict';

  const submit = form.handleSubmit(async (v) => {
    if (stale) return;
    try {
      // Acilistaki surum: arada degisen ihalenin uzerine eski alanlarla yazilmaz (409).
      const r = await save.mutateAsync({ ...(opened ? { id: opened.tenderId, version: opened.version } : {}), idempotencyKey: key, input: toTenderInput(v) });
      onClose();
      if (!opened) navigate(`/admin/tenders/${encodeURIComponent(r.tender.tenderId)}`);
    } catch (err) {
      applyApiFieldError(err, form.setError, TENDER_FORM_FIELDS);
    }
  });

  const close = () => !save.isPending && onClose();
  const ticketOptions = tickets.data?.items ?? [];
  const linked = opened?.ticket;
  const minQuotesLocked = !!opened && opened.status !== 'draft';

  return (
    <Dialog open={open} onClose={close} title={opened ? 'İhaleyi düzenle' : 'Yeni ihale'} variant="wide">
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        {save.isError && !Object.values(errors).some((e) => e?.type === 'server') && (
          <Alert tone="danger">{stale ? 'İhale bu arada başka bir işlemle değişti; değişikliğiniz kaydedilmedi. Güncel bilgiyi görmek için pencereyi kapatıp yeniden açın.' : errorMessage(save.error)}</Alert>
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
          <FormField
            label="Asgari teklif sayısı"
            error={errors.minQuotes?.message}
            hint={minQuotesLocked ? 'Teklif toplamaya başlandıktan sonra değiştirilemez.' : 'Altında yayınlamak için gerekçe istenir.'}
          >
            <Input inputMode="numeric" readOnly={minQuotesLocked} {...form.register('minQuotes')} />
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
          <Button type="submit" loading={save.isPending} disabled={stale}>
            {opened ? 'Kaydet' : 'Taslağı oluştur'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
