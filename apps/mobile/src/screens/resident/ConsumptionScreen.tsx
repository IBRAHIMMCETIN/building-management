import { CATEGORY_LABELS, type PortalPeriod, type TemplateCategory, formatConsumption, formatPercentChange, versusAverage } from '@bm/shared/api/meters';
import { formatDate } from '@bm/shared/dates';
import { formatTRY } from '@bm/shared/money';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { FileDown, Gauge } from '@/components/icons';
import { BarTrack } from '@/components/portal/BarTrack';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { StatTile } from '@/components/portal/StatTile';
import { Alert, AppText, Badge, Button, Card, CardTitle, EmptyState, LoadingBlock, Screen, type AppTextProps } from '@/components/ui';
import { usePortalUnit } from '@/context/PortalUnitProvider';
import { useMyConsumption } from '@/hooks/useConsumption';
import { useMySummary } from '@/hooks/usePortal';
import { useSignedDocument } from '@/hooks/useSignedDocument';
import { metersApi } from '@/lib/api/meters';
import { useServices } from '@/services';
import { MIN_TOUCH, radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/** Ortalamaya gore fark rengi (web ile ayni esik: %10). */
const diffTone = (v: number | null): NonNullable<AppTextProps['tone']> => (v === null ? 'muted' : v > 10 ? 'warning' : v < -10 ? 'success' : 'muted');

/**
 * Tüketimim (web: pages/resident/ConsumptionPage.tsx): dairenin donem donem sayac tuketimi, ortak /
 * tuketim payi ayrimi, bina ve blok ortalamasiyla karsilastirma ve "Sayaç Dağıtım Dökümü" PDF'i
 * (5 dk imzali link, sistem goruntuleyicisinde). Daire: secili daire, yoksa borc ozetindeki daire.
 */
export function ConsumptionScreen() {
  const { unitId: selected } = usePortalUnit();
  const summary = useMySummary();
  const unitId = selected ?? summary.data?.unitId;
  const history = useMyConsumption(unitId);
  const { api } = useServices();
  const doc = useSignedDocument();
  const [category, setCategory] = useState<TemplateCategory | ''>('');
  const [refreshing, setRefreshing] = useState(false);

  const periods = useMemo(() => history.data?.periods ?? [], [history.data]);
  const categories = useMemo(() => [...new Set(periods.map((p) => p.category))], [periods]);
  const active = category && categories.includes(category) ? category : (categories[0] ?? '');
  const list = periods.filter((p) => p.category === active);
  const latest = list[0];

  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([summary.refetch(), unitId ? history.refetch() : undefined]);
    } finally {
      setRefreshing(false);
    }
  };

  const intro = (
    <AppText variant="small" tone="muted">
      Isınma ve su giderinin sayacınıza göre dağıtımı.
    </AppText>
  );

  if (!unitId && summary.isError) {
    return (
      <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
        {intro}
        <PortalQueryState error={summary.error} onRetry={() => void summary.refetch()} />
      </Screen>
    );
  }

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      {intro}
      {history.isPending || !unitId ? (
        <LoadingBlock label="Tüketim yükleniyor" lines={4} />
      ) : history.isError ? (
        <PortalQueryState error={history.error} onRetry={() => void history.refetch()} />
      ) : periods.length === 0 ? (
        <EmptyState
          icon={Gauge}
          title="Henüz onaylanmış bir sayaç dağıtım dönemi yok"
          description="Yönetiminiz ısınma veya su giderini sayaçlara göre dağıttığında dönemleriniz burada görünecek."
        />
      ) : (
        <>
          {categories.length > 1 && <CategoryChips value={active as TemplateCategory} options={categories} onChange={setCategory} />}
          {latest && <Comparison period={latest} />}
          {list.length > 1 && <Trend periods={list} />}
          {doc.error && <Alert tone="danger">{doc.error}</Alert>}
          {list.map((p) => (
            <PeriodCard key={p.periodId} period={p} loading={doc.pendingId === p.periodId} onPdf={() => doc.open(p.periodId, () => metersApi.statement(api, p.periodId, unitId))} />
          ))}
        </>
      )}
    </Screen>
  );
}

/** Gider turu secimi (web: FilterChips "Gider türü"); tek secim. Gorunen en az 36 pt, dokunma alani 44 pt (UnitPicker gibi). */
function CategoryChips({ value, options, onChange }: { value: TemplateCategory; options: TemplateCategory[]; onChange: (c: TemplateCategory) => void }) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Gider türü" style={styles.chips}>
      {options.map((c) => {
        const on = c === value;
        return (
          <Pressable
            key={c}
            accessibilityRole="radio"
            accessibilityLabel={CATEGORY_LABELS[c]}
            accessibilityState={{ checked: on }}
            hitSlop={{ top: 4, bottom: 4 }}
            onPress={() => onChange(c)}
            style={({ pressed }) => [
              styles.chip,
              { borderColor: on ? colors.accent : colors.borderStrong, backgroundColor: on ? withAlpha(colors.accent, 0.1) : pressed ? colors.surfaceMuted : colors.surface },
            ]}
          >
            <AppText variant="small" weight="medium" tone={on ? 'accent' : 'text'}>
              {CATEGORY_LABELS[c]}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

function Comparison({ period: p }: { period: PortalPeriod }) {
  const vsBuilding = p.hasMeter ? versusAverage(p.consumption, p.buildingAverage) : null;
  const vsBlock = p.hasMeter && p.blockAverage !== undefined ? versusAverage(p.consumption, p.blockAverage) : null;
  const mine = p.hasMeter ? formatConsumption(p.consumption) : '—';
  const previous = p.previous ? `Önceki döneme göre ${p.previous.percent !== undefined ? formatPercentChange(p.previous.percent) : formatConsumption(p.previous.diff)}` : null;

  return (
    <View style={styles.grid}>
      <Card style={styles.wide}>
        <View accessible accessibilityLabel={`Sizin tüketiminiz, ${p.name}: ${mine}${previous ? `. ${previous}` : ''}`} style={styles.gap1}>
          <AppText variant="small" tone="muted">{`Sizin tüketiminiz · ${p.name}`}</AppText>
          <AppText variant="title" weight="bold" tabular>
            {mine}
          </AppText>
          {previous && p.previous && (
            <AppText variant="small" tone={p.previous.diff > 0 ? 'warning' : 'success'}>
              {previous}
            </AppText>
          )}
        </View>
        {p.estimated && <Badge tone="accent" label="Tahmini okuma" />}
      </Card>
      <Average label="Bina ortalaması" value={p.buildingAverage} diff={vsBuilding} footnote={`${p.meteredUnits} sayaçlı daire`} />
      {p.blockAverage !== undefined && <Average label="Blok ortalaması" value={p.blockAverage} diff={vsBlock} />}
    </View>
  );
}

function Average({ label, value, diff, footnote }: { label: string; value: number; diff: number | null; footnote?: string }) {
  const text = formatConsumption(value);
  return (
    <Card style={styles.half}>
      <View accessible accessibilityLabel={`${label}: ${text}${diff !== null ? `. Siz: ${formatPercentChange(diff)}` : ''}${footnote ? `. ${footnote}` : ''}`} style={styles.gap1}>
        <AppText variant="small" tone="muted">
          {label}
        </AppText>
        <AppText variant="heading" weight="semibold" tabular>
          {text}
        </AppText>
        {diff !== null && (
          <AppText variant="small" tone={diffTone(diff)}>
            {`Siz: ${formatPercentChange(diff)}`}
          </AppText>
        )}
        {footnote && (
          <AppText variant="small" tone="muted">
            {footnote}
          </AppText>
        )}
      </View>
    </Card>
  );
}

/** Donem donem tuketim (yatay cubuk; en yuksek deger = tam cubuk, cizgi bina ortalamasi). */
function Trend({ periods }: { periods: PortalPeriod[] }) {
  const { colors } = useTheme();
  const max = Math.max(...periods.map((p) => Math.max(p.consumption, p.buildingAverage)), 0);
  if (!(max > 0)) return null;
  return (
    <Card>
      <CardTitle>Dönem dönem tüketim</CardTitle>
      <View style={styles.trend}>
        {periods.map((p) => {
          const value = p.hasMeter ? formatConsumption(p.consumption) : '—';
          return (
            <View key={p.periodId} style={styles.trendRow} accessible accessibilityLabel={`${p.name}: ${value}, bina ortalaması ${formatConsumption(p.buildingAverage)}`}>
              <AppText variant="small" tone="muted" numberOfLines={1} style={styles.trendName}>
                {p.name}
              </AppText>
              <View style={styles.flex}>
                <BarTrack height={12} segments={[{ fraction: p.consumption / max, color: colors.accent }]} marker={p.buildingAverage / max} />
              </View>
              <AppText variant="small" tabular style={styles.trendValue}>
                {value}
              </AppText>
            </View>
          );
        })}
      </View>
      <AppText variant="small" tone="muted">
        Çizgi: bina ortalaması.
      </AppText>
    </Card>
  );
}

function PeriodCard({ period: p, loading, onPdf }: { period: PortalPeriod; loading: boolean; onPdf: () => void }) {
  const { colors } = useTheme();
  const common = p.amount > 0 ? p.commonAmount / p.amount : 0;
  const total = p.consumptionText ? formatConsumption(p.consumptionText) : formatConsumption(p.consumption);

  return (
    <Card>
      <View style={styles.between}>
        <View style={styles.flex}>
          <AppText weight="semibold" accessibilityRole="header">
            {p.name}
          </AppText>
          <AppText variant="small" tone="muted">
            {`${CATEGORY_LABELS[p.category]} · ${formatDate(p.startDate)} – ${formatDate(p.endDate)} · son ödeme ${formatDate(p.dueDate)}`}
          </AppText>
        </View>
        <AppText variant="heading" weight="bold" tabular accessibilityLabel={`Tutar ${formatTRY(p.amount)}`}>
          {formatTRY(p.amount)}
        </AppText>
      </View>

      <BarTrack
        segments={[
          { fraction: common, color: withAlpha(colors.accent, 0.5) },
          { fraction: 1 - common, color: colors.accent },
        ]}
      />
      <View style={styles.stats}>
        <StatTile label="Ortak pay" value={formatTRY(p.commonAmount)} />
        <StatTile label="Tüketim payı" value={formatTRY(p.consumptionAmount)} />
      </View>

      {p.hasMeter ? (
        <View style={styles.meters}>
          {p.meters.map((m) => {
            const delta = m.delta !== undefined ? formatConsumption(m.delta) : '—';
            return (
              <View key={m.meterId} style={styles.between} accessible accessibilityLabel={`${m.label}: ${delta}`}>
                <View style={styles.inline}>
                  <Gauge size={14} color={colors.muted} aria-hidden />
                  <AppText variant="small" tone="muted">
                    {m.label}
                  </AppText>
                </View>
                <AppText variant="small" tabular>
                  {delta}
                </AppText>
              </View>
            );
          })}
          <View style={[styles.between, styles.total, { borderTopColor: colors.border }]} accessible accessibilityLabel={`Toplam tüketim: ${total}`}>
            <AppText variant="small" weight="medium">
              Toplam tüketim
            </AppText>
            <AppText variant="small" weight="medium" tabular>
              {total}
            </AppText>
          </View>
        </View>
      ) : (
        <AppText variant="small" tone="muted">
          Dairenizde sayaç olmadığı için yalnızca ortak pay yansıtıldı.
        </AppText>
      )}
      {p.estimated && (
        <AppText variant="small" tone="accent">
          Bu dönem okuma yapılamadığı için yönetici onaylı tahmini endeks kullanıldı.
        </AppText>
      )}

      <Button
        variant="secondary"
        icon={FileDown}
        label="Sayaç Dağıtım Dökümü (PDF)"
        accessibilityLabel={`${p.name} Sayaç Dağıtım Dökümü (PDF)`}
        accessibilityHint="Kısa süreli bağlantıyla sistem görüntüleyicisinde açar"
        loading={loading}
        onPress={onPdf}
      />
    </Card>
  );
}


const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap1: { gap: space(1) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  chip: { minHeight: MIN_TOUCH - 8, justifyContent: 'center', borderRadius: radii.full, borderWidth: StyleSheet.hairlineWidth * 2, paddingHorizontal: space(4), paddingVertical: space(1.5) },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space(3) },
  wide: { flexBasis: '100%' },
  half: { flexGrow: 1, flexBasis: '45%' },
  trend: { gap: space(2) },
  trendRow: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  trendName: { width: space(24) },
  trendValue: { minWidth: space(12), textAlign: 'right' },
  between: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space(3) },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: space(3) },
  meters: { gap: space(1) },
  total: { borderTopWidth: StyleSheet.hairlineWidth * 2, paddingTop: space(1) },
});
