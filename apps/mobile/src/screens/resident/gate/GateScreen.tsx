import { errorMessage } from '@bm/shared/api/errors';
import {
  type Courier,
  DIRECTION_TEXT,
  ENTRY_MODE_TEXT,
  type GateLogEntry,
  type GateUnit,
  LOG_KIND_TEXT,
  type MyPass,
  VERDICT_TEXT,
  type Vehicle,
  normalizePlate,
  plateError,
  timeOf,
  validityText,
} from '@bm/shared/api/portalGate';
import { formatDateTime } from '@bm/shared/dates';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Car, DoorOpen, LogIn, LogOut, Package, Plus, QrCode as QrIcon } from '@/components/icons';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { RefetchErrorBanner } from '@/components/portal/RefetchErrorBanner';
import { Sheet } from '@/components/portal/Sheet';
import { Alert, AppText, Badge, Button, Card, CardTitle, ChipGroup, EmptyState, LoadingBlock, Screen, TextField } from '@/components/ui';
import { useAuth } from '@/context/AuthProvider';
import { gateKeys, useGateLog, useMyCouriers, useMyGate, useMyGateActions, useMyPasses, useMyVehicles, usePassIssuing } from '@/hooks/useGate';
import { radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { NewPassForm } from './NewPassForm';
import { PassShare } from './PassShare';

type Tab = 'guests' | 'vehicles' | 'history';
/** Tek pencere: form -> (basarida) ayni pencerede QR / paylasim. Iki Modal art arda acilmaz. */
type PassSheetState = { kind: 'new' } | { kind: 'share'; pass: MyPass };

/**
 * Sakin "Ziyaretçi" (web: pages/resident/gate/MyGatePage.tsx): kapidaki kuryeye onay (en ustte,
 * yanit icin son saatle; ekran acikken sunucunun `pollSeconds` araligiyla ve uygulama one gelince
 * yenilenir), misafir gecisi (QR + kisa kod paylasimi, yeni QR, iptal), araclarim ve dairemin kapi
 * kayitlari. Yalnizca dairede oturan sakinler (kiraci veya oturan malik) kullanir. Gecis penceresi ve
 * jeton veren islemler ekran duzeyindedir: istek surerken bolum degisse de yeni QR kaybolmaz.
 */
export function GateScreen() {
  const overview = useMyGate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('guests');
  const [refreshing, setRefreshing] = useState(false);
  const [sheet, setSheet] = useState<PassSheetState>();
  const issuing = usePassIssuing((pass) => setSheet({ kind: 'share', pass }));

  const refresh = async () => {
    setRefreshing(true);
    try {
      await queryClient.refetchQueries({ queryKey: gateKeys.all(user?.apartmentId ?? '', user?.sub ?? ''), type: 'active' });
    } finally {
      setRefreshing(false);
    }
  };

  if (overview.isPending) {
    return (
      <Screen>
        <LoadingBlock label="Ziyaretçi bilgileri yükleniyor" />
      </Screen>
    );
  }
  if (!overview.data) {
    return (
      <Screen>
        <PortalQueryState error={overview.error} onRetry={() => void overview.refetch()} />
      </Screen>
    );
  }
  const { units, limits } = overview.data;

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      {overview.isError && <RefetchErrorBanner error={overview.error} onRetry={() => void overview.refetch()} />}
      {units.length === 0 ? (
        <Alert>Misafir geçişi, kurye onayı ve araç kaydı yalnızca dairede oturan sakinler içindir. Bir hata olduğunu düşünüyorsanız yönetimle iletişime geçin.</Alert>
      ) : (
        <>
          <WaitingCouriers />
          <ChipGroup
            size="compact"
            label="Ziyaretçi bölümü"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'guests', label: 'Misafirler' },
              { value: 'vehicles', label: 'Araçlarım' },
              { value: 'history', label: 'Kapı kayıtları' },
            ]}
          />
          {tab === 'guests' && <Guests units={units} rotate={issuing.rotate} onNew={() => setSheet({ kind: 'new' })} />}
          {tab === 'vehicles' && <MyVehicles units={units} max={limits.maxVehiclesPerUnit} />}
          {tab === 'history' && <History units={units} />}
          <Sheet open={!!sheet} title={sheet?.kind === 'share' ? 'Misafir geçişi' : 'Misafir geçişi oluştur'} onClose={() => setSheet(undefined)}>
            {sheet?.kind === 'new' ? (
              <NewPassForm units={units} limits={limits} create={issuing.create} onCancel={() => setSheet(undefined)} />
            ) : sheet?.kind === 'share' ? (
              <PassShare pass={sheet.pass} />
            ) : null}
          </Sheet>
        </>
      )}
    </Screen>
  );
}

/** Verilen ana kadar `false`, sonra `true` (yanit suresi dolunca kart kendini kapatir). */
function usePassed(iso: string): boolean {
  const at = Date.parse(iso);
  const [passed, setPassed] = useState(() => Date.now() >= at);
  useEffect(() => {
    if (passed) return;
    const wait = Math.max(0, at - Date.now()) + 50;
    // setTimeout 2^31-1 ms'den (~24,8 gun) uzun beklemede hemen calisir: o kadar uzak son saat bu ekranda beklenmez.
    if (wait > 2_147_483_647) return;
    const t = setTimeout(() => setPassed(true), wait);
    return () => clearTimeout(t);
  }, [at, passed]);
  return passed;
}

function WaitingCouriers() {
  const couriers = useMyCouriers();
  const waiting = (couriers.data ?? []).filter((c) => c.canRespond);
  if (!waiting.length) return null;
  return (
    <View accessibilityLabel="Onay bekleyen kuryeler" accessibilityLiveRegion="polite" style={styles.gap3}>
      {waiting.map((c) => (
        <CourierPrompt key={c.courierId} c={c} />
      ))}
    </View>
  );
}

/**
 * Belirgin kurye karti: firma, daire, gelis saati, gorevlinin notu, yanit icin son saat. Son saat
 * gecince dugmeler istemcide de kapanir (sunucu bir sonraki yenilemede `canRespond: false` doner).
 */
function CourierPrompt({ c }: { c: Courier }) {
  const a = useMyGateActions();
  const { colors } = useTheme();
  const late = usePassed(c.respondBy);
  const respond = (decision: 'approve' | 'decline') => a.respondCourier.mutate({ id: c.courierId, version: c.version, decision });
  const pending = a.respondCourier.isPending ? a.respondCourier.variables?.decision : undefined;

  return (
    <Card style={[styles.courier, { borderColor: withAlpha(colors.warning, 0.5) }]}>
      <CardTitle icon={<Package size={20} color={colors.warning} aria-hidden />}>Kapıda kurye var</CardTitle>
      <AppText>
        <AppText weight="semibold">{c.company ?? 'Kurye'}</AppText>
        {` · ${c.unitLabel} · ${timeOf(c.createdAt)}`}
      </AppText>
      {c.note ? (
        <AppText variant="small" tone="secondary">
          {`Görevlinin notu: ${c.note}`}
        </AppText>
      ) : null}
      <View style={[styles.respondBy, { backgroundColor: withAlpha(colors.warning, 0.1) }]}>
        <AppText variant="small" tone="warning">
          {late ? 'Yanıt süresi doldu (' : 'Yanıt için son saat: '}
          <AppText variant="small" tone="warning" weight="semibold" tabular>
            {timeOf(c.respondBy)}
          </AppText>
          {late ? '). Kurye içeri alınmaz.' : '. Yanıt verilmezse kurye içeri alınmaz.'}
        </AppText>
      </View>
      {a.respondCourier.error && <Alert tone="danger">{errorMessage(a.respondCourier.error)}</Alert>}
      <View style={styles.pair}>
        <View style={styles.flex}>
          <Button label="İçeri alınsın" block loading={pending === 'approve'} disabled={!!pending || late} onPress={() => respond('approve')} />
        </View>
        <View style={styles.flex}>
          <Button variant="secondary" label="Reddet" block loading={pending === 'decline'} disabled={!!pending || late} onPress={() => respond('decline')} />
        </View>
      </View>
    </Card>
  );
}

function VerdictBadge({ verdict }: { verdict: MyPass['verdict'] }) {
  const v = VERDICT_TEXT[verdict];
  return <Badge tone={v.tone} label={v.label} />;
}

type RotateMutation = { mutate: (v: { id: string; version: number }, opts?: { onSettled?: () => void }) => void; isPending: boolean; error: unknown };

function Guests({ units, rotate, onNew }: { units: GateUnit[]; rotate: RotateMutation; onNew: () => void }) {
  const passes = useMyPasses();
  const a = useMyGateActions();
  const { colors } = useTheme();
  /** `revoke:<id>` veya `rotate:<id>`: ikinci dokunusla onaylanan islem. */
  const [confirm, setConfirm] = useState<string>();
  const items = passes.data ?? [];

  return (
    <View style={styles.gap3}>
      <Button icon={Plus} label="Misafir geçişi oluştur" block onPress={onNew} />
      {a.revokePass.error && <Alert tone="danger">{errorMessage(a.revokePass.error)}</Alert>}
      {rotate.error ? <Alert tone="danger">{errorMessage(rotate.error)}</Alert> : null}
      {passes.isError && passes.data && <RefetchErrorBanner error={passes.error} onRetry={() => void passes.refetch()} />}
      {passes.isPending ? (
        <LoadingBlock label="Misafir geçişleri yükleniyor" />
      ) : !passes.data ? (
        <PortalQueryState error={passes.error} onRetry={() => void passes.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={DoorOpen} title="Henüz misafir geçişi yok" description="Misafiriniz gelmeden önce geçiş oluşturup QR'ı paylaşın." />
      ) : (
        items.map((p) => {
          const asking = confirm === `revoke:${p.passId}` ? 'revoke' : confirm === `rotate:${p.passId}` ? 'rotate' : undefined;
          return (
            <View key={p.passId} style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.between}>
                <View style={styles.flex}>
                  <AppText weight="semibold">{p.guestName}</AppText>
                  <AppText variant="small" tone="secondary">
                    {`${validityText(p.validFrom, p.validUntil)} · ${ENTRY_MODE_TEXT[p.entryMode]}${units.length > 1 ? ` · ${p.unitLabel}` : ''}`}
                  </AppText>
                  {p.inside && (
                    <AppText variant="small" tone="accent">
                      Şu an sitede
                    </AppText>
                  )}
                </View>
                <VerdictBadge verdict={p.verdict} />
              </View>
              {asking === 'rotate' && (
                <AppText variant="small" tone="secondary">
                  Yeni QR ve kod oluşturulur; daha önce paylaştığınız QR ve kod çalışmaz. Yenisini misafirinize gönderin.
                </AppText>
              )}
              {asking === 'revoke' && (
                <AppText variant="small" tone="secondary">
                  Geçiş iptal edilsin mi? Misafiriniz bu QR veya kodla giremez.
                </AppText>
              )}
              {(p.canRotate || p.canRevoke) && (
                <View style={styles.actions}>
                  {asking ? (
                    <>
                      <Button variant="ghost" label="Vazgeç" onPress={() => setConfirm(undefined)} />
                      {asking === 'revoke' ? (
                        <Button variant="danger" label="Evet, iptal et" loading={a.revokePass.isPending} onPress={() => a.revokePass.mutate({ id: p.passId, version: p.version }, { onSettled: () => setConfirm(undefined) })} />
                      ) : (
                        <Button
                          label="Evet, yeni QR oluştur"
                          loading={rotate.isPending}
                          onPress={() => rotate.mutate({ id: p.passId, version: p.version }, { onSettled: () => setConfirm(undefined) })}
                        />
                      )}
                    </>
                  ) : (
                    <>
                      {p.canRevoke && <Button variant="ghost" label="İptal et" accessibilityLabel={`${p.guestName} geçişini iptal et`} onPress={() => setConfirm(`revoke:${p.passId}`)} />}
                      {p.canRotate && (
                        <Button variant="secondary" icon={QrIcon} label="Yeni QR oluştur" accessibilityLabel={`${p.guestName} için yeni QR oluştur`} onPress={() => setConfirm(`rotate:${p.passId}`)} />
                      )}
                    </>
                  )}
                </View>
              )}
            </View>
          );
        })
      )}
    </View>
  );
}

function VehicleRow({ v, showUnit, pending, onToggle }: { v: Vehicle; showUnit: boolean; pending: boolean; onToggle: () => void }) {
  const { colors } = useTheme();
  const active = v.status === 'active';
  const detail = [showUnit ? v.unitLabel : null, v.note].filter(Boolean).join(' · ');
  return (
    <View style={[styles.row, styles.rowInline, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Car size={20} color={active ? colors.accent : colors.muted} aria-hidden />
      <View style={styles.flex}>
        <AppText weight="semibold" style={styles.mono}>
          {v.plateDisplay}
        </AppText>
        {detail ? (
          <AppText variant="small" tone="secondary">
            {detail}
          </AppText>
        ) : null}
        <Badge tone={active && !v.ownerLeft ? 'success' : 'neutral'} label={!active ? 'Pasif' : v.ownerLeft ? 'Sahibi taşındı' : 'Aktif'} />
      </View>
      <Button variant="secondary" label={active ? 'Pasife al' : 'Etkinleştir'} accessibilityLabel={`${v.plateDisplay} ${active ? 'pasife al' : 'etkinleştir'}`} loading={pending} onPress={onToggle} />
    </View>
  );
}

function MyVehicles({ units, max }: { units: GateUnit[]; max: number }) {
  const vehicles = useMyVehicles();
  const a = useMyGateActions();
  const [unitId, setUnitId] = useState(units[0]?.unitId ?? '');
  const [plate, setPlate] = useState('');
  const [note, setNote] = useState('');
  const [plateMsg, setPlateMsg] = useState<string>();
  const [pendingId, setPendingId] = useState<string>();
  const [toggleError, setToggleError] = useState<string>();
  const items = vehicles.data?.items ?? [];

  const add = () => {
    const problem = plateError(plate);
    setPlateMsg(problem);
    if (problem) return;
    a.createVehicle.mutate(
      { unitId: unitId || units[0]?.unitId || '', plate: normalizePlate(plate), ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: () => {
          setPlate('');
          setNote('');
        },
      },
    );
  };

  return (
    <View style={styles.gap3}>
      <Card>
        <CardTitle>Araç ekle</CardTitle>
        <AppText variant="small" tone="muted">
          {`Güvenlik plakayı sorguladığında yalnızca dairenizi ve aracın notunu görür. Bir daireye en fazla ${max} aktif araç kaydedilir.`}
        </AppText>
        {units.length > 1 && <UnitChips units={units} value={unitId} onChange={setUnitId} />}
        <View style={styles.field}>
          <TextField label="Plaka" value={plate} onChangeText={(t) => setPlate(t.toUpperCase())} error={plateMsg} accessibilityHint={plateMsg ?? 'Örnek: 34 ABC 123'} maxLength={14} autoCapitalize="characters" />
          {!plateMsg && (
            <AppText variant="small" tone="muted">
              Örnek: 34 ABC 123
            </AppText>
          )}
        </View>
        <View style={styles.field}>
          <TextField label="Not (isteğe bağlı)" value={note} onChangeText={setNote} accessibilityHint="Renk / marka, örnek: beyaz Fiat Egea" maxLength={80} />
          <AppText variant="small" tone="muted">
            Renk / marka, örnek: beyaz Fiat Egea
          </AppText>
        </View>
        {a.createVehicle.error && <Alert tone="danger">{errorMessage(a.createVehicle.error)}</Alert>}
        <Button label="Aracı kaydet" block loading={a.createVehicle.isPending} onPress={add} />
      </Card>
      {toggleError && <Alert tone="danger">{toggleError}</Alert>}
      {vehicles.isError && vehicles.data && <RefetchErrorBanner error={vehicles.error} onRetry={() => void vehicles.refetch()} />}
      {vehicles.isPending ? (
        <LoadingBlock label="Araçlar yükleniyor" />
      ) : !vehicles.data ? (
        <PortalQueryState error={vehicles.error} onRetry={() => void vehicles.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={Car} title="Kayıtlı aracınız yok" />
      ) : (
        items.map((v) => (
          <VehicleRow
            key={v.vehicleId}
            v={v}
            showUnit={units.length > 1}
            pending={pendingId === v.vehicleId}
            onToggle={() => {
              setPendingId(v.vehicleId);
              setToggleError(undefined);
              a.updateVehicle.mutate(
                { id: v.vehicleId, input: { version: v.version, status: v.status === 'active' ? 'inactive' : 'active' } },
                { onError: (err) => setToggleError(errorMessage(err)), onSettled: () => setPendingId(undefined) },
              );
            }}
          />
        ))
      )}
    </View>
  );
}

/** Birden fazla dairede daire secimi: gorunur "Daire" etiketi + hap dugmeler (NewPassSheet ve rezervasyonla ayni). */
function UnitChips({ units, value, onChange }: { units: GateUnit[]; value: string; onChange: (unitId: string) => void }) {
  return (
    <View style={styles.field}>
      <AppText variant="small" weight="medium">
        Daire
      </AppText>
      <ChipGroup size="compact" label="Daire" value={value} onChange={onChange} options={units.map((u) => ({ value: u.unitId, label: u.label }))} />
    </View>
  );
}

function LogRow({ e }: { e: GateLogEntry }) {
  const { colors } = useTheme();
  const Icon = e.direction === 'entry' ? LogIn : LogOut;
  const who = e.visitorName ?? e.company ?? LOG_KIND_TEXT[e.kind] ?? '';
  const detail = `${e.unitLabel ?? 'Bağımsız bölüm yok'}${e.plateDisplay ? ` · ${e.plateDisplay}` : ''}${e.kind === 'courier' && e.company && e.visitorName ? ` · ${e.company}` : ''}`;
  return (
    <View
      accessible
      accessibilityLabel={`${who}, ${DIRECTION_TEXT[e.direction]}, ${LOG_KIND_TEXT[e.kind]}, ${detail}, ${formatDateTime(e.at)}`}
      style={[styles.row, styles.rowInline, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <Icon size={20} color={e.direction === 'entry' ? colors.success : colors.muted} aria-hidden />
      <View style={styles.flex}>
        <View style={styles.meta}>
          <AppText weight="semibold">{who}</AppText>
          <Badge tone={e.direction === 'entry' ? 'success' : 'neutral'} label={DIRECTION_TEXT[e.direction] ?? e.direction} />
          <AppText variant="caption" tone="muted">
            {LOG_KIND_TEXT[e.kind]}
          </AppText>
        </View>
        <AppText variant="small" tone="secondary">
          {detail}
        </AppText>
        {e.note ? (
          <AppText variant="small" tone="muted">
            {e.note}
          </AppText>
        ) : null}
        <AppText variant="caption" tone="muted">
          {formatDateTime(e.at)}
        </AppText>
      </View>
    </View>
  );
}

function History({ units }: { units: GateUnit[] }) {
  const [unitId, setUnitId] = useState(units[0]?.unitId ?? '');
  const log = useGateLog(unitId);
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <View style={styles.gap3}>
      {units.length > 1 && <UnitChips units={units} value={unitId} onChange={setUnitId} />}
      <AppText variant="small" tone="muted">
        Dairenize gelen misafir, kurye ve ziyaretçilerin son 7 günlük giriş / çıkış kayıtları.
      </AppText>
      {log.isError && log.data && <RefetchErrorBanner error={log.error} onRetry={() => void log.refetch()} />}
      {log.isPending ? (
        <LoadingBlock label="Kapı kayıtları yükleniyor" />
      ) : !log.data ? (
        <PortalQueryState error={log.error} onRetry={() => void log.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={DoorOpen} title="Son 7 günde kapı kaydı yok" />
      ) : (
        items.map((e) => <LogRow key={e.logId} e={e} />)
      )}
      {log.hasNextPage && <Button variant="secondary" block label="Daha fazla yükle" loading={log.isFetchingNextPage} onPress={() => void log.fetchNextPage()} />}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 2 },
  gap3: { gap: space(3) },
  field: { gap: space(1.5) },
  courier: { borderWidth: 2 },
  respondBy: { borderRadius: radii.md, paddingHorizontal: space(3), paddingVertical: space(2) },
  pair: { flexDirection: 'row', gap: space(2) },
  row: { borderRadius: radii.xl, borderWidth: StyleSheet.hairlineWidth * 2, padding: space(4), gap: space(2) },
  rowInline: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  between: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space(3) },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(1.5) },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space(2) },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
});
