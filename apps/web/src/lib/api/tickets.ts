import { type EstimateInput, photoUploadSchema, similarSchema, ticketDetailSchema, ticketEventSchema, ticketListSchema, ticketSchema } from '@bm/shared/api/tickets';
import { z } from 'zod';
import { TICKET_STATUSES, type TicketCategory, type TicketPriority, type TransitionAction } from '@/lib/tickets/model';
import { apiClient } from './client';
import { signedDownloadSchema } from './documentModel';
import { ApiError } from './errors';

/*
 * Faz 3 (O1) ariza / talep (apps/api/src/modules/tickets, workcosts):
 *   /api/tickets          yonetim, gorevli, guvenlik, denetci (ince yetki serviste; `actions`)
 *   /api/tickets/:id/costs, /charges   O1-4 masraf ve daireye yansitma (yonetim; denetci okur)
 *   /api/portal/tickets   sakin (bkz. portalTickets.ts)
 * Tutarlar kurus.
 * Talep, liste, olay / ayrinti, foto yukleme ve benzer talep semalari web + mobil ortak:
 * packages/shared/src/api/tickets.ts (bu dosya eski import yollari icin yeniden disa aktarir).
 */
export {
  type EstimateInput,
  type SimilarTicket,
  type StaffEstimate,
  type Ticket,
  type TicketDetail,
  type TicketEvent,
  photoUploadSchema,
  similarSchema,
  staffEstimateSchema,
  ticketDetailSchema,
  ticketEventSchema,
  ticketListSchema,
  ticketSchema,
} from '@bm/shared/api/tickets';

export const boardSchema = z.object({
  columns: z.array(z.object({ status: z.enum(TICKET_STATUSES), count: z.number().int(), items: z.array(ticketSchema) })),
  overdueCount: z.number().int(),
  urgentOpenCount: z.number().int(),
  closedLast30Days: z.number().int(),
  settings: z.object({ staffSelfAssign: z.boolean(), autoCloseDays: z.number().int() }).loose().optional(),
});
export type TicketBoard = z.infer<typeof boardSchema>;

export const assigneesSchema = z.object({ items: z.array(z.object({ userId: z.string(), name: z.string() })) });

// --- O1-4 masraflar -------------------------------------------------------

const costItem = z.object({
  expenseId: z.string(),
  transactionId: z.string(),
  amount: z.number().int(),
  mode: z.enum(['expense', 'link']),
  date: z.string(),
  description: z.string(),
  linkedAt: z.string(),
  linkedBy: z.string(),
  reversed: z.boolean(),
  expenseAccountId: z.string().optional(),
  creditAccountId: z.string().optional(),
  supplier: z.string().optional(),
  invoiceNumber: z.string().optional(),
  hasInvoice: z.boolean().optional(),
});
const recharge = z.object({
  transactionId: z.string(),
  amount: z.number().int(),
  unitId: z.string(),
  liableParty: z.enum(['owner', 'occupant']),
  requestedParty: z.enum(['owner', 'occupant']),
  dueDate: z.string(),
  description: z.string(),
  at: z.string(),
  by: z.string(),
  reversed: z.boolean(),
});
export const workCostsSchema = z.object({
  target: z.object({ kind: z.enum(['ticket', 'maintenance']), id: z.string(), label: z.string(), status: z.string(), unitId: z.string().optional() }),
  items: z.array(costItem),
  recharges: z.array(recharge),
  total: z.number().int(),
  rechargedTotal: z.number().int(),
  rechargeable: z.number().int(),
  suggestion: z.object({ expenseAccountId: z.string(), creditAccountId: z.string().optional() }),
  replayed: z.boolean().optional(),
  /** Tek adimda gider + yansitma: yansitma sonucu (basarili) veya hatasi (gider yine kaydedildi). */
  recharge: z.object({ transactionId: z.string(), liableParty: z.enum(['owner', 'occupant']), vacant: z.boolean().optional() }).optional(),
  rechargeError: z.string().optional(),
});
export type WorkCosts = z.infer<typeof workCostsSchema>;
export type CostItem = WorkCosts['items'][number];

export type NewCostInput =
  | {
      mode: 'expense';
      idempotencyKey: string;
      amount: number;
      expenseAccountId?: string;
      creditAccountId?: string;
      date?: string;
      description?: string;
      supplier?: string;
      invoiceNumber?: string;
      /** Yalnizca daire ici talep: gider kaydinin ardindan ayni tutar daireye yansitilir. */
      recharge?: { liableParty: 'owner' | 'occupant'; dueDate: string };
    }
  | { mode: 'link'; idempotencyKey: string; expenseId: string };

export type ChargeInput = {
  idempotencyKey: string;
  confirm: true;
  liableParty: 'owner' | 'occupant';
  amount: number;
  dueDate: string;
  description?: string;
};

// --- Istekler -------------------------------------------------------------

export type TicketListQuery = {
  status?: string;
  assignee?: string;
  category?: string;
  priority?: string;
  overdue?: 'true';
  q?: string;
  equipmentId?: string;
  cursor?: string;
  limit?: number;
};

export type CreateTicketInput = {
  idempotencyKey: string;
  title: string;
  description: string;
  category: TicketCategory;
  priority?: TicketPriority;
  location: { kind: 'unit'; unitId: string } | { kind: 'common'; area: string; blockId?: string };
  photos?: string[];
  /** v2: yonetim ve gorevli (ayni apartmanin ekipmani). */
  equipmentId?: string;
};

export type UpdateTicketInput = { version: number; title?: string; description?: string; category?: TicketCategory; priority?: TicketPriority; equipmentId?: string | null };

const enc = encodeURIComponent;
const T = '/api/tickets';

/** Imzali S3 linkine dogrudan PUT (dosya API'den gecmez). */
export async function putPhoto(upload: z.infer<typeof photoUploadSchema>, file: File): Promise<string> {
  let res: Response;
  try {
    res = await fetch(upload.uploadUrl, { method: 'PUT', headers: upload.headers, body: file });
  } catch {
    throw new ApiError(0, { error: 'upload_failed', message: 'Fotoğraf yüklenemedi: bağlantı hatası.' });
  }
  if (!res.ok) throw new ApiError(res.status, { error: 'upload_failed', message: `Fotoğraf yüklenemedi (${res.status}).` });
  return upload.uploadId;
}

export const ticketsApi = {
  list: (q: TicketListQuery = {}, signal?: AbortSignal) => apiClient.get(T, { query: q, signal, schema: ticketListSchema }),
  board: (signal?: AbortSignal) => apiClient.get(`${T}/board`, { signal, schema: boardSchema }),
  assignees: (signal?: AbortSignal) => apiClient.get(`${T}/assignees`, { signal, schema: assigneesSchema }),
  get: (id: string, signal?: AbortSignal) => apiClient.get(`${T}/${enc(id)}`, { signal, schema: ticketDetailSchema }),
  create: (input: CreateTicketInput) => apiClient.post(T, input, { schema: z.object({ ticket: ticketSchema, replayed: z.boolean() }) }),
  update: (id: string, input: UpdateTicketInput) => apiClient.patch(`${T}/${enc(id)}`, input, { schema: z.object({ ticket: ticketSchema }) }),
  /** v2: tahmini tutar notu (`amount: null` kaldirir). */
  estimate: (id: string, input: EstimateInput) => apiClient.put(`${T}/${enc(id)}/estimate`, input, { schema: z.object({ ticket: ticketSchema }) }),
  assign: (id: string, input: { version: number; assigneeId: string | null; note?: string }) =>
    apiClient.post(`${T}/${enc(id)}/assign`, input, { schema: z.object({ ticket: ticketSchema }) }),
  transition: (id: string, input: { version: number; action: TransitionAction; note?: string; photos?: string[] }) =>
    apiClient.post(`${T}/${enc(id)}/status`, input, { schema: z.object({ ticket: ticketSchema }) }),
  comment: (id: string, input: { body: string; visibility: 'public' | 'internal'; photos?: string[] }) =>
    apiClient.post(`${T}/${enc(id)}/comments`, input, { schema: z.object({ event: ticketEventSchema }) }),
  async uploadPhoto(file: File): Promise<string> {
    const upload = await apiClient.post(`${T}/photos/upload-url`, { contentType: file.type, size: file.size }, { schema: photoUploadSchema });
    return putPhoto(upload, file);
  },
  photo: (id: string, photoId: string) => apiClient.get(`${T}/${enc(id)}/photos/${enc(photoId)}`, { schema: signedDownloadSchema }),
  similar: (q: { category?: string; blockId?: string }, signal?: AbortSignal) => apiClient.get(`${T}/similar`, { query: q, signal, schema: similarSchema }),

  // O1-4
  costs: (id: string, signal?: AbortSignal) => apiClient.get(`${T}/${enc(id)}/costs`, { signal, schema: workCostsSchema }),
  addCost: (id: string, input: NewCostInput) => apiClient.post(`${T}/${enc(id)}/costs`, input, { schema: workCostsSchema }),
  unlinkCost: (id: string, expenseId: string, reason: string) =>
    apiClient.post(`${T}/${enc(id)}/costs/${enc(expenseId)}/unlink`, { reason }, { schema: workCostsSchema }),
  charge: (id: string, input: ChargeInput) => apiClient.post(`${T}/${enc(id)}/charges`, input, { schema: workCostsSchema }),
};

export const expenseOptionsSchema = z.object({
  items: z.array(
    z.object({
      expenseId: z.string(),
      date: z.string(),
      description: z.string(),
      amount: z.number().int(),
      expenseAccountId: z.string(),
      supplier: z.string().optional(),
      invoiceNumber: z.string().optional(),
      linkedTo: z.object({ type: z.enum(['ticket', 'maintenance']), id: z.string(), label: z.string() }).optional(),
    }),
  ),
});
export type ExpenseOption = z.infer<typeof expenseOptionsSchema>['items'][number];

/** O1-4: baglanabilir giderler (yonetim). */
export const expenseOptionsApi = {
  list: (signal?: AbortSignal) => apiClient.get('/api/tickets/costs/expense-options', { signal, schema: expenseOptionsSchema }),
};
