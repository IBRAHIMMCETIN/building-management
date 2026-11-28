import { errorMessage } from '@bm/shared/api/errors';
import type { Ticket } from '@bm/shared/api/tickets';
import type { TicketEvent } from '@bm/shared/api/work';
import { formatDateTime } from '@bm/shared/dates';
import { ACTION_LABELS, CATEGORY_LABELS, EVENT_LABELS, STATUS_LABELS, TRANSITIONS, type TransitionAction, locationText, noteRequired } from '@bm/shared/tickets/model';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Send, UserCheck } from '@/components/icons';
import { Alert, AppText, Button, Card, CardTitle, ChipGroup, LoadingBlock, Screen, TextField } from '@/components/ui';
import { useAssigneeNames, useSiteLabels, useStaffTicket, useTicketActions } from '@/hooks/useWork';
import { workEndpoints } from '@/lib/api/workEndpoints';
import type { LocalPhoto } from '@/lib/photos';
import { useServices } from '@/services';
import { radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { EstimateCard, InfoRow, PhotoLinks, PhotoPicker, PriorityBadge, SlaBadge, TicketStatusBadge } from './WorkUi';

const isTransition = (a: string): a is TransitionAction => (TRANSITIONS as readonly string[]).includes(a);
/** Fotograf eklenebilen gecisler (web TransitionDialog). */
const WITH_PHOTOS: readonly TransitionAction[] = ['start', 'hold', 'resolve'];

/**
 * Talep ayrintisi - gorevli (web: pages/admin/tickets/TicketDetailPanel.tsx): bilgiler, ustlenme,
 * durum gecisleri (not + once / sonra fotograf), tahmini tutar notu, yorum / ic not, zaman cizelgesi.
 * Gecisleri ve yetkiyi API belirler (`actions`, `canAssign`, `canEstimate`).
 */
export function StaffTicketScreen({ id }: { id: string }) {
  const detail = useStaffTicket(id);
  if (detail.isPending) {
    return (
      <Screen>
        <LoadingBlock label="Talep yükleniyor" lines={5} />
      </Screen>
    );
  }
  if (detail.isError) {
    return (
      <Screen>
        <Card>
          <Alert tone="danger">{errorMessage(detail.error)}</Alert>
          <Button variant="secondary" label="Tekrar dene" onPress={() => void detail.refetch()} />
        </Card>
      </Screen>
    );
  }
  return <TicketDetail key={`${detail.data.ticket.ticketId}-${detail.data.ticket.version}`} ticket={detail.data.ticket} events={detail.data.events} onRefresh={() => detail.refetch()} />;
}

function TicketDetail({ ticket, events, onRefresh }: { ticket: Ticket; events: TicketEvent[]; onRefresh: () => Promise<unknown> }) {
  const { colors } = useTheme();
  const { api } = useServices();
  const act = useTicketActions(ticket.ticketId);
  const labels = useSiteLabels();
  const nameOf = useAssigneeNames();
  const [action, setAction] = useState<TransitionAction | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const transitions = ticket.actions.filter(isTransition);
  const assignee = ticket.assigneeId ? (ticket.mine ? 'Siz' : (nameOf(ticket.assigneeId) ?? 'Görevli')) : 'Atanmamış';

  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <Card>
        <AppText variant="caption" tone="muted">{`${ticket.number} · ${CATEGORY_LABELS[ticket.category]}`}</AppText>
        <AppText variant="heading" weight="semibold" accessibilityRole="header">
          {ticket.title}
        </AppText>
        <View style={styles.badges}>
          <TicketStatusBadge status={ticket.status} />
          <PriorityBadge priority={ticket.priority} />
          <SlaBadge ticket={ticket} />
        </View>
        {ticket.source === 'maintenance' && (
          <AppText variant="small" tone="muted">
            Bakım görevinden açıldı
          </AppText>
        )}
        <View style={styles.gap2}>
          <InfoRow label="Konum" value={locationText(ticket.location, labels.unitLabel)} />
          <InfoRow label="Açılış" value={formatDateTime(ticket.createdAt)} />
          <InfoRow label="SLA hedefi" value={`${formatDateTime(ticket.dueAt)}${ticket.slaMet !== undefined ? (ticket.slaMet ? ' (süresinde çözüldü)' : ' (gecikmeli çözüldü)') : ''}`} />
          <InfoRow label="Görevli" value={assignee} />
        </View>
        <View style={[styles.description, { backgroundColor: colors.surfaceMuted }]}>
          <AppText variant="small" selectable>
            {ticket.description}
          </AppText>
        </View>
        {ticket.canAssign && !ticket.mine && (
          <Button variant="secondary" icon={UserCheck} label="Üstlen" loading={act.claim.isPending} onPress={() => act.claim.mutate(ticket.version)} />
        )}
        {act.claim.error && <Alert tone="danger">{errorMessage(act.claim.error)}</Alert>}
      </Card>

      {transitions.length > 0 && !action && (
        <Card>
          <CardTitle>Durum işlemleri</CardTitle>
          <View style={styles.row} accessibilityLabel="Durum işlemleri">
            {transitions.map((a) => (
              <Button key={a} variant={a === 'resolve' || a === 'start' ? 'primary' : a === 'cancel' ? 'danger' : 'secondary'} label={ACTION_LABELS[a]} onPress={() => setAction(a)} />
            ))}
          </View>
        </Card>
      )}
      {action && <TransitionForm ticket={ticket} action={action} onClose={() => setAction(null)} />}

      <EstimateCard estimate={ticket.estimate} canEdit={ticket.canEstimate} version={ticket.version} mutation={act.estimate} nameOf={nameOf} />

      <Card>
        <CardTitle>Zaman çizelgesi</CardTitle>
        {events.length === 0 ? (
          <AppText variant="small" tone="muted">
            Henüz kayıt yok.
          </AppText>
        ) : (
          <View style={styles.timeline}>
            {[...events].reverse().map((e) => (
              <EventRow key={e.eventId} event={e} nameOf={nameOf} load={(photoId) => workEndpoints.ticketPhoto(api, ticket.ticketId, photoId)} />
            ))}
          </View>
        )}
      </Card>

      {ticket.status !== 'cancelled' && ticket.status !== 'closed' && <CommentBox ticket={ticket} />}
    </Screen>
  );
}

function TransitionForm({ ticket, action, onClose }: { ticket: Ticket; action: TransitionAction; onClose: () => void }) {
  const act = useTicketActions(ticket.ticketId);
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [error, setError] = useState<string>();
  const required = noteRequired(action, false);
  const busy = act.transition.isPending;

  const submit = () => {
    if (required && note.trim().length < 3) {
      setError('Bu işlem için açıklama gerekli (en az 3 karakter).');
      return;
    }
    setError(undefined);
    act.transition.mutate(
      { version: ticket.version, action, ...(note.trim() ? { note: note.trim() } : {}), ...(photos.length ? { photos } : {}) },
      { onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
    );
  };

  return (
    <Card>
      <CardTitle>{`${ticket.number}: ${ACTION_LABELS[action]}`}</CardTitle>
      <TextField label={required ? 'Açıklama' : 'Açıklama (isteğe bağlı)'} value={note} onChangeText={setNote} maxLength={2000} multiline editable={!busy} />
      {action === 'resolve' && (
        <AppText variant="small" tone="muted">
          Sakine “çözüldü, onaylayın” bildirimiyle iletilir.
        </AppText>
      )}
      {WITH_PHOTOS.includes(action) && <PhotoPicker label="Önce / sonra fotoğrafları (isteğe bağlı)" photos={photos} onChange={setPhotos} disabled={busy} />}
      {error && <Alert tone="danger">{error}</Alert>}
      <View style={styles.row}>
        <Button variant={action === 'cancel' ? 'danger' : 'primary'} label={ACTION_LABELS[action]} loading={busy} onPress={submit} />
        <Button variant="ghost" label="Vazgeç" disabled={busy} onPress={onClose} />
      </View>
    </Card>
  );
}

function CommentBox({ ticket }: { ticket: Ticket }) {
  const act = useTicketActions(ticket.ticketId);
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'internal'>('internal');
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const busy = act.comment.isPending;

  const submit = () => {
    if (!body.trim()) return;
    act.comment.mutate(
      { body: body.trim(), visibility, ...(photos.length ? { photos } : {}) },
      {
        onSuccess: () => {
          setBody('');
          setPhotos([]);
        },
      },
    );
  };

  return (
    <Card>
      <CardTitle>{visibility === 'internal' ? 'İç not ekle' : 'Yorum yaz'}</CardTitle>
      <ChipGroup
        label="Görünürlük"
        value={visibility}
        onChange={setVisibility}
        options={[
          { value: 'internal', label: 'İç not (sakin görmez)' },
          { value: 'public', label: 'Sakine yorum' },
        ]}
      />
      <TextField label="Yorum metni" value={body} onChangeText={setBody} maxLength={2000} multiline editable={!busy} />
      <PhotoPicker photos={photos} onChange={setPhotos} disabled={busy} />
      {act.comment.error && <Alert tone="danger">{errorMessage(act.comment.error)}</Alert>}
      {act.comment.isSuccess && !body && (
        <AppText variant="small" tone="success" accessibilityLiveRegion="polite">
          Gönderildi.
        </AppText>
      )}
      <Button icon={Send} label="Gönder" loading={busy} disabled={!body.trim()} onPress={submit} />
    </Card>
  );
}

function EventRow({ event: e, nameOf, load }: { event: TicketEvent; nameOf: (id: string | undefined) => string | undefined; load: (photoId: string) => ReturnType<typeof workEndpoints.ticketPhoto> }) {
  const { colors } = useTheme();
  const who = e.mine ? 'Siz' : (nameOf(e.by) ?? (e.byRole === 'resident' ? 'Sakin' : 'Görevli'));
  const title =
    e.kind === 'status_changed' && e.to ? `${e.from ? `${STATUS_LABELS[e.from]} → ` : ''}${STATUS_LABELS[e.to]}` : (EVENT_LABELS[e.kind] ?? e.kind);
  return (
    <View style={[styles.event, { borderLeftColor: e.visibility === 'internal' ? colors.warning : colors.border }]}>
      <View accessible accessibilityLabel={`${title}${e.visibility === 'internal' ? ', iç not' : ''}, ${who}, ${formatDateTime(e.at)}${e.body ? `, ${e.body}` : ''}`}>
        <AppText variant="small" weight="semibold">
          {title}
          {e.visibility === 'internal' ? (
            <AppText variant="small" tone="warning">
              {' · iç not'}
            </AppText>
          ) : null}
        </AppText>
        <AppText variant="caption" tone="muted">{`${who} · ${formatDateTime(e.at)}`}</AppText>
        {e.body && (
          <AppText variant="small" tone="secondary" selectable>
            {e.body}
          </AppText>
        )}
      </View>
      {!!e.photoKeys?.length && <PhotoLinks keys={e.photoKeys} load={load} />}
    </View>
  );
}

const styles = StyleSheet.create({
  gap2: { gap: space(2) },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(1.5) },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  description: { borderRadius: radii.md, padding: space(3) },
  timeline: { gap: space(3) },
  event: { borderLeftWidth: 2, paddingLeft: space(3), gap: space(1) },
});
