import { formatDate } from '@bm/shared/dates';
import { WEEKDAYS, addDays, weekdayOf } from '@bm/shared/reservations/model';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { CalendarDays, ChevronLeft, ChevronRight } from '@/components/icons';
import { AppText, Button } from '@/components/ui';
import { MIN_TOUCH, radii, space, typeScale } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { Sheet } from './Sheet';

type Props = {
  label: string;
  /** "YYYY-AA-GG" (Istanbul takvim gunu); bos: secilmedi. */
  value: string;
  onChange: (date: string) => void;
  /** Secilebilecek ilk ve son gun (dahil). */
  min?: string;
  max?: string;
  /** Istege bagli alan: "Temizle" ile bosaltilir. */
  onClear?: () => void;
  placeholder?: string;
  hint?: string;
  error?: string;
};

const monthOf = (date: string) => date.slice(0, 7);
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const monthTitle = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
/** "4 Aralık 2026 Cuma" (ekran okuyucu). */
const longDate = (date: string) => `${new Date(`${date}T00:00:00Z`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })} ${WEEKDAYS[weekdayOf(date) - 1]?.label ?? ''}`;

/** Ayin gunleri, Pazartesi'den baslayan haftalar (ay disi hucreler bos). */
function monthGrid(month: string): (string | null)[] {
  const first = `${month}-01`;
  const lead = weekdayOf(first) - 1;
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = first; monthOf(d) === month; d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(null);
  return cells;
}

/**
 * Tarih alani (web: `<input type="date">`): etiketli alan secili gunu gosterir, dokununca alttan ay
 * takvimi acilir; `min` / `max` disindaki gunler secilemez. Yerel tarih secici paketi yoktur (web
 * onizlemesinde de ayni bilesen calisir).
 */
export function DateField({ label, value, onChange, min, max, onClear, placeholder = 'Tarih seçin', hint, error }: Props) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(monthOf(value || min || new Date().toISOString().slice(0, 10)));
  const cells = monthGrid(month);
  const canPrev = !min || shiftMonth(month, -1) >= monthOf(min);
  const canNext = !max || shiftMonth(month, 1) <= monthOf(max);
  const disabled = (d: string) => (!!min && d < min) || (!!max && d > max);
  const borderColor = error ? colors.danger : colors.borderStrong;

  return (
    <View style={styles.field}>
      <AppText variant="small" weight="medium">
        {label}
      </AppText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value ? longDate(value) : placeholder}`}
        accessibilityHint={error ?? hint ?? 'Takvimi açar'}
        onPress={() => {
          setMonth(monthOf(value || min || month));
          setOpen(true);
        }}
        style={({ pressed }) => [styles.input, { borderColor, backgroundColor: pressed ? colors.surfaceMuted : colors.surface }]}
      >
        <AppText style={[styles.flex, typeScale.body]} tone={value ? 'text' : 'muted'}>
          {value ? formatDate(value) : placeholder}
        </AppText>
        <CalendarDays size={20} color={colors.muted} aria-hidden />
      </Pressable>
      {error ? (
        <AppText variant="small" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : hint ? (
        <AppText variant="small" tone="muted">
          {hint}
        </AppText>
      ) : null}

      <Sheet open={open} title={label} onClose={() => setOpen(false)}>
        <View style={styles.monthRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Önceki ay"
            accessibilityState={{ disabled: !canPrev }}
            disabled={!canPrev}
            onPress={() => setMonth(shiftMonth(month, -1))}
            style={[styles.nav, !canPrev && styles.dim]}
          >
            <ChevronLeft size={22} color={colors.text} aria-hidden />
          </Pressable>
          <AppText weight="semibold" style={styles.monthTitle} accessibilityRole="header">
            {monthTitle(month)}
          </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sonraki ay"
            accessibilityState={{ disabled: !canNext }}
            disabled={!canNext}
            onPress={() => setMonth(shiftMonth(month, 1))}
            style={[styles.nav, !canNext && styles.dim]}
          >
            <ChevronRight size={22} color={colors.text} aria-hidden />
          </Pressable>
        </View>
        <View style={styles.grid}>
          {WEEKDAYS.map((w) => (
            <View key={w.day} style={styles.cell} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
              <AppText variant="caption" tone="muted" weight="medium">
                {w.short}
              </AppText>
            </View>
          ))}
          {cells.map((d, i) =>
            d ? (
              <Pressable
                key={d}
                accessibilityRole="button"
                accessibilityLabel={longDate(d)}
                accessibilityState={{ selected: d === value, disabled: disabled(d) }}
                disabled={disabled(d)}
                onPress={() => {
                  onChange(d);
                  setOpen(false);
                }}
                style={({ pressed }) => [
                  styles.cell,
                  styles.day,
                  d === value ? { backgroundColor: colors.accent } : pressed ? { backgroundColor: colors.surfaceMuted } : null,
                  disabled(d) && styles.dim,
                ]}
              >
                <AppText variant="small" weight={d === value ? 'semibold' : 'regular'} tabular style={d === value ? { color: colors.onAccent } : undefined}>
                  {String(Number(d.slice(8)))}
                </AppText>
              </Pressable>
            ) : (
              <View key={`e${i}`} style={styles.cell} />
            ),
          )}
        </View>
        <View style={styles.actions}>
          {onClear && value ? (
            <Button
              variant="secondary"
              label="Temizle"
              onPress={() => {
                onClear();
                setOpen(false);
              }}
            />
          ) : null}
          <Button variant="ghost" label="Vazgeç" onPress={() => setOpen(false)} />
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: space(1.5) },
  flex: { flex: 1 },
  input: { minHeight: MIN_TOUCH + 4, flexDirection: 'row', alignItems: 'center', gap: space(2), paddingHorizontal: space(3), borderRadius: radii.md, borderWidth: 1 },
  monthRow: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  monthTitle: { flex: 1, textAlign: 'center' },
  nav: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center', borderRadius: radii.full },
  dim: { opacity: 0.35 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  day: { borderRadius: radii.full },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space(2) },
});
