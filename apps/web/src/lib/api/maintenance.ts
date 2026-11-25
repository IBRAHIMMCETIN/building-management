import { z } from 'zod';
import { SCHEDULE_UNITS, TASK_STATUSES, type ScheduleUnit } from '@/lib/maintenance/schedule';
import { TICKET_CATEGORIES, type TicketCategory, type TicketPriority } from '@/lib/tickets/model';
import { apiClient } from './client';
import { signedDownloadSchema } from './documentModel';
import { type NewCostInput, photoUploadSchema, putPhoto, ticketSchema, workCostsSchema } from './tickets';

/*
 * Faz 3 (O1-3) periyodik bakim - /api/maintenance (yonetim yazar; gorevli gorev akisinda; denetci okur).
 * Gorev kimligi `<dueDate>_<templateId>`. Masraf uclari O1-4 (talep ile ayni sozlesme).
 */

const checklistItem = z.object({ id: z.string(), text: z.string(), required: z.boolean() });
const schedule = z.object({ every: z.number().int(), unit: z.enum(SCHEDULE_UNITS), startDate: z.string() });

export const presetSchema = z.object({
  preset: z.string(),
  name: z.string(),
  category: z.enum(TICKET_CATEGORIES),
  every: z.number().int(),
  unit: z.enum(SCHEDULE_UNITS),
  checklist: z.array(z.string()),
  expenseAccountId: z.string().optional(),
  legalNote: z.string().optional(),
});
export type MaintenancePreset = z.infer<typeof presetSchema>;

export const templateSchema = z.object({
  templateId: z.string(),
  name: z.string(),
  kind: z.string(),
  category: z.enum(TICKET_CATEGORIES),
  asset: z.string().optional(),
  blockIds: z.array(z.string()).optional(),
  schedule,
  checklist: z.array(checklistItem),
  defaultAssigneeId: z.string().optional(),
  supplierAccountId: z.string().optional(),
  expenseAccountId: z.string().optional(),
  expectedCost: z.number().int().optional(),
  legalNote: z.string().optional(),
  leadDays: z.number().int(),
  status: z.enum(['active', 'archived']),
  version: z.number().int(),
});
export type MaintenanceTemplate = z.infer<typeof templateSchema>;

export const taskSchema = z.object({
  taskId: z.string(),
  templateId: z.string(),
  dueDate: z.string(),
  name: z.string(),
  kind: z.string(),
  category: z.enum(TICKET_CATEGORIES),
  asset: z.string().optional(),
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
  overdue: z.boolean().default(false),
  actions: z.array(z.string()).default([]),
  version: z.number().int(),
});
export type MaintenanceTask = z.infer<typeof taskSchema>;

export const calendarSchema = z.object({ month: z.string(), items: z.array(taskSchema), overdue: z.array(taskSchema) });
export type MaintenanceCalendar = z.infer<typeof calendarSchema>;

export type TemplateInput = {
  preset?: string;
  name?: string;
  category?: TicketCategory;
  asset?: string | null;
  schedule?: { every?: number; unit?: ScheduleUnit; startDate?: string };
  checklist?: (string | { text: string; required?: boolean })[];
  defaultAssigneeId?: string | null;
  supplierAccountId?: string | null;
  expenseAccountId?: string | null;
  expectedCost?: number | null;
  legalNote?: string | null;
  leadDays?: number;
};

export type CompleteTaskInput = {
  version: number;
  checklistResults: { id: string; ok: boolean; note?: string }[];
  note?: string;
  photos?: string[];
};

const enc = encodeURIComponent;
const B = '/api/maintenance';

export const maintenanceApi = {
  presets: (signal?: AbortSignal) => apiClient.get(`${B}/presets`, { signal, schema: z.object({ items: z.array(presetSchema) }) }),
  templates: (status: 'active' | 'archived' | 'all' = 'active', signal?: AbortSignal) =>
    apiClient.get(`${B}/templates`, { query: { status }, signal, schema: z.object({ items: z.array(templateSchema) }) }),
  createTemplate: (input: TemplateInput) => apiClient.post(`${B}/templates`, input, { schema: z.object({ template: templateSchema, generated: z.number().int() }) }),
  updateTemplate: (id: string, input: TemplateInput & { version: number }) =>
    apiClient.put(`${B}/templates/${enc(id)}`, input, { schema: z.object({ template: templateSchema }).loose() }),
  archiveTemplate: (id: string, version: number) =>
    apiClient.post(`${B}/templates/${enc(id)}/archive`, { version }, { schema: z.object({ template: templateSchema, tasksChanged: z.number().int() }) }),

  tasks: (q: { from?: string; to?: string; status?: string; assignee?: string; templateId?: string; overdue?: 'true' } = {}, signal?: AbortSignal) =>
    apiClient.get(`${B}/tasks`, { query: q, signal, schema: z.object({ items: z.array(taskSchema) }) }),
  calendar: (month: string, signal?: AbortSignal) => apiClient.get(`${B}/calendar`, { query: { month }, signal, schema: calendarSchema }),
  task: (id: string, signal?: AbortSignal) => apiClient.get(`${B}/tasks/${enc(id)}`, { signal, schema: z.object({ task: taskSchema }) }),
  assign: (id: string, input: { version: number; assigneeId: string | null }) => apiClient.post(`${B}/tasks/${enc(id)}/assign`, input, { schema: z.object({ task: taskSchema }) }),
  start: (id: string, version: number) => apiClient.post(`${B}/tasks/${enc(id)}/start`, { version }, { schema: z.object({ task: taskSchema }) }),
  complete: (id: string, input: CompleteTaskInput) =>
    apiClient.post(`${B}/tasks/${enc(id)}/complete`, input, { schema: z.object({ task: taskSchema, failedItems: z.number().int(), suggestTicket: z.boolean() }) }),
  skip: (id: string, input: { version: number; reason: string }) => apiClient.post(`${B}/tasks/${enc(id)}/skip`, input, { schema: z.object({ task: taskSchema }) }),
  openTicket: (id: string, input: { idempotencyKey: string; title?: string; description?: string; priority?: TicketPriority; photos?: string[] }) =>
    apiClient.post(`${B}/tasks/${enc(id)}/ticket`, input, { schema: z.object({ ticket: ticketSchema, replayed: z.boolean() }).loose() }),
  async uploadPhoto(file: File): Promise<string> {
    const upload = await apiClient.post(`${B}/photos/upload-url`, { contentType: file.type, size: file.size }, { schema: photoUploadSchema });
    return putPhoto(upload, file);
  },
  photo: (id: string, photoId: string) => apiClient.get(`${B}/tasks/${enc(id)}/photos/${enc(photoId)}`, { schema: signedDownloadSchema }),

  // O1-4
  costs: (id: string, signal?: AbortSignal) => apiClient.get(`${B}/tasks/${enc(id)}/costs`, { signal, schema: workCostsSchema }),
  addCost: (id: string, input: NewCostInput) => apiClient.post(`${B}/tasks/${enc(id)}/costs`, input, { schema: workCostsSchema }),
  unlinkCost: (id: string, expenseId: string, reason: string) =>
    apiClient.post(`${B}/tasks/${enc(id)}/costs/${enc(expenseId)}/unlink`, { reason }, { schema: workCostsSchema }),
};

