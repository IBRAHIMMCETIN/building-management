import { z } from 'zod';
import { TICKET_CATEGORIES, TICKET_STATUSES } from '../tickets/model';
import { staffEstimateSchema, ticketSchema } from './tickets';

/*
 * Bina gorevlisi "İşlerim": talep ayrintisi (olaylar), fotograf yukleme ve periyodik bakim gorevi
 * (apps/api/src/modules/tickets, maintenance; web karsiliklari: apps/web/src/lib/api/tickets.ts,
 * maintenance.ts, lib/maintenance/schedule.ts, lib/tickets/myWork.ts, MaintenanceTaskDialog
 * `checklistErrors`). Yetki ve gecis kararlarini API verir (`actions`).
 */

export const ticketEventSchema = z.object({
  eventId: z.string(),
  kind: z.string(),
  visibility: z.enum(['public', 'internal']),
  at: z.string(),
  by: z.string().optional(),
  byRole: z.string().optional(),
  mine: z.boolean().optional(),
  from: z.enum(TICKET_STATUSES).optional(),
  to: z.enum(TICKET_STATUSES).optional(),
  assigneeId: z.string().optional(),
  body: z.string().optional(),
  changes: z.record(z.string(), z.tuple([z.unknown(), z.unknown()])).optional(),
  photoKeys: z.array(z.string()).optional(),
  rating: z.number().optional(),
  amount: z.number().optional(),
  expenseId: z.string().optional(),
  transactionId: z.string().optional(),
});
export type TicketEvent = z.infer<typeof ticketEventSchema>;

export const ticketDetailSchema = z.object({ ticket: ticketSchema, events: z.array(ticketEventSchema) });
export type TicketDetail = z.infer<typeof ticketDetailSchema>;
export const ticketOneSchema = z.object({ ticket: ticketSchema });

export const assigneesSchema = z.object({ items: z.array(z.object({ userId: z.string(), name: z.string() })) });

/** Imzali S3 yukleme linki (talep / bakim fotografi): istemci dosyayi dogrudan PUT eder. */
export const photoUploadSchema = z.object({ uploadId: z.string(), uploadUrl: z.string(), headers: z.record(z.string(), z.string()).default({}) });
export type PhotoUpload = z.infer<typeof photoUploadSchema>;

/** API kabul ettigi fotograf turleri ve siniri (meters/common.ts, tickets/photos.ts). */
export const PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_PHOTOS_PER_EVENT = 6;

// ---------------------------------------------------------------------------
// Periyodik bakim gorevi
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ['scheduled', 'in_progress', 'done', 'skipped', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  scheduled: 'Planlandı',
  in_progress: 'Yapılıyor',
  done: 'Tamamlandı',
  skipped: 'Atlandı',
  cancelled: 'İptal',
};
export const TASK_STATUS_TONES: Record<TaskStatus, 'neutral' | 'success' | 'warning' | 'accent' | 'danger'> = {
  scheduled: 'neutral',
  in_progress: 'accent',
  done: 'success',
  skipped: 'warning',
  cancelled: 'neutral',
};

const checklistItem = z.object({ id: z.string(), text: z.string(), required: z.boolean() });

export const taskSchema = z.object({
  taskId: z.string(),
  templateId: z.string(),
  dueDate: z.string(),
  name: z.string(),
  kind: z.string(),
  category: z.enum(TICKET_CATEGORIES),
  asset: z.string().optional(),
  equipmentId: z.string().optional(),
  checklist: z.array(checklistItem),
  status: z.enum(TASK_STATUSES),
  assigneeId: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  completedBy: z.string().optional(),
  checklistResults: z.array(z.object({ id: z.string(), ok: z.boolean(), note: z.string().optional() })).optional(),
  note: z.string().optional(),
  photoKeys: z.array(z.string()).optional(),
  skipReason: z.string().optional(),
  cancelReason: z.string().optional(),
  ticketIds: z.array(z.string()).default([]),
  costSummary: z.object({ total: z.number().int(), expenseIds: z.array(z.string()) }).optional(),
  estimate: staffEstimateSchema.optional(),
  overdue: z.boolean().default(false),
  actions: z.array(z.string()).default([]),
  version: z.number().int(),
});
export type MaintenanceTask = z.infer<typeof taskSchema>;
export const taskListSchema = z.object({ items: z.array(taskSchema) });
export const taskOneSchema = z.object({ task: taskSchema });
export const taskCompleteSchema = z.object({ task: taskSchema, failedItems: z.number().int(), suggestTicket: z.boolean() });

export type CompleteTaskInput = {
  version: number;
  checklistResults: { id: string; ok: boolean; note?: string }[];
  note?: string;
  photos?: string[];
};

export type ChecklistAnswer = { id: string; ok: boolean | null; note: string };

/** Tamamlama formu dogrulamasi (API kurali: zorunlu maddeler cevaplanir; basarisiz maddede not). */
export function checklistErrors(task: Pick<MaintenanceTask, 'checklist'>, results: readonly ChecklistAnswer[]): string | null {
  for (const item of task.checklist) {
    const r = results.find((x) => x.id === item.id);
    if (item.required && (r?.ok === null || r?.ok === undefined)) return `Zorunlu madde cevaplanmadı: ${item.text}`;
    if (r?.ok === false && r.note.trim().length < 3) return `Başarısız madde için açıklama gerekli: ${item.text}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// İşlerim gruplamasi
// ---------------------------------------------------------------------------

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
