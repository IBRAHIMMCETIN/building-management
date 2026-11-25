import { useFinanceAccounts } from '@/hooks/useFinance';
import { zodResolver } from '@hookform/resolvers/zod';
import { Archive, Droplets, Flame, Pencil, Plus, Star, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Badge, Button, Card, Dialog, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useMeterPermissions, useSaveTemplate, useTemplateAction, useTemplatePresets, useTemplates } from '@/hooks/useMeters';
import type { MeterTemplate, TemplatePreset } from '@/lib/api/meters';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import {
  BPS_TOTAL,
  CATEGORY_LABELS,
  COMMON_KEYS,
  COMMON_KEY_LABELS,
  LEGAL_PROFILES,
  LEGAL_PROFILE_LABELS,
  LIABLE_PARTIES,
  LIABLE_PARTY_LABELS,
  METER_KINDS,
  METER_KIND_LABELS,
  TEMPLATE_CATEGORIES,
  bpsToPercent,
  isLegalDeviation,
  percentToBps,
  splitLabel,
} from '@/lib/meters/model';
import { type TemplateForm, type TemplateValues, templateSchema } from './schemas';

type Editing = { template?: MeterTemplate; preset?: TemplatePreset } | null;

const FIELDS = ['name', 'meterKind', 'category', 'commonKey', 'liableParty', 'legalProfile', 'decisionRef', 'reason', 'incomeAccountId'] as const;

/** Dagitim sablonlari: hazir merkezi isitma (%30 m² + %70) ve su (%0 + %100) sablonlari, yonetmelik sapma uyarisi. */
export function TemplatesPanel() {
  const { canManage } = useMeterPermissions();
  const [showArchived, setShowArchived] = useState(false);
  const templates = useTemplates(showArchived);
  const presets = useTemplatePresets();
  const action = useTemplateAction();
  const [editing, setEditing] = useState<Editing>(null);

  const preset = (id: string) => presets.data?.find((p) => p.preset === id);
  const heating = preset('central_heating');
  const water = preset('hot_water');

  return (
    <div className="flex flex-col gap-4">
      {canManage && (
        <Card className="flex flex-col gap-3">
          <p className="text-small text-muted">
            Hazır şablonla başlayın; oran ve ortak anahtar sonradan değiştirilebilir. Merkezi ısıtmada yönetmelik esası %30 ortak (kullanım alanı) + %70
            tüketimdir; farklı oran kat malikleri kurulu kararı ister.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={!heating} onClick={() => heating && setEditing({ preset: heating })}>
              <Flame className="size-4" aria-hidden="true" />
              Merkezi ısıtma şablonu
            </Button>
            <Button variant="secondary" disabled={!water} onClick={() => water && setEditing({ preset: water })}>
              <Droplets className="size-4" aria-hidden="true" />
              Su şablonu (%100 tüketim)
            </Button>
            <Button variant="ghost" onClick={() => setEditing({})}>
              <Plus className="size-4" aria-hidden="true" />
              Boş şablon
            </Button>
          </div>
        </Card>
      )}

      <label className="flex items-center gap-2 text-small text-muted">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        Arşivlenmişleri göster
      </label>

      {templates.isError && <Alert tone="danger">{errorMessage(templates.error)}</Alert>}
      {action.isError && <Alert tone="danger">{errorMessage(action.error)}</Alert>}
      {templates.isPending && <Skeleton className="h-24" />}
      {templates.data?.length === 0 && <Alert>Henüz dağıtım şablonu yok. Yukarıdaki hazır şablonlardan biriyle başlayın.</Alert>}

      <div className="grid gap-3 md:grid-cols-2">
        {templates.data?.map((t) => {
          const deviation = t.warnings.some((w) => w.code === 'legal_deviation');
          return (
            <Card key={t.templateId} className="flex flex-col gap-2 p-4 md:p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold">{t.name}</h3>
                  <p className="text-small text-muted">
                    {CATEGORY_LABELS[t.category]} · {METER_KIND_LABELS[t.meterKind]}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  {t.isDefault && <Badge tone="accent">Varsayılan</Badge>}
                  {t.status === 'archived' && <Badge>Arşiv</Badge>}
                  {deviation && <Badge tone="warning">Yönetmelik dışı</Badge>}
                </div>
              </div>
              <p className="text-small">{splitLabel(t.commonShareBps, t.commonKey)}</p>
              <p className="text-small text-muted">Borçlu: {LIABLE_PARTY_LABELS[t.liableParty]}</p>
              {deviation && (
                <p className="text-small text-warning">
                  Karar: {t.decisionRef ?? '—'}
                  {t.reason ? ` · ${t.reason}` : ''}
                </p>
              )}
              {canManage && t.status === 'active' && (
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button size="xs" variant="secondary" onClick={() => setEditing({ template: t })}>
                    <Pencil className="size-3.5" aria-hidden="true" />
                    Düzenle
                  </Button>
                  {!t.isDefault && (
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={action.isPending && action.variables?.templateId === t.templateId && action.variables.action === 'default'}
                      onClick={() => action.mutate({ action: 'default', templateId: t.templateId, version: t.version })}
                    >
                      <Star className="size-3.5" aria-hidden="true" />
                      Varsayılan yap
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={action.isPending && action.variables?.templateId === t.templateId && action.variables.action === 'archive'}
                    onClick={() => action.mutate({ action: 'archive', templateId: t.templateId, version: t.version })}
                  >
                    <Archive className="size-3.5" aria-hidden="true" />
                    Arşivle
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <TemplateDialog editing={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function formValuesOf(e: NonNullable<Editing>): TemplateForm {
  const src = e.template ?? e.preset;
  return {
    name: src?.name ?? '',
    meterKind: src?.meterKind ?? 'heat_allocator',
    category: src?.category ?? 'heating',
    commonPercent: bpsToPercent(src?.commonShareBps ?? 3000),
    commonKey: src?.commonKey ?? 'area',
    liableParty: src?.liableParty ?? 'occupant',
    legalProfile: src?.legalProfile ?? 'central_heating',
    decisionRef: e.template?.decisionRef ?? '',
    reason: e.template?.reason ?? '',
    isDefault: e.template?.isDefault ?? !e.template,
    incomeAccountId: src?.incomeAccountId ?? '',
  };
}

export function TemplateDialog({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const save = useSaveTemplate();
  const incomeAccounts = useFinanceAccounts('income');
  const form = useForm<TemplateForm, unknown, TemplateValues>({ resolver: zodResolver(templateSchema), defaultValues: editing ? formValuesOf(editing) : undefined });
  const { errors } = form.formState;
  const [percent, commonKey, legalProfile] = form.watch(['commonPercent', 'commonKey', 'legalProfile']);
  const bps = percentToBps(percent ?? '');
  const deviation = bps !== null && isLegalDeviation({ legalProfile, commonShareBps: bps, commonKey });
  const isEdit = !!editing?.template;

  useEffect(() => {
    if (!editing) return;
    save.reset();
    form.reset(formValuesOf(editing));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [editing]);

  const submit = form.handleSubmit(async (v) => {
    const input = {
      name: v.name,
      category: v.category,
      commonShareBps: v.commonShareBps,
      commonKey: v.commonKey,
      liableParty: v.liableParty,
      legalProfile: v.legalProfile,
      ...(v.decisionRef ? { decisionRef: v.decisionRef } : {}),
      ...(v.reason ? { reason: v.reason } : {}),
      incomeAccountId: v.incomeAccountId === '' ? null : v.incomeAccountId,
    };
    try {
      if (editing?.template) {
        await save.mutateAsync({ templateId: editing.template.templateId, input: { ...input, version: editing.template.version } });
      } else {
        await save.mutateAsync({ input: { ...input, meterKind: v.meterKind, isDefault: v.isDefault } });
      }
      onClose();
    } catch (err) {
      if (applyApiFieldError(err, form.setError, FIELDS, { commonShareBps: 'commonPercent' })) return;
      // 422 + warnings: sunucu da sapma icin karar/gerekce istiyor.
      if (err instanceof ApiError && err.status === 422 && Array.isArray(err.body?.warnings)) {
        if (!v.decisionRef) form.setError('decisionRef', { type: 'server', message: 'Kat malikleri kurulu karar no/tarihi gerekli.' });
        if (!v.reason) form.setError('reason', { type: 'server', message: 'Gerekçe gerekli.' });
      }
    }
  });

  return (
    <Dialog open={!!editing} onClose={() => !save.isPending && onClose()} title={isEdit ? 'Şablonu düzenle' : 'Dağıtım şablonu'} className="max-w-lg">
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Şablon adı" error={errors.name?.message}>
          <Input {...form.register('name')} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Sayaç türü" error={errors.meterKind?.message} hint={isEdit ? 'Kayıtlı şablonda değiştirilemez.' : undefined}>
            <Select disabled={isEdit} {...form.register('meterKind')}>
              {METER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {METER_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Gider türü" error={errors.category?.message}>
            <Select {...form.register('category')}>
              {TEMPLATE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="Ortak pay (%)"
            error={errors.commonPercent?.message}
            hint={bps !== null ? `Tüketim payı %${bpsToPercent(BPS_TOTAL - bps)}` : undefined}
          >
            <Input inputMode="decimal" {...form.register('commonPercent')} />
          </FormField>
          <FormField label="Ortak pay anahtarı" error={errors.commonKey?.message}>
            <Select {...form.register('commonKey')}>
              {COMMON_KEYS.map((k) => (
                <option key={k} value={k}>
                  {COMMON_KEY_LABELS[k]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Borçlu" error={errors.liableParty?.message}>
            <Select {...form.register('liableParty')}>
              {LIABLE_PARTIES.map((p) => (
                <option key={p} value={p}>
                  {LIABLE_PARTY_LABELS[p]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Gelir hesabı" error={errors.incomeAccountId?.message}>
            <Select {...form.register('incomeAccountId')}>
              <option value="">Aidat Gelirleri (varsayılan)</option>
              {(incomeAccounts.data ?? [])
                .filter((a) => a.accountId !== 'income-dues' && a.accountId !== 'income-late-fee')
                .map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.name}
                  </option>
                ))}
            </Select>
          </FormField>
          <FormField label="Mevzuat profili" error={errors.legalProfile?.message}>
            <Select {...form.register('legalProfile')}>
              {LEGAL_PROFILES.map((p) => (
                <option key={p} value={p}>
                  {LEGAL_PROFILE_LABELS[p]}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        {deviation && (
          <div role="alert" className="flex gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-small text-warning">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              Merkezi ısıtmada yönetmelik esası %30 ortak (kullanım alanı) + %70 tüketimdir. Bu oranla kaydetmek için kat malikleri kurulu karar
              referansı ve gerekçe zorunludur.
            </span>
          </div>
        )}
        {(deviation || form.getValues('decisionRef')) && (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Karar no / tarihi" error={errors.decisionRef?.message}>
              <Input placeholder="KMK 2026/3 — 12.10.2026" {...form.register('decisionRef')} />
            </FormField>
            <FormField label="Gerekçe" error={errors.reason?.message}>
              <Textarea rows={2} {...form.register('reason')} />
            </FormField>
          </div>
        )}
        {!isEdit && (
          <label className="flex items-center gap-2 text-small">
            <input type="checkbox" {...form.register('isDefault')} />
            Bu sayaç türü için varsayılan şablon yap
          </label>
        )}
        {save.isError && !(save.error instanceof ApiError && save.error.status === 422 && Array.isArray(save.error.body?.warnings)) && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={save.isPending}>
            Kaydet
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
