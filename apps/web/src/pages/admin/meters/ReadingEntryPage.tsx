import { Check, Search } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { PhotoInput } from '@/components/meters/PhotoInput';
import { Alert, Badge, Button, Card, FilterChips, Input, Select, Skeleton } from '@/components/ui';
import { useMeterPermissions, useOpenReadingPeriods, useReadingSheet, useSaveReadings } from '@/hooks/useMeters';
import { type SheetRow, itemErrorsOf, metersApi } from '@/lib/api/meters';
import { errorMessage } from '@/lib/api/errors';
import { formatDate } from '@/lib/dates';
import { METER_KIND_LABELS, READING_FLAG_LABELS, READING_STATUS_META, formatIndex, parseIndexText } from '@/lib/meters/model';
import { useMeterUnits } from './useMeterUnits';

type Show = 'missing' | 'all';

/**
 * Saha gorevlisi icin hizli endeks girisi (mobil oncelikli): blok / daire filtresi, son endeks
 * gosterimi, telefon kamerasiyla fotograf (S3 imzali link). Her sayac tek tek kaydedilir; kayit
 * sonrasi siradaki eksik sayaca odaklanilir.
 */
export function ReadingEntryPage() {
  const { canWriteReadings } = useMeterPermissions();
  const periods = useOpenReadingPeriods();
  const [periodId, setPeriodId] = useState('');
  const sheet = useReadingSheet(periodId || null);
  const units = useMeterUnits();
  const [blockId, setBlockId] = useState('');
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<Show>('missing');
  const [focusNext, setFocusNext] = useState<string | null>(null);

  // Secili donem listede yoksa (ilk acilis, iptal / onay sonrasi) en guncel acik doneme gecilir.
  useEffect(() => {
    const list = periods.data ?? [];
    if (list.length === 0) {
      if (periodId) setPeriodId('');
      return;
    }
    if (!list.some((p) => p.periodId === periodId)) setPeriodId(list[0]?.periodId ?? '');
  }, [periods.data, periodId]);

  const rows = useMemo(() => (sheet.data?.rows ?? []).filter((r) => r.inScope), [sheet.data]);
  const blocks = useMemo(() => [...new Set(rows.map((r) => r.blockId).filter((b): b is string => !!b))], [rows]);
  const q = search.trim().toLocaleLowerCase('tr-TR');
  const visible = rows.filter(
    (r) =>
      (!blockId || r.blockId === blockId) &&
      (show === 'all' || r.status === 'missing' || r.status === 'error') &&
      (!q || (r.unitNumber ?? '').toLocaleLowerCase('tr-TR').includes(q) || (r.serialNo ?? '').toLocaleLowerCase('tr-TR').includes(q)),
  );
  const s = sheet.data?.summary;
  // Donemde (kapsamda) hic sayac yok: hata degil, yonlendirici bos durum.
  const noMeters = !!sheet.data && rows.length === 0;

  if (!canWriteReadings) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-title font-bold">Sayaç Okuma</h1>
        <Alert>Bu rol sayaç okuması giremez.</Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <div>
        <h1 className="text-title font-bold">Sayaç Okuma</h1>
        <p className="text-small text-muted">Endeksi sayaçta göründüğü gibi girin; fotoğraf eklemek okumayı kanıtlar.</p>
      </div>

      {periods.isError && <Alert tone="danger">{errorMessage(periods.error)}</Alert>}
      {periods.isPending && <Skeleton className="h-10" />}
      {periods.data?.length === 0 && <Alert>Okumaya açık dönem yok. Yönetici yeni dönem açtığında burada görünür.</Alert>}

      {!!periods.data?.length && (
        <Select aria-label="Dönem" value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
          {periods.data.map((p) => (
            <option key={p.periodId} value={p.periodId}>
              {p.name} ({formatDate(p.startDate)} – {formatDate(p.endDate)})
            </option>
          ))}
        </Select>
      )}

      {s && !noMeters && (
        <div className="flex flex-wrap gap-2 text-small" role="status">
          <Badge tone="success">
            {s.ok + s.auto}/{s.meters} okundu
          </Badge>
          {s.missing > 0 && <Badge tone="warning">{s.missing} eksik</Badge>}
          {s.errors > 0 && <Badge tone="danger">{s.errors} hatalı</Badge>}
        </div>
      )}

      {noMeters && (
        <Alert>
          Bu dönem aralığında kurulu aktif sayaç bulunamadı. Sayaçların kurulum tarihlerini yöneticinize kontrol ettirin (Sayaç Dağıtımı → Sayaçlar).
        </Alert>
      )}

      {sheet.data && !noMeters && (
        <div className="sticky top-14 z-[5] flex flex-col gap-2 border-b border-border bg-surface/95 py-2 backdrop-blur">
          <div className="grid grid-cols-2 gap-2">
            {blocks.length > 1 ? (
              <Select aria-label="Blok" value={blockId} onChange={(e) => setBlockId(e.target.value)}>
                <option value="">Tüm bloklar</option>
                {blocks.map((b) => (
                  <option key={b} value={b}>
                    {units.blockName.get(b) ?? b}
                  </option>
                ))}
              </Select>
            ) : (
              <span />
            )}
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
              <Input aria-label="Daire no veya seri no" placeholder="Daire / seri no" inputMode="search" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          <FilterChips<Show>
            label="Gösterilecek sayaçlar"
            value={show}
            onChange={setShow}
            options={[
              { value: 'missing', label: 'Okunmayanlar', count: (s?.missing ?? 0) + (s?.errors ?? 0) },
              { value: 'all', label: 'Tümü' },
            ]}
          />
        </div>
      )}

      {sheet.isPending && !!periodId && <Skeleton className="h-40" />}
      {sheet.isError && <Alert tone="danger">{errorMessage(sheet.error)}</Alert>}
      {sheet.data && !noMeters && visible.length === 0 && (
        <Alert tone="success">{show === 'missing' ? 'Bu filtrede okunmamış sayaç kalmadı.' : 'Filtreye uyan sayaç yok.'}</Alert>
      )}

      <div className="flex flex-col gap-3">
        {visible.map((r, i) => (
          <ReadingCard
            key={r.meterId}
            periodId={periodId}
            row={r}
            unitLabel={units.labelOf.get(r.unitId) ?? r.unitNumber ?? r.unitId}
            autoFocus={focusNext === r.meterId}
            onSaved={() => setFocusNext(visible[i + 1]?.meterId ?? null)}
          />
        ))}
      </div>
    </div>
  );
}

function ReadingCard({ periodId, row, unitLabel, autoFocus, onSaved }: { periodId: string; row: SheetRow; unitLabel: string; autoFocus: boolean; onSaved: () => void }) {
  const save = useSaveReadings();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoKey, setPhotoKey] = useState<{ sig: string; key: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const meta = READING_STATUS_META[row.status];
  const start = row.startIndex !== undefined ? formatIndex(row.startIndex, row.scale) : '—';
  const parsed = value.trim() ? parseIndexText(value, row.scale) : null;
  const delta = parsed?.ok && row.startIndex !== undefined ? parsed.value - row.startIndex : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const p = parseIndexText(value, row.scale);
    if (!p.ok) {
      setError(p.message);
      return;
    }
    if (photoError) return;
    let key: string | undefined;
    if (photo) {
      const sig = `${photo.name}|${photo.size}|${photo.lastModified}`;
      if (photoKey?.sig === sig) key = photoKey.key;
      else {
        setUploading(true);
        try {
          key = await metersApi.uploadReadingPhoto(periodId, row.meterId, photo);
          setPhotoKey({ sig, key });
        } catch (err) {
          setPhotoError(errorMessage(err));
          return;
        } finally {
          setUploading(false);
        }
      }
    }
    try {
      const res = await save.mutateAsync({
        periodId,
        items: [{ meterId: row.meterId, endIndex: p.value, ...(note.trim() ? { note: note.trim().slice(0, 200) } : {}), ...(key ? { photoKey: key } : {}) }],
      });
      const flags = res.items[0]?.flags ?? [];
      setSavedAt(flags.includes('spike') ? 'Kaydedildi — olağan dışı artış, lütfen sayacı tekrar kontrol edin.' : 'Kaydedildi.');
      setValue('');
      setNote('');
      setPhoto(null);
      setPhotoKey(null);
      setResetKey((k) => k + 1);
      onSaved();
    } catch (err) {
      setError(itemErrorsOf(err)[0]?.message ?? errorMessage(err));
    }
  }

  const busy = save.isPending || uploading;

  return (
    <Card className="p-4 md:p-4">
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-semibold">{unitLabel}</p>
            <p className="text-small text-muted">
              {row.label} · {METER_KIND_LABELS[row.kind]}
              {row.serialNo ? ` · ${row.serialNo}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-1">
            <Badge tone={meta.tone}>{meta.label}</Badge>
            {row.flags.map((f) => (
              <Badge key={f} tone={f === 'spike' ? 'warning' : 'accent'}>
                {READING_FLAG_LABELS[f] ?? f}
              </Badge>
            ))}
          </div>
        </div>

        <p className="text-small">
          Son endeks: <strong className="tabular-nums">{start}</strong>
          {row.startDate ? <span className="text-muted"> ({formatDate(row.startDate)})</span> : null}
          {row.endSource === 'reading' && row.endIndex !== undefined && (
            <span className="block text-muted">
              Bu dönem girilen: <span className="tabular-nums">{formatIndex(row.endIndex, row.scale)}</span>
              {row.reading?.hasPhoto ? ' · fotoğraflı' : ''}
            </span>
          )}
        </p>
        {row.error && row.status === 'error' && <p className="text-small text-danger">{row.error.message}</p>}

        <div className="flex items-end gap-2">
          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-small font-medium">Yeni endeks</span>
            <Input
              ref={inputRef}
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="done"
              className="h-12 text-lg tabular-nums"
              invalid={!!error}
              placeholder={row.scale > 0 ? `0,${'0'.repeat(row.scale)}` : '0'}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
                setSavedAt(null);
              }}
            />
          </label>
          <Button type="submit" className="h-12" loading={busy} disabled={!value.trim()}>
            <Check className="size-4" aria-hidden="true" />
            Kaydet
          </Button>
        </div>
        {delta !== null && (
          <p className={delta < 0 ? 'text-small text-danger' : 'text-small text-muted'}>
            {delta < 0 ? 'Yeni endeks son endeksten küçük — sayaç değişmiş olabilir, yöneticiye bildirin.' : `Tüketim: ${formatIndex(delta, row.scale)}`}
          </p>
        )}
        {error && (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}
        {savedAt && (
          <p role="status" className="text-small text-success">
            {savedAt}
          </p>
        )}

        <PhotoInput
          file={photo}
          error={photoError}
          disabled={busy}
          resetKey={resetKey}
          onChange={(f, e) => {
            setPhoto(f);
            setPhotoError(e);
          }}
        />
        <Input aria-label="Not (isteğe bağlı)" placeholder="Not (isteğe bağlı): sayaca ulaşılamadı vb." value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      </form>
    </Card>
  );
}
