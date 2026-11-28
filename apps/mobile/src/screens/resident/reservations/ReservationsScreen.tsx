import { errorMessage } from '@bm/shared/api/errors';
import type { MyBooking } from '@bm/shared/api/reservations';
import { formatDateTime } from '@bm/shared/dates';
import { formatTRY } from '@bm/shared/money';
import { BOOKING_STATUS_LABELS, BOOKING_STATUS_TONES, FEE_STATUS_LABELS, dayLabel, hoursSummary } from '@bm/shared/reservations/model';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { CalendarCheck, CalendarDays, ChevronRight, CircleCheck } from '@/components/icons';
import { FilterChips } from '@/components/portal/FilterChips';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { Alert, AppText, Badge, Button, Card, EmptyState, LoadingBlock, Screen } from '@/components/ui';
import { useAuth } from '@/context/AuthProvider';
import { reservationKeys, useCancelMyBooking, useMyBookings, usePortalFacilities } from '@/hooks/useReservations';
import { radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

type Tab = 'new' | 'mine';

/**
 * Sakin "Rezervasyon" (web: pages/resident/reservations/MyReservationsPage.tsx): Yeni rezervasyon
 * (ortak alan listesi; dokununca tarih / saat secimi ayri ekranda) ve Rezervasyonlarım (yaklasan,
 * gecmis ve iptal edilenler; iptal). Bildirimden (`?tab=mine`) rezervasyonlarim acilir.
 */
export function ReservationsScreen({ tab: requested, doneId, warning }: { tab?: Tab; doneId?: string; warning?: string }) {
  const [tab, setTab] = useState<Tab>(requested ?? 'new');
  const [done, setDone] = useState(doneId);
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [refreshing, setRefreshing] = useState(false);

  // Rezervasyon tamamlaninca (`?tab=mine&done=<id>`) veya bildirimden (`?tab=mine`) bu ekrana donulur.
  useEffect(() => {
    if (requested) setTab(requested);
    setDone(doneId);
  }, [requested, doneId]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await queryClient.refetchQueries({ queryKey: reservationKeys.all(user?.apartmentId ?? '', user?.sub ?? ''), type: 'active' });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <FilterChips
        label="Rezervasyon görünümü"
        value={tab}
        onChange={(t) => {
          setTab(t);
          setDone(undefined);
        }}
        options={[
          { value: 'new', label: 'Yeni rezervasyon' },
          { value: 'mine', label: 'Rezervasyonlarım' },
        ]}
      />
      {done && tab === 'mine' && <DoneCard bookingId={done} warning={warning} />}
      {tab === 'new' ? <Facilities /> : <MyBookings />}
    </Screen>
  );
}

/** Yeni rezervasyonun sonucu (web: `done` karti): onay bekliyor veya onaylandi, alan / gun / saat. */
function DoneCard({ bookingId, warning }: { bookingId: string; warning?: string }) {
  const list = useMyBookings();
  const { colors } = useTheme();
  const b = [...(list.data?.upcoming ?? []), ...(list.data?.history ?? [])].find((x) => x.bookingId === bookingId);
  if (!b) return null;
  return (
    <Card style={styles.done} accessibilityLiveRegion="polite">
      <CircleCheck size={40} color={colors.success} aria-hidden />
      <AppText weight="semibold" style={styles.center} accessibilityRole="header">
        {b.status === 'pending' ? 'Talebiniz alındı, yönetici onayı bekleniyor' : 'Rezervasyonunuz onaylandı'}
      </AppText>
      <AppText variant="small" tone="muted" style={styles.center}>{`${b.facilityName} · ${dayLabel(b.date)} · ${b.startTime}–${b.endTime}`}</AppText>
      {warning ? <Alert>{warning}</Alert> : null}
    </Card>
  );
}

function Facilities() {
  const facilities = usePortalFacilities();
  const router = useRouter();
  const { colors } = useTheme();
  if (facilities.isPending) return <LoadingBlock label="Ortak alanlar yükleniyor" />;
  if (facilities.isError) return <PortalQueryState error={facilities.error} onRetry={() => void facilities.refetch()} />;
  const { items, units } = facilities.data;
  if (!units.length) return <EmptyState icon={CalendarDays} title="Rezervasyon için bir daireye üye olmanız gerekir" />;
  if (!items.length) return <EmptyState icon={CalendarDays} title="Rezervasyona açık ortak alan yok" />;

  return (
    <View style={styles.list}>
      {items.map((f) => {
        const fee = f.feeKurus ? formatTRY(f.feeKurus) : 'Ücretsiz';
        const hours = hoursSummary(f.openingHours);
        return (
          <Pressable
            key={f.facilityId}
            accessibilityRole="button"
            accessibilityLabel={`${f.name}, ${fee}${f.requiresApproval ? ', yönetici onaylı' : ''}, ${hours}`}
            accessibilityHint="Tarih ve saat seçimini açar"
            onPress={() => router.push({ pathname: '/resident/reservations/[facilityId]', params: { facilityId: f.facilityId } })}
            style={({ pressed }) => [styles.card, { backgroundColor: pressed ? colors.surfaceMuted : colors.surface, borderColor: colors.border }]}
          >
            <View style={styles.text}>
              <AppText weight="semibold">{f.name}</AppText>
              <View style={styles.meta}>
                <Badge tone={f.feeKurus ? 'accent' : 'neutral'} label={fee} />
                {f.requiresApproval && <Badge tone="warning" label="Yönetici onaylı" />}
              </View>
              {f.description ? (
                <AppText variant="small" tone="secondary" numberOfLines={2}>
                  {f.description}
                </AppText>
              ) : null}
              <AppText variant="caption" tone="muted">
                {hours}
              </AppText>
            </View>
            <ChevronRight size={18} color={colors.muted} aria-hidden />
          </Pressable>
        );
      })}
    </View>
  );
}

function MyBookings() {
  const list = useMyBookings();
  const cancel = useCancelMyBooking();
  const [confirming, setConfirming] = useState<string>();
  const [notice, setNotice] = useState<string>();
  if (list.isPending) return <LoadingBlock label="Rezervasyonlarınız yükleniyor" />;
  if (list.isError) return <PortalQueryState error={list.error} onRetry={() => void list.refetch()} />;
  const { upcoming, history } = list.data;

  const row = (b: MyBooking) => (
    <Card key={b.bookingId}>
      <View style={styles.between}>
        <View style={styles.text}>
          <AppText weight="semibold">{b.facilityName}</AppText>
          <AppText variant="small" tone="muted">{`${dayLabel(b.date)} · ${b.startTime}–${b.endTime}`}</AppText>
        </View>
        <Badge tone={b.expired ? 'neutral' : BOOKING_STATUS_TONES[b.status]} label={b.expired ? 'Süresi geçti' : BOOKING_STATUS_LABELS[b.status]} />
      </View>
      {b.fee.amount > 0 && (
        <AppText variant="caption" tone="muted">
          {`${formatTRY(b.fee.amount)} · ${FEE_STATUS_LABELS[b.fee.status]}`}
        </AppText>
      )}
      {b.decisionNote ? (
        <AppText variant="caption" tone="danger">
          {`Ret gerekçesi: ${b.decisionNote}`}
        </AppText>
      ) : null}
      {b.cancelKind === 'manager' && b.cancelReason ? (
        <AppText variant="caption" tone="danger">
          {`Yönetim iptal etti: ${b.cancelReason}`}
        </AppText>
      ) : null}
      {b.canCancel ? (
        confirming === b.bookingId ? (
          <View style={styles.gap2}>
            <AppText variant="small">{`Rezervasyon iptal edilsin mi?${b.fee.status === 'charged' ? ' Ücret ters kayıtla borcunuzdan düşülür.' : ''}`}</AppText>
            {cancel.isError && <Alert tone="danger">{errorMessage(cancel.error)}</Alert>}
            <View style={styles.actions}>
              <Button variant="ghost" label="Vazgeç" disabled={cancel.isPending} onPress={() => setConfirming(undefined)} />
              <Button
                variant="danger"
                label="İptal et"
                accessibilityLabel={`${b.facilityName} rezervasyonunu iptal et`}
                loading={cancel.isPending}
                onPress={() =>
                  cancel.mutate(
                    { id: b.bookingId, version: b.version },
                    {
                      onSuccess: (r) => {
                        setConfirming(undefined);
                        setNotice(r.warning);
                      },
                    },
                  )
                }
              />
            </View>
          </View>
        ) : (
          <View style={styles.cancelRow}>
            <AppText variant="caption" tone="muted" style={styles.text}>
              {`En geç ${formatDateTime(b.cancelDeadline)} iptal edilebilir`}
            </AppText>
            <Button
              variant="secondary"
              label="İptal et"
              accessibilityLabel={`${b.facilityName} rezervasyonunu iptal et`}
              onPress={() => {
                cancel.reset();
                setConfirming(b.bookingId);
              }}
            />
          </View>
        )
      ) : (
        !b.past &&
        b.status !== 'cancelled' &&
        b.status !== 'rejected' && (
          <AppText variant="caption" tone="muted">
            İptal süresi geçti; değişiklik için yönetimle görüşün.
          </AppText>
        )
      )}
    </Card>
  );

  return (
    <>
      {notice && <Alert tone="danger">{notice}</Alert>}
      {upcoming.length === 0 ? <EmptyState icon={CalendarCheck} title="Yaklaşan rezervasyonunuz yok" /> : <View style={styles.list}>{upcoming.map(row)}</View>}
      {history.length > 0 && (
        <View style={styles.list}>
          <AppText variant="small" weight="semibold" tone="muted" accessibilityRole="header">
            Geçmiş ve iptal edilenler
          </AppText>
          {history.map(row)}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  list: { gap: space(3) },
  gap2: { gap: space(2) },
  card: { flexDirection: 'row', alignItems: 'center', gap: space(3), borderRadius: radii.xl, borderWidth: StyleSheet.hairlineWidth * 2, padding: space(4) },
  text: { flex: 1, gap: space(1) },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: space(1.5) },
  between: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space(3) },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space(2) },
  cancelRow: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  done: { alignItems: 'center', paddingVertical: space(6) },
  center: { textAlign: 'center' },
});
