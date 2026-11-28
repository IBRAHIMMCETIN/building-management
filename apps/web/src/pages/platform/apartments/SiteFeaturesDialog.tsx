import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Dialog, FormField, Select, Skeleton, Textarea } from '@/components/ui';
import { usePlatformSiteFeatures, useUpdateSiteFeatures } from '@/hooks/useSiteFeatureAdmin';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { FEATURE_AREA_LABELS, PROFILE_LABELS, type FeatureProfile, isPlanModuleKey } from '@/lib/features/catalog';
import { useBillingSettings } from '@/hooks/useSubscriptions';
import { type FeatureChoice, type FeatureDraft, REASON_MIN, buildFeaturePatch, draftFromView, effectiveValue } from '@/lib/features/draft';

const CHOICE_LABELS = (defaultOn: boolean): Record<FeatureChoice, string> => ({
  default: `Mod varsayılanı (${defaultOn ? 'açık' : 'kapalı'})`,
  on: 'Açık',
  off: 'Kapalı',
});

/**
 * Platform: bir sitenin ozellik anahtarlari. Mod (Tam / Sade) varsayilanlari belirler; her anahtar
 * istenirse ayrica acilip kapatilabilir. Gerekce zorunludur; degisiklik sitenin denetim gunlugune
 * yazilir. Calisan moduller silinmez, yalnizca gizlenir.
 */
export function SiteFeaturesDialog({ site, onClose }: { site: { siteId: string; name: string } | undefined; onClose: () => void }) {
  const query = usePlatformSiteFeatures(site?.siteId);
  // Abonelik modul anahtarlari yalnizca abonelik sistemi aciksa listelenir.
  const billing = useBillingSettings();
  const showPlanModules = billing.data?.enabled === true;
  const update = useUpdateSiteFeatures(site?.siteId ?? '');
  const [draft, setDraft] = useState<FeatureDraft | null>(null);
  const [reason, setReason] = useState('');
  const [saved, setSaved] = useState(false);
  const view = query.data;

  useEffect(() => {
    if (view) setDraft(draftFromView(view));
  }, [view]);

  const close = () => {
    setReason('');
    setSaved(false);
    setDraft(null);
    update.reset();
    onClose();
  };

  const patch = useMemo(() => (view && draft ? buildFeaturePatch(view, draft, reason) : null), [view, draft, reason]);
  const tooShort = reason.trim().length < REASON_MIN;
  const conflict = update.error instanceof ApiError && update.error.status === 409;

  return (
    <Dialog open={!!site} onClose={close} title={`Site özellikleri · ${site?.name ?? ''}`} className="max-w-2xl">
      {query.isPending && <Skeleton className="h-48" />}
      {query.isError && <Alert tone="danger">{errorMessage(query.error)}</Alert>}
      {view && draft && (
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!patch || tooShort) return;
            setSaved(false);
            update.mutate(patch, {
              onSuccess: () => {
                setReason('');
                setSaved(true);
              },
              onError: (err) => {
                if (err instanceof ApiError && err.status === 409) void query.refetch();
              },
            });
          }}
        >
          {view.inherited && (
            <Alert>Bu site Adım 1 öncesinde açıldı; tam mod varsayılanları uygulanıyor (mevcut davranış korunuyor).</Alert>
          )}
          <FormField label="Kullanım modu" hint="Sade mod: teknolojiyi az kullanan yönetici ve sakinler için gizlemeler açık.">
            <Select value={draft.profile} onChange={(e) => setDraft({ ...draft, profile: e.target.value as FeatureProfile })}>
              {(Object.keys(PROFILE_LABELS) as FeatureProfile[]).map((p) => (
                <option key={p} value={p}>
                  {PROFILE_LABELS[p]}
                </option>
              ))}
            </Select>
          </FormField>

          <ul className="flex flex-col divide-y divide-border" aria-label="Özellik anahtarları">
            {view.catalog.filter((def) => showPlanModules || !isPlanModuleKey(def.key)).map((def) => {
              const labels = CHOICE_LABELS(def.defaults[draft.profile]);
              const on = effectiveValue(draft, def.key, def.defaults);
              return (
                <li key={def.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-small font-medium">
                      {def.label}
                      <Badge>{FEATURE_AREA_LABELS[def.area]}</Badge>
                      {def.upcoming && <Badge tone="warning">Yakında</Badge>}
                      {def.platformSetup && <Badge tone="accent">Kurulum</Badge>}
                    </p>
                    <p className="text-small text-muted">{def.description}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {on ? <Badge tone="success">Açık</Badge> : <Badge>Kapalı</Badge>}
                    <Select
                      aria-label={`${def.label} seçimi`}
                      className="w-56"
                      value={draft.choices[def.key]}
                      onChange={(e) => setDraft({ ...draft, choices: { ...draft.choices, [def.key]: e.target.value as FeatureChoice } })}
                    >
                      {(['default', 'on', 'off'] as const).map((c) => (
                        <option key={c} value={c}>
                          {labels[c]}
                        </option>
                      ))}
                    </Select>
                  </div>
                </li>
              );
            })}
          </ul>

          <FormField label="Gerekçe" hint={`Denetim günlüğüne yazılır (en az ${REASON_MIN} karakter).`}>
            <Textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          {conflict && <Alert tone="danger">Site ayarları bu arada değişti; güncel durum yüklendi. Seçimlerinizi kontrol edip tekrar kaydedin.</Alert>}
          {update.isError && !conflict && <Alert tone="danger">{errorMessage(update.error)}</Alert>}
          {saved && !patch && <Alert tone="success">Özellikler kaydedildi.</Alert>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              Kapat
            </Button>
            <Button type="submit" disabled={!patch || tooShort || update.isPending}>
              Kaydet
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
