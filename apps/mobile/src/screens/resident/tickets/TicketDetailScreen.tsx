import { ApiError, errorMessage } from '@bm/shared/api/errors';
import { reopenNoteSchema, ticketCommentSchema } from '@bm/shared/api/portalTickets';
import type { Ticket, TicketEvent } from '@bm/shared/api/tickets';
import { formatDateTime } from '@bm/shared/dates';
import { CATEGORY_LABELS, RATING_LABELS } from '@bm/shared/tickets/model';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { SearchX, Star } from '@/components/icons';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { TicketStatusBadge } from '@/components/tickets/TicketBadges';
import { PhotoPicker } from '@/components/tickets/PhotoPicker';
import { TicketTimeline } from '@/components/tickets/TicketTimeline';
import { Alert, AppText, Button, Card, CardTitle, EmptyState, LoadingBlock, Screen, TextField } from '@/components/ui';
import { useMyTicket, useMyTicketActions, usePhotoUploader, useTicketPhotoLoader } from '@/hooks/useTickets';
import { type PreparedPhoto, photoErrorMessage, uploadPhotos } from '@/lib/photos';
import { MIN_TOUCH, radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/**
 * Sakin talep ayrintisi (web: pages/resident/tickets/MyTicketDetailPage.tsx): yalnizca herkese acik
 * olaylar; onay (1-5 puan), yeniden acma, geri cekme (atanmadan once), mesaj + fotograf. Islem
 * dugmeleri API'nin `actions` listesine gore gorunur.
 */
export function TicketDetailScreen({ id }: { id: string }) {
  const detail = useMyTicket(id);
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
        <LoadingBlock label="Talep yükleniyor" lines={5} />
      ) : detail.isError ? (
        detail.error instanceof ApiError && detail.error.status === 404 ? (
          <EmptyState icon={SearchX} title="Talep bulunamadı" description="Bu talep kaldırılmış veya sizinle paylaşılmıyor olabilir." />
        ) : (
          <PortalQueryState error={detail.error} onRetry={() => void detail.refetch()} />
        )
      ) : (
        <Detail key={`${detail.data.ticket.ticketId}-${detail.data.ticket.version}`} ticket={detail.data.ticket} events={detail.data.events} />
      )}
    </Screen>
  );
}

function Detail({ ticket, events }: { ticket: Ticket; events: TicketEvent[] }) {
  const { colors } = useTheme();
  const loadPhoto = useTicketPhotoLoader(ticket.ticketId);
  const can = (a: string) => ticket.actions.includes(a);
  const open = ticket.status !== 'closed' && ticket.status !== 'cancelled';

  return (
    <>
      <Card>
        <AppText variant="caption" tone="muted">
          <AppText variant="caption" tone="muted" style={styles.mono}>
            {ticket.number}
          </AppText>
          {` · ${CATEGORY_LABELS[ticket.category]} · ${formatDateTime(ticket.createdAt)}`}
        </AppText>
        <AppText variant="heading" weight="semibold" accessibilityRole="header">
          {ticket.title}
        </AppText>
        <View style={styles.meta}>
          <TicketStatusBadge status={ticket.status} />
          <AppText variant="small" tone="muted">
            {ticket.location.kind === 'common' ? `Ortak alan · ${ticket.location.area}` : 'Daire içi'}
            {ticket.assigned && ticket.status !== 'closed' ? ' · Görevli atandı' : ''}
          </AppText>
        </View>
        <View style={[styles.description, { backgroundColor: colors.surfaceMuted }]}>
          <AppText variant="small" selectable>
            {ticket.description}
          </AppText>
        </View>
        {ticket.rating && (
          <AppText variant="small">
            {'Puanınız: '}
            <AppText variant="small" weight="semibold">{`${ticket.rating.score}/5`}</AppText>
            {` (${RATING_LABELS[ticket.rating.score] ?? ''})`}
          </AppText>
        )}
      </Card>

      {can('confirm') && <ConfirmCard ticket={ticket} canReopen={can('reopen')} />}
      {!can('confirm') && can('reopen') && <ReopenCard ticket={ticket} />}

      <Card>
        <CardTitle>Gelişmeler</CardTitle>
        <TicketTimeline events={events} loadPhoto={loadPhoto} />
      </Card>

      {open && <CommentCard ticket={ticket} />}
      {can('cancel') && <WithdrawCard ticket={ticket} />}
    </>
  );
}

/** 1-5 puan (web RatingInput): yildiz dugmeleri, secili deger ekran okuyucuya bildirilir. */
export function RatingInput({ value, onChange }: { value: number | null; onChange: (v: number) => void }) {
  const { colors } = useTheme();
  return (
    <View style={styles.ratingRow}>
      <View accessibilityRole="radiogroup" accessibilityLabel="Puan" style={styles.stars}>
        {[1, 2, 3, 4, 5].map((n) => {
          const on = value !== null && n <= value;
          return (
            <Pressable
              key={n}
              accessibilityRole="radio"
              accessibilityLabel={`${n} - ${RATING_LABELS[n]}`}
              accessibilityState={{ checked: value === n }}
              onPress={() => onChange(n)}
              style={({ pressed }) => [styles.star, pressed && { backgroundColor: colors.surfaceMuted }]}
            >
              <Star size={24} color={on ? colors.warning : colors.muted} fill={on ? colors.warning : 'transparent'} aria-hidden />
            </Pressable>
          );
        })}
      </View>
      {value !== null && (
        <AppText variant="small" tone="muted">
          {RATING_LABELS[value]}
        </AppText>
      )}
    </View>
  );
}

function ConfirmCard({ ticket, canReopen }: { ticket: Ticket; canReopen: boolean }) {
  const act = useMyTicketActions(ticket.ticketId);
  const { colors } = useTheme();
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [reopening, setReopening] = useState(false);
  if (reopening) return <ReopenCard ticket={ticket} onCancel={() => setReopening(false)} />;

  return (
    <Card style={{ borderColor: withAlpha(colors.success, 0.4) }}>
      <CardTitle>Sorun çözüldü mü?</CardTitle>
      <AppText variant="small" tone="muted">
        Yönetim talebi çözüldü olarak işaretledi. Onaylarsanız talep kapanır; onaylamazsanız birkaç gün içinde otomatik kapanır.
      </AppText>
      <RatingInput value={rating} onChange={setRating} />
      <TextField label="Not (isteğe bağlı)" value={note} onChangeText={setNote} maxLength={2000} multiline numberOfLines={2} textAlignVertical="top" />
      {act.confirm.isError && <Alert tone="danger">{errorMessage(act.confirm.error)}</Alert>}
      <View style={styles.actions}>
        <Button
          label="Onayla ve kapat"
          loading={act.confirm.isPending}
          onPress={() => act.confirm.mutate({ version: ticket.version, ...(rating ? { rating } : {}), ...(note.trim() ? { note: note.trim() } : {}) })}
        />
        {canReopen && <Button variant="secondary" label="Hâlâ sorun var" onPress={() => setReopening(true)} />}
      </View>
    </Card>
  );
}

function ReopenCard({ ticket, onCancel }: { ticket: Ticket; onCancel?: () => void }) {
  const act = useMyTicketActions(ticket.ticketId);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();

  const submit = () => {
    const parsed = reopenNoteSchema.safeParse(note);
    setError(parsed.success ? undefined : parsed.error.issues[0]?.message);
    if (parsed.success) act.reopen.mutate({ version: ticket.version, note: parsed.data });
  };

  return (
    <Card>
      <CardTitle>Talebi yeniden aç</CardTitle>
      <TextField label="Sorun neden devam ediyor?" value={note} onChangeText={setNote} error={error} maxLength={2000} multiline numberOfLines={3} textAlignVertical="top" />
      {act.reopen.isError && <Alert tone="danger">{errorMessage(act.reopen.error)}</Alert>}
      <View style={styles.actions}>
        <Button label="Yeniden aç" loading={act.reopen.isPending} onPress={submit} />
        {onCancel && <Button variant="ghost" label="Vazgeç" onPress={onCancel} />}
      </View>
    </Card>
  );
}

function CommentCard({ ticket }: { ticket: Ticket }) {
  const act = useMyTicketActions(ticket.ticketId);
  const upload = usePhotoUploader();
  const [body, setBody] = useState('');
  const [photos, setPhotos] = useState<PreparedPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const parsed = ticketCommentSchema.safeParse(body);
    setFieldError(parsed.success ? undefined : parsed.error.issues[0]?.message);
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      const ids = await uploadPhotos(photos, upload);
      await act.comment.mutateAsync({ body: parsed.data, ...(ids.length ? { photos: ids } : {}) });
      setBody('');
      setPhotos([]);
    } catch (err) {
      setError(photoErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardTitle>Mesaj ekle</CardTitle>
      <TextField label="Mesaj" value={body} onChangeText={setBody} error={fieldError} maxLength={2000} multiline numberOfLines={3} textAlignVertical="top" editable={!busy} />
      <PhotoPicker photos={photos} onChange={setPhotos} disabled={busy} onBusyChange={setPreparing} />
      {error && <Alert tone="danger">{error}</Alert>}
      <Button label="Gönder" block loading={busy} disabled={preparing} onPress={() => void submit()} />
    </Card>
  );
}

function WithdrawCard({ ticket }: { ticket: Ticket }) {
  const act = useMyTicketActions(ticket.ticketId);
  const [confirming, setConfirming] = useState(false);
  return (
    <Card>
      <AppText variant="small" tone="muted">
        {confirming ? 'Talebi geri çekmek istediğinize emin misiniz?' : 'Talep henüz işleme alınmadı; gerekmiyorsa geri çekebilirsiniz.'}
      </AppText>
      {act.cancel.isError && <Alert tone="danger">{errorMessage(act.cancel.error)}</Alert>}
      {confirming ? (
        <View style={styles.actions}>
          <Button variant="ghost" label="Vazgeç" disabled={act.cancel.isPending} onPress={() => setConfirming(false)} />
          <Button variant="danger" label="Evet, geri çek" loading={act.cancel.isPending} onPress={() => act.cancel.mutate({ version: ticket.version })} />
        </View>
      ) : (
        <Button variant="secondary" label="Talebi geri çek" onPress={() => setConfirming(true)} />
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(2) },
  description: { borderRadius: radii.md, padding: space(3) },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  ratingRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space(2) },
  stars: { flexDirection: 'row' },
  star: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md },
});
