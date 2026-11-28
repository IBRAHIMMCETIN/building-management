import { z } from 'zod';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from '../tickets/model';

/*
 * Faz 3 (O1) ariza / talep (apps/api/src/modules/tickets): talep ve liste semalari (web + mobil ortak).
 *   /api/tickets          yonetim, gorevli, guvenlik, denetci (ince yetki serviste; `actions`)
 *   /api/portal/tickets   sakin
 * Olay, pano, masraf semalari ve uclar: apps/web/src/lib/api/tickets.ts, portalTickets.ts.
 */

const location = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unit'), unitId: z.string(), blockId: z.string().optional() }),
  z.object({ kind: z.literal('common'), area: z.string(), blockId: z.string().optional() }),
]);

/** v2: gorevlinin tahmini tutar notu (talep ve bakim gorevi). Deftere yazilmaz. */
export const staffEstimateSchema = z.object({ amount: z.number().int(), note: z.string().optional(), at: z.string(), by: z.string(), byRole: z.string().optional() });
export type StaffEstimate = z.infer<typeof staffEstimateSchema>;
export type EstimateInput = { version: number; amount: number | null; note?: string };

export const ticketSchema = z.object({
  ticketId: z.string(),
  number: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES),
  location,
  status: z.enum(TICKET_STATUSES),
  source: z.string(),
  createdByRole: z.string().optional(),
  createdAt: z.string(),
  createdBy: z.string().optional(),
  updatedAt: z.string().optional(),
  assigneeId: z.string().optional(),
  /** Sakin gorunumu: gorevli kimligi yerine yalnizca atanip atanmadigi. */
  assigned: z.boolean().optional(),
  maintenanceTaskId: z.string().optional(),
  dueAt: z.string(),
  resolvedAt: z.string().optional(),
  slaMet: z.boolean().optional(),
  closedAt: z.string().optional(),
  closeKind: z.enum(['confirmed', 'forced', 'auto']).optional(),
  cancelKind: z.enum(['withdrawn', 'rejected']).optional(),
  rating: z.object({ score: z.number().int(), note: z.string().optional() }).optional(),
  reopenCount: z.number().int().default(0),
  photoCount: z.number().int().default(0),
  costSummary: z.object({ total: z.number().int(), expenseIds: z.array(z.string()) }).optional(),
  /** v2: ekipman sicili baglantisi (sakin uclarina donmez). */
  equipmentId: z.string().optional(),
  /** v2: gorevlinin tahmini tutar notu (kurus; bilgi amacli; sakin uclarina donmez). */
  estimate: staffEstimateSchema.optional(),
  overdue: z.boolean().default(false),
  mine: z.boolean().default(false),
  actions: z.array(z.string()).default([]),
  canAssign: z.boolean().default(false),
  canEdit: z.boolean().default(false),
  canEstimate: z.boolean().default(false),
  version: z.number().int(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const ticketListSchema = z.object({ items: z.array(ticketSchema), total: z.number().int(), nextCursor: z.string().optional() });

/** Sakin listesi: acik (cozum bekleyen + onay bekleyen) ve kapanan. */
export const PORTAL_OPEN_STATUSES = 'open,assigned,in_progress,on_hold,resolved';
export const PORTAL_CLOSED_STATUSES = 'closed,cancelled';

/** Onayini bekleyen talep: cozuldu ve sakin onaylayabilir. */
export const awaitsMyConfirmation = (t: { status: string; actions: readonly string[] }) => t.status === 'resolved' && t.actions.includes('confirm');
