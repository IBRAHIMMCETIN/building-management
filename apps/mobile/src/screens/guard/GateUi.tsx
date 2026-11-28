import { errorMessage } from '@bm/shared/api/errors';
import type { Courier, GateLogEntry } from '@bm/shared/api/gate';
import { formatDateTime } from '@bm/shared/dates';
import { COURIER_TEXT, DIRECTION_TEXT, LOG_KIND_TEXT, type PassVerdict, VERDICT_TEXT, courierState } from '@bm/shared/gate/plate';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Check, LogIn, LogOut } from '@/components/icons';
import { Alert, AppText, Badge, Button, Skeleton, TextField } from '@/components/ui';
import { useGateUnits } from '@/hooks/useGate';
import { MIN_TOUCH, radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/* Kapi ekranlarinin ortak parcalari (web: components/gate/GateUi.tsx, pages/admin/gate/shared.tsx). */

export function VerdictBadge({ verdict }: { verdict: PassVerdict }) {
  const v = VERDICT_TEXT[verdict];
  return <Badge tone={v.tone} label={v.label} />;
}

export function CourierBadge({ courier }: { courier: Pick<Courier, 'status' | 'expired' | 'approvalExpired' | 'enteredAt' | 'exitedAt'> }) {
  const c = COURIER_TEXT[courierState(courier)];
  return <Badge tone={c.tone} label={c.label} />;
}

/** Kapi gunlugu satiri. */
export function LogRow({ e }: { e: GateLogEntry }) {
  const { colors } = useTheme();
  const Icon = e.direction === 'entry' ? LogIn : LogOut;
  const who = e.visitorName ?? e.company ?? LOG_KIND_TEXT[e.kind] ?? '';
  const place = `${e.unitLabel ?? 'Bağımsız bölüm yok'}${e.plateDisplay ? ` · ${e.plateDisplay}` : ''}${e.kind === 'courier' && e.company && e.visitorName ? ` · ${e.company}` : ''}`;
  const when = `${formatDateTime(e.at)}${e.recordedByName ? ` · ${e.recordedByName}` : ''}`;
  return (
    <View
      accessible
      accessibilityLabel={`${who}, ${DIRECTION_TEXT[e.direction]}, ${LOG_KIND_TEXT[e.kind]}, ${place}${e.note ? `, ${e.note}` : ''}, ${when}`}
      style={[styles.logRow, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <Icon size={20} color={e.direction === 'entry' ? colors.success : colors.muted} aria-hidden style={styles.iconTop} />
      <View style={styles.flex}>
        <View style={styles.wrap}>
          <AppText weight="medium">{who}</AppText>
          <Badge tone={e.direction === 'entry' ? 'success' : 'neutral'} label={DIRECTION_TEXT[e.direction] ?? ''} />
          <AppText variant="caption" tone="muted">
            {LOG_KIND_TEXT[e.kind] ?? ''}
          </AppText>
        </View>
        <AppText variant="small" tone="secondary">
          {place}
        </AppText>
        {e.note && (
          <AppText variant="small" tone="muted">
            {e.note}
          </AppText>
        )}
        <AppText variant="caption" tone="muted">
          {when}
        </AppText>
      </View>
    </View>
  );
}

/** Kalan saniye (0'a inince durur); `until` epoch ms. */
export function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Deneme siniri (429): API mesaji + geri sayim; sure dolunca kaybolur. */
export function RateLimitNotice({ message, seconds }: { message: string; seconds: number }) {
  if (seconds <= 0) return null;
  return <Alert tone="danger">{`${message} Kalan süre: ${mmss(seconds)}.`}</Alert>;
}

/**
 * Bagimsiz bolum secimi: once arama (blok / daire no), sonra listeden secim (API en fazla 50 bolum,
 * yalnizca etiket; web: pages/admin/gate/shared.tsx UnitPicker). Secili oge isaretli ve "secili" okunur.
 */
export function GateUnitSelect({
  label,
  value,
  onChange,
  optional,
}: {
  label: string;
  value: { unitId: string; label: string } | null;
  onChange: (unit: { unitId: string; label: string } | null) => void;
  optional?: boolean;
}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const units = useGateUnits(debounced);
  const items = (units.data ?? []).slice(0, 8);

  return (
    <View style={styles.gap2}>
      <AppText variant="small" weight="medium">
        {label}
      </AppText>
      <TextField label="Bağımsız bölüm ara" placeholder="Blok veya daire no ile ara" value={q} onChangeText={setQ} autoCapitalize="characters" returnKeyType="search" />
      {value && (
        <AppText variant="small" tone="accent" weight="medium" accessibilityLiveRegion="polite">
          {`Seçili: ${value.label}`}
        </AppText>
      )}
      {units.isPending ? (
        <View accessible accessibilityRole="progressbar" accessibilityLabel="Bölümler yükleniyor" style={styles.gap2}>
          <Skeleton height={MIN_TOUCH} />
          <Skeleton height={MIN_TOUCH} />
        </View>
      ) : units.isError ? (
        <View style={styles.gap2}>
          <Alert tone="danger">{errorMessage(units.error)}</Alert>
          <Button variant="secondary" label="Tekrar dene" onPress={() => void units.refetch()} />
        </View>
      ) : items.length === 0 ? (
        <AppText variant="small" tone="muted">
          Aramaya uyan bölüm yok.
        </AppText>
      ) : (
        <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.options}>
          {optional && <UnitOption label="Bağımsız bölüm yok" selected={!value} onPress={() => onChange(null)} />}
          {items.map((u) => (
            <UnitOption key={u.unitId} label={u.label} selected={value?.unitId === u.unitId} onPress={() => onChange(u)} />
          ))}
        </View>
      )}
      {!units.isPending && (units.data?.length ?? 0) > items.length && (
        <AppText variant="caption" tone="muted">
          Daha fazla sonuç var; aramayı daraltın.
        </AppText>
      )}
    </View>
  );
}

function UnitOption({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        { borderColor: selected ? colors.accent : colors.border, backgroundColor: pressed || selected ? colors.surfaceMuted : colors.surface },
      ]}
    >
      <AppText weight={selected ? 'semibold' : 'regular'} style={styles.flex}>
        {label}
      </AppText>
      {selected && <Check size={18} color={colors.accent} aria-hidden />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap2: { gap: space(2) },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(2) },
  iconTop: { marginTop: 2 },
  logRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space(3), borderRadius: radii.xl, borderWidth: StyleSheet.hairlineWidth * 2, padding: space(3) },
  options: { gap: space(1.5) },
  option: {
    minHeight: MIN_TOUCH + 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    paddingHorizontal: space(3),
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
});
