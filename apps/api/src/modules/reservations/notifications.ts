/**
 * Ortak alan rezervasyonu olaylarindan alici cozumleme (saf; notification worker kullanir).
 *
 *  RESERVATION_APPROVED / _REJECTED / _CANCELLED -> rezervasyonu yapan sakin, yalnizca o gun
 *  dairenin guncel uyesiyse (tasinan / uyeligi biten almaz). Islemi yapan bildirim almaz.
 *
 * Gerekce, yonetimin notu ve ucret iadesinin GUNCEL durumu olayda yoktur; worker rezervasyon
 * kaydini okur (`booking`). Kayit okunamazsa olaydaki yazim anindaki ucret durumu kullanilir.
 */
import type { IsoDate } from '../core/types.js';
import type { DomainEvent } from '../../events/publisher.js';
import type { NotificationData, NotificationTemplate } from '../notifications/notifier.js';
import type { UnitMembership } from '../portal/types.js';
import type { Booking } from './types.js';

export type ReservationRecipient = { userId: string; template: NotificationTemplate; data: NotificationData };

type ReservationDomainEvent = Extract<DomainEvent, { type: 'RESERVATION_APPROVED' | 'RESERVATION_REJECTED' | 'RESERVATION_CANCELLED' }>;

export const isReservationEvent = (e: DomainEvent): e is ReservationDomainEvent =>
  e.type === 'RESERVATION_APPROVED' || e.type === 'RESERVATION_REJECTED' || e.type === 'RESERVATION_CANCELLED';

/** Worker'in okudugu rezervasyon kaydi (yalnizca gereken alanlar). `null`: kayit yok. */
export type BookingSnapshot = (Pick<Booking, 'bookingId' | 'unitId' | 'decisionNote' | 'cancelReason'> & { feeStatus: string }) | null;

const TEMPLATE: Record<ReservationDomainEvent['type'], NotificationTemplate> = {
  RESERVATION_APPROVED: 'reservation_approved',
  RESERVATION_REJECTED: 'reservation_rejected',
  RESERVATION_CANCELLED: 'reservation_cancelled',
};

const activeOn = (m: UnitMembership, day: IsoDate) => m.status === 'active' && m.startDate <= day && (!m.endDate || m.endDate >= day);

export function reservationRecipients(event: ReservationDomainEvent, memberships: readonly UnitMembership[], day: IsoDate, booking?: BookingSnapshot): ReservationRecipient[] {
  const p = event.payload;
  if (p.bookerId === event.actorId) return [];
  const current = memberships.some((m) => m.apartmentId === event.apartmentId && m.userId === p.bookerId && m.unitId === p.unitId && activeOn(m, day));
  if (!current) return [];
  const record = booking && booking.bookingId === p.bookingId && booking.unitId === p.unitId ? booking : undefined;
  // Onayda yonetimin notu, retde gerekce (ikisi de `decisionNote`), iptalde iptal gerekcesi.
  const text = event.type === 'RESERVATION_CANCELLED' ? record?.cancelReason : record?.decisionNote;
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
        ...(text ? { [event.type === 'RESERVATION_APPROVED' ? 'note' : 'reason']: text } : {}),
      },
    },
  ];
}
