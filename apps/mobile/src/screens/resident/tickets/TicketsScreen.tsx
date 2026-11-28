import { PORTAL_CLOSED_STATUSES, PORTAL_OPEN_STATUSES, awaitsMyConfirmation } from '@bm/shared/api/tickets';
import { formatDate } from '@bm/shared/dates';
import { CATEGORY_LABELS } from '@bm/shared/tickets/model';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { ChevronRight, Plus, Wrench } from '@/components/icons';
import { FilterChips } from '@/components/portal/FilterChips';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { TicketStatusBadge } from '@/components/tickets/TicketBadges';
import { AppText, Badge, Button, EmptyState, LoadingBlock, Screen } from '@/components/ui';
import { useMyTickets } from '@/hooks/useTickets';
import { radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

type Tab = 'open' | 'closed';

/**
 * Sakin "Arıza / Talep" (web: pages/resident/tickets/MyTicketsPage.tsx): actigim ve dairemin
 * talepleri, Açık / Kapanan; onayimi bekleyenler en ustte ve vurgulu. Dokununca ayrinti.
 */
export function TicketsScreen() {
  const [tab, setTab] = useState<Tab>('open');
  const list = useMyTickets(tab === 'open' ? PORTAL_OPEN_STATUSES : PORTAL_CLOSED_STATUSES);
  const router = useRouter();
  const { colors } = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  const items = [...(list.data?.items ?? [])].sort((a, b) => Number(awaitsMyConfirmation(b)) - Number(awaitsMyConfirmation(a)));

  const refresh = async () => {
    setRefreshing(true);
    try {
      await list.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Screen title="Arıza / Talep" refreshing={refreshing} onRefresh={() => void refresh()}>
      <Button icon={Plus} label="Yeni talep" onPress={() => router.push('/resident/tickets/new')} />
      <FilterChips
        label="Talep durumu"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'open', label: 'Açık' },
          { value: 'closed', label: 'Kapanan' },
        ]}
      />
      {list.isPending ? (
        <LoadingBlock label="Talepler yükleniyor" />
      ) : list.isError ? (
        <PortalQueryState error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title={tab === 'open' ? 'Açık talebiniz yok' : 'Kapanmış talep yok'}
          description={tab === 'open' ? 'Bir arıza bildirmek için "Yeni talep"e dokunun.' : undefined}
        />
      ) : (
        <View style={styles.list}>
          {items.map((t) => {
            const waiting = awaitsMyConfirmation(t);
            const meta = `${t.number} · ${CATEGORY_LABELS[t.category]} · ${formatDate(t.createdAt)}`;
            return (
              <Pressable
                key={t.ticketId}
                accessibilityRole="button"
                accessibilityLabel={`${t.title}, ${meta}${waiting ? ', onayınızı bekliyor' : ''}`}
                accessibilityHint="Talebin ayrıntısını açar"
                onPress={() => router.push({ pathname: '/resident/tickets/[id]', params: { id: t.ticketId } })}
                style={({ pressed }) => [
                  styles.card,
                  { backgroundColor: pressed ? colors.surfaceMuted : colors.surface, borderColor: waiting ? withAlpha(colors.success, 0.5) : colors.border },
                ]}
              >
                <View style={styles.text}>
                  <AppText variant="caption" tone="muted">
                    <AppText variant="caption" tone="muted" style={styles.mono}>
                      {t.number}
                    </AppText>
                    {` · ${CATEGORY_LABELS[t.category]} · ${formatDate(t.createdAt)}`}
                  </AppText>
                  <AppText weight="semibold">{t.title}</AppText>
                  <View style={styles.meta}>
                    <TicketStatusBadge status={t.status} />
                    {waiting && <Badge tone="success" label="Onayınızı bekliyor" />}
                    {t.location.kind === 'common' && (
                      <AppText variant="caption" tone="muted">
                        {`Ortak alan · ${t.location.area}`}
                      </AppText>
                    )}
                  </View>
                </View>
                <ChevronRight size={18} color={colors.muted} aria-hidden />
              </Pressable>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: space(3) },
  card: { flexDirection: 'row', alignItems: 'center', gap: space(3), borderRadius: radii.xl, borderWidth: StyleSheet.hairlineWidth * 2, padding: space(4) },
  text: { flex: 1, gap: space(1) },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(1.5) },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
});
