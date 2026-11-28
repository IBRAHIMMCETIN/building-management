import { errorMessage } from '@bm/shared/api/errors';
import { METER_KIND_LABELS, READING_FLAG_LABELS, READING_STATUS_META, type SheetRow, formatIndex, itemErrorMessage, parseIndexText } from '@bm/shared/api/meterReadings';
import { formatDate } from '@bm/shared/dates';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Check, ClipboardPen } from '@/components/icons';
import { Alert, AppText, Badge, Button, Card, ChipGroup, EmptyState, LoadingBlock, Screen, TextField, type TextFieldHandle } from '@/components/ui';
import { useReadingPeriods, useReadingSheet, useSaveReading, useSiteLabels } from '@/hooks/useWork';
import { PhotoPicker } from '@/components/tickets/PhotoPicker';
import type { PreparedPhoto } from '@/lib/photos';
import { space } from '@/theme/tokens';


type Show = 'missing' | 'all';

/** Bir seferde cizilen sayac karti (giris alanli kartlar; liste sanallastirilmaz). */
export const READING_PAGE = 20;

/**
 * Sayac okuma (web: pages/admin/meters/ReadingEntryPage.tsx): acik donem, okunmayanlar / tumu, daire
 * veya seri no arama, blok secimi; her sayac tek tek kaydedilir (son endeks, tuketim, fotograf kaniti,
 * not). Kayittan sonra siradaki eksik sayaca gecilir. Toplu CSV aktarimi web'de kalir.
 */
export function MeterReadingScreen() {
  const periods = useReadingPeriods();
  const [periodId, setPeriodId] = useState('');
  const sheet = useReadingSheet(periodId || null);
  const labels = useSiteLabels();
  const [blockId, setBlockId] = useState('');
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<Show>('missing');
  const [focusNext, setFocusNext] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Buyuk sitelerde yuzlerce sayac: kartlar 20'ser cizilir (Borçlarım ile ayni), filtre degisince basa doner.
  const [limit, setLimit] = useState(READING_PAGE);
  useEffect(() => setLimit(READING_PAGE), [periodId, blockId, search, show]);

  // Secili donem listede yoksa en guncel acik doneme gecilir.
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
  const noMeters = !!sheet.data && rows.length === 0;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([periods.refetch(), periodId ? sheet.refetch() : Promise.resolve()]);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Screen title="Sayaç okuma" refreshing={refreshing} onRefresh={() => void refresh()}>
      <AppText variant="small" tone="muted">
        Endeksi sayaçta göründüğü gibi girin; fotoğraf eklemek okumayı kanıtlar.
      </AppText>

      {periods.isPending ? (
        <LoadingBlock label="Okuma dönemleri yükleniyor" />
      ) : periods.isError ? (
        <Card>
          <Alert tone="danger">{errorMessage(periods.error)}</Alert>
          <Button variant="secondary" label="Tekrar dene" onPress={() => void periods.refetch()} />
        </Card>
      ) : periods.data.length === 0 ? (
        <EmptyState icon={ClipboardPen} title="Okumaya açık dönem yok" description="Yönetici yeni dönem açtığında burada görünür." />
      ) : (
        <>
          {periods.data.length > 1 && (
            <View style={styles.gap2}>
              <AppText variant="small" weight="medium">
                Dönem
              </AppText>
              <ChipGroup label="Dönem" value={periodId} onChange={setPeriodId} options={periods.data.map((p) => ({ value: p.periodId, label: `${p.name} (${formatDate(p.startDate)} – ${formatDate(p.endDate)})` }))} />
            </View>
          )}
          {periods.data.length === 1 && periods.data[0] && (
            <AppText weight="semibold">{`${periods.data[0].name} · ${formatDate(periods.data[0].startDate)} – ${formatDate(periods.data[0].endDate)}`}</AppText>
          )}

          {s && !noMeters && (
            <View style={styles.badges} accessible accessibilityLabel={`${s.ok + s.auto} / ${s.meters} okundu${s.missing ? `, ${s.missing} eksik` : ''}${s.errors ? `, ${s.errors} hatalı` : ''}`}>
              <Badge tone="success" label={`${s.ok + s.auto}/${s.meters} okundu`} />
              {s.missing > 0 && <Badge tone="warning" label={`${s.missing} eksik`} />}
              {s.errors > 0 && <Badge tone="danger" label={`${s.errors} hatalı`} />}
            </View>
          )}

          {noMeters && <Alert tone="info">Bu dönem aralığında kurulu aktif sayaç bulunamadı. Sayaçların kurulum tarihlerini yöneticinize kontrol ettirin.</Alert>}

          {sheet.data && !noMeters && (
            <View style={styles.gap3}>
              {blocks.length > 1 && (
                <ChipGroup label="Blok" value={blockId} onChange={setBlockId} options={[{ value: '', label: 'Tüm bloklar' }, ...blocks.map((b) => ({ value: b, label: labels.blockName(b) ?? b }))]} />
              )}
              <TextField label="Daire no veya seri no" placeholder="Daire / seri no" value={search} onChangeText={setSearch} returnKeyType="search" />
              <ChipGroup
                label="Gösterilecek sayaçlar"
                value={show}
                onChange={setShow}
                options={[
                  { value: 'missing', label: 'Okunmayanlar', count: (s?.missing ?? 0) + (s?.errors ?? 0) },
                  { value: 'all', label: 'Tümü' },
                ]}
              />
            </View>
          )}

          {sheet.isPending && !!periodId && <LoadingBlock label="Okuma çizelgesi yükleniyor" lines={4} />}
          {sheet.isError && (
            <Card>
              <Alert tone="danger">{errorMessage(sheet.error)}</Alert>
              <Button variant="secondary" label="Tekrar dene" onPress={() => void sheet.refetch()} />
            </Card>
          )}
          {sheet.data && !noMeters && visible.length === 0 && <Alert tone="success">{show === 'missing' ? 'Bu filtrede okunmamış sayaç kalmadı.' : 'Filtreye uyan sayaç yok.'}</Alert>}

          <View style={styles.gap3}>
            {visible.slice(0, limit).map((r, i) => (
              <ReadingCard
                key={r.meterId}
                periodId={periodId}
                row={r}
                unitLabel={labels.unitLabel(r.unitId) ?? (r.unitNumber ? `Daire ${r.unitNumber}` : 'Daire')}
                autoFocus={focusNext === r.meterId}
                onSaved={() => {
                  const next = visible[i + 1];
                  if (next && i + 1 >= limit) setLimit((l) => l + READING_PAGE);
                  setFocusNext(next?.meterId ?? null);
                }}
              />
            ))}
          </View>
          {visible.length > limit && (
            <Button variant="secondary" block label={`Daha fazla göster (${visible.length - limit} kaldı)`} onPress={() => setLimit((l) => l + READING_PAGE)} />
          )}
        </>
      )}
    </Screen>
  );
}

function ReadingCard({ periodId, row, unitLabel, autoFocus, onSaved }: { periodId: string; row: SheetRow; unitLabel: string; autoFocus: boolean; onSaved: () => void }) {
  const save = useSaveReading(periodId);
  const inputRef = useRef<TextFieldHandle>(null);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<PreparedPhoto[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const meta = READING_STATUS_META[row.status];
  const start = row.startIndex !== undefined ? formatIndex(row.startIndex, row.scale) : '—';
  const parsed = value.trim() ? parseIndexText(value, row.scale) : null;
  const delta = parsed?.ok && row.startIndex !== undefined ? parsed.value - row.startIndex : null;

  const submit = () => {
    setError(null);
    const p = parseIndexText(value, row.scale);
    if (!p.ok) {
      setError(p.message);
      return;
    }
    const photo = photos[0];
    save.mutate(
      { meterId: row.meterId, endIndex: p.value, ...(note.trim() ? { note: note.trim().slice(0, 200) } : {}), ...(photo ? { photo } : {}) },
      {
        onSuccess: (res) => {
          const flags = res.items[0]?.flags ?? [];
          setSaved(flags.includes('spike') ? 'Kaydedildi — olağan dışı artış, lütfen sayacı tekrar kontrol edin.' : 'Kaydedildi.');
          setValue('');
          setNote('');
          setPhotos([]);
          onSaved();
        },
        onError: (err) => setError(itemErrorMessage(err) ?? errorMessage(err)),
      },
    );
  };

  return (
    <Card>
      <View style={styles.between}>
        <View style={styles.flex}>
          <AppText weight="semibold">{unitLabel}</AppText>
          <AppText variant="small" tone="muted">{`${row.label} · ${METER_KIND_LABELS[row.kind]}${row.serialNo ? ` · ${row.serialNo}` : ''}`}</AppText>
        </View>
        <View style={styles.flags}>
          <Badge tone={meta.tone} label={meta.label} />
          {row.flags.map((f) => (
            <Badge key={f} tone={f === 'spike' ? 'warning' : 'accent'} label={READING_FLAG_LABELS[f] ?? f} />
          ))}
        </View>
      </View>
      <AppText variant="small">
        {'Son endeks: '}
        <AppText variant="small" weight="semibold" tabular>
          {start}
        </AppText>
        {row.startDate ? (
          <AppText variant="small" tone="muted">
            {` (${formatDate(row.startDate)})`}
          </AppText>
        ) : null}
      </AppText>
      {row.endSource === 'reading' && row.endIndex !== undefined && (
        <AppText variant="small" tone="muted">{`Bu dönem girilen: ${formatIndex(row.endIndex, row.scale)}${row.reading?.hasPhoto ? ' · fotoğraflı' : ''}`}</AppText>
      )}
      {row.error && row.status === 'error' && (
        <AppText variant="small" tone="danger">
          {row.error.message}
        </AppText>
      )}
      <TextField
        ref={inputRef}
        label="Yeni endeks"
        keyboardType="decimal-pad"
        autoComplete="off"
        returnKeyType="done"
        placeholder={row.scale > 0 ? `0,${'0'.repeat(row.scale)}` : '0'}
        value={value}
        error={error ?? undefined}
        onChangeText={(t) => {
          setValue(t);
          setError(null);
          setSaved(null);
        }}
        onSubmitEditing={submit}
      />
      {delta !== null && (
        <AppText variant="small" tone={delta < 0 ? 'danger' : 'muted'}>
          {delta < 0 ? 'Yeni endeks son endeksten küçük — sayaç değişmiş olabilir, yöneticiye bildirin.' : `Tüketim: ${formatIndex(delta, row.scale)}`}
        </AppText>
      )}
      {saved && <Alert tone="success">{saved}</Alert>}
      <PhotoPicker label="Sayaç fotoğrafı (isteğe bağlı)" photos={photos} onChange={setPhotos} disabled={save.isPending} max={1} />
      <TextField label="Not (isteğe bağlı)" placeholder="Sayaca ulaşılamadı vb." value={note} onChangeText={setNote} maxLength={200} />
      <Button block icon={Check} label="Kaydet" loading={save.isPending} disabled={!value.trim()} accessibilityLabel={`${unitLabel} ${row.label} endeksini kaydet`} onPress={submit} />
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap2: { gap: space(2) },
  gap3: { gap: space(3) },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  between: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space(3) },
  flags: { alignItems: 'flex-end', gap: space(1) },
});
