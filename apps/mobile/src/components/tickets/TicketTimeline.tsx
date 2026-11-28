import { errorMessage } from '@bm/shared/api/errors';
import type { SignedDownload } from '@bm/shared/api/documents';
import { ticketEventAuthor, ticketEventTitle } from '@bm/shared/api/portalTickets';
import type { TicketEvent } from '@bm/shared/api/tickets';
import { formatDateTime } from '@bm/shared/dates';
import { photoIdOf } from '@bm/shared/tickets/model';
import { useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { ImageIcon, Star } from '@/components/icons';
import { Sheet } from '@/components/portal/Sheet';
import { Alert, AppText, Spinner } from '@/components/ui';
import { MIN_TOUCH, radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

type Props = {
  events: readonly TicketEvent[];
  loadPhoto: (photoId: string) => Promise<SignedDownload>;
};

/** Puan yildizlari (yalnizca gosterim). */
export function Stars({ value, size = 14 }: { value: number; size?: number }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stars} accessible accessibilityLabel={`Puan ${value}/5`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star key={i} size={size} color={i < value ? colors.warning : colors.muted} fill={i < value ? colors.warning : 'transparent'} aria-hidden />
      ))}
    </View>
  );
}

/**
 * Zaman cizelgesi, eskiden yeniye (web: components/tickets/TicketTimeline.tsx; sakin gorunumunde API
 * yalnizca herkese acik olaylari dondurur). Fotograflarin imzali linki yalnizca acilinca istenir.
 */
export function TicketTimeline({ events, loadPhoto }: Props) {
  const { colors } = useTheme();
  const [open, setOpen] = useState<{ index: number; url?: string; error?: string } | null>(null);
  /** Son istek: gec gelen eski yanit (kapatilmis pencere veya baska fotograf) yok sayilir. */
  const request = useRef(0);

  if (!events.length) {
    return (
      <AppText variant="small" tone="muted">
        Henüz kayıt yok.
      </AppText>
    );
  }

  const show = async (key: string, index: number) => {
    const id = ++request.current;
    setOpen({ index });
    try {
      const r = await loadPhoto(photoIdOf(key));
      if (request.current === id) setOpen({ index, url: r.url });
    } catch (err) {
      if (request.current === id) setOpen({ index, error: errorMessage(err) });
    }
  };
  const close = () => {
    request.current++;
    setOpen(null);
  };

  return (
    <View style={styles.list} accessibilityLabel="Zaman çizelgesi">
      {events.map((e) => {
        const who = ticketEventAuthor(e);
        return (
          <View key={e.eventId} style={[styles.item, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <View style={styles.head}>
              <AppText variant="small" weight="semibold" style={styles.flex}>
                {ticketEventTitle(e)}
              </AppText>
              <AppText variant="caption" tone="muted">
                {`${who ? `${who} · ` : ''}${formatDateTime(e.at)}`}
              </AppText>
            </View>
            {e.rating !== undefined && <Stars value={e.rating} />}
            {e.body ? (
              <AppText variant="small" tone="secondary" selectable>
                {e.body}
              </AppText>
            ) : null}
            {!!e.photoKeys?.length && (
              <View style={styles.photos}>
                {e.photoKeys.map((k, i) => (
                  <Pressable
                    key={k}
                    accessibilityRole="button"
                    accessibilityLabel={`Fotoğraf ${i + 1}`}
                    accessibilityHint="Fotoğrafı açar"
                    onPress={() => void show(k, i)}
                    style={({ pressed }) => [styles.photo, { borderColor: colors.borderStrong, backgroundColor: pressed ? colors.surfaceMuted : colors.surface }]}
                  >
                    <ImageIcon size={16} color={colors.accent} aria-hidden />
                    <AppText variant="small" weight="medium">{`Fotoğraf ${i + 1}`}</AppText>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        );
      })}
      <Sheet open={!!open} title={`Fotoğraf ${(open?.index ?? 0) + 1}`} onClose={close}>
        {open?.error ? (
          <Alert tone="danger">{open.error}</Alert>
        ) : open?.url ? (
          <Image source={{ uri: open.url }} resizeMode="contain" style={[styles.full, { backgroundColor: colors.surfaceMuted }]} accessibilityLabel={`Fotoğraf ${(open.index ?? 0) + 1}`} />
        ) : (
          <Spinner label="Fotoğraf yükleniyor" />
        )}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space(3) },
  item: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth * 2, paddingHorizontal: space(3), paddingVertical: space(2), gap: space(1) },
  head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(2) },
  flex: { flexGrow: 1, flexShrink: 1 },
  stars: { flexDirection: 'row', gap: 2 },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2), paddingTop: space(1) },
  photo: { minHeight: MIN_TOUCH, flexDirection: 'row', alignItems: 'center', gap: space(1.5), paddingHorizontal: space(3), borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth * 2 },
  full: { width: '100%', aspectRatio: 3 / 4, borderRadius: radii.md },
});
