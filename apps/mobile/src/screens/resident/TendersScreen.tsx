import { TENDER_CATEGORY_LABELS, TENDER_STATUS_LABELS, TENDER_STATUS_TONES, type TenderSummary, deadlineText } from '@bm/shared/api/tenders';
import { formatDate } from '@bm/shared/dates';
import { formatTRY } from '@bm/shared/money';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Scale } from '@/components/icons';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { RowLink } from '@/components/portal/RowLink';
import { AppText, Badge, EmptyState, LoadingBlock, Screen } from '@/components/ui';
import { useMyTenders } from '@/hooks/useTenders';
import { space } from '@/theme/tokens';

/** Bugunun Istanbul takvim gunu ("2026-11-28"; web: lib/reservations/model.ts istanbulToday). */
export function istanbulToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Kart metinleri (web: components/tenders/TenderCard.tsx ile ayni kurallar). */
export function tenderCardLines(t: TenderSummary, today: string) {
  const collecting = t.status === 'draft' || t.status === 'collecting';
  const counts = `Teklif: ${t.quoteCount}/${t.minQuotes}${t.lowestTotalKurus !== undefined ? ` · En düşük: ${formatTRY(t.lowestTotalKurus)}` : ''}`;
  const outcome = t.decision
    ? `Seçilen: ${t.decision.supplierName} · ${formatTRY(t.decision.totalKurus)}`
    : collecting
      ? `Son teklif: ${formatDate(t.deadline)} · ${deadlineText(t.deadline, today)}`
      : null;
  return { category: `${TENDER_CATEGORY_LABELS[t.category]}${t.ticket ? ` · ${t.ticket.number}` : ''}`, counts, outcome, short: t.quoteCount < t.minQuotes && collecting };
}

/**
 * Sakin "İhaleler" (web: pages/resident/tenders/MyTendersPage.tsx): yonetimin sakinlerle paylastigi
 * ihaleler (teklifler yan yana, belgeler, karar). Baslik yigin ust cubugunda.
 */
export function TendersScreen() {
  const list = useMyTenders();
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const today = istanbulToday();

  const refresh = async () => {
    setRefreshing(true);
    try {
      await list.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <AppText variant="small" tone="muted">
        Büyük tadilat ve bakım işleri için alınan teklifler, belgeleri ve yönetimin kararı.
      </AppText>
      {list.isPending ? (
        <LoadingBlock label="İhaleler yükleniyor" />
      ) : list.isError ? (
        <PortalQueryState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState icon={Scale} title="Paylaşılmış ihale yok" description="Yönetim bir iş için aldığı teklifleri paylaştığında burada yan yana görebilirsiniz." />
      ) : (
        <View style={styles.list}>
          {list.data.map((t) => {
            const l = tenderCardLines(t, today);
            const status = TENDER_STATUS_LABELS[t.status];
            return (
              <RowLink
                key={t.tenderId}
                accessibilityLabel={`${t.title}, ${status}, ${l.category}, ${l.counts}${l.outcome ? `, ${l.outcome}` : ''}`}
                accessibilityHint="İhalenin tekliflerini ve ayrıntısını açar"
                onPress={() => router.push({ pathname: '/resident/tenders/[id]', params: { id: t.tenderId } })}
              >
                <AppText weight="semibold">{t.title}</AppText>
                <AppText variant="caption" tone="muted">
                  {l.category}
                </AppText>
                <Badge tone={TENDER_STATUS_TONES[t.status]} label={status} />
                <AppText variant="small" tone={l.short ? 'warning' : 'text'} tabular>
                  {l.counts}
                </AppText>
                {l.outcome && (
                  <AppText variant="small" tone={!t.decision && t.deadlinePassed ? 'warning' : t.decision ? 'text' : 'muted'} tabular>
                    {l.outcome}
                  </AppText>
                )}
              </RowLink>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: space(3) },
});
