/**
 * Faz 3 (O1) - Saf kurallar: aktor turu, gorunurluk, yetki matrisi, durum makinesi ve SLA.
 * Depo ve zamandan bagimsizdir; servis ve testler bu fonksiyonlari dogrudan kullanir.
 *
 * Yetki matrisi (plan: claude/o1-ariza-bakim-plani.md, onay 25.11.2026):
 *  - Yonetici / yonetim firmasi: tum talepler, atama, tum gecisler, gerekceli iptal/ret ve zorla kapama.
 *  - Bina gorevlisi: kendisine atananlar + (ayar acikken) atanmamis havuz; kendine ustlenme; yalnizca
 *    kendi isinde Islemde / Beklemede / Cozuldu; ic not.
 *  - Sakin (malik / kiraci): acti(g)i + uyesi oldugu dairenin daire ici talepleri; onay / yeniden acma
 *    (autoCloseDays icinde); yalnizca kendi talebini ve atanmadan once iptal.
 *  - Denetci: tumu salt okunur (ic notlar dahil). Guvenlik: yalnizca ortak alan talebi acar ve kendi
 *    acti(g)i talepleri gorur.
 */
import type { IsoDateTime } from '../core/types.js';
import {
  ACTIVE_STATUSES,
  type Ticket,
  type TicketEvent,
  type TicketPriority,
  type TicketSettings,
  type TicketSource,
  type TicketStatus,
} from './types.js';

export type ActorKind = 'manager' | 'staff' | 'resident' | 'observer' | 'security';

export type TicketActor = {
  apartmentId: string;
  userId: string;
  role: string;
  kind: ActorKind;
  /** Sakinin guncel uyesi oldugu daireler (sakin disi rollerde bos). */
  unitIds: readonly string[];
};

export function actorKindOf(role: string): ActorKind | undefined {
  switch (role) {
    case 'apartment_manager':
    case 'management_company':
      return 'manager';
    case 'building_staff':
      return 'staff';
    case 'resident':
      return 'resident';
    case 'observer':
      return 'observer';
    case 'security_guard':
      return 'security';
    default:
      return undefined;
  }
}

export function sourceOf(kind: ActorKind): TicketSource {
  return kind === 'manager' ? 'manager' : kind === 'staff' ? 'staff' : kind === 'security' ? 'security' : 'resident';
}

/** Ic notlari (internal olaylar) gorebilir mi? */
export const seesInternal = (a: TicketActor) => a.kind === 'manager' || a.kind === 'staff' || a.kind === 'observer';

/** Talebi gorebilir mi (liste ve detay)? */
export function canView(a: TicketActor, t: Ticket, settings: TicketSettings): boolean {
  switch (a.kind) {
    case 'manager':
    case 'observer':
      return true;
    case 'staff':
      return t.assigneeId === a.userId || t.createdBy === a.userId || (settings.staffSelfAssign && t.status === 'open' && !t.assigneeId);
    case 'security':
      return t.createdBy === a.userId;
    case 'resident':
      return t.createdBy === a.userId || (t.location.kind === 'unit' && a.unitIds.includes(t.location.unitId));
  }
}

/** Talep acabilir mi? (Konum servis tarafinda ayrica dogrulanir.) */
export function canCreate(a: TicketActor, location: Ticket['location']): boolean {
  switch (a.kind) {
    case 'manager':
    case 'staff':
      return true;
    case 'security':
      return location.kind === 'common';
    case 'resident':
      return location.kind === 'common' || a.unitIds.includes(location.unitId);
    case 'observer':
      return false;
  }
}

export const canEditFields = (a: TicketActor) => a.kind === 'manager';

/** Herkese acik yorum: goren herkes (denetci haric, salt okunur). Ic not: yonetici ve gorevli. */
export function canComment(a: TicketActor, t: Ticket, visibility: 'public' | 'internal', settings: TicketSettings): boolean {
  if (a.kind === 'observer' || !canView(a, t, settings)) return false;
  if (visibility === 'internal') return a.kind === 'manager' || a.kind === 'staff';
  return true;
}

// ---------------------------------------------------------------------------
// Atama
// ---------------------------------------------------------------------------

export type AssignCheck = { ok: true } | { ok: false; reason: string };

/**
 * Atama / yeniden atama / kaldirma. Yonetici her aktif talepte; gorevli yalnizca acik ve atanmamis
 * talebi kendine (ayar acikken) ustlenebilir.
 */
export function checkAssign(a: TicketActor, t: Ticket, assigneeId: string | null, settings: TicketSettings): AssignCheck {
  if (!ACTIVE_STATUSES.includes(t.status)) return { ok: false, reason: 'Kapanmış, çözülmüş veya iptal edilmiş talebe atama yapılamaz' };
  if (a.kind === 'manager') return { ok: true };
  if (a.kind === 'staff') {
    if (!settings.staffSelfAssign) return { ok: false, reason: 'Bu apartmanda görevliler talep üstlenemez' };
    if (assigneeId !== a.userId || t.assigneeId || t.status !== 'open') return { ok: false, reason: 'Yalnızca atanmamış açık talebi kendinize üstlenebilirsiniz' };
    return { ok: true };
  }
  return { ok: false, reason: 'Atama yetkiniz yok' };
}

/** Atama sonrasi durum: acik talep atanir; atama kaldirilirsa yeniden acik olur. Diger durumlar korunur. */
export function statusAfterAssign(t: Ticket, assigneeId: string | null): TicketStatus {
  if (assigneeId && t.status === 'open') return 'assigned';
  if (!assigneeId) return 'open';
  return t.status;
}

// ---------------------------------------------------------------------------
// Durum makinesi
// ---------------------------------------------------------------------------

export const TRANSITIONS = ['start', 'hold', 'resume', 'resolve', 'confirm', 'close', 'reopen', 'cancel'] as const;
export type TransitionAction = (typeof TRANSITIONS)[number];

type Rule = {
  from: readonly TicketStatus[];
  to: TicketStatus | ((t: Ticket) => TicketStatus);
  /** Not / gerekce zorunlu mu (rol bazli olabilir). */
  note: (a: TicketActor) => boolean;
  allowed: (a: TicketActor, t: Ticket, ctx: { now: Date; settings: TicketSettings }) => boolean;
};

const isAssignee = (a: TicketActor, t: Ticket) => a.kind === 'staff' && t.assigneeId === a.userId;
const isOwnerOfTicket = (a: TicketActor, t: Ticket) =>
  a.kind === 'resident' && (t.createdBy === a.userId || (t.location.kind === 'unit' && a.unitIds.includes(t.location.unitId)));
const withinReopenWindow = (t: Ticket, now: Date, s: TicketSettings) =>
  !!t.resolvedAt && now.getTime() - Date.parse(t.resolvedAt) <= s.autoCloseDays * 86_400_000;

export const RULES: Record<TransitionAction, Rule> = {
  start: { from: ['assigned', 'on_hold'], to: 'in_progress', note: () => false, allowed: (a, t) => a.kind === 'manager' || isAssignee(a, t) },
  hold: { from: ['assigned', 'in_progress'], to: 'on_hold', note: () => true, allowed: (a, t) => a.kind === 'manager' || isAssignee(a, t) },
  resume: { from: ['on_hold'], to: 'in_progress', note: () => false, allowed: (a, t) => a.kind === 'manager' || isAssignee(a, t) },
  resolve: {
    from: ['open', 'assigned', 'in_progress', 'on_hold'],
    to: 'resolved',
    note: () => true,
    // Gorevli yalnizca kendi isini; acik (atanmamis) talebi yalnizca yonetici dogrudan cozebilir.
    allowed: (a, t) => a.kind === 'manager' || (isAssignee(a, t) && t.status !== 'open'),
  },
  confirm: { from: ['resolved'], to: 'closed', note: () => false, allowed: (a, t) => isOwnerOfTicket(a, t) },
  /** Yonetici zorla kapama (sakin onayi beklenmeden), gerekceli. */
  close: { from: ['resolved'], to: 'closed', note: () => true, allowed: (a) => a.kind === 'manager' },
  reopen: {
    from: ['resolved'],
    to: (t) => (t.assigneeId ? 'assigned' : 'open'),
    note: () => true,
    allowed: (a, t, { now, settings }) => a.kind === 'manager' || (isOwnerOfTicket(a, t) && withinReopenWindow(t, now, settings)),
  },
  cancel: {
    from: ['open', 'assigned', 'in_progress', 'on_hold'],
    to: 'cancelled',
    // Acan kisinin geri cekmesi gerekcesiz; yoneticinin reddi gerekceli.
    note: (a) => a.kind === 'manager',
    allowed: (a, t) => a.kind === 'manager' || (t.createdBy === a.userId && t.status === 'open' && a.kind !== 'observer'),
  },
};

export type TransitionCheck = { ok: true; to: TicketStatus; noteRequired: boolean } | { ok: false; code: 'forbidden' | 'invalid_state'; reason: string };

export function checkTransition(a: TicketActor, t: Ticket, action: TransitionAction, ctx: { now: Date; settings: TicketSettings }): TransitionCheck {
  const rule = RULES[action];
  if (!rule.from.includes(t.status)) {
    return { ok: false, code: 'invalid_state', reason: `Bu işlem "${STATUS_LABELS[t.status]}" durumundaki talepte yapılamaz` };
  }
  if (!rule.allowed(a, t, ctx)) {
    const late = action === 'reopen' && isOwnerOfTicket(a, t) && !withinReopenWindow(t, ctx.now, ctx.settings);
    return { ok: false, code: 'forbidden', reason: late ? `Talep yalnızca çözümden sonraki ${ctx.settings.autoCloseDays} gün içinde yeniden açılabilir` : 'Bu işlem için yetkiniz yok' };
  }
  return { ok: true, to: typeof rule.to === 'function' ? rule.to(t) : rule.to, noteRequired: rule.note(a) };
}

/** Aktorun bu talepte yapabilecegi gecisler (arayuz dugmeleri icin). */
export function availableActions(a: TicketActor, t: Ticket, ctx: { now: Date; settings: TicketSettings }): TransitionAction[] {
  return TRANSITIONS.filter((action) => checkTransition(a, t, action, ctx).ok);
}

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Açık',
  assigned: 'Atandı',
  in_progress: 'İşlemde',
  on_hold: 'Beklemede',
  resolved: 'Çözüldü',
  closed: 'Kapandı',
  cancelled: 'İptal',
};

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------

export function dueAtFor(createdAt: IsoDateTime, priority: TicketPriority, settings: TicketSettings): IsoDateTime {
  return new Date(Date.parse(createdAt) + settings.slaHours[priority] * 3_600_000).toISOString();
}

/** Cozum bekleyen ve hedefi gecmis mi? */
export function isOverdue(t: Pick<Ticket, 'status' | 'dueAt'>, now: Date): boolean {
  return ACTIVE_STATUSES.includes(t.status) && Date.parse(t.dueAt) < now.getTime();
}

/** Sakin uclarinda yalnizca herkese acik olaylar. */
export function visibleEvents(a: TicketActor, events: readonly TicketEvent[]): TicketEvent[] {
  return seesInternal(a) ? [...events] : events.filter((e) => e.visibility === 'public');
}
