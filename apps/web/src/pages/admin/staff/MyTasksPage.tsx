import { CalendarCheck, ChevronRight, Play, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { PriorityBadge, SlaBadge, TaskStatusBadge } from '@/components/tickets/TicketBadges';
import { Alert, Button, FilterChips, Skeleton } from '@/components/ui';
import { useMaintenanceTasks, useTaskActions } from '@/hooks/useMaintenance';
import { useTicketList, useTicketPermissions, useTransitionTicket } from '@/hooks/useTickets';
import { errorMessage } from '@/lib/api/errors';
import type { MaintenanceTask } from '@/lib/api/maintenance';
import type { Ticket } from '@/lib/api/tickets';
import { formatDate } from '@/lib/dates';
import { istanbulToday } from '@/lib/maintenance/schedule';
import { type WorkItem, groupMyWork } from '@/lib/tickets/myWork';
import { CATEGORY_LABELS, locationText } from '@/lib/tickets/model';
import { MaintenanceTaskDialog } from '../tickets/MaintenanceTaskDialog';
import { TicketDetailPanel } from '../tickets/TicketDetailPanel';
import { type TicketLabels, useTicketLabels } from '../tickets/shared';

type Tab = 'today' | 'week' | 'pool';

/**
 * Bina gorevlisi "Islerim" (mobil oncelikli): atanan talepler ve bakim gorevleri tek listede.
 * Baslatma tek dokunus; cozum / tamamlama (not, kontrol listesi, fotograf) ayrinti panelinde.
 */
export function MyTasksPage() {
  const p = useTicketPermissions();
  const labels = useTicketLabels();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('today');
  const myTickets = useTicketList({ assignee: 'me', status: 'active', limit: 200 });
  const poolTickets = useTicketList({ assignee: 'none', status: 'active', limit: 200 });
  const myTasks = useMaintenanceTasks({ assignee: 'me', status: 'open' });
  const poolTasks = useMaintenanceTasks({ assignee: 'none', status: 'open' });
  const today = istanbulToday();

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
  const open = (k: 'ticket' | 'task', id: string) => setParams(k === 'ticket' ? { ticket: id } : { task: id });

  if (!p.isStaff && !p.canManage) return <Alert>Bu sayfa bina görevlisi içindir.</Alert>;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <h1 className="text-title font-bold">İşlerim</h1>
      <FilterChips
        label="İş listesi"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'today', label: 'Bugün', count: groups.today.length },
          { value: 'week', label: 'Bu hafta', count: groups.week.length },
          { value: 'pool', label: 'Havuz', count: groups.pool.length },
        ]}
      />
      {error && <Alert tone="danger">{errorMessage(error)}</Alert>}
      {pending ? (
        <Skeleton className="h-48" />
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-small text-muted">{tab === 'pool' ? 'Havuzda üstlenilecek iş yok.' : 'Bu listede iş yok.'}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((w) => (
            <li key={w.type === 'ticket' ? w.ticket.ticketId : w.task.taskId}>
              <WorkRow item={w} labels={labels} onOpen={open} />
            </li>
          ))}
        </ul>
      )}
      <TicketDetailPanel ticketId={params.get('ticket')} onClose={() => setParams({})} />
      <MaintenanceTaskDialog taskId={params.get('task')} onClose={() => setParams({})} onOpenTicket={(id) => setParams({ ticket: id })} />
    </div>
  );
}

function WorkRow({ item, labels, onOpen }: { item: WorkItem<Ticket, MaintenanceTask>; labels: TicketLabels; onOpen: (k: 'ticket' | 'task', id: string) => void }) {
  if (item.type === 'ticket') return <TicketRow ticket={item.ticket} labels={labels} onOpen={() => onOpen('ticket', item.ticket.ticketId)} />;
  return <TaskRow task={item.task} onOpen={() => onOpen('task', item.task.taskId)} />;
}

const rowClass = 'flex w-full items-center gap-3 rounded-xl border bg-surface/70 p-3 text-left shadow-xs';

function TicketRow({ ticket, labels, onOpen }: { ticket: Ticket; labels: TicketLabels; onOpen: () => void }) {
  const transition = useTransitionTicket(ticket.ticketId);
  return (
    <div className={`${rowClass} ${ticket.overdue ? 'border-danger/40' : 'border-border'}`}>
      <Wrench className="size-5 shrink-0 text-accent" aria-hidden="true" />
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 flex-col gap-1 text-left">
        <span className="text-xs text-muted">
          <span className="font-mono">{ticket.number}</span> · {CATEGORY_LABELS[ticket.category]}
        </span>
        <span className="font-medium">{ticket.title}</span>
        <span className="text-xs text-muted">{locationText(ticket.location, labels.unitLabel)}</span>
        <span className="flex flex-wrap gap-1.5">
          {ticket.priority !== 'normal' && <PriorityBadge priority={ticket.priority} />}
          <SlaBadge ticket={ticket} />
        </span>
      </button>
      {ticket.actions.includes('start') ? (
        <Button size="sm" loading={transition.isPending} onClick={() => transition.mutate({ version: ticket.version, action: 'start' })} aria-label={`${ticket.number} işe başla`}>
          <Play className="size-4" aria-hidden="true" />
          Başla
        </Button>
      ) : (
        <ChevronRight className="size-5 text-muted" aria-hidden="true" />
      )}
    </div>
  );
}

function TaskRow({ task, onOpen }: { task: MaintenanceTask; onOpen: () => void }) {
  const act = useTaskActions(task.taskId);
  return (
    <div className={`${rowClass} ${task.overdue ? 'border-danger/40' : 'border-border'}`}>
      <CalendarCheck className="size-5 shrink-0 text-success" aria-hidden="true" />
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 flex-col gap-1 text-left">
        <span className="text-xs text-muted">Bakım · {formatDate(task.dueDate)}</span>
        <span className="font-medium">{task.name}</span>
        {task.asset && <span className="text-xs text-muted">{task.asset}</span>}
        <span className="flex flex-wrap gap-1.5">
          <TaskStatusBadge status={task.status} overdue={task.overdue} />
          <span className="text-xs text-muted">{task.checklist.length} kontrol maddesi</span>
        </span>
      </button>
      {task.actions.includes('start') && task.actions.includes('complete') ? (
        <Button size="sm" loading={act.start.isPending} onClick={() => act.start.mutate(task.version)} aria-label={`${task.name} başla`}>
          <Play className="size-4" aria-hidden="true" />
          Başla
        </Button>
      ) : (
        <ChevronRight className="size-5 text-muted" aria-hidden="true" />
      )}
    </div>
  );
}
