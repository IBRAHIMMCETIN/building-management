import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input, Textarea } from '@/components/ui';
import { useApproveAnnouncement, useCreateAnnouncement, useUpdateAnnouncement } from '@/hooks/useAnnouncements';
import type { Announcement } from '@/lib/api/announcements';
import { errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { formatDateTime, nowIstanbulLocal } from '@/lib/dates';
import type { Block } from '@/lib/api/units';
import { type AnnouncementForm, type AnnouncementValues, FORM_FIELDS, announcementSchema, formDefaults, toCreateInput, toUpdateInput } from './schemas';

type Props = {
  open: boolean;
  onClose: () => void;
  /** Verilirse taslak duzenlenir; yoksa yeni duyuru. */
  announcement?: Announcement;
  blocks: Block[];
};

type Intent = 'draft' | 'publish';
type Outcome = { kind: 'saved' | 'published'; item: Announcement } | { kind: 'publish_failed'; message: string } | null;

export function AnnouncementDialog({ open, onClose, announcement, blocks }: Props) {
  const create = useCreateAnnouncement();
  const update = useUpdateAnnouncement();
  const approve = useApproveAnnouncement();
  const [intent, setIntent] = useState<Intent>('draft');
  const [outcome, setOutcome] = useState<Outcome>(null);
  const editing = Boolean(announcement);

  const form = useForm<AnnouncementForm, unknown, AnnouncementValues>({
    resolver: zodResolver(announcementSchema),
    defaultValues: formDefaults(announcement),
  });
  const { errors } = form.formState;
  const timing = form.watch('timing');
  const selectedBlocks = form.watch('blockIds');

  useEffect(() => {
    if (!open) return;
    create.reset();
    update.reset();
    approve.reset();
    setOutcome(null);
    form.reset(formDefaults(announcement));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open, announcement]);

  const saveError = create.error ?? update.error;
  const pending = create.isPending || update.isPending || approve.isPending;

  const toggleBlock = (blockId: string, checked: boolean) => {
    const next = checked ? [...selectedBlocks, blockId] : selectedBlocks.filter((id) => id !== blockId);
    form.setValue('blockIds', next, { shouldDirty: true });
  };

  const submit = (which: Intent) =>
    form.handleSubmit(async (v) => {
      setIntent(which);
      let saved: Announcement;
      try {
        saved = announcement
          ? await update.mutateAsync({ id: announcement.announcementId, input: toUpdateInput(v, announcement.version) })
          : await create.mutateAsync(toCreateInput(v));
      } catch (err) {
        applyApiFieldError(err, form.setError, FORM_FIELDS);
        return;
      }
      if (which === 'draft') {
        setOutcome({ kind: 'saved', item: saved });
        return;
      }
      try {
        setOutcome({ kind: 'published', item: await approve.mutateAsync({ id: saved.announcementId, version: saved.version }) });
      } catch (err) {
        setOutcome({ kind: 'publish_failed', message: errorMessage(err) });
      }
    });

  const close = () => !pending && onClose();
  const title = editing ? 'Taslağı düzenle' : 'Yeni duyuru';

  if (outcome) {
    return (
      <Dialog open={open} onClose={close} title={title}>
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          {outcome.kind === 'publish_failed' ? (
            <Alert tone="danger">
              Duyuru taslak olarak kaydedildi ancak yayınlanamadı: {outcome.message} Listeden tekrar yayınlayabilirsiniz.
            </Alert>
          ) : (
            <>
              <CheckCircle2 className="size-10 text-success" aria-hidden="true" />
              <p className="font-semibold">
                {outcome.kind === 'saved'
                  ? 'Taslak kaydedildi'
                  : Date.parse(outcome.item.publishAt) > Date.now()
                    ? `Duyuru ${formatDateTime(outcome.item.publishAt)} tarihinde yayınlanacak`
                    : 'Duyuru yayınlandı'}
              </p>
              {outcome.kind === 'saved' && <p className="text-small text-muted">Sakinler taslağı göremez. Hazır olduğunuzda listeden yayınlayın.</p>}
            </>
          )}
          <Button className="mt-2" onClick={onClose}>
            Tamam
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={close} title={title} className="max-w-xl">
      <form className="flex flex-col gap-4" noValidate onSubmit={submit('draft')}>
        {saveError && !Object.values(errors).some((e) => e?.type === 'server') && <Alert tone="danger">{errorMessage(saveError)}</Alert>}

        <FormField label="Başlık" error={errors.title?.message}>
          <Input autoComplete="off" maxLength={150} placeholder="Örn. Su kesintisi" {...form.register('title')} />
        </FormField>

        <FormField label="Duyuru metni" error={errors.body?.message}>
          <Textarea maxLength={5000} placeholder="Sakinlerin göreceği metin" {...form.register('body')} />
        </FormField>

        {blocks.length > 1 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-small font-medium">Kimler görsün?</legend>
            <p className="text-small text-muted">Blok seçmezseniz duyuru tüm apartmana gider.</p>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {blocks.map((b) => (
                <label key={b.blockId} className="inline-flex items-center gap-2 text-body">
                  <input
                    type="checkbox"
                    className="size-4 accent-accent"
                    checked={selectedBlocks.includes(b.blockId)}
                    onChange={(e) => toggleBlock(b.blockId, e.target.checked)}
                  />
                  {b.name}
                </label>
              ))}
            </div>
            {errors.blockIds?.message && <p className="text-small text-danger">{errors.blockIds.message}</p>}
          </fieldset>
        )}

        <fieldset className="flex flex-col gap-2">
          <legend className="text-small font-medium">Yayın zamanı</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <label className="inline-flex items-center gap-2">
              <input type="radio" value="now" className="size-4 accent-accent" {...form.register('timing')} />
              Yayınlayınca hemen
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="radio" value="scheduled" className="size-4 accent-accent" {...form.register('timing')} />
              İleri bir tarihte
            </label>
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          {timing === 'scheduled' && (
            <FormField label="Yayın tarihi ve saati" error={errors.publishAt?.message}>
              <Input type="datetime-local" min={nowIstanbulLocal()} {...form.register('publishAt')} />
            </FormField>
          )}
          <FormField label="Bitiş (isteğe bağlı)" error={errors.expiresAt?.message} hint="Bu zamandan sonra sakinler duyuruyu görmez.">
            <Input type="datetime-local" min={nowIstanbulLocal()} {...form.register('expiresAt')} />
          </FormField>
        </div>

        <p className="text-small text-muted">Yayınlanan duyuru değiştirilemez. Düzeltme için arşivleyip yenisini oluşturun.</p>

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={close} disabled={pending}>
            Vazgeç
          </Button>
          <Button type="submit" variant="secondary" loading={pending && intent === 'draft'} disabled={pending}>
            Taslak olarak kaydet
          </Button>
          <Button onClick={submit('publish')} loading={pending && intent === 'publish'} disabled={pending}>
            {timing === 'scheduled' ? 'Kaydet ve planla' : 'Kaydet ve yayınla'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
