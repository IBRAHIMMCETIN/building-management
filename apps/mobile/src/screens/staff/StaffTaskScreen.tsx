import { errorMessage } from '@bm/shared/api/errors';
import { type ChecklistAnswer, type MaintenanceTask, checklistErrors } from '@bm/shared/api/work';
import { formatDate, formatDateTime } from '@bm/shared/dates';
import { CATEGORY_LABELS, PRIORITY_LABELS, TICKET_PRIORITIES, type TicketPriority } from '@bm/shared/tickets/model';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CircleCheck, CircleX, Play, UserCheck, Wrench } from '@/components/icons';
import { Alert, AppText, Button, Card, CardTitle, ChipGroup, LoadingBlock, Screen, TextField } from '@/components/ui';
import { useAssigneeNames, useStaffTask, useTaskActions } from '@/hooks/useWork';
import { workEndpoints } from '@/lib/api/workEndpoints';
import { useIdempotencyKey } from '@/lib/idempotency';
import type { LocalPhoto } from '@/lib/photos';
import { useServices } from '@/services';
import { radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { EstimateCard, InfoRow, PhotoLinks, PhotoPicker, TaskStatusBadge } from './WorkUi';

type Mode = 'complete' | 'skip' | 'ticket' | null;

/**
 * Bakim gorevi - gorevli (web: pages/admin/tickets/MaintenanceTaskDialog.tsx): kontrol listesiyle
 * tamamlama (Uygun / Sorunlu, sorunlu maddede not), fotograf, ustlenme, baslatma, atlama (gerekce),
 * sorunlu maddede ariza talebi acma, tahmini tutar notu.
 */
export function StaffTaskScreen({ id }: { id: string }) {
  const task = useStaffTask(id);
  if (task.isPending) {
    return (
      <Screen>
        <LoadingBlock label="Bakım görevi yükleniyor" lines={5} />
      </Screen>
    );
  }
  if (task.isError) {
    return (
      <Screen>
        <Card>
          <Alert tone="danger">{errorMessage(task.error)}</Alert>
          <Button variant="secondary" label="Tekrar dene" onPress={() => void task.refetch()} />
        </Card>
      </Screen>
    );
  }
  return <TaskBody key={`${task.data.taskId}-${task.data.version}`} task={task.data} />;
}

function TaskBody({ task }: { task: MaintenanceTask }) {
  const { api } = useServices();
  const router = useRouter();
  const act = useTaskActions(task.taskId);
  const nameOf = useAssigneeNames();
  const [mode, setMode] = useState<Mode>(null);
  const [suggest, setSuggest] = useState(false);
  const has = (a: string) => task.actions.includes(a);
  const err = act.claim.error ?? act.start.error;

  return (
    <Screen>
      <Card>
        <AppText variant="caption" tone="muted">{`Bakım · ${CATEGORY_LABELS[task.category]}${task.asset ? ` · ${task.asset}` : ''}`}</AppText>
        <AppText variant="heading" weight="semibold" accessibilityRole="header">
          {task.name}
        </AppText>
        <View style={styles.badges}>
          <TaskStatusBadge status={task.status} overdue={task.overdue} />
        </View>
        <View style={styles.gap2}>
          <InfoRow label="Vade" value={formatDate(task.dueDate)} />
          <InfoRow label="Görevli" value={task.assigneeId ? (nameOf(task.assigneeId) ?? 'Görevli') : 'Atanmamış'} />
          {task.completedAt && <InfoRow label="Tamamlandı" value={formatDateTime(task.completedAt)} />}
          {task.skipReason && <InfoRow label="Atlama gerekçesi" value={task.skipReason} />}
          {task.cancelReason && <InfoRow label="İptal" value={task.cancelReason} />}
        </View>
      </Card>

      {suggest && (
        <Card>
          <Alert tone="warning">Başarısız madde var. Sorunu takip etmek için arıza talebi açın.</Alert>
          <Button variant="secondary" icon={Wrench} label="Arıza talebi aç" onPress={() => setMode('ticket')} />
        </Card>
      )}

      {mode === 'complete' ? (
        <CompleteForm
          task={task}
          onDone={(s) => {
            setMode(null);
            setSuggest(s);
          }}
          onCancel={() => setMode(null)}
        />
      ) : mode === 'skip' ? (
        <SkipForm task={task} onDone={() => setMode(null)} />
      ) : mode === 'ticket' ? (
        <OpenTicketForm
          task={task}
          onDone={(ticketId) => {
            setMode(null);
            setSuggest(false);
            router.push({ pathname: '/staff/ticket/[id]', params: { id: ticketId } });
          }}
          onCancel={() => setMode(null)}
        />
      ) : (
        <>
          <Checklist task={task} />
          {(has('assign') || has('start') || has('complete') || has('ticket') || has('skip')) && (
            <Card>
              <CardTitle>İşlemler</CardTitle>
              <View style={styles.row}>
                {has('assign') && <Button variant="secondary" icon={UserCheck} label="Üstlen" loading={act.claim.isPending} onPress={() => act.claim.mutate(task.version)} />}
                {has('start') && <Button variant="secondary" icon={Play} label="Başla" loading={act.start.isPending} onPress={() => act.start.mutate(task.version)} />}
                {has('complete') && <Button icon={CircleCheck} label="Tamamla" onPress={() => setMode('complete')} />}
                {has('ticket') && <Button variant="secondary" icon={Wrench} label="Arıza aç" onPress={() => setMode('ticket')} />}
                {has('skip') && <Button variant="ghost" label="Atla" onPress={() => setMode('skip')} />}
              </View>
              {err && <Alert tone="danger">{errorMessage(err)}</Alert>}
            </Card>
          )}
        </>
      )}

      {!!task.photoKeys?.length && (
        <Card>
          <CardTitle>Fotoğraflar</CardTitle>
          <PhotoLinks keys={task.photoKeys} load={(photoId) => workEndpoints.taskPhoto(api, task.taskId, photoId)} />
        </Card>
      )}
      {task.ticketIds.length > 0 && (
        <Card>
          <CardTitle>Açılan arızalar</CardTitle>
          <View style={styles.row}>
            {task.ticketIds.map((tid, i) => (
              <Button key={tid} variant="ghost" icon={Wrench} label={`Talep ${i + 1}`} onPress={() => router.push({ pathname: '/staff/ticket/[id]', params: { id: tid } })} />
            ))}
          </View>
        </Card>
      )}
      <EstimateCard estimate={task.estimate} canEdit={has('estimate')} version={task.version} mutation={act.estimate} nameOf={nameOf} />
    </Screen>
  );
}

function Checklist({ task }: { task: MaintenanceTask }) {
  const { colors } = useTheme();
  if (!task.checklist.length) return null;
  const result = (id: string) => task.checklistResults?.find((r) => r.id === id);
  return (
    <Card>
      <CardTitle>Kontrol listesi</CardTitle>
      <View style={styles.gap2}>
        {task.checklist.map((c) => {
          const r = result(c.id);
          const state = r ? (r.ok ? 'Uygun' : 'Sorunlu') : 'Cevaplanmadı';
          return (
            <View key={c.id} style={styles.checkRow} accessible accessibilityLabel={`${c.text}${c.required ? '' : ', isteğe bağlı'}, ${state}${r?.note ? `, ${r.note}` : ''}`}>
              {r ? r.ok ? <CircleCheck size={18} color={colors.success} aria-hidden /> : <CircleX size={18} color={colors.danger} aria-hidden /> : <View style={[styles.dot, { backgroundColor: colors.borderStrong }]} />}
              <View style={styles.flex}>
                <AppText variant="small">
                  {c.text}
                  {!c.required ? (
                    <AppText variant="caption" tone="muted">
                      {' (isteğe bağlı)'}
                    </AppText>
                  ) : null}
                </AppText>
                {r?.note && (
                  <AppText variant="caption" tone="muted">
                    {r.note}
                  </AppText>
                )}
              </View>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

function CompleteForm({ task, onDone, onCancel }: { task: MaintenanceTask; onDone: (suggestTicket: boolean) => void; onCancel: () => void }) {
  const { colors } = useTheme();
  const act = useTaskActions(task.taskId);
  const [results, setResults] = useState<ChecklistAnswer[]>(task.checklist.map((c) => ({ id: c.id, ok: null, note: '' })));
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const busy = act.complete.isPending;
  const set = (id: string, patch: Partial<ChecklistAnswer>) => setResults((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const submit = () => {
    const invalid = checklistErrors(task, results);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    act.complete.mutate(
      {
        version: task.version,
        checklistResults: results.filter((x) => x.ok !== null).map((x) => ({ id: x.id, ok: x.ok as boolean, ...(x.note.trim() ? { note: x.note.trim() } : {}) })),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(photos.length ? { photos } : {}),
      },
      { onSuccess: (r) => onDone(r.suggestTicket), onError: (err) => setError(errorMessage(err)) },
    );
  };

  return (
    <Card>
      <CardTitle>Görevi tamamla</CardTitle>
      {task.checklist.map((c) => {
        const r = results.find((x) => x.id === c.id) as ChecklistAnswer;
        return (
          <View key={c.id} style={[styles.item, { borderColor: colors.border }]}>
            <AppText variant="small" weight="medium">
              {c.text}
              {!c.required ? (
                <AppText variant="caption" tone="muted">
                  {' (isteğe bağlı)'}
                </AppText>
              ) : null}
            </AppText>
            <ChipGroup
              label={c.text}
              size="large"
              columns={2}
              value={r.ok === null ? '' : r.ok ? 'ok' : 'fail'}
              onChange={(v) => set(c.id, { ok: v === 'ok' })}
              options={[
                { value: 'ok', label: 'Uygun' },
                { value: 'fail', label: 'Sorunlu' },
              ]}
            />
            {r.ok === false && <TextField label={`${c.text} açıklaması`} placeholder="Sorunu kısaca yazın" value={r.note} onChangeText={(t) => set(c.id, { note: t })} maxLength={500} />}
          </View>
        );
      })}
      <TextField label="Not (isteğe bağlı)" value={note} onChangeText={setNote} maxLength={2000} multiline editable={!busy} />
      <PhotoPicker label="Önce / sonra fotoğrafları (isteğe bağlı)" photos={photos} onChange={setPhotos} disabled={busy} />
      {error && <Alert tone="danger">{error}</Alert>}
      <View style={styles.row}>
        <Button label="Tamamla" loading={busy} onPress={submit} />
        <Button variant="ghost" label="Vazgeç" disabled={busy} onPress={onCancel} />
      </View>
    </Card>
  );
}

function SkipForm({ task, onDone }: { task: MaintenanceTask; onDone: () => void }) {
  const act = useTaskActions(task.taskId);
  const [reason, setReason] = useState('');
  return (
    <Card>
      <CardTitle>Görevi atla</CardTitle>
      <TextField label="Atlama gerekçesi" placeholder="Örn. firma gelemedi, bir sonraki bakımda yapılacak." value={reason} onChangeText={setReason} maxLength={500} multiline />
      {act.skip.isError && <Alert tone="danger">{errorMessage(act.skip.error)}</Alert>}
      <View style={styles.row}>
        <Button variant="danger" label="Atla" loading={act.skip.isPending} disabled={reason.trim().length < 3} onPress={() => act.skip.mutate({ version: task.version, reason: reason.trim() }, { onSuccess: onDone })} />
        <Button variant="ghost" label="Vazgeç" onPress={onDone} />
      </View>
    </Card>
  );
}

function OpenTicketForm({ task, onDone, onCancel }: { task: MaintenanceTask; onDone: (ticketId: string) => void; onCancel: () => void }) {
  const act = useTaskActions(task.taskId);
  const [key] = useIdempotencyKey();
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const failed = (task.checklistResults ?? []).filter((r) => !r.ok).length;
  return (
    <Card>
      <CardTitle>Görevden arıza aç</CardTitle>
      <AppText variant="small" tone="muted">
        {failed ? `${failed} sorunlu madde açıklamaya eklenecek.` : 'Talep bakım görevine bağlanır.'}
      </AppText>
      <TextField label="Başlık (isteğe bağlı)" placeholder={`Boş bırakılırsa: "${task.name} - bulgu"`} value={title} onChangeText={setTitle} maxLength={120} />
      <View style={styles.gap2}>
        <AppText variant="small" weight="medium">
          Öncelik
        </AppText>
        <ChipGroup label="Öncelik" value={priority} onChange={setPriority} options={TICKET_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))} />
      </View>
      {act.openTicket.isError && <Alert tone="danger">{errorMessage(act.openTicket.error)}</Alert>}
      <View style={styles.row}>
        <Button
          label="Arıza talebi aç"
          loading={act.openTicket.isPending}
          onPress={() => act.openTicket.mutate({ idempotencyKey: key, priority, ...(title.trim().length >= 3 ? { title: title.trim() } : {}) }, { onSuccess: (r) => onDone(r.ticket.ticketId) })}
        />
        <Button variant="ghost" label="Vazgeç" onPress={onCancel} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap2: { gap: space(2) },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(1.5) },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space(2) },
  dot: { width: space(2), height: space(2), borderRadius: radii.full, marginTop: space(1.5), marginHorizontal: space(1) },
  item: { gap: space(2), borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth * 2, padding: space(3) },
});
