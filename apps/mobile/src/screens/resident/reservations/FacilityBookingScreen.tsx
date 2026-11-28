import { errorMessage } from '@bm/shared/api/errors';
import type { PortalFacility, PortalUnit, SlotState } from '@bm/shared/api/reservations';
import { formatDate } from '@bm/shared/dates';
import { formatTRY } from '@bm/shared/money';
import { addClock, addDays, dayLabel, durationOptions, formatMinutes, hoursSummary } from '@bm/shared/reservations/model';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { CalendarCheck, SearchX } from '@/components/icons';
import { DateField } from '@/components/portal/DateField';
import { FilterChips } from '@/components/portal/FilterChips';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { Alert, AppText, Button, Card, EmptyState, LoadingBlock, Screen, Skeleton, TextField } from '@/components/ui';
import { usePortalUnit } from '@/context/PortalUnitProvider';
import { useAvailability, useCreateBooking, usePortalFacilities } from '@/hooks/useReservations';
import { useIdempotencyKey } from '@/lib/idempotency';
import { MIN_TOUCH, radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

const SLOT_TEXT: Record<SlotState, string> = { free: 'Boş', busy: 'Dolu', mine: 'Sizin', past: 'Geçti' };

/**
 * Ortak alanda tarih -> bos dilim -> sure -> onay (web: MyReservationsPage `SlotPicker`). Alan listesi
 * onceki ekranin sorgusundan (ayni onbellek) okunur. Onaylaninca Rezervasyonlarım'a sonucla donulur.
 */
export function FacilityBookingScreen({ facilityId }: { facilityId: string }) {
  const facilities = usePortalFacilities();

  if (facilities.isPending) {
    return (
      <Screen>
        <LoadingBlock label="Ortak alan yükleniyor" />
      </Screen>
    );
  }
  if (facilities.isError) {
    return (
      <Screen>
        <PortalQueryState error={facilities.error} onRetry={() => void facilities.refetch()} />
      </Screen>
    );
  }
  const { items, units, today } = facilities.data;
  const facility = items.find((f) => f.facilityId === facilityId);
  if (!facility) {
    return (
      <Screen>
        <EmptyState icon={SearchX} title="Ortak alan bulunamadı" description="Bu alan artık rezervasyona açık değil." />
      </Screen>
    );
  }
  return <SlotPicker facility={facility} units={units.filter((u) => facility.unitIds.includes(u.unitId))} today={today} />;
}

function SlotPicker({ facility, units, today }: { facility: PortalFacility; units: PortalUnit[]; today: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const { unitId: preferred } = usePortalUnit();
  const [unitId, setUnitId] = useState(units.find((u) => u.unitId === preferred)?.unitId ?? units[0]?.unitId ?? '');
  const [date, setDate] = useState(today);
  const [startIndex, setStartIndex] = useState<number>();
  const [minutes, setMinutes] = useState<number>();
  const [partySize, setPartySize] = useState('');
  const [note, setNote] = useState('');
  const [partyError, setPartyError] = useState<string>();
  const [key, renewKey] = useIdempotencyKey();
  const day = useAvailability(facility.facilityId, date);
  const create = useCreateBooking();
  const lastDate = addDays(today, facility.advanceDays);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setStartIndex(undefined);
    setMinutes(undefined);
  }, [date]);

  const slots = day.data?.slots ?? [];
  const durations = useMemo(
    () => (startIndex === undefined || !day.data ? [] : durationOptions(day.data.slots, startIndex, day.data.slotMinutes, day.data.maxBookingMinutes)),
    [day.data, startIndex],
  );
  const start = startIndex === undefined ? undefined : slots[startIndex];
  const chosenMinutes = minutes ?? durations[0];

  // Her yeni secim yeni bir istektir: anahtar yenilenir. Ayni secimin tekrar gonderimi ayni anahtari kullanir.
  useEffect(() => {
    renewKey();
  }, [unitId, date, startIndex, chosenMinutes, partySize, note, renewKey]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await day.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  const submit = async () => {
    if (!start || !chosenMinutes) return;
    const party = partySize.trim() ? Number(partySize) : undefined;
    if (party !== undefined && (!Number.isInteger(party) || party < 1 || party > facility.capacity)) {
      setPartyError(`1–${facility.capacity} arasında olmalı`);
      return;
    }
    setPartyError(undefined);
    try {
      const r = await create.mutateAsync({
        idempotencyKey: key,
        facilityId: facility.facilityId,
        unitId,
        date,
        start: start.start,
        minutes: chosenMinutes,
        ...(party ? { partySize: party } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      renewKey();
      router.dismissTo({ pathname: '/resident/reservations', params: { tab: 'mine', done: r.booking.bookingId, ...(r.warning ? { warning: r.warning } : {}) } });
    } catch {
      // Hata asagida gosterilir; dolu dilimde musaitlik yenilenir.
      void day.refetch();
    }
  };

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <View style={styles.head}>
        <AppText variant="heading" weight="semibold" accessibilityRole="header">
          {facility.name}
        </AppText>
        <AppText variant="caption" tone="muted">{`${hoursSummary(facility.openingHours)} · ${facility.capacity} kişi`}</AppText>
        {facility.description ? (
          <AppText variant="small" tone="secondary">
            {facility.description}
          </AppText>
        ) : null}
      </View>

      {units.length > 1 && (
        <View style={styles.gap15}>
          <AppText variant="small" weight="medium">
            Daire
          </AppText>
          <FilterChips label="Daire" value={unitId} onChange={setUnitId} options={units.map((u) => ({ value: u.unitId, label: u.label }))} />
        </View>
      )}
      <DateField label="Tarih" value={date} min={today} max={lastDate} onChange={setDate} hint={`En geç ${formatDate(lastDate)} için rezervasyon yapılabilir.`} />

      <View style={styles.gap2}>
        <AppText variant="small" weight="semibold" accessibilityRole="header">
          {dayLabel(date)}
        </AppText>
        {day.isPending ? (
          <View accessible accessibilityRole="progressbar" accessibilityLabel="Saatler yükleniyor" style={styles.grid}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} height={MIN_TOUCH + 8} style={styles.slot} />
            ))}
          </View>
        ) : day.isError ? (
          <PortalQueryState error={day.error} onRetry={() => void day.refetch()} />
        ) : !day.data.open ? (
          <AppText variant="small" tone="muted">
            Ortak alan bu gün kapalı.
          </AppText>
        ) : !day.data.bookable ? (
          <AppText variant="small" tone="muted">
            Bu tarih için rezervasyon yapılamaz.
          </AppText>
        ) : (
          <View style={styles.grid}>
            {slots.map((s, i) => {
              const chosen = startIndex !== undefined && chosenMinutes !== undefined && i >= startIndex && i < startIndex + chosenMinutes / day.data.slotMinutes;
              const free = s.state === 'free';
              const tone = chosen ? colors.accent : s.state === 'mine' ? colors.success : free ? colors.text : colors.muted;
              return (
                <Pressable
                  key={s.start}
                  accessibilityRole="button"
                  accessibilityLabel={`${s.start}, ${SLOT_TEXT[s.state]}`}
                  accessibilityState={{ disabled: !free, selected: startIndex === i }}
                  disabled={!free}
                  onPress={() => {
                    setStartIndex(i);
                    setMinutes(undefined);
                  }}
                  style={({ pressed }) => [
                    styles.slot,
                    styles.slotButton,
                    {
                      borderColor: chosen ? colors.accent : s.state === 'mine' ? withAlpha(colors.success, 0.4) : colors.borderStrong,
                      backgroundColor: chosen ? withAlpha(colors.accent, 0.1) : !free ? colors.surfaceMuted : pressed ? colors.surfaceMuted : colors.surface,
                    },
                  ]}
                >
                  <AppText variant="small" weight="semibold" tabular style={[styles.mono, { color: tone }]}>
                    {s.start}
                  </AppText>
                  <AppText variant="caption" style={{ color: tone }}>
                    {SLOT_TEXT[s.state]}
                  </AppText>
                </Pressable>
              );
            })}
          </View>
        )}
      </View>

      {start && chosenMinutes && (
        <Card>
          <View style={styles.gap15}>
            <AppText variant="small" weight="medium">
              Süre
            </AppText>
            <FilterChips
              label="Süre"
              value={String(chosenMinutes)}
              onChange={(m) => setMinutes(Number(m))}
              options={durations.map((m) => ({ value: String(m), label: `${formatMinutes(m)} (${start.start}–${addClock(start.start, m)})` }))}
            />
          </View>
          <TextField label="Kişi sayısı (isteğe bağlı)" value={partySize} onChangeText={setPartySize} error={partyError} keyboardType="number-pad" inputMode="numeric" maxLength={4} />
          <TextField label="Not (isteğe bağlı)" value={note} onChangeText={setNote} maxLength={300} multiline numberOfLines={2} textAlignVertical="top" />
          <View style={styles.gap1}>
            <AppText weight="semibold">{`${dayLabel(date)} · ${start.start}–${addClock(start.start, chosenMinutes)}`}</AppText>
            <AppText variant="small" tone="muted">
              {(facility.feeKurus ? `Ücret: ${formatTRY(facility.feeKurus)} — ${facility.requiresApproval ? 'onaylanınca' : 'rezervasyonla birlikte'} dairenizin borcuna eklenir.` : 'Ücretsiz.') +
                (facility.requiresApproval ? ' Rezervasyon yönetici onayından sonra kesinleşir.' : '') +
                (facility.cancelNoticeHours ? ` Başlangıçtan en geç ${facility.cancelNoticeHours} saat önce iptal edebilirsiniz.` : '')}
            </AppText>
          </View>
          {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
          <Button icon={CalendarCheck} block loading={create.isPending} label={facility.requiresApproval ? 'Rezervasyon talebi gönder' : 'Rezervasyonu onayla'} onPress={() => void submit()} />
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: space(1) },
  gap1: { gap: space(1) },
  gap15: { gap: space(1.5) },
  gap2: { gap: space(2) },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  slot: { width: '31%' },
  slotButton: { minHeight: MIN_TOUCH + 8, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth * 2, paddingVertical: space(1.5) },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
});
