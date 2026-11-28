import { errorMessage } from '@bm/shared/api/errors';
import { type StatementRow, mergeStatement } from '@bm/shared/api/portal';
import { formatDate } from '@bm/shared/dates';
import { formatTRY } from '@bm/shared/money';
import { useQueryClient } from '@tanstack/react-query';
import { ReceiptText } from '@/components/icons';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PayOnlineButton } from '@/components/portal/PayOnlineButton';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { PortalStatusBadge } from '@/components/portal/PortalStatusBadge';
import { Alert, AppText, Badge, Button, Card, EmptyState, LoadingBlock, Skeleton } from '@/components/ui';
import { useAuth } from '@/context/AuthProvider';
import { usePortalUnit } from '@/context/PortalUnitProvider';
import { portalKeys, useMyStatement, useMySummary } from '@/hooks/usePortal';
import { endpoints } from '@/lib/api/endpoints';
import { openDocument } from '@/lib/openExternal';
import { useServices } from '@/services';
import { MIN_TOUCH, radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

export const TYPE_LABEL: Record<StatementRow['entryType'], string> = {
  ACCRUAL: 'Tahakkuk',
  COLLECTION: 'Tahsilat',
  REVERSAL: 'Düzeltme',
  LATE_FEE: 'Gecikme tazminatı',
  OTHER: 'Diğer',
};

/** API hareketleri sayfalamadan tek seferde dondurur (`/my-statement`); liste parca parca cizilir. */
export const PAGE_SIZE = 20;

const rowKey = (r: StatementRow) => `${r.transactionId}-${r.liableParty}`;

function SummaryCard() {
  const summary = useMySummary();
  const { colors } = useTheme();
  if (summary.isPending) return <LoadingBlock label="Borç durumu yükleniyor" lines={4} />;
  if (summary.isError) return <PortalQueryState error={summary.error} onRetry={() => void summary.refetch()} />;
  const s = summary.data;

  return (
    <Card>
      <View style={styles.between}>
        <View style={styles.flex}>
          <AppText variant="small" tone="muted">
            {`${s.unitLabel} · ${s.relationLabel}`}
          </AppText>
          <AppText variant="small" tone="muted">
            Güncel borç
          </AppText>
          <AppText variant="title" weight="bold" tabular tone={s.debt === 0 ? 'success' : 'text'}>
            {formatTRY(s.debt)}
          </AppText>
        </View>
        <PortalStatusBadge status={s.status} />
      </View>
      {s.overdueAmount > 0 && (
        <View style={[styles.notice, { backgroundColor: withAlpha(colors.warning, 0.1) }]} accessibilityRole="alert">
          <AppText variant="small" tone="warning">
            {`${formatTRY(s.overdueAmount)} gecikmede (en eski vade ${s.oldestOverdueDueDate ? formatDate(s.oldestOverdueDueDate) : '—'}, ${s.daysOverdue} gün).`}
          </AppText>
        </View>
      )}
      {s.accruedLateFee > 0 && (
        <AppText variant="small" tone="muted">
          {'Bugüne kadar işleyen gecikme tazminatı: '}
          <AppText variant="small" weight="semibold" tone="warning" tabular>
            {formatTRY(s.accruedLateFee)}
          </AppText>
          {'. Ödenen kısım için tazminat ödeme gününde durur; işleyen tutar her ayın 1’inde borcunuza eklenir.'}
        </AppText>
      )}
      <View style={styles.stats}>
        <Stat label="Toplam tahakkuk" value={formatTRY(s.totalCharged)} />
        <Stat label="Toplam ödenen" value={formatTRY(s.totalPaid)} tone="success" />
        {s.advance > 0 ? (
          <Stat label="Avans" value={formatTRY(s.advance)} tone="success" wide />
        ) : s.nextDue ? (
          <Stat label="Sıradaki son ödeme" value={formatDate(s.nextDue.dueDate)} wide />
        ) : null}
      </View>
      <PayOnlineButton />
    </Card>
  );
}

function Stat({ label, value, tone = 'text', wide }: { label: string; value: string; tone?: 'text' | 'success'; wide?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.stat, wide && styles.statWide, { backgroundColor: colors.surfaceMuted }]} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText variant="small" tone="muted">
        {label}
      </AppText>
      <AppText weight="semibold" tone={tone} tabular>
        {value}
      </AppText>
    </View>
  );
}

function MovementRow({ row, onReceipt, receiptPending }: { row: StatementRow; onReceipt: (paymentId: string) => void; receiptPending: boolean }) {
  const { colors } = useTheme();
  const isCredit = row.credit > 0;
  const amount = isCredit ? `−${formatTRY(row.credit)}` : formatTRY(row.debit);
  const label = `${row.description}, ${formatDate(row.date)}, ${TYPE_LABEL[row.entryType]}, ${isCredit ? 'tahsilat' : 'borç'} ${isCredit ? formatTRY(row.credit) : formatTRY(row.debit)}${row.reversed ? ', iptal edildi' : ''}`;

  return (
    <View style={[styles.rowCard, { backgroundColor: colors.surface, borderColor: colors.border }, row.reversed && styles.reversed]}>
      <View accessible accessibilityLabel={label} style={styles.between}>
        <View style={styles.flex}>
          <AppText weight="medium" strike={row.reversed}>
            {row.description}
          </AppText>
          <AppText variant="small" tone="muted">
            {formatDate(row.date)}
          </AppText>
        </View>
        <AppText weight="semibold" tabular tone={row.reversed ? 'muted' : isCredit ? 'success' : 'text'} strike={row.reversed}>
          {amount}
        </AppText>
      </View>
      <View style={styles.meta}>
        <Badge tone={row.entryType === 'COLLECTION' ? 'success' : 'neutral'} label={TYPE_LABEL[row.entryType]} />
        {row.reversed && <Badge tone="warning" label="İptal edildi" />}
        {row.entryType === 'ACCRUAL' && row.dueDate && (
          <AppText variant="small" tone="muted">
            {`Son ödeme ${formatDate(row.dueDate)}`}
          </AppText>
        )}
      </View>
      {row.receiptNumber &&
        (row.paymentId ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${row.receiptNumber} numaralı makbuzu aç`}
            accessibilityState={{ busy: receiptPending, disabled: receiptPending }}
            disabled={receiptPending}
            onPress={() => onReceipt(row.paymentId as string)}
            style={({ pressed }) => [styles.receipt, { backgroundColor: pressed ? colors.surfaceMuted : 'transparent' }]}
          >
            {receiptPending ? <ActivityIndicator size="small" color={colors.accent} /> : <ReceiptText size={16} color={colors.accent} aria-hidden />}
            <AppText variant="small" tone="accent" weight="medium" style={styles.mono}>
              {row.receiptNumber}
            </AppText>
          </Pressable>
        ) : (
          <AppText variant="small" tone="muted" style={styles.mono}>
            {row.receiptNumber}
          </AppText>
        ))}
    </View>
  );
}

/**
 * Borçlarım (web: pages/resident/DuesPage.tsx): borc ozeti, "Online öde", hesap hareketleri (malik +
 * sakin carisi birlesik, en yeni once). Asagi cek-yenile; liste 20'ser satir acilir (sona gelince
 * veya "Daha fazla göster" ile). Makbuz PDF'i imzali linkle sistem goruntuleyicisinde acilir.
 */
export function DuesScreen() {
  const statement = useMyStatement();
  // Ozet de hataliysa (ayni sebep: daire secimi, uyelik yok) hata ozet kartinda bir kez gosterilir.
  const summaryFailed = useMySummary().isError;
  const { api } = useServices();
  const { unitId } = usePortalUnit();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingReceipt, setPendingReceipt] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);

  const rows = useMemo(() => (statement.data ? mergeStatement(statement.data) : []), [statement.data]);
  const shown = rows.slice(0, visible);
  const hasMore = rows.length > visible;
  const showMore = useCallback(() => setVisible((v) => (rows.length > v ? v + PAGE_SIZE : v)), [rows.length]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await queryClient.refetchQueries({ queryKey: portalKeys.all(user?.apartmentId ?? '', user?.sub ?? ''), type: 'active' });
      setVisible(PAGE_SIZE);
    } finally {
      setRefreshing(false);
    }
  };

  const openReceipt = (paymentId: string) => {
    setPendingReceipt(paymentId);
    setDocError(null);
    openDocument(() => endpoints.myReceipt(api, paymentId, unitId))
      .catch((err: unknown) => setDocError(errorMessage(err)))
      .finally(() => setPendingReceipt(null));
  };

  const header = (
    <View style={styles.header}>
      <AppText variant="title" weight="bold" accessibilityRole="header">
        Borçlarım
      </AppText>
      <SummaryCard />
      {statement.isPending ? (
        <View accessible accessibilityRole="progressbar" accessibilityLabel="Hareketler yükleniyor" style={styles.gap2}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={64} />
          ))}
        </View>
      ) : statement.isError ? (
        summaryFailed ? null : <PortalQueryState error={statement.error} onRetry={() => void statement.refetch()} />
      ) : statement.isSuccess && rows.length === 0 ? (
        <EmptyState icon={ReceiptText} title="Henüz hesap hareketi yok" description="Aidat tahakkukları ve ödemeleriniz burada listelenecek." />
      ) : statement.isSuccess ? (
        <View style={styles.gap2}>
          <AppText variant="heading" weight="semibold" accessibilityRole="header">
            Hesap hareketleri
          </AppText>
          <AppText variant="small" tone="muted">{`${rows.length} hareket, en yeni önce`}</AppText>
          {docError && <Alert tone="danger">{docError}</Alert>}
        </View>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.root, { backgroundColor: colors.bg }]}>
      <FlatList
        data={statement.isSuccess ? shown : []}
        keyExtractor={rowKey}
        renderItem={({ item }) => <MovementRow row={item} onReceipt={openReceipt} receiptPending={pendingReceipt === item.paymentId} />}
        ListHeaderComponent={header}
        ListFooterComponent={
          hasMore ? (
            <View style={styles.footer}>
              <Button variant="secondary" block label={`Daha fazla göster (${rows.length - visible} kaldı)`} onPress={showMore} />
            </View>
          ) : undefined
        }
        initialNumToRender={PAGE_SIZE}
        onEndReached={showMore}
        onEndReachedThreshold={0.4}
        contentContainerStyle={styles.content}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.accent} colors={[colors.accent]} />}
        accessibilityLabel="Hesap hareketleri, en yeni önce"
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: space(4), paddingBottom: space(8) },
  header: { gap: space(4), marginBottom: space(3) },
  flex: { flex: 1 },
  gap2: { gap: space(2) },
  between: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space(3) },
  notice: { borderRadius: radii.md, paddingHorizontal: space(3), paddingVertical: space(2) },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: space(3) },
  stat: { flexGrow: 1, flexBasis: '45%', borderRadius: radii.md, padding: space(3), gap: 2 },
  statWide: { flexBasis: '100%' },
  rowCard: { borderRadius: radii.xl, borderWidth: StyleSheet.hairlineWidth * 2, padding: space(4), gap: space(2) },
  reversed: { opacity: 0.7 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(1.5) },
  receipt: { minHeight: MIN_TOUCH, flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: space(1.5), paddingHorizontal: space(2), marginLeft: -space(2), borderRadius: radii.md },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  separator: { height: space(2) },
  footer: { paddingTop: space(3) },
});
