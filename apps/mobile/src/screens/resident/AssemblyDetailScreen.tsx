import {
  CHOICE_LABELS,
  DECISION_LABELS,
  MAJORITY_LABELS,
  PORTAL_PHASE_LABELS,
  PORTAL_PHASE_TONES,
  type PortalAssembly,
  type PortalDecision,
  VOTE_CHOICES,
} from '@bm/shared/api/assemblies';
import { errorMessage } from '@bm/shared/api/errors';
import { formatBps } from '@bm/shared/api/polls';
import { formatDateTime } from '@bm/shared/dates';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CalendarClock, ExternalLink, FileText, MapPin } from '@/components/icons';
import { Alert, AppText, Badge, Button, Card, CardTitle, LoadingBlock, Screen } from '@/components/ui';
import { useMyAssembly, useOwnerGate } from '@/hooks/useAssemblies';
import { useSignedDocument } from '@/hooks/useSignedDocument';
import { assembliesApi } from '@/lib/api/assemblies';
import { openInAppBrowser } from '@/lib/openExternal';
import { useServices } from '@/services';
import { radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { AssemblyQueryState, OwnersOnlyState, assemblyTitle } from './AssembliesScreen';

/** Toplam sayilar: oy (m.31 sinirli), varsa kat maliki, bolum ve arsa payi. Bolum / kisi bazinda bilgi yok (web ile ayni). */
export function decisionLine(d: PortalDecision): string {
  return VOTE_CHOICES.map((k) => {
    const parts = [`${d.votes[k]} oy`];
    if (d.persons) parts.push(`${d.persons[k]} kat maliki`);
    if (d.units) parts.push(`${d.units[k]} bölüm`);
    if (d.landShareBps) parts.push(`arsa payı ${formatBps(d.landShareBps[k])}`);
    return `${CHOICE_LABELS[k]} ${parts.join(' · ')}`;
  }).join(' — ');
}

/**
 * Sakin genel kurul ayrintisi (web: pages/resident/assemblies/MyAssemblyDetailPage.tsx), yalnizca kat
 * maliki: toplanti bilgisi, gundem ve gerekli cogunluk; kesinlesince yeter sayi, kararlar ve tutanak
 * PDF'i (5 dk imzali link, sistem goruntuleyicisinde).
 */
export function AssemblyDetailScreen({ id }: { id: string }) {
  const { notOwner } = useOwnerGate();
  const detail = useMyAssembly(id);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await detail.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  if (notOwner) {
    return (
      <Screen>
        <OwnersOnlyState />
      </Screen>
    );
  }

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      {detail.isPending ? (
        <LoadingBlock label="Toplantı yükleniyor" lines={5} />
      ) : detail.isError ? (
        <AssemblyQueryState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <Detail key={detail.data.assemblyId} assembly={detail.data} />
      )}
    </Screen>
  );
}

function Detail({ assembly: a }: { assembly: PortalAssembly }) {
  const { colors } = useTheme();
  const { api } = useServices();
  const doc = useSignedDocument();
  const held = a.phase === 'held';
  const q = a.quorum;

  return (
    <>
      <Card>
        <AppText variant="heading" weight="semibold" accessibilityRole="header">
          {assemblyTitle(a)}
        </AppText>
        <View style={styles.meta}>
          <Badge tone={PORTAL_PHASE_TONES[a.phase]} label={PORTAL_PHASE_LABELS[a.phase]} />
          <View style={styles.inline}>
            <CalendarClock size={14} color={colors.muted} aria-hidden />
            <AppText variant="caption" tone="muted">
              {formatDateTime(a.scheduledAt)}
            </AppText>
          </View>
          {a.location && (
            <View style={styles.inline}>
              <MapPin size={14} color={colors.muted} aria-hidden />
              <AppText variant="caption" tone="muted">
                {a.location}
              </AppText>
            </View>
          )}
        </View>
      </Card>

      <Card>
        <CardTitle>Toplantı bilgileri</CardTitle>
        <Field label="Tarih ve saat" value={`${formatDateTime(a.scheduledAt)} (Türkiye saati)`} />
        <Field label="Yer" value={a.location ?? 'Çevrim içi'} />
        {a.onlineUrl && <OnlineLink label="Çevrim içi bağlantı" url={a.onlineUrl} />}
        <Field
          label="Çağrı"
          value={a.calledAt ? `${formatDateTime(a.calledAt)}${a.lastCalledAt && a.lastCalledAt !== a.calledAt ? ` (güncelleme ${formatDateTime(a.lastCalledAt)})` : ''}` : '—'}
        />
        {a.secondMeetingPlan && (
          <>
            <Field
              label="Yeter sayı sağlanamazsa ikinci toplantı"
              value={`${formatDateTime(a.secondMeetingPlan.scheduledAt)}${a.secondMeetingPlan.location ? ` · ${a.secondMeetingPlan.location}` : ''}`}
            />
            {a.secondMeetingPlan.onlineUrl && <OnlineLink label="İkinci toplantı çevrim içi bağlantısı" url={a.secondMeetingPlan.onlineUrl} />}
          </>
        )}
        {a.cancelReason && <Alert>{`Toplantı iptal edildi: ${a.cancelReason}`}</Alert>}
        <AppText variant="small" tone="muted">
          Toplantıya kendiniz katılabilir veya yazılı vekaletnameyle temsil edilebilirsiniz. E-posta ve bu sayfa bilgilendirme amaçlıdır; yasal çağrı yönetiminizce ayrıca yapılır (KMK m.29).
        </AppText>
      </Card>

      <Card>
        <CardTitle>{held ? 'Gündem ve kararlar' : 'Gündem'}</CardTitle>
        {held && q && (
          <Alert tone={q.met || q.secondMeeting ? 'success' : 'info'}>
            {q.secondMeeting
              ? 'İkinci toplantı: toplantı yeter sayısı aranmadı.'
              : q.met
                ? `Toplantı yeter sayısı sağlandı (${q.presentOwners}/${q.totalOwners} kat maliki).`
                : `Toplantı yeter sayısı sağlanamadı${q.noAttendance ? ' (katılım olmadı)' : ` (${q.presentOwners}/${q.totalOwners} kat maliki)`}; karar alınmadı.`}
          </Alert>
        )}
        <View style={styles.agenda} accessibilityLabel="Gündem maddeleri">
          {a.agenda.map((item, i) => (
            <View key={item.itemId} style={[styles.item, { borderColor: colors.border }]}>
              <View style={styles.itemHead}>
                <AppText weight="medium" style={styles.flex}>{`${i + 1}. ${item.title}`}</AppText>
                {item.decision && <Badge tone={item.decision.decision === 'accepted' ? 'success' : 'danger'} label={DECISION_LABELS[item.decision.decision]} />}
              </View>
              {item.description && (
                <AppText variant="small" tone="secondary" selectable>
                  {item.description}
                </AppText>
              )}
              <AppText variant="caption" tone="muted">{`Gerekli çoğunluk: ${MAJORITY_LABELS[item.majority]}`}</AppText>
              {item.decision && (
                <AppText variant="caption" tone="muted" tabular>
                  {`${decisionLine(item.decision)}${item.decision.corrected ? ' · karar kaydı düzeltildi' : ''}`}
                </AppText>
              )}
              {held && !item.decision && q && (q.met || q.secondMeeting) && (
                <AppText variant="caption" tone="muted">
                  Bu madde için karar kaydı yok.
                </AppText>
              )}
            </View>
          ))}
        </View>
      </Card>

      <Card>
        <CardTitle>Toplantı tutanağı</CardTitle>
        {a.minutesAvailable ? (
          <>
            <Button
              variant="secondary"
              icon={FileText}
              label="Tutanağı görüntüle (PDF)"
              accessibilityHint="Kısa süreli bağlantıyla sistem görüntüleyicisinde açar"
              loading={doc.pendingId === a.assemblyId}
              onPress={() => doc.open(a.assemblyId, () => assembliesApi.minutes(api, a.assemblyId))}
            />
            {doc.error && <Alert tone="danger">{doc.error}</Alert>}
          </>
        ) : (
          <AppText variant="small" tone="muted">
            {a.phase === 'cancelled' ? 'Toplantı iptal edildi.' : 'Tutanak, toplantıdan sonra yönetim tarafından kesinleştirildiğinde burada görünür.'}
          </AppText>
        )}
      </Card>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText variant="caption" tone="muted">
        {label}
      </AppText>
      <AppText variant="small">{value}</AppText>
    </View>
  );
}

/** Toplanti baglantisi uygulama ici tarayicida (web: yeni sekmede acilan baglanti). */
function OnlineLink({ label, url }: { label: string; url: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={styles.field}>
      <AppText variant="caption" tone="muted">
        {label}
      </AppText>
      <AppText variant="small" selectable>
        {url}
      </AppText>
      <Button
        variant="ghost"
        icon={ExternalLink}
        label="Bağlantıyı aç"
        accessibilityRole="link"
        accessibilityLabel={`${label}: bağlantıyı aç`}
        accessibilityHint="Uygulama içi tarayıcıda açar"
        onPress={() => {
          setError(null);
          openInAppBrowser(url).catch((err: unknown) => setError(errorMessage(err)));
        }}
      />
      {error && <Alert tone="danger">{error}</Alert>}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(2) },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space(1.5), flexShrink: 1 },
  field: { gap: 2 },
  agenda: { gap: space(3) },
  item: { gap: space(1.5), borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth * 2, paddingHorizontal: space(3), paddingVertical: space(2.5) },
  itemHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space(2) },
});
