/**
 * Bildirim devami: arka plan toplu isinin bitis ozeti (saf; notification worker kullanir).
 *
 *  BULK_JOB_FINISHED -> isi baslatan kullanici, yalnizca o gun apartmanda aktif yonetim rolu
 *                       (yonetici / yonetim firmasi) varsa. Sistemin baslattigi is olay uretmez.
 *
 * Veri: is turu, durum, sayilar (toplam / basarili / hatali / yeni yazilan), donem veya tahakkuk
 * etiketi ve yonetim panelindeki ekranin yolu. Hatali bolum ornekleri tasinmaz (ekranda).
 */
import type { DomainEvent } from '../../events/publisher.js';
import type { ApartmentRole } from '../apartment-roles/types.js';
import type { IsoDate } from '../core/types.js';
import type { NotificationData, NotificationTemplate } from '../notifications/notifier.js';

type BulkJobEvent = Extract<DomainEvent, { type: 'BULK_JOB_FINISHED' }>;

export const isBulkJobEvent = (e: DomainEvent): e is BulkJobEvent => e.type === 'BULK_JOB_FINISHED';

const MANAGER_ROLES = ['apartment_manager', 'management_company'];

/** Yonetim panelinde isin izlendigi ekran (WEB_APP_URL'e gore; e-postada `../admin/...`). */
export function bulkJobAdminPath(p: { kind: string; periodId?: string }): string {
  if (p.kind !== 'dues_bulk' && p.periodId) return `admin/meters?period=${encodeURIComponent(p.periodId)}`;
  return p.kind === 'dues_bulk' ? 'admin/finance' : 'admin/meters';
}

export function bulkJobRecipients(event: BulkJobEvent, roles: readonly ApartmentRole[], day: IsoDate): { userId: string; template: NotificationTemplate; data: NotificationData }[] {
  const p = event.payload;
  const active = roles.some(
    (r) => r.apartmentId === event.apartmentId && r.userId === p.startedBy && MANAGER_ROLES.includes(r.role) && r.status === 'active' && r.startDate <= day && (!r.endDate || r.endDate >= day),
  );
  if (!active) return [];
  return [
    {
      userId: p.startedBy,
      template: 'bulk_job_summary',
      data: {
        jobId: p.jobId,
        kind: p.kind,
        status: p.status,
        total: p.total,
        succeeded: p.succeeded,
        failed: p.failed,
        written: p.written,
        periodId: p.periodId,
        label: p.label,
        errorMessage: p.errorMessage,
        adminPath: bulkJobAdminPath(p),
      },
    },
  ];
}
