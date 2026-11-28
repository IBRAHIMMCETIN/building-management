import { errorMessage } from '@bm/shared/api/errors';
import { type GateUnit, type MyPass, normalizePlate, passFormError } from '@bm/shared/api/portalGate';
import { addDays, istanbulToday } from '@bm/shared/reservations/model';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Check, Circle } from '@/components/icons';
import { DateField } from '@/components/portal/DateField';
import { FilterChips } from '@/components/portal/FilterChips';
import { Sheet } from '@/components/portal/Sheet';
import { Alert, AppText, Button, ListRow, TextField } from '@/components/ui';
import { useMyGateActions } from '@/hooks/useGate';
import { useIdempotencyKey } from '@/lib/idempotency';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

type Limits = { maxPassDays: number; maxPassLeadDays: number };
type Props = { open: boolean; onClose: () => void; units: GateUnit[]; limits: Limits; onCreated: (p: MyPass) => void };

const ENTRY_MODES = [
  { value: 'single', title: 'Tek giriş', detail: 'Bir kez girişte kullanılır, sonra geçersiz olur.' },
  { value: 'multi', title: 'Çoklu giriş', detail: 'Seçilen günler boyunca girip çıkabilir.' },
] as const;

/** Sakin: misafir gecisi (web: pages/resident/gate/NewPassDialog.tsx): ad, tarih / aralik, tek veya coklu giris, istege bagli plaka ve not. */
export function NewPassSheet({ open, onClose, units, limits, onCreated }: Props) {
  const today = istanbulToday();
  const actions = useMyGateActions();
  const { colors } = useTheme();
  const [key, renew] = useIdempotencyKey();
  const [unitId, setUnitId] = useState(units[0]?.unitId ?? '');
  const [guestName, setGuestName] = useState('');
  const [validFrom, setValidFrom] = useState(today);
  const [validUntil, setValidUntil] = useState('');
  const [entryMode, setEntryMode] = useState<'single' | 'multi'>('single');
  const [plate, setPlate] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string>();
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setGuestName('');
    setValidFrom(today);
    setValidUntil('');
    setEntryMode('single');
    setPlate('');
    setNote('');
    setFormError(undefined);
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };
  const submit = () => {
    setError(null);
    const problem = passFormError({ guestName, validFrom, validUntil, today, ...limits });
    setFormError(problem);
    if (problem) return;
    const p = normalizePlate(plate);
    actions.createPass.mutate(
      {
        idempotencyKey: key,
        unitId: unitId || units[0]?.unitId || '',
        guestName: guestName.trim(),
        validFrom,
        ...(validUntil ? { validUntil } : {}),
        entryMode,
        ...(p ? { plate: p } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      {
        onSuccess: (r) => {
          renew();
          reset();
          onClose();
          onCreated(r.pass);
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };
  const nameError = formError?.startsWith('Misafirin adını') ? formError : undefined;
  const dateError = formError && !nameError ? formError : undefined;

  return (
    <Sheet open={open} title="Misafir geçişi oluştur" onClose={close}>
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
        error={dateError}
      />
      <DateField
        label="Son gün (isteğe bağlı)"
        value={validUntil}
        min={validFrom}
        max={addDays(validFrom, limits.maxPassDays - 1)}
        onChange={setValidUntil}
        onClear={() => setValidUntil('')}
        placeholder="Yalnızca geliş günü"
      />
      <View style={styles.group}>
        <AppText variant="small" weight="medium" accessibilityRole="header">
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
      {error && <Alert tone="danger">{error}</Alert>}
      <View style={styles.actions}>
        <Button variant="ghost" label="Vazgeç" onPress={close} />
        <Button label="Geçiş oluştur" loading={actions.createPass.isPending} onPress={submit} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  group: { gap: space(1.5) },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space(2) },
});
