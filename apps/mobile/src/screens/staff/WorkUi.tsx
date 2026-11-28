import { errorMessage } from '@bm/shared/api/errors';
import type { EstimateInput, StaffEstimate } from '@bm/shared/api/tickets';
import { MAX_PHOTOS_PER_EVENT, TASK_STATUS_LABELS, TASK_STATUS_TONES, type TaskStatus } from '@bm/shared/api/work';
import { formatDateTime } from '@bm/shared/dates';
import { MAX_KURUS, formatTRY, kurusToInput, parseTRYToKurus } from '@bm/shared/money';
import type { SignedDownload } from '@bm/shared/api/documents';
import { type LocationLike, PRIORITY_LABELS, PRIORITY_TONES, STATUS_LABELS, STATUS_TONES, type TicketPriority, type TicketStatus, photoIdOf, slaText } from '@bm/shared/tickets/model';
import { useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, View } from 'react-native';
import { AlarmClock, Calculator, Camera, Clock, ImageIcon, ImagePlus, type LucideIcon, Pencil, Settings, X } from '@/components/icons';
import { Alert, AppText, Badge, Button, Card, CardTitle, TextField } from '@/components/ui';
import { openDocument } from '@/lib/openExternal';
import { type LocalPhoto, pickPhoto } from '@/lib/photos';
import { MIN_TOUCH, radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/* Gorevli ekranlarinin ortak parcalari (web: components/tickets/TicketBadges.tsx, PhotoPicker.tsx, tickets/EstimateCard.tsx). */

/** Kart basligi ikonu (aile: CardTitle icon 20 / muted / aria-hidden). */
export function TitleIcon({ icon: Icon }: { icon: LucideIcon }) {
  const { colors } = useTheme();
  return <Icon size={20} color={colors.muted} aria-hidden />;
}

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <Badge tone={STATUS_TONES[status]} label={STATUS_LABELS[status]} />;
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return <Badge tone={PRIORITY_TONES[priority]} label={PRIORITY_LABELS[priority]} />;
}

/** SLA kalan / gecikme: yalnizca cozum bekleyen taleplerde. */
export function SlaBadge({ ticket }: { ticket: { status: TicketStatus; dueAt: string } }) {
  const sla = slaText(ticket);
  if (!sla) return null;
  return <Badge tone={sla.overdue ? 'danger' : 'neutral'} icon={sla.overdue ? AlarmClock : Clock} label={sla.text} />;
}

export function TaskStatusBadge({ status, overdue }: { status: TaskStatus; overdue?: boolean }) {
  if (overdue) return <Badge tone="danger" label="Gecikti" />;
  return <Badge tone={TASK_STATUS_TONES[status]} label={TASK_STATUS_LABELS[status]} />;
}

/** Talep konumu: "A Blok · Daire 7" (etiket yuklenmemisse "Daire içi") veya "Ortak alan · Lobi". */
export function whereText(l: LocationLike, unitLabel: (unitId: string) => string | undefined): string {
  return l.kind === 'unit' ? (unitLabel(l.unitId) ?? 'Daire içi') : `Ortak alan · ${l.area}`;
}

/** Bilgi satiri (etiket: deger), ekran okuyucuda tek oge. */
export function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.info} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText variant="small" tone="muted" style={styles.infoLabel}>
        {label}
      </AppText>
      <AppText variant="small" style={styles.flex}>
        {value}
      </AppText>
    </View>
  );
}

/**
 * Fotograf ekleme (once / sonra): kamera veya galeri, kucuk onizleme ve kaldirma. Izin reddinde
 * aciklama ve ayarlar baglantisi. Yukleme gonderimde yapilir (useWork).
 */
export function PhotoPicker({ label = 'Fotoğraflar (isteğe bağlı)', photos, onChange, disabled, max = MAX_PHOTOS_PER_EVENT }: { label?: string; photos: readonly LocalPhoto[]; onChange: (next: LocalPhoto[]) => void; disabled?: boolean; max?: number }) {
  const { colors } = useTheme();
  const [denied, setDenied] = useState<{ source: 'camera' | 'library'; canAskAgain: boolean } | null>(null);
  const add = async (source: 'camera' | 'library') => {
    setDenied(null);
    const r = await pickPhoto(source).catch(() => ({ kind: 'cancelled' as const }));
    if (r.kind === 'picked') onChange([...photos, r.photo].slice(0, max));
    if (r.kind === 'denied') setDenied({ source, canAskAgain: r.canAskAgain });
  };
  const full = photos.length >= max;

  return (
    <View style={styles.gap2}>
      <AppText variant="small" weight="medium">
        {label}
      </AppText>
      {photos.length > 0 && (
        <View style={styles.thumbs}>
          {photos.map((p, i) => (
            <View key={`${p.uri}-${i}`} style={[styles.thumb, { borderColor: colors.border, backgroundColor: colors.surfaceMuted }]}>
              <Image source={{ uri: p.uri }} style={styles.thumbImage} accessibilityLabel={`Fotoğraf ${i + 1}`} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Fotoğraf ${i + 1} kaldır`}
                disabled={disabled}
                hitSlop={10}
                onPress={() => onChange(photos.filter((_, j) => j !== i))}
                style={[styles.remove, { backgroundColor: colors.surface, borderColor: colors.borderStrong }]}
              >
                <X size={14} color={colors.text} aria-hidden />
              </Pressable>
            </View>
          ))}
        </View>
      )}
      <View style={styles.row}>
        <Button variant="secondary" icon={Camera} label="Fotoğraf çek" disabled={disabled || full} onPress={() => void add('camera')} />
        <Button variant="secondary" icon={ImagePlus} label="Galeriden seç" disabled={disabled || full} onPress={() => void add('library')} />
      </View>
      <AppText variant="caption" tone="muted">
        {`En fazla ${max} fotoğraf; JPEG, PNG, WEBP veya HEIC, her biri en fazla 10 MB.`}
      </AppText>
      {denied && (
        <View style={styles.gap2}>
          <Alert tone="warning">
            {denied.source === 'camera'
              ? 'Fotoğraf çekmek için kamera izni gerekiyor. İzni telefonun Ayarlar > YÖNESİST bölümünden açabilirsiniz.'
              : 'Galeriden seçmek için fotoğraflara erişim izni gerekiyor. İzni telefonun Ayarlar > YÖNESİST bölümünden açabilirsiniz.'}
          </Alert>
          {!denied.canAskAgain && <Button variant="secondary" icon={Settings} label="Ayarları aç" onPress={() => void Linking.openSettings()} />}
        </View>
      )}
    </View>
  );
}

/** Kayitli fotograflar: imzali (5 dk) link istenip sistem goruntuleyicisinde acilir (web: PhotoGallery). */
export function PhotoLinks({ keys, load }: { keys: readonly string[]; load: (photoId: string) => Promise<SignedDownload> }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (keys.length === 0) return null;
  return (
    <View style={styles.gap2}>
      <View style={styles.row}>
        {keys.map((k, i) => {
          const id = photoIdOf(k);
          return (
            <Button
              key={k}
              variant="ghost"
              icon={ImageIcon}
              label={`Fotoğraf ${i + 1}`}
              loading={pending === id}
              onPress={() => {
                setPending(id);
                setError(null);
                openDocument(() => load(id))
                  .catch((err: unknown) => setError(errorMessage(err)))
                  .finally(() => setPending(null));
              }}
            />
          );
        })}
      </View>
      {error && <Alert tone="danger">{error}</Alert>}
    </View>
  );
}

type EstimateMutation = { mutate: (input: EstimateInput, opts?: { onSuccess?: () => void }) => void; isPending: boolean; isError: boolean; error: unknown };

/**
 * Tahmini tutar (gorevli notu; web: tickets/EstimateCard.tsx). Bilgi amaclidir: Finans'a yazilmaz,
 * sakin gormez. Tutar kurus olarak gonderilir; 0 gecerli ("ucretsiz yapilabilir").
 */
export function EstimateCard({ estimate, canEdit, version, mutation, nameOf }: { estimate?: StaffEstimate; canEdit: boolean; version: number; mutation: EstimateMutation; nameOf: (userId: string) => string | undefined }) {
  const { colors } = useTheme();
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(estimate ? kurusToInput(estimate.amount) : '');
  const [note, setNote] = useState(estimate?.note ?? '');
  if (!estimate && !canEdit) return null;
  const kurus = amount.trim() ? parseTRYToKurus(amount, { allowZero: true }) : null;
  const valid = kurus !== null && kurus <= MAX_KURUS;
  const save = (input: EstimateInput) => mutation.mutate(input, { onSuccess: () => setEditing(false) });
  // Duzenleme her acilista guncel nottan baslar (ekran surum degisince yeniden kurulmaz).
  const startEdit = () => {
    setAmount(estimate ? kurusToInput(estimate.amount) : '');
    setNote(estimate?.note ?? '');
    setEditing(true);
  };

  return (
    <Card>
      <CardTitle icon={<Calculator size={20} color={colors.muted} aria-hidden />}>Tahmini tutar (görevli notu)</CardTitle>
      <AppText variant="small" tone="muted">
        Bilgi amaçlıdır: Finans’a kaydedilmez, sakin görmez.
      </AppText>
      {editing ? (
        <View style={styles.gap3}>
          <TextField label="Tutar (TL)" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} error={amount.trim() && !valid ? 'Geçerli bir tutar girin' : undefined} />
          <TextField label="Kısa not (isteğe bağlı)" value={note} onChangeText={setNote} maxLength={300} placeholder="Örn. conta ve işçilik" />
          {mutation.isError && <Alert tone="danger">{errorMessage(mutation.error)}</Alert>}
          <View style={styles.row}>
            <Button label="Kaydet" loading={mutation.isPending} disabled={!valid} onPress={() => kurus !== null && save({ version, amount: kurus, ...(note.trim() ? { note: note.trim() } : {}) })} />
            <Button variant="ghost" label="Vazgeç" disabled={mutation.isPending} onPress={() => setEditing(false)} />
            {estimate && <Button variant="ghost" label="Notu kaldır" disabled={mutation.isPending} onPress={() => save({ version, amount: null })} />}
          </View>
        </View>
      ) : (
        <>
          {estimate ? (
            <View accessible accessibilityLabel={`Tahmini tutar ${formatTRY(estimate.amount)}${estimate.note ? `, ${estimate.note}` : ''}`}>
              <AppText weight="semibold" tabular>
                {formatTRY(estimate.amount)}
                {estimate.note ? (
                  <AppText tone="secondary" weight="regular">
                    {` · ${estimate.note}`}
                  </AppText>
                ) : null}
              </AppText>
              <AppText variant="caption" tone="muted">
                {`${nameOf(estimate.by) ?? 'Görevli'} · ${formatDateTime(estimate.at)}`}
              </AppText>
            </View>
          ) : (
            <AppText variant="small" tone="muted">
              Henüz tahmini tutar girilmedi.
            </AppText>
          )}
          {canEdit && <Button variant="secondary" icon={Pencil} label={estimate ? 'Düzenle' : 'Tutar gir'} onPress={startEdit} />}
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap2: { gap: space(2) },
  gap3: { gap: space(3) },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  info: { flexDirection: 'row', gap: space(3) },
  infoLabel: { width: space(24) },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  thumb: { width: space(20), height: space(20), borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth * 2, overflow: 'visible' },
  thumbImage: { width: '100%', height: '100%', borderRadius: radii.md },
  remove: {
    position: 'absolute',
    top: -space(2),
    right: -space(2),
    width: MIN_TOUCH / 2 + 4,
    height: MIN_TOUCH / 2 + 4,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
