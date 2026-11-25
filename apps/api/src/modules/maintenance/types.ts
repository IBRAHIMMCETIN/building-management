/**
 * Faz 3 (O1-3) - Periyodik bakim. Tek tablo, `PK = APT#<apartmentId>`:
 *
 *   MTPL#<templateId>                     bakim sablonu (surumlu)
 *   MTASK#<dueDate>#<templateId>          bakim gorevi (surumlu); anahtar ayni zamanda idempotency
 *                                         anahtaridir: ayni sablonun ayni gune ikinci gorevi olamaz
 *
 * Hicbir kayit silinmez (Lambda'larin DeleteItem yetkisi yok): sablon arsivlenir, artik istenmeyen
 * gelecek gorev `cancelled` olur.
 */
import type { AuditFields, IsoDate, IsoDateTime, TableKeys } from '../core/types.js';
import type { TicketCategory } from '../tickets/types.js';

export const SCHEDULE_UNITS = ['week', 'month', 'year'] as const;
export type ScheduleUnit = (typeof SCHEDULE_UNITS)[number];

/** `every` birimde bir; ilk tekrar `startDate`. Ay/yil adiminda gun, ayin son gunune sabitlenir. */
export type MaintenanceSchedule = { every: number; unit: ScheduleUnit; startDate: IsoDate };

export type ChecklistItem = { id: string; text: string; required: boolean };
export type ChecklistResult = { id: string; ok: boolean; note?: string };

export type MaintenanceTemplate = TableKeys &
  AuditFields & {
    entityType: 'MAINT_TEMPLATE';
    apartmentId: string;
    templateId: string;
    name: string;
    /** Hazir sablon kimligi veya `custom`. */
    kind: string;
    /** Bakimdan acilan arizanin kategorisi ve (O1-4) varsayilan gider hesabi icin. */
    category: TicketCategory;
    /** Ekipman / yer (orn. "B Blok asansoru"); ekipman sicili v2. */
    asset?: string;
    blockIds?: string[];
    schedule: MaintenanceSchedule;
    checklist: ChecklistItem[];
    defaultAssigneeId?: string;
    /** O1-4: tedarikci carisi (payable) ve gider hesabi; masraf formunu doldurur. */
    supplierAccountId?: string;
    expenseAccountId?: string;
    /** Tahmini maliyet (kurus). */
    expectedCost?: number;
    /** Mevzuat notu (metin; yasal yukumluluk hesaplanmaz). */
    legalNote?: string;
    /** Gorev vadesinden kac gun once hazirlansin / bildirimde "yaklasan" sayilsin. */
    leadDays: number;
    status: 'active' | 'archived';
  };

export const TASK_STATUSES = ['scheduled', 'in_progress', 'done', 'skipped', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** Islemi suren (gecikme hesabina giren) durumlar. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['scheduled', 'in_progress'];

export type MaintenanceTask = TableKeys &
  AuditFields & {
    entityType: 'MAINT_TASK';
    apartmentId: string;
    /** `<dueDate>_<templateId>` (URL guvenli). */
    taskId: string;
    templateId: string;
    templateVersion: number;
    dueDate: IsoDate;
    /** Sablondan kopya (gorev olusurken). */
    name: string;
    kind: string;
    category: TicketCategory;
    asset?: string;
    blockIds?: string[];
    checklist: ChecklistItem[];
    status: TaskStatus;
    assigneeId?: string;
    startedAt?: IsoDateTime;
    startedBy?: string;
    completedAt?: IsoDateTime;
    completedBy?: string;
    checklistResults?: ChecklistResult[];
    note?: string;
    photoKeys?: string[];
    skipReason?: string;
    /** `cancelled`: sablon degisti / arsivlendi. */
    cancelReason?: string;
    /** Gorevden acilan arizalar. */
    ticketIds: string[];
    /** O1-4: bagli masraflar. */
    costSummary?: { total: number; expenseIds: string[] };
  };

export const maintenanceKeys = {
  template: (apartmentId: string, templateId: string): TableKeys => ({ PK: `APT#${apartmentId}`, SK: `MTPL#${templateId}` }),
  task: (apartmentId: string, dueDate: IsoDate, templateId: string): TableKeys => ({ PK: `APT#${apartmentId}`, SK: `MTASK#${dueDate}#${templateId}` }),
};
export const TEMPLATE_PREFIX = 'MTPL#';
export const TASK_PREFIX = 'MTASK#';

export const taskIdOf = (dueDate: IsoDate, templateId: string) => `${dueDate}_${templateId}`;
export function parseTaskId(taskId: string): { dueDate: IsoDate; templateId: string } | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})_([A-Za-z0-9-]{1,40})$/.exec(taskId);
  return m ? { dueDate: m[1] as IsoDate, templateId: m[2] as string } : undefined;
}
