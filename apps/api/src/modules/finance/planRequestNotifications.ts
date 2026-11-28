/**
 * Yapilandirma talebi olaylarindan alici cozumleme (saf; notification worker kullanir).
 *
 *  RESTRUCTURE_REQUESTED -> yonetim (o gun aktif yonetici + yonetim firmasi rolleri); talep artik
 *                           `pending` degilse (bu arada sonuclandi / geri cekildi) kimse.
 *  RESTRUCTURE_APPROVED  -> talebi acan sakin, hala o dairenin guncel uyesiyse; talep `approved` degilse kimse.
 *  RESTRUCTURE_REJECTED  -> ayni sakin; talep `rejected` degilse kimse.
 *
 * Payload yalnizca talep kimligi tasir; tutar, taksit, ilk vade ve ret gerekcesi worker'in okudugu
 * GUNCEL talep kaydindan gelir. Sakin adi / notu bildirime girmez (yonetim notu portalda gorur).
 */
import type { DomainEvent } from '../../events/publisher.js';
import type { ApartmentRole } from '../apartment-roles/types.js';
import type { IsoDate } from '../core/types.js';
import type { NotificationData, NotificationTemplate } from '../notifications/notifier.js';
import type { UnitMembership } from '../portal/types.js';
import type { PlanRequest } from './planRequests.js';

export type RestructureRecipient = { userId: string; template: NotificationTemplate; data: NotificationData };

type RestructureDomainEvent = Extract<DomainEvent, { type: 'RESTRUCTURE_REQUESTED' | 'RESTRUCTURE_APPROVED' | 'RESTRUCTURE_REJECTED' }>;

export const isRestructureEvent = (e: DomainEvent): e is RestructureDomainEvent =>
  e.type === 'RESTRUCTURE_REQUESTED' || e.type === 'RESTRUCTURE_APPROVED' || e.type === 'RESTRUCTURE_REJECTED';

/** Worker'in okudugu guncel talep. `null`: kayit yok. */
export type PlanRequestSnapshot = Pick<PlanRequest, 'requestId' | 'apartmentId' | 'userId' | 'unitId' | 'liableParty' | 'installments' | 'estimate' | 'status' | 'decision'> | null;

const activeOn = (x: { status: string; startDate: IsoDate; endDate?: IsoDate }, day: IsoDate) => x.status === 'active' && x.startDate <= day && (!x.endDate || x.endDate >= day);

export function restructureRecipients(
  event: RestructureDomainEvent,
  memberships: readonly UnitMembership[],
  roles: readonly ApartmentRole[],
  day: IsoDate,
  snapshot?: PlanRequestSnapshot,
): RestructureRecipient[] {
  const r = snapshot;
  if (!r || r.apartmentId !== event.apartmentId || r.requestId !== event.payload.requestId) return [];
  const base = { requestId: r.requestId, unitId: r.unitId, liableParty: r.liableParty };
  if (event.type === 'RESTRUCTURE_REQUESTED') {
    if (r.status !== 'pending') return [];
    const managers = [
      ...new Set(roles.filter((x) => x.apartmentId === event.apartmentId && activeOn(x, day) && (x.role === 'apartment_manager' || x.role === 'management_company')).map((x) => x.userId)),
    ].filter((u) => u !== r.userId);
    return managers.map((userId) => ({
      userId,
      template: 'restructure_requested' as const,
      data: { ...base, installments: r.installments, total: r.estimate.total, installmentAmount: r.estimate.installmentAmount },
    }));
  }
  const stillMember = memberships.some((m) => m.apartmentId === event.apartmentId && m.userId === r.userId && m.unitId === r.unitId && activeOn(m, day));
  if (!stillMember) return [];
  const d = r.decision;
  if (event.type === 'RESTRUCTURE_APPROVED') {
    if (r.status !== 'approved' || !d) return [];
    return [
      {
        userId: r.userId,
        template: 'restructure_approved',
        data: {
          ...base,
          requestedInstallments: r.installments,
          installments: d.installments ?? r.installments,
          ...(d.firstDueDate ? { firstDueDate: d.firstDueDate } : {}),
          ...(d.total !== undefined ? { total: d.total } : {}),
          changed: d.mode === 'changed' ? 'true' : 'false',
        },
      },
    ];
  }
  if (r.status !== 'rejected' || !d) return [];
  return [{ userId: r.userId, template: 'restructure_rejected', data: { ...base, reason: d.reason } }];
}
