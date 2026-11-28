import { errorMessage } from '@bm/shared/api/errors';
import { addDays, istanbulDay } from '@bm/shared/gate/plate';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { DoorOpen, Plus } from '@/components/icons';
import { Alert, AppText, Button, Card, ChipGroup, EmptyState, LoadingBlock } from '@/components/ui';
import { useGateLog } from '@/hooks/useGate';
import { space } from '@/theme/tokens';
import { LogRow } from './GateUi';

type Kind = '' | 'guest' | 'courier' | 'manual';

/**
 * Kapi kayitlari (web: pages/admin/gate/GateLogPanel.tsx gorevli gorunumu): dun ve bugun (API de
 * bunu zorlar), tur filtresi, "Daha fazla yükle". Elle giris / cikis ayri ekranda.
 */
export function GateLog({ onManualEntry }: { onManualEntry: () => void }) {
  const today = istanbulDay();
  const [kind, setKind] = useState<Kind>('');
  const log = useGateLog({ from: addDays(today, -1), to: today, ...(kind ? { kind } : {}) });
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <View style={styles.gap4}>
      <View style={styles.gap2}>
        <AppText variant="small" tone="muted">
          Dün ve bugünün kayıtları
        </AppText>
        <Button size="large" block icon={Plus} label="Elle giriş / çıkış" onPress={onManualEntry} />
        <ChipGroup
          label="Kayıt türü"
          value={kind}
          onChange={setKind}
          options={[
            { value: '', label: 'Tümü' },
            { value: 'guest', label: 'Misafir' },
            { value: 'courier', label: 'Kurye' },
            { value: 'manual', label: 'Elle kayıt' },
          ]}
        />
      </View>
      {log.isPending ? (
        <LoadingBlock label="Kapı kayıtları yükleniyor" />
      ) : log.isError ? (
        <Card>
          <Alert tone="danger">{errorMessage(log.error)}</Alert>
          <Button variant="secondary" label="Tekrar dene" onPress={() => void log.refetch()} />
        </Card>
      ) : items.length === 0 ? (
        <EmptyState icon={DoorOpen} title="Kapı kaydı yok" description="Dün ve bugün bu türde giriş / çıkış kaydedilmedi." />
      ) : (
        <View style={styles.gap2}>
          {items.map((e) => (
            <LogRow key={e.logId} e={e} />
          ))}
        </View>
      )}
      {log.hasNextPage && <Button variant="secondary" block label="Daha fazla yükle" loading={log.isFetchingNextPage} onPress={() => void log.fetchNextPage()} />}
    </View>
  );
}

const styles = StyleSheet.create({
  gap2: { gap: space(2) },
  gap4: { gap: space(4) },
});
