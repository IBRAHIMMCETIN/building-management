import { Camera, Save, Sparkles, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, FilterChips, Input, Skeleton } from '@/components/ui';
import { useMeterPermissions, useReadingSheet, useSaveReadings } from '@/hooks/useMeters';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { type MeterPeriod, type ReadingItemInput, type SheetRow, itemErrorsOf, metersApi } from '@/lib/api/meters';
import { errorMessage } from '@/lib/api/errors';
import { READING_FLAG_LABELS, READING_STATUS_META, formatIndex, isOpenPeriod } from '@/lib/meters/model';
import { ImportReadingsDialog } from './ImportReadingsDialog';
import { draftItems, estimableRows } from './readingDrafts';

type Filter = 'all' | 'missing' | 'error' | 'flagged';
const CHUNK = 90;

async function saveInChunks(save: (items: ReadingItemInput[]) => Promise<unknown>, items: ReadingItemInput[]) {
  for (let i = 0; i < items.length; i += CHUNK) await save(items.slice(i, i + CHUNK));
}

/** Okuma cizelgesi (yonetici): elle giris, toplu aktarim, tahmin onayi, tur atma onayi. */
export function ReadingSheetCard({ period, unitLabel }: { period: MeterPeriod; unitLabel: (unitId: string, fallback?: string) => string }) {
  const { canManage, canWriteReadings } = useMeterPermissions();
  const sheet = useReadingSheet(period.periodId);
  const save = useSaveReadings();
  const photo = useOpenDocument();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [importing, setImporting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const open = isOpenPeriod(period.status);
  const editable = open && canWriteReadings;

  useEffect(() => {
    setDrafts({});
    setClientErrors({});
  }, [period.periodId]);

  const serverErrors = useMemo(() => new Map(itemErrorsOf(save.error).map((e) => [e.meterId ?? '', e.message])), [save.error]);
  const rows = sheet.data?.rows ?? [];
  const visible = rows.filter((r) => {
    if (filter === 'missing') return r.status === 'missing';
    if (filter === 'error') return r.status === 'error' || clientErrors[r.meterId] || serverErrors.has(r.meterId);
    if (filter === 'flagged') return r.flags.length > 0;
    return true;
  });
  const estimable = estimableRows(rows);
  const dirty = Object.values(drafts).some((v) => v.trim() !== '');

  async function run(items: ReadingItemInput[], message: string) {
    setSaved(null);
    try {
      await saveInChunks((chunk) => save.mutateAsync({ periodId: period.periodId, items: chunk }), items);
      setDrafts({});
      setClientErrors({});
      setSaved(message);
    } catch {
      /* satir hatalari / genel hata asagida */
    }
  }

  function saveDrafts() {
    const { items, invalid } = draftItems(rows, drafts);
    setClientErrors(invalid);
    if (Object.keys(invalid).length) return;
    if (items.length === 0) {
      setDrafts({});
      return;
    }
    void run(items, `${items.length} okuma kaydedildi.`);
  }

  const applyEstimates = (targets: SheetRow[]) =>
    void run(
      targets.map((r) => ({ meterId: r.meterId, acceptEstimate: true })),
      `${targets.length} sayaç için tahmini ortalama uygulandı.`,
    );

  const s = sheet.data?.summary;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Sayaç okumaları</CardTitle>
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setImporting(true)} disabled={!sheet.data}>
              <Upload className="size-4" aria-hidden="true" />
              Excel / CSV aktar
            </Button>
            {canManage && estimable.length > 0 && (
              <Button size="sm" variant="secondary" onClick={() => applyEstimates(estimable)} loading={save.isPending}>
                <Sparkles className="size-4" aria-hidden="true" />
                Tahmini Ortalama Uygula ({estimable.length})
              </Button>
            )}
            <Button size="sm" onClick={saveDrafts} disabled={!dirty} loading={save.isPending}>
              <Save className="size-4" aria-hidden="true" />
              Kaydet
            </Button>
          </div>
        )}
      </div>

      {s && (
        <div className="flex flex-wrap gap-2 text-small">
          <Badge>{s.meters} sayaç</Badge>
          <Badge tone="success">{s.ok + s.auto} hazır</Badge>
          {s.missing > 0 && <Badge tone="warning">{s.missing} eksik</Badge>}
          {s.errors > 0 && <Badge tone="danger">{s.errors} hatalı</Badge>}
          {s.spikes > 0 && <Badge tone="warning">{s.spikes} olağan dışı artış</Badge>}
          {s.estimated > 0 && <Badge tone="accent">{s.estimated} tahmini</Badge>}
          {s.outOfScope > 0 && <Badge>{s.outOfScope} kapsam dışı</Badge>}
        </div>
      )}
      {open && s && s.missing > 0 && (
        <p className="text-small text-muted">
          Eksik okuma onayı engeller. Sayacı okunamayan daireler için sistemin geçmiş dönem ortalamasından önerdiği tahmini yönetici olarak kabul edebilirsiniz.
        </p>
      )}

      <FilterChips<Filter>
        label="Okuma filtresi"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'Tümü' },
          { value: 'missing', label: 'Eksik', count: s?.missing },
          { value: 'error', label: 'Hatalı', count: s?.errors },
          { value: 'flagged', label: 'Uyarılı' },
        ]}
      />

      {saved && <Alert tone="success">{saved} Dönem yeniden hesaplanmalıdır.</Alert>}
      {save.isError && serverErrors.size === 0 && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
      {serverErrors.size > 0 && <Alert tone="danger">Okumalar kaydedilmedi; işaretli satırları düzeltin.</Alert>}
      {photo.error && <Alert tone="danger">{photo.error}</Alert>}
      {sheet.isError && <Alert tone="danger">{errorMessage(sheet.error)}</Alert>}
      {sheet.isPending && <Skeleton className="h-40" />}

      {sheet.data && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-small" aria-label="Okuma çizelgesi">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 pr-2">Daire</th>
                <th className="pr-2">Sayaç</th>
                <th className="pr-2 text-right">Başlangıç</th>
                <th className="pr-2 text-right">Son endeks</th>
                <th className="pr-2 text-right">Tüketim</th>
                <th className="pr-2">Durum</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const meta = READING_STATUS_META[r.status];
                const rowError = clientErrors[r.meterId] ?? serverErrors.get(r.meterId) ?? r.error?.message;
                const value = drafts[r.meterId] ?? (r.endSource === 'reading' && r.endIndex !== undefined ? formatIndex(r.endIndex, r.scale) : '');
                return (
                  <tr key={r.meterId} className={r.inScope ? 'border-t border-border align-top' : 'border-t border-border align-top opacity-60'}>
                    <td className="py-2 pr-2">{unitLabel(r.unitId, r.unitNumber)}</td>
                    <td className="pr-2 py-2">
                      {r.label}
                      {r.serialNo && <span className="block text-muted">{r.serialNo}</span>}
                    </td>
                    <td className="pr-2 py-2 text-right tabular-nums">{r.startIndex !== undefined ? formatIndex(r.startIndex, r.scale) : '—'}</td>
                    <td className="w-36 pr-2 py-1 text-right">
                      {editable && r.inScope && r.endSource !== 'swap_closing' && r.endSource !== 'retire_closing' ? (
                        <Input
                          aria-label={`${unitLabel(r.unitId, r.unitNumber)} ${r.label} son endeks`}
                          inputMode="decimal"
                          className="h-8 text-right tabular-nums"
                          invalid={!!clientErrors[r.meterId] || serverErrors.has(r.meterId)}
                          value={value}
                          placeholder={r.suggestion ? formatIndex(r.suggestion.suggestedEndIndex, r.scale) : ''}
                          onChange={(e) => setDrafts((d) => ({ ...d, [r.meterId]: e.target.value }))}
                        />
                      ) : (
                        <span className="tabular-nums">{r.endIndex !== undefined ? formatIndex(r.endIndex, r.scale) : '—'}</span>
                      )}
                    </td>
                    <td className="pr-2 py-2 text-right tabular-nums">{r.delta !== undefined ? formatIndex(r.delta, r.scale) : '—'}</td>
                    <td className="pr-2 py-2">
                      <div className="flex flex-wrap gap-1">
                        {r.inScope ? <Badge tone={meta.tone}>{meta.label}</Badge> : <Badge>Kapsam dışı</Badge>}
                        {r.flags.map((f) => (
                          <Badge key={f} tone={f === 'spike' ? 'warning' : 'accent'}>
                            {READING_FLAG_LABELS[f] ?? f}
                          </Badge>
                        ))}
                      </div>
                      {rowError && <p className="mt-1 text-danger">{rowError}</p>}
                      {r.reading?.note && <p className="mt-1 text-muted">Not: {r.reading.note}</p>}
                    </td>
                    <td className="py-1">
                      <div className="flex flex-wrap justify-end gap-1">
                        {canManage && open && r.status === 'missing' && r.suggestion && (
                          <Button size="xs" variant="ghost" onClick={() => applyEstimates([r])} disabled={save.isPending}>
                            Tahmin ({formatIndex(r.suggestion.suggestedDelta, r.scale)})
                          </Button>
                        )}
                        {canManage && open && r.error?.code === 'negative_delta' && r.endIndex !== undefined && (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={save.isPending}
                            onClick={() => void run([{ meterId: r.meterId, endIndex: r.endIndex as number, rolloverConfirmed: true }], 'Tur atma onaylandı.')}
                          >
                            Tur attı (onayla)
                          </Button>
                        )}
                        {r.reading?.hasPhoto && (
                          <Button
                            size="xs"
                            variant="ghost"
                            aria-label="Okuma fotoğrafını aç"
                            loading={photo.pendingId === r.meterId}
                            onClick={() => void photo.open(r.meterId, () => metersApi.readingPhoto(period.periodId, r.meterId))}
                          >
                            <Camera className="size-3.5" aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visible.length === 0 && <p className="py-3 text-small text-muted">Filtreye uyan sayaç yok.</p>}
        </div>
      )}

      <ImportReadingsDialog periodId={importing ? period.periodId : null} periodName={period.name} rows={rows} onClose={() => setImporting(false)} />
    </Card>
  );
}
