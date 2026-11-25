/** Gorevli "Islerim": atanan talepler + bakim gorevleri tek listede (saf gruplama). */

type TicketLike = { ticketId: string; priority: string; dueAt: string; overdue: boolean };
type TaskLike = { taskId: string; dueDate: string; overdue: boolean };

export type WorkItem<T extends TicketLike, K extends TaskLike> = { type: 'ticket'; at: string; urgent: boolean; ticket: T } | { type: 'task'; at: string; urgent: boolean; task: K };

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/** Acil / geciken once, sonra hedef tarihe gore. */
function sortItems<T extends TicketLike, K extends TaskLike>(items: WorkItem<T, K>[]): WorkItem<T, K>[] {
  return items.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.at.localeCompare(b.at));
}

const ticketItem = <T extends TicketLike>(t: T) => ({ type: 'ticket' as const, at: t.dueAt.slice(0, 10), urgent: t.overdue || t.priority === 'urgent', ticket: t });
const taskItem = <K extends TaskLike>(t: K) => ({ type: 'task' as const, at: t.dueDate, urgent: t.overdue, task: t });

/**
 * - today: bana atanan acik talepler + vadesi bugun ya da gecmis bakimlarim
 * - week:  onumuzdeki 7 gune dusen bakimlarim
 * - pool:  atanmamis acik talepler ve bakimlar (kendine ustlenme acikken)
 */
export function groupMyWork<T extends TicketLike, K extends TaskLike>(
  input: { myTickets: readonly T[]; myTasks: readonly K[]; poolTickets: readonly T[]; poolTasks: readonly K[] },
  today: string,
) {
  const weekEnd = addDays(today, 7);
  return {
    today: sortItems<T, K>([...input.myTickets.map(ticketItem), ...input.myTasks.filter((t) => t.dueDate <= today).map(taskItem)]),
    week: sortItems<T, K>(input.myTasks.filter((t) => t.dueDate > today && t.dueDate <= weekEnd).map(taskItem)),
    pool: sortItems<T, K>([...input.poolTickets.map(ticketItem), ...input.poolTasks.filter((t) => t.dueDate <= weekEnd).map(taskItem)]),
  };
}
