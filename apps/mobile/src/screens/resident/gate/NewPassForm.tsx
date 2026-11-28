import { errorMessage } from '@bm/shared/api/errors';
import { type CreatePassInput, type GateUnit, type PassFormIssue, normalizePlate, passFormIssue } from '@bm/shared/api/portalGate';
import { addDays, istanbulToday } from '@bm/shared/reservations/model';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Check, Circle } from '@/components/icons';
import { DateField } from '@/components/portal/DateField';
import { FilterChips } from '@/components/portal/FilterChips';
import { Alert, AppText, Button, ListRow, TextField } from '@/components/ui';
import { useIdempotencyKey } from '@/lib/idempotency';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

type Limits = { maxPassDays: number; maxPassLeadDays: number };
/** Ekran duzeyindeki olusturma islemi (usePassIssuing().create): basarida pencere paylasim adimina gecer. */
type CreateMutation = {
  mutate: (input: CreatePassInput) => void;
  reset: () => void;
  isPending: boolean;
  error: unknown;
};
type Props = { units: GateUnit[]; limits: Limits; create: CreateMutation; onCancel: () => void };

const ENTRY_MODES = [
  { value: 'single', title: 'Tek giriş', detail: 'Bir kez girişte kullanılır, sonra geçersiz olur.' },
  { value: 'multi', title: 'Çoklu giriş', detail: 'Seçilen günler boyunca girip çıkabilir.' },
] as const;

/**
 * Misafir gecisi formu (web: pages/resident/gate/NewPassDialog.tsx): ad, tarih / aralik, tek veya
 * coklu giris, istege bagli plaka ve not. Pencere her acilista formu yeniden kurar: islem anahtari
 * (idempotencyKey) acilis basina yenidir, ayni acilistaki tekrar gonderim ayni anahtari kullanir.
 * Basarida ayni pencere QR / paylasim adimina gecer (ikinci bir pencere acilmaz).
 */
export function NewPassForm({ units, limits, create, onCancel }: Props) {
  const today = istanbulToday();
  const { colors } = useTheme();
  const [key] = useIdempotencyKey();
  const [unitId, setUnitId] = useState(units[0]?.unitId ?? '');
  const [guestName, setGuestName] = useState('');
  const [validFrom, setValidFrom] = useState(today);
  const [validUntil, setValidUntil] = useState('');
  const [entryMode, setEntryMode] = useState<'single' | 'multi'>('single');
  const [plate, setPlate] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<PassFormIssue>();
  const { reset } = create;

  // Onceki acilistan kalan hata yeni formda gosterilmez.
  useEffect(() => reset(), [reset]);

  const submit = () => {
    const problem = passFormIssue({ guestName, validFrom, validUntil, today, ...limits });
    setFormError(problem);
    if (problem) return;
    const p = normalizePlate(plate);
    create.mutate({
      idempotencyKey: key,
      unitId: unitId || units[0]?.unitId || '',
      guestName: guestName.trim(),
      validFrom,
      ...(validUntil ? { validUntil } : {}),
      entryMode,
      ...(p ? { plate: p } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  };
  const errorOf = (field: PassFormIssue['field']) => (formError?.field === field ? formError.message : undefined);
  const nameError = errorOf('guestName');

  return (
    <>
      {units.length > 1 && (
        <View style={styles.group}>
          <AppText variant="small" weight="medium">
            Daire
          </AppText>
          <FilterChips label="Daire" value={unitId} onChange={setUnitId} options={units.map((u) => ({ value: u.unitId, label: u.label }))} />
        </View>
      )}
      <View style={styles.group}>
        <TextField label="Misafirin adı" value={guestName} onChangeText={setGuestName} error={nameError} accessibilityHint={nameError ?? 'Güvenlik görevlisi girişte bu adı görür'} maxLength={80} autoComplete="off" />
        {!nameError && (
          <AppText variant="small" tone="muted">
            Güvenlik görevlisi girişte bu adı görür
          </AppText>
        )}
      </View>
      <DateField
        label="Geliş tarihi"
        value={validFrom}
        min={today}
        max={addDays(today, limits.maxPassLeadDays)}
        onChange={(d) => {
          setValidFrom(d);
          if (validUntil && validUntil < d) setValidUntil('');
        }}
        error={errorOf('validFrom')}
      />
      <DateField
        label="Son gün (isteğe bağlı)"
        value={validUntil}
        min={validFrom}
        max={addDays(validFrom, limits.maxPassDays - 1)}
        onChange={setValidUntil}
        onClear={() => setValidUntil('')}
        error={errorOf('validUntil')}
        placeholder="Yalnızca geliş günü"
      />
      <View style={styles.group}>
        <AppText variant="small" weight="medium">
          Giriş hakkı
        </AppText>
        {ENTRY_MODES.map((m) => (
          <ListRow
            key={m.value}
            title={m.title}
            subtitle={m.detail}
            selected={entryMode === m.value}
            trailing={entryMode === m.value ? <Check size={20} color={colors.accent} aria-hidden /> : <Circle size={20} color={colors.borderStrong} aria-hidden />}
            onPress={() => setEntryMode(m.value)}
          />
        ))}
      </View>
      <TextField label="Araç plakası (isteğe bağlı)" value={plate} onChangeText={(t) => setPlate(t.toUpperCase())} maxLength={14} autoCapitalize="characters" />
      <View style={styles.group}>
        <TextField label="Güvenliğe not (isteğe bağlı)" value={note} onChangeText={setNote} accessibilityHint="Görevli görür; telefon numarası yazmayın" maxLength={200} multiline numberOfLines={2} textAlignVertical="top" />
        <AppText variant="small" tone="muted">
          Görevli görür; telefon numarası yazmayın
        </AppText>
      </View>
      {create.error ? <Alert tone="danger">{errorMessage(create.error)}</Alert> : null}
      <View style={styles.actions}>
        <Button variant="ghost" label="Vazgeç" onPress={onCancel} />
        <Button label="Geçiş oluştur" loading={create.isPending} onPress={submit} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  group: { gap: space(1.5) },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space(2) },
});
