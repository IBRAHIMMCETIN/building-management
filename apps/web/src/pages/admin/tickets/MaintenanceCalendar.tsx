import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { TaskStatusBadge } from '@/components/tickets/TicketBadges';
import { Alert, Button, Card, CardTitle, FilterChips, Skeleton } from '@/components/ui';
import { useMaintenanceCalendar } from '@/hooks/useMaintenance';
import { errorMessage } from '@/lib/api/errors';
import type { MaintenanceTask } from '@/lib/api/maintenance';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import { WEEKDAYS_SHORT, addMonth, istanbulToday, monthGrid, monthLabel } from '@/lib/maintenance/schedule';

type View = 'month' | 'list';

/** Ay gorunumu (gun hucresinde gorev rozetleri) ve liste; gecikenler ustte. */
export function MaintenanceCalendar({ onOpen }: { onOpen: (taskId: string) => void }) {
  const today = istanbulToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [view, setView] = useState<View>('month');
  const cal = useMaintenanceCalendar(month);
  const byDay = useMemo(() => {
    const m = new Map<string, MaintenanceTask[]>();
    for (const t of cal.data?.items ?? []) m.set(t.dueDate, [...(m.get(t.dueDate) ?? []), t]);
    return m;
  }, [cal.data]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="secondary" aria-label="Önceki ay" onClick={() => setMonth(addMonth(month, -1))}>
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Button>
        <h3 className="min-w-36 text-center text-small font-semibold capitalize">{monthLabel(month)}</h3>
        <Button size="sm" variant="secondary" aria-label="Sonraki ay" onClick={() => setMonth(addMonth(month, 1))}>
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
        {month !== today.slice(0, 7) && (
          <Button size="sm" variant="ghost" onClick={() => setMonth(today.slice(0, 7))}>
            Bugün
          </Button>
        )}
        <div className="ml-auto">
          <FilterChips label="Görünüm" value={view} onChange={setView} options={[{ value: 'month', label: 'Ay' }, { value: 'list', label: 'Liste' }]} />
        </div>
      </div>

      {cal.isPending ? (
        <Skeleton className="h-80" />
      ) : cal.isError ? (
        <Alert tone="danger">{errorMessage(cal.error)}</Alert>
      ) : (
        <>
          {cal.data.overdue.length > 0 && (
            <Card className="flex flex-col gap-2 border-danger/30 p-4 md:p-4">
              <CardTitle className="text-small text-danger md:text-small">Geciken bakımlar ({cal.data.overdue.length})</CardTitle>
              <TaskList tasks={cal.data.overdue} onOpen={onOpen} />
            </Card>
          )}
          {view === 'list' ? (
            cal.data.items.length === 0 ? (
              <p className="py-6 text-center text-small text-muted">Bu ay planlı bakım yok.</p>
            ) : (
              <TaskList tasks={cal.data.items} onOpen={onOpen} />
            )
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[42rem] table-fixed border-collapse text-xs">
                <caption className="sr-only">{monthLabel(month)} bakım takvimi</caption>
                <thead>
                  <tr>
                    {WEEKDAYS_SHORT.map((d) => (
                      <th key={d} scope="col" className="py-1 font-medium text-muted">
                        {d}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {monthGrid(month).map((week, i) => (
                    <tr key={i}>
                      {week.map((day, j) => (
                        <td key={j} className={cn('h-24 border border-border p-1 align-top', !day && 'bg-surface-muted/30', day === today && 'bg-accent/5')}>
                          {day && (
                            <div className="flex h-full flex-col gap-1">
                              <span className={cn('text-[11px] tabular-nums text-muted', day === today && 'font-bold text-accent')}>{Number(day.slice(8))}</span>
                              {(byDay.get(day) ?? []).map((t) => (
                                <button
                                  key={t.taskId}
                                  type="button"
                                  onClick={() => onOpen(t.taskId)}
                                  title={t.name}
                                  className={cn(
                                    'truncate rounded px-1 py-0.5 text-left text-[11px] font-medium',
                                    t.overdue ? 'bg-danger/10 text-danger' : t.status === 'done' ? 'bg-success/10 text-success line-through' : t.status === 'skipped' ? 'bg-warning/10 text-warning' : 'bg-accent/10 text-accent',
                                  )}
                                >
                                  {t.name}
                                </button>
                              ))}
                            </div>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function TaskList({ tasks, onOpen }: { tasks: readonly MaintenanceTask[]; onOpen: (taskId: string) => void }) {
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border text-small">
      {tasks.map((t) => (
        <li key={t.taskId}>
          <button type="button" onClick={() => onOpen(t.taskId)} className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-surface-muted/40">
            <span className="w-24 tabular-nums text-muted">{formatDate(t.dueDate)}</span>
            <span className="min-w-0 flex-1 truncate font-medium">
              {t.name}
              {t.asset ? <span className="font-normal text-muted"> · {t.asset}</span> : null}
            </span>
            <TaskStatusBadge status={t.status} overdue={t.overdue} />
          </button>
        </li>
      ))}
    </ul>
  );
}
