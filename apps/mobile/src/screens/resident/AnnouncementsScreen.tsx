import { formatDateTime } from '@bm/shared/dates';
import { useRouter } from 'expo-router';
import { ChevronRight, Megaphone } from '@/components/icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { AppText, EmptyState, LoadingBlock, Screen } from '@/components/ui';
import { useMyAnnouncements } from '@/hooks/usePortal';
import { radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/** Duyurunun ilk satirlari (liste onizlemesi). */
export function excerpt(body: string, max = 140): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Sakin duyurulari (web: pages/resident/AnnouncementsPage.tsx); dokununca ayrinti ekrani. */
export function AnnouncementsScreen() {
  const list = useMyAnnouncements();
  const router = useRouter();
  const { colors } = useTheme();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await list.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Screen title="Duyurular" refreshing={refreshing} onRefresh={() => void refresh()}>
      {list.isPending ? (
        <LoadingBlock label="Duyurular yükleniyor" />
      ) : list.isError ? (
        <PortalQueryState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState icon={Megaphone} title="Güncel duyuru yok" description="Yönetiminiz bir duyuru yayınladığında burada görünecek." />
      ) : (
        <View style={styles.list}>
          {list.data.map((a) => (
            <Pressable
              key={a.announcementId}
              accessibilityRole="button"
              accessibilityLabel={`${a.title}, ${formatDateTime(a.publishAt)}`}
              accessibilityHint="Duyurunun tamamını açar"
              onPress={() => router.push({ pathname: '/resident/announcements/[id]', params: { id: a.announcementId } })}
              style={({ pressed }) => [styles.card, { backgroundColor: pressed ? colors.surfaceMuted : colors.surface, borderColor: colors.border }]}
            >
              <View style={styles.text}>
                <AppText weight="semibold">{a.title}</AppText>
                <AppText variant="caption" tone="muted">
                  {formatDateTime(a.publishAt)}
                </AppText>
                <AppText variant="small" tone="secondary" numberOfLines={3}>
                  {excerpt(a.body)}
                </AppText>
              </View>
              <ChevronRight size={18} color={colors.muted} aria-hidden />
            </Pressable>
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: space(3) },
  card: { flexDirection: 'row', alignItems: 'center', gap: space(3), borderRadius: radii.xl, borderWidth: StyleSheet.hairlineWidth * 2, padding: space(4) },
  text: { flex: 1, gap: space(1) },
});
