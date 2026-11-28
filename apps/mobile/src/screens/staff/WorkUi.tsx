import type { SignedDownload } from '@bm/shared/api/documents';
import { errorMessage } from '@bm/shared/api/errors';
import type { EstimateInput, StaffEstimate } from '@bm/shared/api/tickets';
import { formatDateTime } from '@bm/shared/dates';
import { MAX_KURUS, formatTRY, kurusToInput, parseTRYToKurus } from '@bm/shared/money';
import { type LocationLike, photoIdOf } from '@bm/shared/tickets/model';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Calculator, ImageIcon, type LucideIcon, Pencil } from '@/components/icons';
import { Alert, AppText, Button, Card, CardTitle, TextField } from '@/components/ui';
import { openDocument } from '@/lib/openExternal';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/*
 * Gorevli ekranlarinin ortak parcalari (web: tickets/EstimateCard.tsx, PhotoGallery). Rozetler
 * (components/tickets/TicketBadges.tsx) ve fotograf secici (components/tickets/PhotoPicker.tsx) sakin
 * ekranlariyla ortaktir.
 */

/** Kart basligi ikonu (aile: CardTitle icon 20 / muted / aria-hidden). */
export function TitleIcon({ icon: Icon }: { icon: LucideIcon }) {
  const { colors } = useTheme();
  return <Icon size={20} color={colors.muted} aria-hidden />;
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
});
