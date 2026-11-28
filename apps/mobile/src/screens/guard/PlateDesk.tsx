import { errorMessage } from '@bm/shared/api/errors';
import { rateLimitSeconds } from '@bm/shared/api/gate';
import { PLATE_MIN_QUERY, normalizePlate } from '@bm/shared/gate/plate';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Car, UserPlus } from '@/components/icons';
import { Alert, AppText, Badge, Button, Card, Skeleton, TextField } from '@/components/ui';
import { usePlateLookup } from '@/hooks/useGate';
import { radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { RateLimitNotice, useCountdown } from './GateUi';

/** Yazmayi biraktiktan sonra sorgu (her tus vurusunda istek yok; plaka sorgusu da deneme sinirinda). */
export const PLATE_DEBOUNCE_MS = 400;

/**
 * Plaka sorgusu (web: pages/admin/gate/PlateDesk.tsx): tam plaka veya son en az 3 karakter. Sonucta
 * yalnizca bagimsiz bolum, kayit durumu ve arac notu; kisi adi / telefon / borc yok. Kayitli degilse
 * ziyaretci olarak elle giris kaydina gecilir.
 */
export function PlateDesk({ onManualEntry }: { onManualEntry: (plate: string) => void }) {
  const { colors } = useTheme();
  const [text, setText] = useState('');
  const [query, setQuery] = useState<string>();
  const [lock, setLock] = useState<{ until: number; message: string } | null>(null);
  const remaining = useCountdown(lock?.until ?? null);
  const locked = remaining > 0;
  const q = normalizePlate(text);

  useEffect(() => {
    if (locked) return;
    const t = setTimeout(() => setQuery(q.length >= PLATE_MIN_QUERY ? q : undefined), PLATE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, locked]);

  const lookup = usePlateLookup(locked ? undefined : query);
  const wait = lookup.isError ? rateLimitSeconds(lookup.error) : null;
  useEffect(() => {
    if (wait && lookup.error) setLock({ until: Date.now() + wait * 1000, message: errorMessage(lookup.error) });
  }, [wait, lookup.error]);

  return (
    <View style={styles.gap4}>
      <Card>
        <TextField
          label="Plaka (tamamı veya son 3+ karakter)"
          value={text}
          onChangeText={(t) => setText(t.toUpperCase())}
          placeholder="34 ABC 123"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect={false}
          maxLength={14}
          returnKeyType="search"
          onSubmitEditing={() => {
            if (q.length >= PLATE_MIN_QUERY && !locked) setQuery(q);
          }}
        />
        {q.length > 0 && q.length < PLATE_MIN_QUERY && (
          <AppText variant="small" tone="muted">
            {`Sorgu için en az ${PLATE_MIN_QUERY} karakter yazın.`}
          </AppText>
        )}
        {lock && <RateLimitNotice message={lock.message} seconds={remaining} />}
      </Card>

      {query && !locked && (
        lookup.isPending ? (
          <View accessible accessibilityRole="progressbar" accessibilityLabel="Plaka sorgulanıyor">
            <Skeleton height={96} />
          </View>
        ) : lookup.isError ? (
          wait ? null : <Alert tone="danger">{errorMessage(lookup.error)}</Alert>
        ) : lookup.data.items.length === 0 ? (
          <Card style={{ borderWidth: 2, borderColor: withAlpha(colors.warning, 0.5) }} accessibilityLiveRegion="polite">
            <AppText variant="heading" weight="bold" tone="warning" accessibilityRole="header">
              Kayıtlı değil
            </AppText>
            <AppText>
              <AppText weight="semibold" style={styles.mono}>
                {lookup.data.queryDisplay}
              </AppText>
              {' sitede kayıtlı bir araç değil.'}
            </AppText>
            <Button size="large" block variant="secondary" icon={UserPlus} label="Ziyaretçi olarak giriş kaydet" onPress={() => onManualEntry(lookup.data.query)} />
          </Card>
        ) : (
          <View style={styles.gap2} accessibilityLiveRegion="polite">
            {lookup.data.items.map((r) => (
              <View
                key={r.plate}
                accessible
                accessibilityLabel={`${r.plateDisplay}, ${r.unitLabel}, ${r.active ? 'kayıtlı, aktif' : 'kayıtlı, pasif'}${r.note ? `, ${r.note}` : ''}`}
                style={[styles.hit, { backgroundColor: colors.surface, borderColor: r.active ? withAlpha(colors.success, 0.4) : colors.border }]}
              >
                <Car size={32} color={r.active ? colors.success : colors.muted} aria-hidden />
                <View style={styles.flex}>
                  <AppText variant="heading" weight="bold" style={styles.mono}>
                    {r.plateDisplay}
                  </AppText>
                  <AppText weight="medium">{r.unitLabel}</AppText>
                  {r.note && (
                    <AppText variant="small" tone="muted">
                      {r.note}
                    </AppText>
                  )}
                </View>
                <Badge tone={r.active ? 'success' : 'neutral'} label={r.active ? 'Kayıtlı · aktif' : 'Kayıtlı · pasif'} />
              </View>
            ))}
          </View>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap2: { gap: space(2) },
  gap4: { gap: space(4) },
  hit: { flexDirection: 'row', alignItems: 'center', gap: space(3), borderRadius: radii.xl, borderWidth: 2, padding: space(4) },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
});
