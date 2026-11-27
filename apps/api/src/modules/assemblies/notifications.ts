/**
 * Genel kurul cagrisindan alici cozumleme (saf; notification worker kullanir).
 *
 *  ASSEMBLY_CALLED -> cagri kaydindaki (`ASMCALL#`) alicilar: cagri anindaki oy listesinde malik
 *  olan apartman kullanicilari. Gonderim aninda apartmanda aktif uyeligi kalmayan atlanir. Toplanti
 *  iptal edildiyse, baslamissa veya cagridan sonra toplanti bilgisi degistiyse (gecikmis / DLQ'dan
 *  yeniden surulen teslim; `meetingHash` uyusmaz) kimseye gitmez: eski tarih / yer e-postalanmaz.
 *
 * Toplanti bilgisi olaydan (cagridaki hali); alici listesi olayda TASINMAZ (5.000 bolumde SNS
 * ileti siniri), worker cagri ve toplanti kaydini okur.
 */
import { createHash } from 'node:crypto';
import type { DomainEvent } from '../../events/publisher.js';
import type { IsoDate, IsoDateTime } from '../core/types.js';
import type { NotificationData, NotificationTemplate } from '../notifications/notifier.js';
import type { UnitMembership } from '../portal/types.js';
import type { Assembly, AssemblyStatus } from './types.js';

export type AssemblyCallRecipient = { userId: string; template: NotificationTemplate; data: NotificationData };

type AssemblyCalledEvent = Extract<DomainEvent, { type: 'ASSEMBLY_CALLED' }>;

export const isAssemblyEvent = (e: DomainEvent): e is AssemblyCalledEvent => e.type === 'ASSEMBLY_CALLED';

/**
 * Cagridaki toplanti bilgisi ozeti (tur, tarih, yer, baglanti, gundem ve karar turleri, ikinci
 * toplanti): degisirse onceki cagri eskimistir. Servis ve worker ayni fonksiyonu kullanir.
 */
export const meetingHash = (a: Pick<Assembly, 'kind' | 'scheduledAt' | 'location' | 'onlineUrl' | 'agenda' | 'secondMeetingPlan'>) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        kind: a.kind,
        scheduledAt: a.scheduledAt,
        location: a.location ?? null,
        onlineUrl: a.onlineUrl ?? null,
        agenda: a.agenda.map((i) => [i.title, i.description ?? null, i.decisionKind ?? 'general', i.majority ?? 'attendees']),
        plan: a.secondMeetingPlan ?? null,
      }),
    )
    .digest('hex');

/** Worker'in okudugu cagri + toplanti durumu. `null`: kayit yok. */
export type AssemblyCallSnapshot = {
  assemblyId: string;
  seq: number;
  status: AssemblyStatus;
  scheduledAt: IsoDateTime;
  recipientUserIds: readonly string[];
  /** Cagri anindaki toplanti ozeti (toplanti kaydindaki cagri ozetinden). */
  callMeetingHash?: string;
  /** Toplantinin guncel ozeti. */
  currentMeetingHash: string;
} | null;

const activeOn = (m: UnitMembership, day: IsoDate) => m.status === 'active' && m.startDate <= day && (!m.endDate || m.endDate >= day);

export function assemblyCallRecipients(event: AssemblyCalledEvent, memberships: readonly UnitMembership[], day: IsoDate, now: Date, call?: AssemblyCallSnapshot): AssemblyCallRecipient[] {
  const p = event.payload;
  if (!call || call.assemblyId !== p.assemblyId || call.seq !== p.callSeq) return [];
  if (call.status !== 'planned' || Date.parse(call.scheduledAt) <= now.getTime()) return [];
  // Cagridan sonra toplanti tasindi / degisti: olaydaki (eski) bilgi gonderilmez.
  if (!call.callMeetingHash || call.callMeetingHash !== call.currentMeetingHash) return [];
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
