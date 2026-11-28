import { errorMessage } from '@bm/shared/api/errors';
import { formatPlate, normalizePlate } from '@bm/shared/gate/plate';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Alert, AppText, Button, Card, ChipGroup, Screen, TextField } from '@/components/ui';
import { useDeskActions } from '@/hooks/useGate';
import { useIdempotencyKey } from '@/lib/idempotency';
import { space } from '@/theme/tokens';
import { GateUnitSelect } from './GateUi';

/**
 * Elle kapi kaydi (web: GateLogPanel ManualEntryDialog): QR'siz ziyaretci, servis araci vb. icin
 * giris / cikis gunluge yazilir. Plaka sorgusundan gelince plaka dolu acilir. Kayittan sonra form
 * bosalir (siradaki ziyaretci); geri tusu kapiya doner.
 */
export function ManualEntryScreen({ initialPlate }: { initialPlate?: string }) {
  const a = useDeskActions();
  const [key, renew] = useIdempotencyKey();
  const [direction, setDirection] = useState<'entry' | 'exit'>('entry');
  const [visitorName, setVisitorName] = useState('');
  const [unit, setUnit] = useState<{ unitId: string; label: string } | null>(null);
  const [plate, setPlate] = useState(initialPlate ? formatPlate(normalizePlate(initialPlate)) : '');
  const [note, setNote] = useState('');
  const [nameError, setNameError] = useState<string>();
  const [done, setDone] = useState<string>();

  const submit = () => {
    setDone(undefined);
    if (visitorName.trim().length < 2) {
      setNameError('Ziyaretçi adı en az 2 karakter olmalı');
      return;
    }
    setNameError(undefined);
    const p = normalizePlate(plate);
    a.manualEntry.mutate(
      { idempotencyKey: key, direction, visitorName: visitorName.trim(), ...(unit ? { unitId: unit.unitId } : {}), ...(p ? { plate: p } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: () => {
          setDone(`${visitorName.trim()} için ${direction === 'entry' ? 'giriş' : 'çıkış'} kaydedildi.`);
          setVisitorName('');
          setUnit(null);
          setPlate('');
          setNote('');
          renew();
        },
      },
    );
  };

  return (
    <Screen>
      <Card>
        <AppText variant="heading" weight="semibold" accessibilityRole="header">
          Elle kapı kaydı
        </AppText>
        <AppText variant="small" tone="muted">
          QR’si olmayan ziyaretçi, servis aracı veya teslimat için. Kayıt kapı günlüğüne yazılır.
        </AppText>
        <View style={styles.gap2}>
          <AppText variant="small" weight="medium">
            Yön
          </AppText>
          <ChipGroup
            label="Yön"
            size="large"
            columns={2}
            value={direction}
            onChange={setDirection}
            options={[
              { value: 'entry', label: 'Giriş' },
              { value: 'exit', label: 'Çıkış' },
            ]}
          />
        </View>
        <TextField label="Ziyaretçi adı / açıklama" value={visitorName} onChangeText={setVisitorName} maxLength={80} placeholder="Örnek: Elektrikçi Hasan, su servisi" error={nameError} />
        <GateUnitSelect label="Gittiği bağımsız bölüm (isteğe bağlı)" value={unit} onChange={setUnit} optional />
        <TextField label="Plaka (isteğe bağlı)" value={plate} onChangeText={(t) => setPlate(t.toUpperCase())} maxLength={14} autoCapitalize="characters" autoCorrect={false} />
        <TextField label="Not (isteğe bağlı)" value={note} onChangeText={setNote} maxLength={200} multiline />
        {done && <Alert tone="success">{done}</Alert>}
        {a.manualEntry.error && <Alert tone="danger">{errorMessage(a.manualEntry.error)}</Alert>}
        <Button size="large" block label="Kaydet" loading={a.manualEntry.isPending} onPress={submit} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  gap2: { gap: space(2) },
});
