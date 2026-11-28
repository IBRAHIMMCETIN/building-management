import { errorMessage } from '@bm/shared/api/errors';
import type { Courier } from '@bm/shared/api/gate';
import { COURIER_COMPANIES, timeOf } from '@bm/shared/gate/plate';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { LogIn, LogOut, Package, X } from '@/components/icons';
import { Alert, AppText, Button, Card, CardTitle, ChipGroup, EmptyState, LoadingBlock, TextField } from '@/components/ui';
import { COURIER_POLL_MS, useDeskActions, useDeskCouriers } from '@/hooks/useGateDesk';
import { useIdempotencyKey } from '@/lib/idempotency';
import { radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { CourierBadge, GateUnitSelect } from './GateUi';

/**
 * Kurye (web: pages/admin/gate/CourierDesk.tsx): gorevli gelen kuryeyi bolum icin kaydeder, daire
 * sakini uygulamadan / portaldan onaylar veya reddeder. Liste ekran acikken 15 sn'de bir yenilenir
 * (onay bekleyenlerin canli durumu); onaylanan kurye iceri alinir ve cikisi kaydedilir.
 */
export function CourierDesk({ active = true }: { active?: boolean }) {
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const list = useDeskCouriers(status, active);
  const items = list.data?.items ?? [];
  const waiting = items.filter((c) => c.status === 'waiting' && !c.expired).length;

  return (
    <View style={styles.gap4}>
      <NewCourierCard />
      <View style={styles.gap2}>
        <AppText variant="heading" weight="semibold" accessibilityRole="header">
          Kuryeler
        </AppText>
        <ChipGroup
          label="Kurye listesi"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: 'Bekleyen / içeride' },
            { value: 'all', label: 'Son 50' },
          ]}
        />
        {list.isSuccess && (
          <AppText variant="small" tone="muted" accessibilityLiveRegion="polite">
            {`${waiting > 0 ? `${waiting} kurye sakin onayı bekliyor · ` : ''}${Math.round(COURIER_POLL_MS / 1000)} sn'de bir güncellenir (son: ${timeOf(new Date(list.dataUpdatedAt).toISOString())})`}
          </AppText>
        )}
      </View>
      {list.isPending ? (
        <LoadingBlock label="Kuryeler yükleniyor" />
      ) : list.isError ? (
        <Card>
          <Alert tone="danger">{errorMessage(list.error)}</Alert>
          <Button variant="secondary" label="Tekrar dene" onPress={() => void list.refetch()} />
        </Card>
      ) : items.length === 0 ? (
        <EmptyState icon={Package} title={status === 'open' ? 'Bekleyen kurye yok' : 'Kurye kaydı yok'} description="Kapıya gelen kuryeyi yukarıdan daireye bildirin." />
      ) : (
        <View style={styles.gap2}>
          {items.map((c) => (
            <CourierRow key={c.courierId} c={c} />
          ))}
        </View>
      )}
    </View>
  );
}

function NewCourierCard() {
  const { colors } = useTheme();
  const a = useDeskActions();
  const [key, renew] = useIdempotencyKey();
  const [unit, setUnit] = useState<{ unitId: string; label: string } | null>(null);
  const [company, setCompany] = useState('');
  const [note, setNote] = useState('');
  const [done, setDone] = useState<string>();

  const submit = () => {
    if (!unit) return;
    setDone(undefined);
    a.createCourier.mutate(
      { idempotencyKey: key, unitId: unit.unitId, ...(company.trim() ? { company: company.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: (r) => {
          setDone(`${r.courier.unitLabel} için kurye kaydedildi; daire sakininin onayı bekleniyor.`);
          setUnit(null);
          setCompany('');
          setNote('');
          renew();
        },
      },
    );
  };

  return (
    <Card>
      <CardTitle icon={<Package size={20} color={colors.muted} aria-hidden />}>Kurye geldi</CardTitle>
      <GateUnitSelect label="Teslimat yapılacak bağımsız bölüm" value={unit} onChange={setUnit} />
      <TextField label="Firma (isteğe bağlı)" value={company} onChangeText={setCompany} maxLength={40} />
      <ChipGroup
        label="Sık kullanılan firmalar"
        value={(COURIER_COMPANIES as readonly string[]).includes(company) ? company : ''}
        onChange={setCompany}
        options={COURIER_COMPANIES.map((c) => ({ value: c, label: c }))}
      />
      <TextField label="Not (isteğe bağlı)" value={note} onChangeText={setNote} maxLength={200} placeholder="Örnek: büyük koli, kapıda ödeme" />
      {done && <Alert tone="success">{done}</Alert>}
      {a.createCourier.error && <Alert tone="danger">{errorMessage(a.createCourier.error)}</Alert>}
      <Button size="large" block label="Daireye bildir" disabled={!unit} loading={a.createCourier.isPending} onPress={submit} />
    </Card>
  );
}

function CourierRow({ c }: { c: Courier }) {
  const { colors } = useTheme();
  const a = useDeskActions();
  const [key, renew] = useIdempotencyKey();
  const [error, setError] = useState<string>();
  const opts = { onSuccess: () => renew(), onError: (err: unknown) => setError(errorMessage(err)) };
  const meta = `${c.company ?? 'Kurye'} · ${timeOf(c.createdAt)}${c.note ? ` · ${c.note}` : ''}`;

  return (
    <View style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.between}>
        <View style={styles.flex} accessible accessibilityLabel={`${c.unitLabel}, ${meta}`}>
          <AppText weight="semibold">{c.unitLabel}</AppText>
          <AppText variant="small" tone="secondary">
            {meta}
          </AppText>
          {c.responseNote && (
            <AppText variant="small" tone="muted">
              {`Sakinin notu: ${c.responseNote}`}
            </AppText>
          )}
          {c.enterBy && !c.approvalExpired && (
            <AppText variant="small" tone="muted">
              {`Onay ${timeOf(c.enterBy)} saatine kadar geçerli`}
            </AppText>
          )}
          {c.approvalExpired && (
            <AppText variant="small" tone="muted">
              Onayın süresi doldu; kurye hâlâ kapıdaysa yeniden kaydedin.
            </AppText>
          )}
        </View>
        <CourierBadge courier={c} />
      </View>
      {error && <Alert tone="danger">{error}</Alert>}
      {(c.canEnter || c.canExit || c.canCancel) && (
        <View style={styles.actions}>
          {c.canEnter && (
            <View style={styles.flex}>
              <Button size="large" block icon={LogIn} label="İçeri al" accessibilityLabel={`${c.unitLabel} kuryesini içeri al`} loading={a.courierEntry.isPending} onPress={() => a.courierEntry.mutate({ id: c.courierId, key }, opts)} />
            </View>
          )}
          {c.canExit && (
            <View style={styles.flex}>
              <Button size="large" block icon={LogOut} label="Çıkış kaydet" accessibilityLabel={`${c.unitLabel} kuryesinin çıkışını kaydet`} loading={a.courierExit.isPending} onPress={() => a.courierExit.mutate({ id: c.courierId, key }, opts)} />
            </View>
          )}
          {c.canCancel && (
            <View style={styles.flex}>
              <Button
                size="large"
                block
                variant="secondary"
                icon={X}
                label="Kapat"
                accessibilityLabel={`${c.unitLabel} kurye kaydını kapat`}
                loading={a.cancelCourier.isPending}
                onPress={() => a.cancelCourier.mutate({ id: c.courierId, version: c.version }, { onError: opts.onError })}
              />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap2: { gap: space(2) },
  gap4: { gap: space(4) },
  between: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space(3) },
  row: { gap: space(3), borderRadius: radii.xl, borderWidth: StyleSheet.hairlineWidth * 2, padding: space(4) },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
});
