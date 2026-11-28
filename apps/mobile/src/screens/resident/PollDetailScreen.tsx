import { ApiError, errorMessage } from '@bm/shared/api/errors';
import { AUDIENCE_LABELS, PHASE_LABELS, PHASE_TONES, type PortalPoll, WEIGHTING_LABELS, myVoteText } from '@bm/shared/api/polls';
import { formatDate, formatDateTime } from '@bm/shared/dates';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { CircleCheck, Lock, Users, Vote } from '@/components/icons';
import { PollResultsView } from '@/components/portal/PollResultsView';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { Alert, AppText, Badge, Button, Card, CardTitle, LoadingBlock, Screen } from '@/components/ui';
import { useMyPoll, useVote } from '@/hooks/usePolls';
import { MIN_TOUCH, radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/** Oylama sona erdi / henuz baslamadi (API `poll_closed`, 409): ekran guncel durumu yeniden ceker. */
const isPollClosed = (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === 'poll_closed';

/**
 * Sakin oylama ayrintisi (web: pages/resident/polls/MyPollDetailPage.tsx): oy verme / degistirme,
 * kendi oyum ve (aciksa) sonuclar. Mobilde oy gonderilmeden once secim onaylatilir.
 */
export function PollDetailScreen({ id }: { id: string }) {
  const detail = useMyPoll(id);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await detail.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      {detail.isPending ? (
        <LoadingBlock label="Oylama yükleniyor" lines={5} />
      ) : detail.isError ? (
        <PortalQueryState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <Detail key={`${detail.data.pollId}-${detail.data.unitId}`} poll={detail.data} />
      )}
    </Screen>
  );
}

function Detail({ poll: p }: { poll: PortalPoll }) {
  const { colors } = useTheme();
  const vote = useVote(p.pollId);
  const [choice, setChoice] = useState<string | undefined>(p.myVote?.optionId);
  const [confirming, setConfirming] = useState(false);
  const mine = myVoteText(p);
  const changing = Boolean(p.myVote);
  const sameAsMine = Boolean(p.myVote?.castByMe && choice === p.myVote.optionId);
  const chosen = p.options.find((o) => o.optionId === choice);

  const pick = (optionId: string) => {
    setChoice(optionId);
    setConfirming(false);
    vote.reset();
  };

  const send = () => {
    if (!choice) return;
    vote.mutate(choice, { onSettled: () => setConfirming(false) });
  };

  return (
    <>
      <Card>
        <AppText variant="heading" weight="semibold" accessibilityRole="header">
          {p.title}
        </AppText>
        <View style={styles.meta}>
          <Badge tone={PHASE_TONES[p.phase]} label={PHASE_LABELS[p.phase]} />
          <View style={styles.inline}>
            <Users size={14} color={colors.muted} aria-hidden />
            <AppText variant="caption" tone="muted">{`${AUDIENCE_LABELS[p.audience]} · ${WEIGHTING_LABELS[p.weighting]}`}</AppText>
          </View>
        </View>
        <AppText variant="caption" tone="muted">
          {`${formatDateTime(p.opensAt)} – ${formatDateTime(p.closedAt ?? p.closesAt)}${p.closedEarly ? ' (erken kapatıldı)' : ''}`}
        </AppText>
        {p.description && (
          <AppText variant="small" tone="secondary" selectable>
            {p.description}
          </AppText>
        )}
      </Card>

      <Card>
        <CardTitle icon={<Vote size={20} color={colors.muted} aria-hidden />}>
          {p.phase === 'open' && p.canVote ? (changing ? 'Oyunuzu değiştirin' : 'Oyunuzu kullanın') : 'Oyunuz'}
        </CardTitle>

        {mine && (
          <View style={styles.inline} accessible accessibilityLabel={mine}>
            <CircleCheck size={16} color={colors.success} aria-hidden />
            <AppText variant="small" weight="medium" tone="success" style={styles.flex}>
              {mine}
            </AppText>
          </View>
        )}

        {!p.eligible && p.ineligibleReason && (
          <Alert>{`${p.ineligibleReason}. Oy listesi yönetimin mülkiyet kayıtlarından hazırlanır; bir hata olduğunu düşünüyorsanız yönetiminize başvurun.`}</Alert>
        )}

        {p.canVote ? (
          <View style={styles.form}>
            <View accessibilityRole="radiogroup" accessibilityLabel="Seçenekler" style={styles.options}>
              {p.options.map((o) => {
                const checked = choice === o.optionId;
                return (
                  <Pressable
                    key={o.optionId}
                    accessibilityRole="radio"
                    accessibilityLabel={o.label}
                    accessibilityState={{ checked, disabled: vote.isPending }}
                    disabled={vote.isPending}
                    onPress={() => pick(o.optionId)}
                    style={({ pressed }) => [
                      styles.option,
                      {
                        borderColor: checked ? colors.accent : colors.border,
                        backgroundColor: checked ? withAlpha(colors.accent, 0.1) : pressed ? colors.surfaceMuted : colors.surface,
                      },
                    ]}
                  >
                    <View style={[styles.radio, { borderColor: checked ? colors.accent : colors.borderStrong }]}>
                      {checked && <View style={[styles.dot, { backgroundColor: colors.accent }]} />}
                    </View>
                    <AppText style={styles.flex}>{o.label}</AppText>
                  </Pressable>
                );
              })}
            </View>

            {vote.isSuccess && <Alert tone="success">Oyunuz kaydedildi. Oylama bitene kadar değiştirebilirsiniz.</Alert>}

            {confirming && chosen ? (
              <View style={[styles.confirm, { borderColor: withAlpha(colors.accent, 0.3), backgroundColor: withAlpha(colors.accent, 0.05) }]} accessibilityLiveRegion="polite">
                <AppText variant="small" weight="semibold">
                  {changing ? `Oyunuz “${chosen.label}” olarak değiştirilecek.` : `“${chosen.label}” seçeneğine oy vereceksiniz.`}
                </AppText>
                <AppText variant="small" tone="secondary">
                  Oylama bitene kadar verilen son oy geçerlidir; isterseniz sonra değiştirebilirsiniz.
                </AppText>
                <View style={styles.actions}>
                  <Button label={changing ? 'Değişikliği onayla' : 'Oyu onayla'} loading={vote.isPending} onPress={send} />
                  <Button variant="secondary" label="Vazgeç" disabled={vote.isPending} onPress={() => setConfirming(false)} />
                </View>
              </View>
            ) : (
              <Button
                label={changing ? 'Oyumu değiştir' : 'Oyu gönder'}
                disabled={!choice || sameAsMine}
                onPress={() => {
                  vote.reset();
                  setConfirming(true);
                }}
              />
            )}
          </View>
        ) : (
          p.phase !== 'open' && (
            <AppText variant="small" tone="muted">
              {p.phase === 'closed' ? 'Oylama sona erdi; oy kabul edilmiyor.' : 'Oylama henüz başlamadı.'}
            </AppText>
          )
        )}

        {/* Gonderim hatasi formun disinda: 409 sonrasi oylama kapanmis gorunse de neden okunur. */}
        {vote.isError && <Alert tone="danger">{isPollClosed(vote.error) ? `Oyunuz kaydedilmedi: ${errorMessage(vote.error)}.` : errorMessage(vote.error)}</Alert>}

        <View style={styles.rules}>
          <AppText variant="small" tone="muted">
            {`Her bağımsız bölüm tek oy kullanır. Bölümünüzün başka bir ${p.audience === 'owners' ? 'paydaşı (hisseli mülkiyet)' : 'sakini veya maliki'} de oy verebilir; oylama bitene kadar verilen son oy geçerlidir.`}
          </AppText>
          <View style={styles.inlineTop}>
            <Lock size={14} color={colors.muted} aria-hidden style={styles.iconTop} />
            <AppText variant="small" tone="muted" style={styles.flex}>
              {p.secret
                ? 'Gizli oylama: yönetim hangi bölümün hangi seçeneği işaretlediğini göremez.'
                : 'Açık oylama: yönetim hangi bölümün hangi seçeneği işaretlediğini görebilir.'}
            </AppText>
          </View>
          <AppText variant="small" tone="muted">{`Oy hakkı ${formatDate(p.rollDate)} tarihli mülkiyet kayıtlarına göre belirlenir.`}</AppText>
        </View>
      </Card>

      <Card>
        <CardTitle>Sonuçlar</CardTitle>
        {p.results ? (
          <PollResultsView results={p.results} highlightOptionId={p.myVote?.castByMe ? p.myVote.optionId : undefined} />
        ) : (
          <AppText variant="small" tone="muted">
            {p.resultsAfterVote ? 'Ara sonuçlar dairenizin oyu kullanıldıktan sonra görünür.' : 'Sonuçlar oylama bitince açıklanır.'}
          </AppText>
        )}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(2) },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
  inlineTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space(1.5) },
  iconTop: { marginTop: 3 },
  form: { gap: space(3) },
  options: { gap: space(2) },
  option: {
    minHeight: MIN_TOUCH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
    paddingHorizontal: space(4),
    paddingVertical: space(3),
  },
  radio: { width: 20, height: 20, borderRadius: radii.full, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 10, height: 10, borderRadius: radii.full },
  confirm: { gap: space(2), borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth * 2, padding: space(3) },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  rules: { gap: space(1.5) },
});
