import { errorMessage } from '@bm/shared/api/errors';
import {
  COMMENT_MAX,
  COMMENT_MIN,
  type ComparisonColumn,
  type Quote,
  TENDER_CATEGORY_LABELS,
  TENDER_STATUS_LABELS,
  TENDER_STATUS_TONES,
  type Tender,
  type TenderComment,
  comparisonColumns,
  formatBps,
  warrantyText,
} from '@bm/shared/api/tenders';
import { formatDate, formatDateTime } from '@bm/shared/dates';
import { formatTRY } from '@bm/shared/money';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CircleCheck, FileText, Trophy } from '@/components/icons';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { Alert, AppText, Badge, Button, Card, CardTitle, LoadingBlock, Screen, TextField } from '@/components/ui';
import { useSignedDocument } from '@/hooks/useSignedDocument';
import { useAskTenderQuestion, useIdempotencyKey, useMyTender } from '@/hooks/useTenders';
import { tendersApi } from '@/lib/api/tenders';
import { useServices } from '@/services';
import { radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

type Row = { label: string; value: (q: Quote, r: ComparisonColumn['row']) => string; strong?: boolean };

/** Karsilastirma satirlari (web: components/tenders/QuoteComparison.tsx ROWS ile ayni sira ve metin). */
const ROWS: Row[] = [
  { label: 'KDV dahil toplam', strong: true, value: (_q, r) => formatTRY(r.totalKurus) },
  { label: 'KDV hariç (matrah)', value: (_q, r) => formatTRY(r.netKurus) },
  { label: 'KDV', value: (q, r) => `${formatTRY(r.vatKurus)} (%${q.vatRate})` },
  { label: 'Teklifteki tutar', value: (q) => `${formatTRY(q.amountKurus)} ${q.vatIncluded ? 'KDV dahil' : '+ KDV'}` },
  { label: 'En düşüğe göre', value: (_q, r) => (r.diffKurus ? `+${formatTRY(r.diffKurus)} (${formatBps(r.diffBps)})` : '—') },
  { label: 'İş süresi', value: (q) => (q.deliveryDays !== undefined ? `${q.deliveryDays} gün` : '—') },
  { label: 'Garanti', value: (q) => (q.warrantyMonths === undefined ? '—' : q.warrantyMonths ? warrantyText(q.warrantyMonths) : 'Yok') },
  { label: 'Geçerlilik', value: (q) => (q.validUntil ? formatDate(q.validUntil) : '—') },
  { label: 'Not', value: (q) => q.notes ?? '—' },
];

/**
 * Sakin ihale ayrintisi (web: pages/resident/tenders/MyTenderDetailPage.tsx): teklifler yan yana
 * (KDV dahil toplama gore artan; dar ekranda her teklif bir kart), belgeler 5 dk imzali linkle sistem
 * goruntuleyicisinde, yonetimin karari, sorular (sakinler birbirinin kimligini gormez).
 */
export function TenderDetailScreen({ id }: { id: string }) {
  const detail = useMyTender(id);
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
        <LoadingBlock label="İhale yükleniyor" lines={5} />
      ) : detail.isError ? (
        <PortalQueryState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <Detail key={detail.data.tenderId} tender={detail.data} />
      )}
    </Screen>
  );
}

function Detail({ tender: t }: { tender: Tender }) {
  const { colors } = useTheme();
  const d = t.decision;

  return (
    <>
      <Card>
        <AppText variant="caption" tone="muted">
          {`${TENDER_CATEGORY_LABELS[t.category]}${t.publishedAt ? ` · Paylaşıldı: ${formatDateTime(t.publishedAt)}` : ''}`}
        </AppText>
        <AppText variant="heading" weight="semibold" accessibilityRole="header">
          {t.title}
        </AppText>
        <View style={styles.meta}>
          <Badge tone={TENDER_STATUS_TONES[t.status]} label={TENDER_STATUS_LABELS[t.status]} />
          <AppText variant="small" tone="muted" tabular>
            {`${t.quoteCount} teklif${t.lowestTotalKurus !== undefined ? ` · en düşük ${formatTRY(t.lowestTotalKurus)}` : ''}`}
          </AppText>
        </View>
        <View style={[styles.description, { backgroundColor: colors.surfaceMuted }]}>
          <AppText variant="small" selectable>
            {t.description}
          </AppText>
        </View>
      </Card>

      {d && (
        <Card style={{ borderColor: withAlpha(colors.success, 0.3) }}>
          <View style={styles.decision}>
            <CircleCheck size={20} color={colors.success} aria-hidden style={styles.iconTop} />
            <View style={styles.flexGap}>
              <AppText variant="heading" weight="semibold" accessibilityRole="header">
                {`Yönetimin kararı: ${d.supplierName} · ${formatTRY(d.totalKurus)}`}
              </AppText>
              <AppText variant="caption" tone="muted">
                {`${formatDateTime(d.decidedAt)}${t.comparison.lowestQuoteIds.includes(d.quoteId) ? ' · En düşük teklif' : ' · En düşük teklif seçilmedi'}`}
              </AppText>
              <AppText variant="small" selectable>
                {d.reason}
              </AppText>
              {d.reference && (
                <AppText variant="small" tone="muted">
                  {`Karar referansı: ${d.reference}`}
                </AppText>
              )}
            </View>
          </View>
        </Card>
      )}
      {t.shortfallReason && <Alert>{`${t.minQuotes} teklif hedeflenmişti, ${t.quoteCount} teklif alındı. Yönetimin açıklaması: ${t.shortfallReason}`}</Alert>}
      {t.status === 'cancelled' && <Alert tone="danger">{`İhale iptal edildi. Gerekçe: ${t.cancelReason ?? '—'}`}</Alert>}

      <Quotes tender={t} />
      <Questions tender={t} />
    </>
  );
}

function Quotes({ tender: t }: { tender: Tender }) {
  const { colors } = useTheme();
  const { api } = useServices();
  const doc = useSignedDocument();
  const { columns, withdrawn } = comparisonColumns(t);
  const selectedId = t.decision?.quoteId;
  const openDoc = (quoteId: string) => doc.open(quoteId, () => tendersApi.document(api, t.tenderId, quoteId));

  return (
    <Card>
      <CardTitle>Teklifler yan yana</CardTitle>
      <AppText variant="caption" tone="muted">
        KDV dahil / hariç verilen teklifler aynı ölçüye (KDV dahil toplam) çevrildi. Belgeler kısa süreli bağlantıyla açılır.
      </AppText>
      {doc.error && <Alert tone="danger">{doc.error}</Alert>}

      {!columns.length && !withdrawn.length ? (
        <AppText variant="small" tone="muted">
          Henüz teklif eklenmedi.
        </AppText>
      ) : (
        <View style={styles.quotes} accessibilityLabel="Teklif karşılaştırması (KDV dahil toplama göre sıralı)">
          {columns.map(({ quote: q, row: r }) => (
            <View
              key={q.quoteId}
              style={[styles.quote, r.isLowest ? { borderColor: withAlpha(colors.success, 0.3), backgroundColor: withAlpha(colors.success, 0.1) } : { borderColor: colors.border }]}
            >
              <View style={styles.quoteHead}>
                <AppText weight="semibold" accessibilityRole="header">
                  {q.supplierName}
                </AppText>
                <View style={styles.meta}>
                  {r.isLowest && <Badge tone="success" icon={Trophy} label="En düşük" />}
                  {selectedId === q.quoteId && <Badge tone="accent" label="Seçilen teklif" />}
                  {!r.isLowest && (
                    <AppText variant="caption" tone="muted">
                      {`${r.rank}. sırada`}
                    </AppText>
                  )}
                </View>
              </View>
              {ROWS.map((row) => {
                const value = row.value(q, r);
                return (
                  <View key={row.label} style={styles.pair} accessible accessibilityLabel={`${row.label}: ${value}`}>
                    <AppText variant="caption" tone="muted" style={styles.pairLabel}>
                      {row.label}
                    </AppText>
                    <AppText variant={row.strong ? 'body' : 'small'} weight={row.strong ? 'semibold' : 'regular'} tabular style={styles.pairValue}>
                      {value}
                    </AppText>
                  </View>
                );
              })}
              {q.document ? (
                <Button
                  variant="secondary"
                  icon={FileText}
                  label="Teklifi aç"
                  accessibilityLabel={`${q.supplierName} teklif belgesini aç`}
                  accessibilityHint="Kısa süreli bağlantıyla sistem görüntüleyicisinde açar"
                  loading={doc.pendingId === q.quoteId}
                  onPress={() => openDoc(q.quoteId)}
                />
              ) : (
                <AppText variant="caption" tone="muted">
                  Belge yok
                </AppText>
              )}
            </View>
          ))}

          {withdrawn.length > 0 && (
            <View style={styles.withdrawn}>
              <AppText variant="small" weight="semibold" accessibilityRole="header">
                Geri çekilen teklifler
              </AppText>
              {withdrawn.map((q) => (
                <View key={q.quoteId} style={[styles.withdrawnRow, { borderColor: colors.border, backgroundColor: colors.surfaceMuted }]}>
                  <AppText variant="small" weight="medium">
                    {q.supplierName}
                  </AppText>
                  <AppText variant="small" tone="muted" tabular>
                    {`${formatTRY(q.totalKurus)} KDV dahil${q.withdrawReason ? ` · ${q.withdrawReason}` : ''}`}
                  </AppText>
                  {q.withdrawnAt && (
                    <AppText variant="caption" tone="muted">
                      {formatDateTime(q.withdrawnAt)}
                    </AppText>
                  )}
                  {q.document && (
                    <Button
                      variant="ghost"
                      icon={FileText}
                      label="Belge"
                      accessibilityLabel={`${q.supplierName} geri çekilen teklif belgesini aç`}
                      loading={doc.pendingId === q.quoteId}
                      onPress={() => openDoc(q.quoteId)}
                    />
                  )}
                </View>
              ))}
            </View>
          )}
        </View>
      )}
    </Card>
  );
}

const authorLabel = (c: TenderComment) => (c.mine ? 'Siz' : c.authorKind === 'management' ? 'Yönetim' : 'Sakin');

/**
 * Sorular ve yanitlar (web: components/tenders/TenderComments.tsx, sakin gorunumu): yayindaki ihaleye
 * kisa soru; diger sakinler soruyu adsiz gorur ("Sakin"), yonetim yanitlar. Ayni gonderim ayni
 * idempotency anahtariyla tekrarlanir; basarida anahtar yenilenir.
 */
function Questions({ tender: t }: { tender: Tender }) {
  const { colors } = useTheme();
  const ask = useAskTenderQuestion(t.tenderId);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [key, renewKey] = useIdempotencyKey();
  const text = body.trim();

  const submit = async () => {
    if (text.length < COMMENT_MIN) {
      setError('Mesaj en az 3 karakter olmalı.');
      return;
    }
    setError(null);
    try {
      await ask.mutateAsync({ idempotencyKey: key, body: text });
      setBody('');
      renewKey();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Card>
      <CardTitle>Sorular ve yanıtlar</CardTitle>
      {t.comments.length ? (
        <View style={styles.comments}>
          {t.comments.map((c) => (
            <View
              key={c.commentId}
              style={[
                styles.comment,
                c.authorKind === 'management'
                  ? { borderColor: withAlpha(colors.accent, 0.3), backgroundColor: withAlpha(colors.accent, 0.05) }
                  : { borderColor: colors.border, backgroundColor: colors.surface },
              ]}
              accessible
              accessibilityLabel={`${authorLabel(c)}, ${formatDateTime(c.createdAt)}: ${c.body}`}
            >
              <View style={styles.commentHead}>
                <Badge tone={c.authorKind === 'management' ? 'accent' : 'neutral'} label={authorLabel(c)} />
                <AppText variant="caption" tone="muted">
                  {formatDateTime(c.createdAt)}
                </AppText>
              </View>
              <AppText variant="small">{c.body}</AppText>
            </View>
          ))}
        </View>
      ) : (
        <AppText variant="small" tone="muted">
          Henüz soru yok.
        </AppText>
      )}

      {t.canComment ? (
        <View style={styles.form}>
          <TextField
            label="Sorunuz"
            value={body}
            onChangeText={setBody}
            multiline
            maxLength={COMMENT_MAX}
            error={error ?? undefined}
            textAlignVertical="top"
            autoCorrect
          />
          <AppText variant="caption" tone="muted">
            Diğer sakinler sorunuzu adınız olmadan görür.
          </AppText>
          <View style={styles.formFoot}>
            <AppText variant="caption" tone="muted" tabular accessibilityLabel={`${text.length} / ${COMMENT_MAX} karakter`}>
              {`${text.length}/${COMMENT_MAX}`}
            </AppText>
            <Button label="Soruyu gönder" loading={ask.isPending} disabled={!text} onPress={() => void submit()} />
          </View>
        </View>
      ) : (
        <AppText variant="caption" tone="muted">
          Sorular yalnızca ihale sakinlerle paylaşıldıktan sonra ve karar verilene kadar yazılabilir.
        </AppText>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(2) },
  description: { borderRadius: radii.lg, padding: space(3) },
  decision: { flexDirection: 'row', alignItems: 'flex-start', gap: space(3) },
  iconTop: { marginTop: 3 },
  flexGap: { flex: 1, gap: space(1) },
  quotes: { gap: space(3) },
  quote: { gap: space(2), borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth * 2, padding: space(3) },
  quoteHead: { gap: space(1) },
  pair: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space(3) },
  pairLabel: { flexShrink: 0, paddingTop: 2 },
  pairValue: { flex: 1, textAlign: 'right' },
  withdrawn: { gap: space(2) },
  withdrawnRow: { gap: space(1), borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth * 2, paddingHorizontal: space(3), paddingVertical: space(2) },
  comments: { gap: space(2) },
  comment: { gap: space(1), borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth * 2, paddingHorizontal: space(3), paddingVertical: space(2) },
  commentHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: space(2) },
  form: { gap: space(2) },
  formFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space(2) },
});
