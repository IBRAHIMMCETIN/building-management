import type { DomainEvent } from '../../events/publisher.js';
import type { ApartmentRole } from '../apartment-roles/types.js';
import type { IsoDate } from '../core/types.js';
import type { NotificationData, NotificationTemplate } from '../notifications/notifier.js';

/**
 * Abonelik olaylarindan alici cozumleme (SAF; notification worker kullanir). Alici: o gun aktif
 * rol kaydi olan `apartment_manager` ve `management_company` kullanicilari. Sakinlere, denetciye ve
 * saha ekibine gitmez. Tercih kategorisi `billing` (olay on eki `SUBSCRIPTION_`).
 */

export type BillingDomainEvent = Extract<
  DomainEvent,
  { type: 'SUBSCRIPTION_TRIAL_ENDING' | 'SUBSCRIPTION_INVOICE_ISSUED' | 'SUBSCRIPTION_PAST_DUE' | 'SUBSCRIPTION_SUSPENDED' | 'SUBSCRIPTION_REACTIVATED' }
>;

export const isBillingEvent = (e: DomainEvent): e is BillingDomainEvent => e.type.startsWith('SUBSCRIPTION_');

export type BillingRecipient = { userId: string; template: NotificationTemplate; data: NotificationData };

const TEMPLATES: Record<BillingDomainEvent['type'], NotificationTemplate> = {
  SUBSCRIPTION_TRIAL_ENDING: 'billing_trial_ending',
  SUBSCRIPTION_INVOICE_ISSUED: 'billing_invoice_issued',
  SUBSCRIPTION_PAST_DUE: 'billing_past_due',
  SUBSCRIPTION_SUSPENDED: 'billing_suspended',
  SUBSCRIPTION_REACTIVATED: 'billing_reactivated',
};

const activeOn = (r: Pick<ApartmentRole, 'status' | 'startDate' | 'endDate'>, day: IsoDate) => r.status === 'active' && r.startDate <= day && (!r.endDate || r.endDate >= day);

export function billingRecipients(event: BillingDomainEvent, roles: readonly ApartmentRole[], day: IsoDate): BillingRecipient[] {
  const managers = new Set(
    roles
      .filter((r) => r.apartmentId === event.apartmentId && (r.role === 'apartment_manager' || r.role === 'management_company') && activeOn(r, day))
      .map((r) => r.userId),
  );
  const data = { ...event.payload } as NotificationData;
  return [...managers].map((userId) => ({ userId, template: TEMPLATES[event.type], data }));
}
