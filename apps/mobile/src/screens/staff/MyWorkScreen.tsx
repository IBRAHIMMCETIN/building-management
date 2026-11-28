import { errorMessage } from '@bm/shared/api/errors';
import type { Ticket } from '@bm/shared/api/tickets';
import { type MaintenanceTask, type WorkItem, groupMyWork } from '@bm/shared/api/work';
import { formatDate } from '@bm/shared/dates';
import { istanbulDay } from '@bm/shared/gate/plate';
import { CATEGORY_LABELS } from '@bm/shared/tickets/model';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { CalendarCheck, ChevronRight, ClipboardList, Play, Wrench } from '@/components/icons';
import { Alert, AppText, Button, Card, ChipGroup, EmptyState, LoadingBlock, Screen } from '@/components/ui';
import { useAuth } from '@/context/AuthProvider';
import { useSiteLabels, useStaffTasks, useStaffTickets, useTaskActions, useTicketActions, workKeys } from '@/hooks/useWork';
import { radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { PriorityBadge, SlaBadge, TaskStatusBadge } from '@/components/tickets/TicketBadges';
import { whereText } from './WorkUi';

type Tab = 'today' | 'week' | 'pool';

/**
 * İşlerim (web: pages/admin/staff/MyTasksPage.tsx): bana atanan talepler ve bakim gorevleri tek
 * listede (Bugün / Bu hafta / Havuz). Baslatma tek dokunus; cozum / tamamlama (not, kontrol listesi,
 * fotograf) ayrinti ekraninda. Asagi cek-yenile.
 */
export function MyWorkScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('today');
  const [refreshing, setRefreshing] = useState(false);
  const myTickets = useStaffTickets({ assignee: 'me', status: 'active', limit: 200 });
  const poolTickets = useStaffTickets({ assignee: 'none', status: 'active', limit: 200 });
  const myTasks = useStaffTasks({ assignee: 'me', status: 'open' });
  const poolTasks = useStaffTasks({ assignee: 'none', status: 'open' });
  const today = istanbulDay();

  const groups = useMemo(
    () =>
      groupMyWork<Ticket, MaintenanceTask>(
        { myTickets: myTickets.data?.items ?? [], myTasks: myTasks.data ?? [], poolTickets: poolTickets.data?.items ?? [], poolTasks: poolTasks.data ?? [] },
        today,
      ),
    [myTickets.data, myTasks.data, poolTickets.data, poolTasks.data, today],
  );
  const pending = myTickets.isPending || myTasks.isPending;
  const error = myTickets.error ?? myTasks.error ?? poolTickets.error ?? poolTasks.error;
  const items = groups[tab];

  const refresh = async () => {
    setRefreshing(true);
    try {
      await queryClient.refetchQueries({ queryKey: workKeys.all(user?.apartmentId ?? ''), type: 'active' });
    } finally {
      setRefreshing(false);
    }
  };

  const open = (w: WorkItem<Ticket, MaintenanceTask>) =>
    w.type === 'ticket' ? router.push({ pathname: '/staff/ticket/[id]', params: { id: w.ticket.ticketId } }) : router.push({ pathname: '/staff/task/[id]', params: { id: w.task.taskId } });

  return (
    <Screen title="İşlerim" refreshing={refreshing} onRefresh={() => void refresh()}>
      <ChipGroup
        label="İş listesi"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'today', label: 'Bugün', count: groups.today.length },
          { value: 'week', label: 'Bu hafta', count: groups.week.length },
          { value: 'pool', label: 'Havuz', count: groups.pool.length },
        ]}
      />
      {error && (
        <Card>
          <Alert tone="danger">{errorMessage(error)}</Alert>
          <Button variant="secondary" label="Tekrar dene" onPress={() => void refresh()} />
        </Card>
      )}
      {pending ? (
        <LoadingBlock label="İşler yükleniyor" lines={4} />
      ) : error && items.length === 0 ? null : items.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={tab === 'pool' ? 'Havuzda üstlenilecek iş yok' : 'Bu listede iş yok'}
          description={tab === 'today' ? 'Size atanan arıza ve vadesi gelen bakım işleri burada görünür.' : undefined}
        />
      ) : (
        <View style={styles.list}>
          {items.map((w) =>
            w.type === 'ticket' ? <TicketRow key={w.ticket.ticketId} ticket={w.ticket} onOpen={() => open(w)} /> : <TaskRow key={w.task.taskId} task={w.task} onOpen={() => open(w)} />,
          )}
        </View>
      )}
    </Screen>
  );
}

function RowFrame({ children, overdue, onOpen, label, action }: { children: React.ReactNode; overdue: boolean; onOpen: () => void; label: string; action?: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.row, { backgroundColor: colors.surface, borderColor: overdue ? withAlpha(colors.danger, 0.4) : colors.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Ayrıntıyı açar"
        onPress={onOpen}
        style={({ pressed }) => [styles.rowMain, pressed && { backgroundColor: colors.surfaceMuted }]}
      >
        {children}
        {!action && <ChevronRight size={18} color={colors.muted} aria-hidden />}
      </Pressable>
      {action}
    </View>
  );
}

function TicketRow({ ticket, onOpen }: { ticket: Ticket; onOpen: () => void }) {
  const { colors } = useTheme();
  const act = useTicketActions(ticket.ticketId);
  const labels = useSiteLabels();
  const where = whereText(ticket.location, labels.unitLabel);
  const canStart = ticket.actions.includes('start');
  return (
    <RowFrame
      overdue={ticket.overdue}
      onOpen={onOpen}
      label={`${ticket.number}, ${CATEGORY_LABELS[ticket.category]}, ${ticket.title}, ${where}${ticket.overdue ? ', gecikti' : ''}`}
      action={
        canStart ? (
          <View style={styles.action}>
            <Button
              icon={Play}
              label="Başla"
              accessibilityLabel={`${ticket.number} işe başla`}
              loading={act.transition.isPending}
              onPress={() => act.transition.mutate({ version: ticket.version, action: 'start' })}
            />
          </View>
        ) : undefined
      }
    >
      <Wrench size={20} color={colors.accent} aria-hidden />
      <View style={styles.text}>
        <AppText variant="caption" tone="muted">{`${ticket.number} · ${CATEGORY_LABELS[ticket.category]}`}</AppText>
        <AppText weight="medium">{ticket.title}</AppText>
        <AppText variant="caption" tone="muted">
          {where}
        </AppText>
        <View style={styles.badges}>
          {ticket.priority !== 'normal' && <PriorityBadge priority={ticket.priority} />}
          <SlaBadge ticket={ticket} />
        </View>
        {act.transition.error && <Alert tone="danger">{errorMessage(act.transition.error)}</Alert>}
      </View>
    </RowFrame>
  );
}

function TaskRow({ task, onOpen }: { task: MaintenanceTask; onOpen: () => void }) {
  const { colors } = useTheme();
  const act = useTaskActions(task.taskId);
  const canStart = task.actions.includes('start') && task.actions.includes('complete');
  return (
    <RowFrame
      overdue={task.overdue}
      onOpen={onOpen}
      label={`Bakım, ${formatDate(task.dueDate)}, ${task.name}${task.asset ? `, ${task.asset}` : ''}${task.overdue ? ', gecikti' : ''}`}
      action={
        canStart ? (
          <View style={styles.action}>
            <Button icon={Play} label="Başla" accessibilityLabel={`${task.name} başla`} loading={act.start.isPending} onPress={() => act.start.mutate(task.version)} />
          </View>
        ) : undefined
      }
    >
      <CalendarCheck size={20} color={colors.success} aria-hidden />
      <View style={styles.text}>
        <AppText variant="caption" tone="muted">{`Bakım · ${formatDate(task.dueDate)}`}</AppText>
        <AppText weight="medium">{task.name}</AppText>
        {task.asset && (
          <AppText variant="caption" tone="muted">
            {task.asset}
          </AppText>
        )}
        <View style={styles.badges}>
          <TaskStatusBadge status={task.status} overdue={task.overdue} />
          <AppText variant="caption" tone="muted">{`${task.checklist.length} kontrol maddesi`}</AppText>
        </View>
        {act.start.error && <Alert tone="danger">{errorMessage(act.start.error)}</Alert>}
      </View>
    </RowFrame>
  );
}

const styles = StyleSheet.create({
  list: { gap: space(3) },
  row: { flexDirection: 'row', alignItems: 'center', borderRadius: radii.xl, borderWidth: StyleSheet.hairlineWidth * 2, overflow: 'hidden' },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space(3), padding: space(4) },
  text: { flex: 1, gap: space(1) },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(1.5) },
  action: { paddingRight: space(4) },
});
