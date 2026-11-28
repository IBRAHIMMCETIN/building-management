import { awaitsMyConfirmation } from '@bm/shared/api/tickets';
import { formatDate, formatDateTime } from '@bm/shared/dates';
import { formatTRY } from '@bm/shared/money';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { ArrowRight, CircleCheck, Megaphone, Plus, TriangleAlert, Wrench } from '@/components/icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { PayOnlineButton } from '@/components/portal/PayOnlineButton';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { PortalStatusBadge } from '@/components/portal/PortalStatusBadge';
import { AppText, Button, Card, CardTitle, LoadingBlock, Screen, Skeleton } from '@/components/ui';
import { useAuth } from '@/context/AuthProvider';
import { portalKeys, useMyAnnouncements, useMyOpenTickets, useMySummary } from '@/hooks/usePortal';
import { MIN_TOUCH, radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/** Borc karti: durum, gecikme uyarisi, siradaki son odeme, son odeme (web: ResidentHomePage DebtCard). */
function DebtCard() {
  const summary = useMySummary();
  const router = useRouter();
  const { colors } = useTheme();

  if (summary.isPending) return <LoadingBlock label="Borç özeti yükleniyor" />;
  if (summary.isError) return <PortalQueryState error={summary.error} onRetry={() => void summary.refetch()} />;

  const s = summary.data;
  const clear = s.debt === 0;

  return (
    <Card>
      <View style={styles.between}>
        <View style={styles.flex}>
          <CardTitle>Güncel borç</CardTitle>
          <AppText variant="small" tone="muted">
            {`${s.unitLabel} · ${s.relationLabel}`}
          </AppText>
        </View>
        <PortalStatusBadge status={s.status} />
      </View>

      {clear ? (
        <View style={[styles.clearBox, { backgroundColor: withAlpha(colors.success, 0.1) }]}>
          <CircleCheck size={24} color={colors.success} aria-hidden />
          <View style={styles.flex}>
            <AppText weight="semibold" tone="success">
              Borcunuz bulunmamaktadır
            </AppText>
            {s.advance > 0 && (
              <AppText variant="small" tone="success">
                {`${formatTRY(s.advance)} avansınız var; sonraki aidatlarınızdan düşülecek.`}
              </AppText>
            )}
          </View>
        </View>
      ) : (
        <View style={styles.gap2}>
          <AppText variant="title" weight="bold" tabular accessibilityLabel={`Güncel borç ${formatTRY(s.debt)}`}>
            {formatTRY(s.debt)}
          </AppText>
          {s.overdueAmount > 0 ? (
            <View style={styles.row} accessibilityRole="alert">
              <TriangleAlert size={16} color={colors.warning} aria-hidden style={styles.iconTop} />
              <AppText variant="small" tone="warning" style={styles.flex}>
                {`${formatTRY(s.overdueAmount)} tutarın son ödeme tarihi ${s.daysOverdue} gün önce geçti.` +
                  (s.accruedLateFee > 0
                    ? ` Bugüne kadar işleyen gecikme tazminatı ${formatTRY(s.accruedLateFee)}; ayın 1'inde borcunuza eklenir.`
                    : ' Gecikme tazminatı uygulanabilir.')}
              </AppText>
            </View>
          ) : s.nextDue ? (
            <AppText variant="small" tone="muted">
              {`${s.nextDue.description} · son ödeme `}
              <AppText variant="small" weight="semibold">
                {formatDate(s.nextDue.dueDate)}
              </AppText>
            </AppText>
          ) : null}
          {s.overdueAmount > 0 && s.nextDue && (
            <AppText variant="small" tone="muted">
              {`Sıradaki: ${s.nextDue.description} · son ödeme ${formatDate(s.nextDue.dueDate)}`}
            </AppText>
          )}
          <PayOnlineButton hint />
        </View>
      )}

      {s.lastPayment && (
        <AppText variant="small" tone="muted">
          {`Son ödeme: ${formatDate(s.lastPayment.paidAt)} · ${formatTRY(s.lastPayment.amount)} (${s.lastPayment.receiptNumber})`}
        </AppText>
      )}

      <View style={[styles.footer, { borderTopColor: colors.border }]}>
        <Button variant="ghost" icon={ArrowRight} label="Hesap hareketlerim" onPress={() => router.navigate('/resident/dues')} />
      </View>
    </Card>
  );
}

/** Acik talep sayisi ve onayini bekleyenler (web: tickets/MyTicketsCard.tsx). */
function MyTicketsCard() {
  const list = useMyOpenTickets();
  const router = useRouter();
  const { colors } = useTheme();
  const items = list.data?.items ?? [];
  const waiting = items.filter(awaitsMyConfirmation).length;

  return (
    <Card>
      <CardTitle icon={<Wrench size={20} color={colors.muted} aria-hidden />}>Arıza / Talep</CardTitle>
      {list.isPending ? (
        <Skeleton height={20} width="50%" />
      ) : list.isError ? (
        <AppText variant="small" tone="muted">
          Talepler şu an yüklenemedi.
        </AppText>
      ) : (
        <AppText variant="small">
          {items.length === 0 ? 'Açık talebiniz yok.' : `${items.length} açık talep`}
          {waiting > 0 && (
            <AppText variant="small" weight="medium" tone="success">
              {` · ${waiting} talep onayınızı bekliyor`}
            </AppText>
          )}
        </AppText>
      )}
      <View style={styles.wrap}>
        <Button variant="secondary" icon={Plus} label="Arıza bildir" onPress={() => router.push('/resident/tickets/new')} />
        <Button variant="ghost" icon={ArrowRight} label="Taleplerim" onPress={() => router.navigate('/resident/tickets')} />
      </View>
    </Card>
  );
}

/** Son 3 duyuru; daire/uyelik hatalari borc kartinda gosterildigi icin burada sessiz kalinir. */
function LatestAnnouncementsCard() {
  const list = useMyAnnouncements();
  const router = useRouter();
  const { colors } = useTheme();
  if (list.isError) return null;

  return (
    <Card>
      <CardTitle icon={<Megaphone size={20} color={colors.muted} aria-hidden />}>Son duyurular</CardTitle>
      {list.isPending ? (
        <View accessible accessibilityRole="progressbar" accessibilityLabel="Duyurular yükleniyor" style={styles.gap2}>
          <Skeleton height={16} width="70%" />
          <Skeleton height={16} width="50%" />
        </View>
      ) : list.data.length === 0 ? (
        <AppText variant="small" tone="muted">
          Güncel duyuru yok.
        </AppText>
      ) : (
        <View>
          {list.data.slice(0, 3).map((a, i) => (
            <Pressable
              key={a.announcementId}
              accessibilityRole="button"
              accessibilityLabel={`${a.title}, ${formatDateTime(a.publishAt)}`}
              accessibilityHint="Duyurunun tamamını açar"
              onPress={() => router.push({ pathname: '/resident/announcements/[id]', params: { id: a.announcementId } })}
              style={({ pressed }) => [styles.annRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: colors.border }, pressed && { backgroundColor: colors.surfaceMuted }]}
            >
              <AppText weight="medium">{a.title}</AppText>
              <AppText variant="small" tone="muted">
                {formatDateTime(a.publishAt)}
              </AppText>
            </Pressable>
          ))}
        </View>
      )}
      <View style={[styles.footer, { borderTopColor: colors.border }]}>
        <Button variant="ghost" icon={ArrowRight} label="Tüm duyurular" onPress={() => router.navigate('/resident/announcements')} />
      </View>
    </Card>
  );
}

/** Sakin ana sayfasi (web: pages/resident/ResidentHomePage.tsx). Asagi cekince tum kartlar yenilenir. */
export function HomeScreen() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await queryClient.refetchQueries({ queryKey: portalKeys.all(user?.apartmentId ?? '', user?.sub ?? ''), type: 'active' });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Screen title="Hoş geldiniz" refreshing={refreshing} onRefresh={() => void refresh()}>
      <DebtCard />
      <MyTicketsCard />
      <LatestAnnouncementsCard />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  between: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space(3) },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space(2) },
  iconTop: { marginTop: 2 },
  gap2: { gap: space(2) },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(2) },
  clearBox: { flexDirection: 'row', alignItems: 'center', gap: space(3), borderRadius: radii.md, paddingHorizontal: space(4), paddingVertical: space(3) },
  footer: { borderTopWidth: StyleSheet.hairlineWidth * 2, paddingTop: space(2), marginHorizontal: -space(1) },
  annRow: { minHeight: MIN_TOUCH, paddingVertical: space(2), gap: 2, justifyContent: 'center' },
});
