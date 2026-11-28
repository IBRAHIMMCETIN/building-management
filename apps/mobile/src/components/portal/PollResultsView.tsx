import { type PollResults, WEIGHTING_LABELS, formatBps, formatFraction, optionBasisBps, outcomeText } from '@bm/shared/api/polls';
import { formatDate } from '@bm/shared/dates';
import { StyleSheet, View } from 'react-native';
import { Trophy } from '@/components/icons';
import { Alert, AppText, Badge } from '@/components/ui';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { BarTrack } from './BarTrack';
import { StatTile } from './StatTile';

type Props = {
  results: PollResults;
  /** Sakinin kendi secimi (vurgulanir). */
  highlightOptionId?: string;
};

/**
 * Oylama sonucu (web: components/polls/PollResultsView.tsx): katilim, secenek cubuklari ve salt
 * cogunluk sonucu. Cubuk genisligi oylamanin karar olcutundeki paydir (bolum sayisi veya arsa payi).
 * Gizli oylama surerken dagilim gosterilmez, yalnizca katilim.
 */
export function PollResultsView({ results: r, highlightOptionId }: Props) {
  const { colors } = useTheme();
  const hasLand = r.eligible.landShare !== null;
  const units = `${r.participation.units} / ${r.eligible.units} bölüm · ${formatBps(r.participation.unitsBps)}`;
  const land = hasLand && r.participation.landShare && r.eligible.landShare ? `${formatFraction(r.participation.landShare)} · ${formatBps(r.participation.landShareBps ?? 0)}` : null;

  return (
    <View style={styles.root}>
      <View style={styles.stats}>
        <StatTile label="Katılım (bölüm)" value={units} />
        {land && <StatTile label="Katılım (arsa payı)" value={land} />}
      </View>

      <AppText variant="caption" tone="muted">
        {`Karar ölçütü: ${WEIGHTING_LABELS[r.weighting].toLocaleLowerCase('tr')} · Oy listesi tarihi ${formatDate(r.rollDate)}`}
      </AppText>

      {r.tallyHidden ? (
        <Alert>Gizli oylama sürüyor: seçeneklerin dağılımı oylama bitince açıklanır. Şimdilik yalnızca katılım görünür.</Alert>
      ) : (
        <View style={styles.options}>
          {(r.options ?? []).map((o) => {
            const bps = optionBasisBps(o, r.weighting);
            const winner = r.winnerOptionId === o.optionId;
            const mine = highlightOptionId === o.optionId;
            const detail = `${o.units} bölüm (${formatBps(o.unitsBps)})${hasLand && o.landShare ? ` · arsa payı ${formatFraction(o.landShare)} (${formatBps(o.landShareBps ?? 0)})` : ''}`;
            return (
              <View
                key={o.optionId}
                style={styles.option}
                accessible
                accessibilityLabel={`${o.label}${winner ? (r.final ? ', kazanan' : ', önde') : ''}${mine ? ', sizin oyunuz' : ''}: ${formatBps(bps)}. ${detail}`}
              >
                <View style={styles.optionHead}>
                  <View style={styles.optionLabel}>
                    {winner && <Trophy size={16} color={colors.success} aria-hidden />}
                    <AppText weight="medium" style={styles.flexShrink}>
                      {o.label}
                    </AppText>
                    {mine && <Badge tone="accent" label="Sizin oyunuz" />}
                  </View>
                  <AppText variant="small" weight="semibold" tabular>
                    {formatBps(bps)}
                  </AppText>
                </View>
                <BarTrack segments={[{ fraction: bps / 10_000, color: winner ? colors.success : colors.accent }]} />
                <AppText variant="caption" tone="muted" tabular>
                  {detail}
                </AppText>
              </View>
            );
          })}
        </View>
      )}

      {!r.tallyHidden && (
        <AppText variant="small" weight="medium">
          {outcomeText(r)}
        </AppText>
      )}
      {r.warnings.length > 0 && <Alert>{r.warnings.join(' · ')}</Alert>}
    </View>
  );
}


const styles = StyleSheet.create({
  root: { gap: space(4) },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: space(3) },
  options: { gap: space(3) },
  option: { gap: space(1.5) },
  optionHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: space(2) },
  optionLabel: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(2), flexShrink: 1 },
  flexShrink: { flexShrink: 1 },
});
