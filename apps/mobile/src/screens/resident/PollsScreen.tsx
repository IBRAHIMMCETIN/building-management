import { AUDIENCE_LABELS, PHASE_LABELS, PHASE_TONES, type PortalPoll } from '@bm/shared/api/polls';
import { formatDateTime } from '@bm/shared/dates';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Vote } from '@/components/icons';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { RowLink } from '@/components/portal/RowLink';
import { AppText, Badge, type BadgeTone, EmptyState, LoadingBlock, Screen } from '@/components/ui';
import { useMyPolls } from '@/hooks/usePolls';
import { space } from '@/theme/tokens';

/** Listedeki durum rozeti (web MyPollsPage PollLink ile ayni kural). */
export function pollStatus(p: PortalPoll): { tone: BadgeTone; label: string } {
  if (p.phase !== 'open') return { tone: PHASE_TONES[p.phase], label: PHASE_LABELS[p.phase] };
  if (p.myVote) return { tone: 'success', label: p.myVote.castByMe ? 'Oy verdiniz' : 'Dairenizin oyu kullanıldı' };
  return p.canVote ? { tone: 'accent', label: 'Oyunuzu bekliyor' } : { tone: 'neutral', label: 'Oy hakkınız yok' };
}

const when = (p: PortalPoll) => (p.phase === 'open' ? `Bitiş: ${formatDateTime(p.closesAt)}` : `Sona erdi: ${formatDateTime(p.closedAt ?? p.closesAt)}`);

/**
 * Sakin "Oylamalar" (web: pages/resident/polls/MyPollsPage.tsx): acik oylamalar once, ardindan
 * bitenler. Baslik yigin ust cubugunda (app/resident/polls/index.tsx), ekranda tekrarlanmaz.
 */
export function PollsScreen() {
  const list = useMyPolls();
  const router = useRouter();
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
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      {list.isPending ? (
        <LoadingBlock label="Oylamalar yükleniyor" />
      ) : list.isError ? (
        <PortalQueryState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState icon={Vote} title="Açık oylama yok" description="Yönetiminiz bir anket veya oylama başlattığında burada görünecek." />
      ) : (
        <View style={styles.list}>
          {list.data.map((p) => {
            const status = pollStatus(p);
            const results = p.resultsAvailable && p.phase === 'closed';
            return (
              <RowLink
                key={p.pollId}
                accessibilityLabel={`${p.title}, ${AUDIENCE_LABELS[p.audience]}, ${when(p)}, ${status.label}${results ? ', sonuçlar açıklandı' : ''}`}
                accessibilityHint="Oylamanın ayrıntısını açar"
                onPress={() => router.push({ pathname: '/resident/polls/[id]', params: { id: p.pollId } })}
              >
                <AppText weight="semibold">{p.title}</AppText>
                <AppText variant="caption" tone="muted">{`${AUDIENCE_LABELS[p.audience]} · ${when(p)}`}</AppText>
                <View style={styles.meta}>
                  <Badge tone={status.tone} label={status.label} />
                  {results && (
                    <AppText variant="caption" tone="muted">
                      Sonuçlar açıklandı
                    </AppText>
                  )}
                </View>
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
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(1.5) },
});
