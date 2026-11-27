/**
 * Ortak alan rezervasyonu olaylarindan alici cozumleme (saf; notification worker kullanir).
 *
 *  RESERVATION_APPROVED / _REJECTED / _CANCELLED -> rezervasyonu yapan sakin, yalnizca o gun
 *  dairenin guncel uyesiyse (tasinan / uyeligi biten almaz). Islemi yapan bildirim almaz.
 *
 * Gerekce ve ucret iadesinin GUNCEL durumu olayda yoktur; worker rezervasyon kaydini okur
 * (`booking`). Yonetimin ONAY notu ic nottur (portal yalnizca ret gerekcesini gosterir): e-postaya
 * girmez. SNS standart konu oldugundan olaylar sirasiz gelebilir (tekrar denenen onay iptalden sonra
 * islenebilir): kaydin guncel durumu olayla uyusmuyorsa (onay -> `confirmed`, ret -> `rejected`, iptal
 * -> `cancelled`) ya da kayit yoksa bildirim gitmez.
 */
import type { IsoDate } from '../core/types.js';
import type { DomainEvent } from '../../events/publisher.js';
import type { NotificationData, NotificationTemplate } from '../notifications/notifier.js';
import type { UnitMembership } from '../portal/types.js';
import type { Booking, BookingStatus } from './types.js';

export type ReservationRecipient = { userId: string; template: NotificationTemplate; data: NotificationData };

type ReservationDomainEvent = Extract<DomainEvent, { type: 'RESERVATION_APPROVED' | 'RESERVATION_REJECTED' | 'RESERVATION_CANCELLED' }>;

export const isReservationEvent = (e: DomainEvent): e is ReservationDomainEvent =>
  e.type === 'RESERVATION_APPROVED' || e.type === 'RESERVATION_REJECTED' || e.type === 'RESERVATION_CANCELLED';

/** Worker'in okudugu rezervasyon kaydi (yalnizca gereken alanlar). `null`: kayit yok. */
export type BookingSnapshot =
  | (Pick<Booking, 'bookingId' | 'unitId' | 'status' | 'decisionNote' | 'cancelReason' | 'cancelledAt'> & {
      feeStatus: string;
      /** Ters kayit denendi ve hata kaydedildi (iade kuyrugunda). */
      feeError?: boolean;
    })
  | null;

const TEMPLATE: Record<ReservationDomainEvent['type'], NotificationTemplate> = {
  RESERVATION_APPROVED: 'reservation_approved',
  RESERVATION_REJECTED: 'reservation_rejected',
  RESERVATION_CANCELLED: 'reservation_cancelled',
};

/** Olayin bildirdigi durum: kayit hala bu durumda degilse olay bayattir. */
const EXPECTED: Record<ReservationDomainEvent['type'], BookingStatus> = {
  RESERVATION_APPROVED: 'confirmed',
  RESERVATION_REJECTED: 'rejected',
  RESERVATION_CANCELLED: 'cancelled',
};

/**
 * Yonetim iptalinde ucret iadesi iptal yaziminin hemen ardindan ayri yazimla tamamlanir. Worker bu
 * pencere icinde (`cancelledAt`'ten itibaren) hatasiz `reversal_pending` gorurse olayi ERTELER (SQS
 * gorunurluk suresi sonra yeniden teslim eder) ki e-posta "isleniyor" yerine sonucu yazsin. Sinir
 * zamana baglidir: pencere gecince durum ne olursa olsun gonderilir, sonsuz erteleme olmaz.
 */
export const REFUND_SETTLE_MS = 30_000;

export function refundSettling(event: DomainEvent, booking: BookingSnapshot | undefined, now: Date): boolean {
  if (event.type !== 'RESERVATION_CANCELLED' || !booking || booking.status !== 'cancelled') return false;
  if (booking.feeStatus !== 'reversal_pending' || booking.feeError || !booking.cancelledAt) return false;
  const age = now.getTime() - Date.parse(booking.cancelledAt);
  return Number.isFinite(age) && age >= 0 && age < REFUND_SETTLE_MS;
}

const activeOn = (m: UnitMembership, day: IsoDate) => m.status === 'active' && m.startDate <= day && (!m.endDate || m.endDate >= day);

export function reservationRecipients(event: ReservationDomainEvent, memberships: readonly UnitMembership[], day: IsoDate, booking?: BookingSnapshot): ReservationRecipient[] {
  const p = event.payload;
  if (p.bookerId === event.actorId) return [];
  // Kayit okunduysa olayla ayni durumda olmali (sirasiz / gec teslim); kayit yoksa gonderilmez.
  if (booking === null) return [];
  const record = booking && booking.bookingId === p.bookingId && booking.unitId === p.unitId ? booking : undefined;
  if (booking && (!record || record.status !== EXPECTED[event.type])) return [];
  const current = memberships.some((m) => m.apartmentId === event.apartmentId && m.userId === p.bookerId && m.unitId === p.unitId && activeOn(m, day));
  if (!current) return [];
  // Ret: gerekce (`decisionNote`); iptal: iptal gerekcesi. Onay notu ic nottur, gonderilmez.
  const reason = event.type === 'RESERVATION_REJECTED' ? record?.decisionNote : event.type === 'RESERVATION_CANCELLED' ? record?.cancelReason : undefined;
  return [
    {
      userId: p.bookerId,
      template: TEMPLATE[event.type],
      data: {
        bookingId: p.bookingId,
        facilityName: p.facilityName,
        unitId: p.unitId,
        date: p.date,
        start: p.start,
        end: p.end,
        feeKurus: p.feeKurus,
        feeStatus: record?.feeStatus ?? p.feeStatus,
        ...(reason ? { reason } : {}),
      },
    },
  ];
}
