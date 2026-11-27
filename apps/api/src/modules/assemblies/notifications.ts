/**
 * Genel kurul cagrisindan alici cozumleme (saf; notification worker kullanir).
 *
 *  ASSEMBLY_CALLED -> cagri kaydindaki (`ASMCALL#`) alicilar: cagri anindaki oy listesinde malik
 *  olan apartman kullanicilari. Gonderim aninda apartmanda aktif uyeligi kalmayan atlanir. Toplanti
 *  iptal edildiyse veya baslamissa (gecikmis / yeniden denenen teslim) kimseye gitmez.
 *
 * Toplanti bilgisi olaydan (cagridaki hali); alici listesi olayda TASINMAZ (5.000 bolumde SNS
 * ileti siniri), worker cagri ve toplanti kaydini okur.
 */
import type { DomainEvent } from '../../events/publisher.js';
import type { IsoDate, IsoDateTime } from '../core/types.js';
import type { NotificationData, NotificationTemplate } from '../notifications/notifier.js';
import type { UnitMembership } from '../portal/types.js';
import type { AssemblyStatus } from './types.js';

export type AssemblyCallRecipient = { userId: string; template: NotificationTemplate; data: NotificationData };

type AssemblyCalledEvent = Extract<DomainEvent, { type: 'ASSEMBLY_CALLED' }>;

export const isAssemblyEvent = (e: DomainEvent): e is AssemblyCalledEvent => e.type === 'ASSEMBLY_CALLED';

/** Worker'in okudugu cagri + toplanti durumu. `null`: kayit yok. */
export type AssemblyCallSnapshot = {
  assemblyId: string;
  seq: number;
  status: AssemblyStatus;
  scheduledAt: IsoDateTime;
  recipientUserIds: readonly string[];
} | null;

const activeOn = (m: UnitMembership, day: IsoDate) => m.status === 'active' && m.startDate <= day && (!m.endDate || m.endDate >= day);

export function assemblyCallRecipients(event: AssemblyCalledEvent, memberships: readonly UnitMembership[], day: IsoDate, now: Date, call?: AssemblyCallSnapshot): AssemblyCallRecipient[] {
  const p = event.payload;
  if (!call || call.assemblyId !== p.assemblyId || call.seq !== p.callSeq) return [];
  if (call.status !== 'planned' || Date.parse(call.scheduledAt) <= now.getTime()) return [];
  const users = new Set(memberships.filter((m) => m.apartmentId === event.apartmentId && activeOn(m, day)).map((m) => m.userId));
  const plan = p.secondMeetingPlan;
  const data: NotificationData = {
    assemblyId: p.assemblyId,
    kind: p.kind,
    secondMeeting: String(p.secondMeeting),
    scheduledAt: p.scheduledAt,
    location: p.location,
    onlineUrl: p.onlineUrl,
    agenda: p.agenda.map((label) => ({ label })),
    secondMeetingAt: plan?.scheduledAt,
    secondMeetingLocation: plan?.location,
    secondMeetingUrl: plan?.onlineUrl,
    resend: String(p.resend),
  };
  return [...new Set(call.recipientUserIds)].filter((u) => users.has(u)).map((userId) => ({ userId, template: 'assembly_called', data }));
}
