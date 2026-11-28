/**
 * Genel kurul cagrisindan alici cozumleme (saf; notification worker kullanir).
 *
 *  ASSEMBLY_CALLED -> cagri kaydindaki (`ASMCALL#` + `ASMCALLR#` kovalari) alicilar: cagri anindaki oy
 *  listesinde malik olan apartman kullanicilari. Gonderim aninda apartmanda aktif uyeligi kalmayan
 *  atlanir. Toplanti iptal edildiyse, baslamissa veya cagridan sonra toplanti bilgisi degistiyse
 *  (gecikmis / DLQ'dan yeniden surulen teslim; `meetingHash` uyusmaz) kimseye gitmez: eski tarih /
 *  yer e-postalanmaz.
 *
 *  ASSEMBLY_CANCELLED -> toplantinin TUM cagrilarindaki alicilar (hala uye); toplanti `cancelled`
 *  degilse kimse. Gerekce toplanti kaydindan.
 *  ASSEMBLY_RESCHEDULED -> ayni alicilar; toplanti `planned`, henuz baslamamis ve ertelemeden sonra
 *  yeniden degismemis olmali (ertelemenin `meetingHash`'i guncel ozetle ayni). Yeni tarih / yer
 *  toplanti kaydindan (olaydaki kopya yedek).
 *
 * Toplanti bilgisi olaydan (cagridaki hali); alici listesi olayda TASINMAZ (5.000 bolumde SNS
 * ileti siniri), worker cagri ve toplanti kaydini okur.
 */
import { createHash } from 'node:crypto';
import { bucketOf } from '../polls/rollSnapshot.js';
import type { DomainEvent } from '../../events/publisher.js';
import type { IsoDate, IsoDateTime } from '../core/types.js';
import type { NotificationData, NotificationTemplate } from '../notifications/notifier.js';
import type { UnitMembership } from '../portal/types.js';
import type { Assembly, AssemblyReschedule, AssemblyStatus } from './types.js';

export type AssemblyCallRecipient = { userId: string; template: NotificationTemplate; data: NotificationData };

type AssemblyCalledEvent = Extract<DomainEvent, { type: 'ASSEMBLY_CALLED' }>;
type AssemblyNoticeEvent = Extract<DomainEvent, { type: 'ASSEMBLY_CANCELLED' | 'ASSEMBLY_RESCHEDULED' }>;

export const isAssemblyEvent = (e: DomainEvent): e is AssemblyCalledEvent => e.type === 'ASSEMBLY_CALLED';

/** Bildirim parcasi basina alici (worker 60 sn icinde, kalan kisim tekrar denemede). */
export const NOTICE_PART_SIZE = 1000;
export const partsFor = (recipients: number) => Math.max(1, Math.ceil(recipients / NOTICE_PART_SIZE));
/** Alici bu parcada mi? Kullanici kimliginin ozetiyle: alici kumesi sonradan degisse de kayma yok. */
export const inPart = (userId: string, part: number | undefined, parts: number | undefined) => !parts || parts <= 1 || bucketOf(userId, parts) === (part ?? 0);
export const isAssemblyNoticeEvent = (e: DomainEvent): e is AssemblyNoticeEvent => e.type === 'ASSEMBLY_CANCELLED' || e.type === 'ASSEMBLY_RESCHEDULED';

/**
 * Cagridaki toplanti bilgisi ozeti (tur, tarih, yer, baglanti, gundem ve karar turleri, adaylar, ikinci
 * toplanti): degisirse onceki cagri eskimistir. Servis ve worker ayni fonksiyonu kullanir. Adaysiz
 * maddenin ozeti onceki surumle aynidir (eski cagrilar eskimez).
 */
export const meetingHash = (a: Pick<Assembly, 'kind' | 'scheduledAt' | 'location' | 'onlineUrl' | 'agenda' | 'secondMeetingPlan'>) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        kind: a.kind,
        scheduledAt: a.scheduledAt,
        location: a.location ?? null,
        onlineUrl: a.onlineUrl ?? null,
        agenda: a.agenda.map((i) => [i.title, i.description ?? null, i.decisionKind ?? 'general', i.majority ?? 'attendees', ...(i.candidates?.length ? [i.candidates.map((c) => c.name)] : [])]),
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

/** Iptal / erteleme bildirimi icin toplanti ve tum cagri alicilari. `null`: kayit yok. */
export type AssemblyNoticeSnapshot = {
  assemblyId: string;
  status: AssemblyStatus;
  kind: Assembly['kind'];
  scheduledAt: IsoDateTime;
  location?: string;
  onlineUrl?: string;
  cancelReason?: string;
  secondMeetingPlan?: Assembly['secondMeetingPlan'];
  reschedules: readonly AssemblyReschedule[];
  currentMeetingHash: string;
  /** Tum cagrilarin alicilari (birlesim). */
  recipientUserIds: readonly string[];
} | null;

const activeOn = (m: UnitMembership, day: IsoDate) => m.status === 'active' && m.startDate <= day && (!m.endDate || m.endDate >= day);

const membersOf = (apartmentId: string, memberships: readonly UnitMembership[], day: IsoDate) =>
  new Set(memberships.filter((m) => m.apartmentId === apartmentId && activeOn(m, day)).map((m) => m.userId));

export function assemblyCallRecipients(event: AssemblyCalledEvent, memberships: readonly UnitMembership[], day: IsoDate, now: Date, call?: AssemblyCallSnapshot): AssemblyCallRecipient[] {
  const p = event.payload;
  if (!call || call.assemblyId !== p.assemblyId || call.seq !== p.callSeq) return [];
  if (call.status !== 'planned' || Date.parse(call.scheduledAt) <= now.getTime()) return [];
  // Cagridan sonra toplanti tasindi / degisti: olaydaki (eski) bilgi gonderilmez.
  if (!call.callMeetingHash || call.callMeetingHash !== call.currentMeetingHash) return [];
  const users = membersOf(event.apartmentId, memberships, day);
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
  return [...new Set(call.recipientUserIds)].filter((u) => users.has(u) && inPart(u, p.part, p.parts)).map((userId) => ({ userId, template: 'assembly_called', data }));
}

/** Iptal ve erteleme bildirimi alicilari (cagri almis, hala uye olan kullanicilar). */
export function assemblyNoticeRecipients(event: AssemblyNoticeEvent, memberships: readonly UnitMembership[], day: IsoDate, now: Date, snap?: AssemblyNoticeSnapshot): AssemblyCallRecipient[] {
  if (!snap || snap.assemblyId !== event.payload.assemblyId) return [];
  const users = membersOf(event.apartmentId, memberships, day);
  const p = event.payload;
  const to = (template: NotificationTemplate, data: NotificationData) =>
    [...new Set(snap.recipientUserIds)].filter((u) => users.has(u) && inPart(u, p.part, p.parts)).map((userId) => ({ userId, template, data }));
  if (event.type === 'ASSEMBLY_CANCELLED') {
    if (snap.status !== 'cancelled') return [];
    return to('assembly_cancelled', { assemblyId: snap.assemblyId, kind: snap.kind, scheduledAt: snap.scheduledAt, reason: snap.cancelReason });
  }
  const r = snap.reschedules.find((x) => x.seq === event.payload.seq);
  // Toplanti bu arada iptal edildi, basladi veya yeniden degisti: eski erteleme bilgisi gonderilmez.
  if (!r || snap.status !== 'planned' || Date.parse(snap.scheduledAt) <= now.getTime() || r.meetingHash !== snap.currentMeetingHash) return [];
  return to('assembly_rescheduled', {
    assemblyId: snap.assemblyId,
    kind: snap.kind,
    previousScheduledAt: r.previousScheduledAt,
    scheduledAt: snap.scheduledAt,
    location: snap.location,
    onlineUrl: snap.onlineUrl,
    placeChanged: String((r.previousLocation ?? '') !== (r.location ?? '') || (r.previousOnlineUrl ?? '') !== (r.onlineUrl ?? '')),
    timeChanged: String(r.previousScheduledAt !== r.scheduledAt),
    movedEarlier: String(r.scheduledAt < r.previousScheduledAt),
    secondMeetingAt: snap.secondMeetingPlan?.scheduledAt,
    secondMeetingLocation: snap.secondMeetingPlan?.location,
    secondMeetingUrl: snap.secondMeetingPlan?.onlineUrl,
    reason: r.reason,
  });
}
