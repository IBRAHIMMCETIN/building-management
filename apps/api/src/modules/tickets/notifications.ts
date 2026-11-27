/**
 * Faz 3 (O1-2) - Ariza / talep olaylarindan alici cozumleme (saf; notification worker kullanir).
 *
 *  TICKET_CREATED         -> yonetim (yonetici + firma); acil talepte ayrica bina gorevlileri;
 *                            daire ici yapisal/tesisat/isitma talebinde dairenin kat malikleri
 *  TICKET_ASSIGNED        -> atanan gorevli
 *  TICKET_STATUS_CHANGED  -> islemde / beklemede / cozuldu / iptal / zorla-otomatik kapanis: talep
 *                            tarafi (acan sakin + dairenin guncel uyeleri). Yeniden acma: atanan
 *                            gorevli (yoksa yonetim). Sakin onayi veya sakinin geri cekmesi:
 *                            atanan gorevli.
 *  TICKET_COMMENTED       -> sakin yazdiysa atanan gorevli (yoksa yonetim); yonetim / gorevli
 *                            yazdiysa talep tarafi. Ic notlar olay uretmez.
 *
 * Islemi yapan kisiye bildirim gitmez. Gorevli ve yonetim alicilari yalnizca o gun aktif rol
 * kaydi olanlardir; sakinler o gun gecerli uyelik kaydi olanlardir.
 */
import type { ApartmentRole } from '../apartment-roles/types.js';
import type { IsoDate } from '../core/types.js';
import type { DomainEvent, TicketEventPayload } from '../../events/publisher.js';
import type { NotificationData, NotificationTemplate } from '../notifications/notifier.js';
import type { UnitMembership } from '../portal/types.js';
import { OWNER_CATEGORIES, type TicketCategory } from './types.js';

export type TicketRecipient = { userId: string; template: NotificationTemplate; data: NotificationData };

type TicketDomainEvent = Extract<DomainEvent, { type: 'TICKET_CREATED' | 'TICKET_ASSIGNED' | 'TICKET_STATUS_CHANGED' | 'TICKET_COMMENTED' }>;

export const isTicketEvent = (e: DomainEvent): e is TicketDomainEvent => e.type.startsWith('TICKET_');

const activeOn = (x: { status: string; startDate: IsoDate; endDate?: IsoDate }, day: IsoDate) => x.status === 'active' && x.startDate <= day && (!x.endDate || x.endDate >= day);

export function ticketRecipients(event: TicketDomainEvent, memberships: readonly UnitMembership[], roles: readonly ApartmentRole[], day: IsoDate): TicketRecipient[] {
  const p: TicketEventPayload = event.payload;
  const actor = event.actorId;
  const currentRoles = roles.filter((r) => r.apartmentId === event.apartmentId && activeOn(r, day));
  const managers = currentRoles.filter((r) => r.role === 'apartment_manager' || r.role === 'management_company').map((r) => r.userId);
  const staff = currentRoles.filter((r) => r.role === 'building_staff').map((r) => r.userId);
  const members = memberships.filter((m) => m.apartmentId === event.apartmentId && activeOn(m, day));
  const unitMembers = p.location.kind === 'unit' ? members.filter((m) => m.unitId === p.location.unitId) : [];
  // Talep tarafi: acan sakin (hala uyeyse) + daire ici talepte dairenin guncel uyeleri.
  const requesterSide = new Set<string>(unitMembers.map((m) => m.userId));
  if (p.createdByKind === 'resident' && members.some((m) => m.userId === p.createdBy)) requesterSide.add(p.createdBy);
  if (p.createdByKind === 'security' && currentRoles.some((r) => r.userId === p.createdBy)) requesterSide.add(p.createdBy);
  const assignee = p.assigneeId && staff.includes(p.assigneeId) ? p.assigneeId : undefined;

  const base = {
    ticketId: p.ticketId,
    number: p.number,
    title: p.title,
    category: p.category,
    priority: p.priority,
    unitId: p.location.unitId,
    area: p.location.area,
  };
  const out = new Map<string, TicketRecipient>();
  const add = (userIds: Iterable<string>, template: NotificationTemplate, link: 'admin' | 'portal', extra: TicketRecipient['data'] = {}) => {
    for (const userId of userIds) {
      if (userId === actor || out.has(userId)) continue;
      out.set(userId, { userId, template, data: { ...base, link, ...extra } });
    }
  };

  switch (event.type) {
    case 'TICKET_CREATED': {
      add(managers, 'ticket_created', 'admin');
      if (p.priority === 'urgent') add(staff, 'ticket_created', 'admin');
      if (p.location.kind === 'unit' && OWNER_CATEGORIES.includes(p.category as TicketCategory)) {
        add(unitMembers.filter((m) => m.relation === 'owner').map((m) => m.userId), 'ticket_created', 'portal');
      }
      break;
    }
    case 'TICKET_ASSIGNED':
      if (assignee) add([assignee], 'ticket_assigned', 'admin');
      break;
    case 'TICKET_STATUS_CHANGED': {
      const to = p.to ?? '';
      if (p.action === 'reopen') {
        add(assignee ? [assignee] : managers, 'ticket_reopened', 'admin');
        add(requesterSide, 'ticket_status', 'portal', { to });
      } else if (p.action === 'confirm' || (p.action === 'cancel' && p.cancelKind === 'withdrawn')) {
        if (assignee) add([assignee], 'ticket_status', 'admin', { to, closeKind: p.closeKind, cancelKind: p.cancelKind });
      } else if (to === 'resolved') {
        add(requesterSide, 'ticket_resolved', 'portal');
      } else if (to === 'in_progress' || to === 'on_hold' || to === 'cancelled' || to === 'closed') {
        add(requesterSide, 'ticket_status', 'portal', { to, closeKind: p.closeKind, cancelKind: p.cancelKind });
        if (to === 'cancelled' && assignee) add([assignee], 'ticket_status', 'admin', { to, cancelKind: p.cancelKind });
      }
      break;
    }
    case 'TICKET_COMMENTED': {
      if (p.actorKind === 'resident') add(assignee ? [assignee] : managers, 'ticket_comment', 'admin');
      else {
        add(requesterSide, 'ticket_comment', 'portal');
        // Yonetici yazdiysa gorevli, gorevli yazdiysa yonetim gorur (ekip ici akis).
        if (p.actorKind === 'manager' && assignee) add([assignee], 'ticket_comment', 'admin');
      }
      break;
    }
  }
  // Sakin tarafinda yonetim / gorevli olan kisi (ornegin yonetici kendi dairesi icin) yonetim baglantisi alir.
  for (const r of out.values()) if (r.data.link === 'portal' && !members.some((m) => m.userId === r.userId)) r.data.link = 'admin';
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// O1-3: gunluk operasyon ozeti
// ---------------------------------------------------------------------------

type DigestEvent = Extract<DomainEvent, { type: 'OPERATIONS_DIGEST' }>;

const PRIORITY_TEXT: Record<string, string> = { low: 'düşük', normal: 'normal', high: 'yüksek', urgent: 'ACİL' };
const trDate = (d: string) => d.slice(0, 10).split('-').reverse().join('.');

const EXPIRY_TEXT: Record<string, string> = { warranty: 'Garanti', contract: 'Servis sözleşmesi', inspection: 'Periyodik kontrol' };

/**
 * Yonetim (yonetici + firma) tum kalemleri; bina gorevlisi SLA'si asilmis kendi taleplerini ve
 * kendisine atanmis ya da atanmamis bakim gorevlerini alir. Ekipman son tarihleri (v2: garanti,
 * servis sozlesmesi, periyodik kontrol) yalnizca yonetime gider. Kalemi olmayana bildirim gitmez.
 */
export function operationsDigestRecipients(event: DigestEvent, roles: readonly ApartmentRole[], day: IsoDate): TicketRecipient[] {
  const p = event.payload;
  const current = roles.filter((r) => r.apartmentId === event.apartmentId && activeOn(r, day));
  const managers = [...new Set(current.filter((r) => r.role === 'apartment_manager' || r.role === 'management_company').map((r) => r.userId))];
  const staff = [...new Set(current.filter((r) => r.role === 'building_staff').map((r) => r.userId))].filter((id) => !managers.includes(id));
  const out: TicketRecipient[] = [];
  type Equip = NonNullable<typeof p.equipmentExpiring>;
  const build = (userId: string, sla: typeof p.slaBreached, due: typeof p.maintenanceDue, overdue: typeof p.maintenanceOverdue, autoClosed: number, equipment: Equip) => {
    if (!sla.length && !due.length && !overdue.length && !autoClosed && !equipment.length) return;
    // Olaydaki liste 100 kalemle sinirli; sayi kesilmeden onceki toplamdir.
    const equipmentCount = equipment.length ? Math.max(p.equipmentTotal ?? 0, equipment.length) : 0;
    out.push({
      userId,
      template: 'operations_digest',
      data: {
        date: p.date,
        link: 'admin',
        slaCount: sla.length,
        dueCount: due.length,
        overdueCount: overdue.length,
        autoClosed,
        equipmentCount,
        ...(equipment.length && p.equipmentWeekly ? { equipmentWeekly: 1 } : {}),
        sla: sla.map((t) => ({ label: `${t.number} ${t.title}`, detail: `${PRIORITY_TEXT[t.priority] ?? t.priority} · hedef ${trDate(t.dueAt)}` })),
        due: due.map((t) => ({ label: t.name, detail: trDate(t.dueDate) })),
        overdue: overdue.map((t) => ({ label: t.name, detail: `vade ${trDate(t.dueDate)}` })),
        equipment: equipment.map((e) => ({ label: `${e.name} · ${EXPIRY_TEXT[e.kind] ?? e.kind}`, detail: e.expired ? `doldu ${trDate(e.date)}` : trDate(e.date) })),
      },
    });
  };
  for (const m of managers) build(m, p.slaBreached, p.maintenanceDue, p.maintenanceOverdue, p.autoClosed, p.equipmentExpiring ?? []);
  for (const s of staff) {
    const mine = <T extends { assigneeId?: string }>(xs: T[], includeUnassigned: boolean) => xs.filter((x) => x.assigneeId === s || (includeUnassigned && !x.assigneeId));
    build(s, mine(p.slaBreached, false), mine(p.maintenanceDue, true), mine(p.maintenanceOverdue, true), 0, []);
  }
  return out;
}
