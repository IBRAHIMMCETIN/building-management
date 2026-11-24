import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { PhotoInput } from '@/components/meters/PhotoInput';
import { Alert, Button, Dialog, FormField, Input, Select, Textarea } from '@/components/ui';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useCreateMeter, useRetireMeter, useSwapMeter } from '@/hooks/useMeters';
import { type Meter, type SwapPreview, metersApi } from '@/lib/api/meters';
import { errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { METER_KINDS, METER_KIND_LABELS, formatIndex, parseIndexText, todayIstanbul } from '@/lib/meters/model';
import {
  type AddMeterForm,
  type AddMeterValues,
  type RetireForm,
  type RetireValues,
  type SwapForm,
  type SwapValues,
  addMeterSchema,
  defaultScaleFor,
  retireSchema,
  swapSchema,
} from './schemas';

const SCALES = [0, 1, 2, 3, 4, 5, 6];
const scaleHint = (s: number) => (s === 0 ? 'Tam sayı (ör. 1234)' : `${s} ondalık hane (ör. 1.234,${'5'.repeat(s)})`);
/** Form dogrulamasindan gecmis endeks metni -> olcekli tam sayi. */
const toIndex = (text: string, scale: number) => {
  const r = parseIndexText(text, scale);
  return r.ok ? r.value : 0;
};

type UnitOption = { unitId: string; label: string };

// ---------------------------------------------------------------------------
// Sayac ekleme
// ---------------------------------------------------------------------------

export function AddMeterDialog({ open, onClose, units, unitId }: { open: boolean; onClose: () => void; units: UnitOption[]; unitId?: string }) {
  const create = useCreateMeter();
  const defaults = (): AddMeterForm => ({
    unitId: unitId ?? '',
    kind: 'heat_allocator',
    label: '',
    serialNo: '',
    scale: String(defaultScaleFor('heat_allocator')),
    openingIndex: '0',
    installedAt: todayIstanbul(),
  });
  const form = useForm<AddMeterForm, unknown, AddMeterValues>({ resolver: zodResolver(addMeterSchema), defaultValues: defaults() });
  const { errors } = form.formState;
  const scale = Number(form.watch('scale'));

  useEffect(() => {
    if (!open) return;
    create.reset();
    form.reset(defaults());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open, unitId]);

  const submit = form.handleSubmit(async (v) => {
    try {
      await create.mutateAsync({
        unitId: v.unitId,
        kind: v.kind,
        label: v.label,
        ...(v.serialNo ? { serialNo: v.serialNo } : {}),
        scale: v.scale,
        openingIndex: toIndex(v.openingIndex, v.scale),
        installedAt: v.installedAt,
      });
      onClose();
    } catch (err) {
      applyApiFieldError(err, form.setError, ['unitId', 'kind', 'label', 'serialNo', 'scale', 'openingIndex', 'installedAt']);
    }
  });

  return (
    <Dialog open={open} onClose={() => !create.isPending && onClose()} title="Sayaç ekle">
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Daire" error={errors.unitId?.message}>
          <Select {...form.register('unitId')}>
            <option value="">Seçin…</option>
            {units.map((u) => (
              <option key={u.unitId} value={u.unitId}>
                {u.label}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Sayaç türü" error={errors.kind?.message}>
            <Select
              {...form.register('kind', {
                onChange: (e) => form.setValue('scale', String(defaultScaleFor(e.target.value as Meter['kind']))),
              })}
            >
              {METER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {METER_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Sayaç adı / konumu" error={errors.label?.message}>
            <Input placeholder="Salon, Mutfak, Banyo…" {...form.register('label')} />
          </FormField>
          <FormField label="Seri no" error={errors.serialNo?.message} hint="Toplu aktarımda sayaç bu numarayla eşleşir.">
            <Input autoComplete="off" {...form.register('serialNo')} />
          </FormField>
          <FormField label="Ondalık hane" error={errors.scale?.message}>
            <Select {...form.register('scale')}>
              {SCALES.map((s) => (
                <option key={s} value={s}>
                  {s === 0 ? 'Yok (tam sayı)' : s}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Açılış endeksi" error={errors.openingIndex?.message} hint={scaleHint(scale)}>
            <Input inputMode="decimal" {...form.register('openingIndex')} />
          </FormField>
          <FormField label="Takılma tarihi" error={errors.installedAt?.message}>
            <Input type="date" {...form.register('installedAt')} />
          </FormField>
        </div>
        {create.isError && !errors.root && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={create.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={create.isPending}>
            Kaydet
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sayac degisimi / sifirlama
// ---------------------------------------------------------------------------

export function SwapMeterDialog({ meter, onClose }: { meter: Meter | null; onClose: () => void }) {
  const swap = useSwapMeter();
  const [idempotencyKey, renewKey] = useIdempotencyKey();
  const [preview, setPreview] = useState<SwapPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<{ sig: string; key: string } | null>(null);

  const defaults = (m: Meter): SwapForm => ({
    kind: 'replacement',
    swapDate: todayIstanbul(),
    oldClosingIndex: '',
    newOpeningIndex: '0',
    reason: '',
    newSerialNo: '',
    newLabel: '',
    scale: String(m.scale),
    newScale: String(m.scale),
  });
  const form = useForm<SwapForm, unknown, SwapValues>({ resolver: zodResolver(swapSchema), defaultValues: meter ? defaults(meter) : undefined });
  const { errors } = form.formState;
  const kind = form.watch('kind');
  const newScale = Number(form.watch('newScale'));

  useEffect(() => {
    if (!meter) return;
    swap.reset();
    renewKey();
    form.reset(defaults(meter));
    setPreview(null);
    setPreviewError(null);
    setPhoto(null);
    setPhotoError(null);
    setUploaded(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [meter?.meterId]);

  // Form degisirse onizleme gecersizlesir; hata sonrasi yeni deneme yeni anahtarla yapilir.
  useEffect(() => {
    const sub = form.watch((_, { type }) => {
      if (type !== 'change') return;
      setPreview(null);
      if (swap.isError) renewKey();
    });
    return () => sub.unsubscribe();
  }, [form, swap.isError, renewKey]);

  if (!meter) return null;

  const bodyOf = (v: SwapValues) => ({
    meterId: meter.meterId,
    kind: v.kind,
    swapDate: v.swapDate,
    oldClosingIndex: toIndex(v.oldClosingIndex, v.scale),
    newOpeningIndex: toIndex(v.newOpeningIndex, v.kind === 'replacement' ? v.newScale : v.scale),
    reason: v.reason,
    ...(v.kind === 'replacement' && v.newSerialNo ? { newSerialNo: v.newSerialNo } : {}),
    ...(v.kind === 'replacement' && v.newLabel ? { newLabel: v.newLabel } : {}),
    ...(v.kind === 'replacement' && v.newScale !== v.scale ? { newScale: v.newScale } : {}),
  });

  const runPreview = form.handleSubmit(async (v) => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      setPreview(await metersApi.previewSwap(bodyOf(v)));
    } catch (err) {
      if (!applyApiFieldError(err, form.setError, ['swapDate', 'oldClosingIndex', 'newOpeningIndex', 'reason', 'newSerialNo'])) setPreviewError(errorMessage(err));
    } finally {
      setPreviewing(false);
    }
  });

  const save = form.handleSubmit(async (v) => {
    if (photoError) return;
    let photoKey: string | undefined;
    if (photo) {
      const sig = `${photo.name}|${photo.size}|${photo.lastModified}|${v.swapDate}`;
      if (uploaded?.sig === sig) photoKey = uploaded.key;
      else {
        setUploading(true);
        try {
          photoKey = await metersApi.uploadMeterPhoto(meter.meterId, v.swapDate, photo);
          setUploaded({ sig, key: photoKey });
        } catch (err) {
          setPhotoError(errorMessage(err));
          return;
        } finally {
          setUploading(false);
        }
      }
    }
    try {
      await swap.mutateAsync({ idempotencyKey, ...bodyOf(v), ...(photoKey ? { photoKey } : {}) });
      onClose();
    } catch {
      /* hata kutusu asagida */
    }
  });

  const busy = swap.isPending || uploading || previewing;
  const fmtOld = (n: number) => formatIndex(n, meter.scale);

  return (
    <Dialog open={!!meter} onClose={() => !busy && onClose()} title={`Sayaç değişimi — ${meter.label}`} className="max-w-lg">
      <form noValidate onSubmit={preview ? save : runPreview} className="flex flex-col gap-4">
        <p className="text-small text-muted">
          {meter.serialNo ? `Seri no ${meter.serialNo} · ` : ''}
          {meter.lastReading
            ? `Son onaylı endeks ${fmtOld(meter.lastReading.index)} (${meter.lastReading.date})`
            : `Açılış endeksi ${fmtOld(meter.openingIndex)} (${meter.installedAt})`}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="İşlem" error={errors.kind?.message}>
            <Select {...form.register('kind')}>
              <option value="replacement">Yeni sayaçla değiştir</option>
              <option value="reset">Aynı sayaç sıfırlandı</option>
            </Select>
          </FormField>
          <FormField label="Değişim tarihi" error={errors.swapDate?.message}>
            <Input type="date" {...form.register('swapDate')} />
          </FormField>
          <FormField label="Eski sayaç kapanış endeksi" error={errors.oldClosingIndex?.message} hint={scaleHint(meter.scale)}>
            <Input inputMode="decimal" {...form.register('oldClosingIndex')} />
          </FormField>
          <FormField
            label={kind === 'replacement' ? 'Yeni sayaç açılış endeksi' : 'Sıfırlama sonrası endeks'}
            error={errors.newOpeningIndex?.message}
            hint={scaleHint(kind === 'replacement' ? newScale : meter.scale)}
          >
            <Input inputMode="decimal" {...form.register('newOpeningIndex')} />
          </FormField>
          {kind === 'replacement' && (
            <>
              <FormField label="Yeni seri no" error={errors.newSerialNo?.message}>
                <Input autoComplete="off" {...form.register('newSerialNo')} />
              </FormField>
              <FormField label="Yeni ondalık hane" error={errors.newScale?.message}>
                <Select {...form.register('newScale')}>
                  {SCALES.map((s) => (
                    <option key={s} value={s}>
                      {s === 0 ? 'Yok (tam sayı)' : s}
                    </option>
                  ))}
                </Select>
              </FormField>
            </>
          )}
        </div>
        <FormField label="Gerekçe" error={errors.reason?.message}>
          <Textarea rows={2} placeholder="Arızalı sayaç değiştirildi, servis fişi no…" {...form.register('reason')} />
        </FormField>
        <PhotoInput
          label="Kapanış endeksi fotoğrafı (kanıt)"
          file={photo}
          error={photoError}
          disabled={busy}
          onChange={(f, e) => {
            setPhoto(f);
            setPhotoError(e);
            if (swap.isError) renewKey();
          }}
        />

        {preview && (
          <Alert tone="info">
            Eski sayaç {fmtOld(preview.startIndex)} ({preview.startDate}) → {fmtOld(preview.oldClosingIndex)} arası{' '}
            <strong>{fmtOld(preview.closingDelta)}</strong> birim tüketim ilgili dönemde sayılır. Yeni sayaç{' '}
            {formatIndex(preview.newMeter.openingIndex, preview.newMeter.scale)} endeksiyle {preview.newMeter.installedAt} tarihinde başlar.
          </Alert>
        )}
        {previewError && <Alert tone="danger">{previewError}</Alert>}
        {swap.isError && <Alert tone="danger">{errorMessage(swap.error)}</Alert>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          {preview ? (
            <Button type="submit" loading={swap.isPending || uploading}>
              Değişimi kaydet
            </Button>
          ) : (
            <Button type="submit" loading={previewing}>
              Önizle
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sokum (emeklilik)
// ---------------------------------------------------------------------------

export function RetireMeterDialog({ meter, onClose }: { meter: Meter | null; onClose: () => void }) {
  const retire = useRetireMeter();
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const form = useForm<RetireForm, unknown, RetireValues>({
    resolver: zodResolver(retireSchema),
    defaultValues: { retiredAt: todayIstanbul(), closingIndex: '', reason: '', scale: String(meter?.scale ?? 0) },
  });
  const { errors } = form.formState;

  useEffect(() => {
    if (!meter) return;
    retire.reset();
    form.reset({ retiredAt: todayIstanbul(), closingIndex: '', reason: '', scale: String(meter.scale) });
    setPhoto(null);
    setPhotoError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [meter?.meterId]);

  if (!meter) return null;

  const submit = form.handleSubmit(async (v) => {
    if (photoError) return;
    let photoKey: string | undefined;
    if (photo) {
      setUploading(true);
      try {
        photoKey = await metersApi.uploadMeterPhoto(meter.meterId, v.retiredAt, photo);
      } catch (err) {
        setPhotoError(errorMessage(err));
        return;
      } finally {
        setUploading(false);
      }
    }
    try {
      await retire.mutateAsync({
        meterId: meter.meterId,
        input: { retiredAt: v.retiredAt, closingIndex: toIndex(v.closingIndex, v.scale), reason: v.reason, ...(photoKey ? { photoKey } : {}) },
      });
      onClose();
    } catch (err) {
      applyApiFieldError(err, form.setError, ['retiredAt', 'closingIndex', 'reason']);
    }
  });
  const busy = retire.isPending || uploading;

  return (
    <Dialog open={!!meter} onClose={() => !busy && onClose()} title={`Sayacı sök — ${meter.label}`}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-small text-muted">Sökülen sayaç sonraki dönemlerde okunmaz; kapanışa kadarki tüketimi açık dönemde sayılır.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Söküm tarihi" error={errors.retiredAt?.message}>
            <Input type="date" {...form.register('retiredAt')} />
          </FormField>
          <FormField label="Kapanış endeksi" error={errors.closingIndex?.message} hint={scaleHint(meter.scale)}>
            <Input inputMode="decimal" {...form.register('closingIndex')} />
          </FormField>
        </div>
        <FormField label="Gerekçe" error={errors.reason?.message}>
          <Textarea rows={2} {...form.register('reason')} />
        </FormField>
        <PhotoInput
          label="Kapanış endeksi fotoğrafı (kanıt)"
          file={photo}
          error={photoError}
          disabled={busy}
          onChange={(f, e) => {
            setPhoto(f);
            setPhotoError(e);
          }}
        />
        {retire.isError && <Alert tone="danger">{errorMessage(retire.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          <Button type="submit" variant="danger" loading={busy}>
            Sök
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
