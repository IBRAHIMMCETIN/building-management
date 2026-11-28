import * as sharedDesk from '@bm/shared/api/gate';
import * as shared from '@bm/shared/api/portalGate';
import * as sharedWork from '@bm/shared/api/work';
import * as sharedPlate from '@bm/shared/gate/plate';
import { describe, expect, it, vi } from 'vitest';
vi.mock('./client', () => ({ apiClient: {} }));
const web = await import('./gate');
const plate = await import('@/lib/gate/plate');
const pass = await import('@/lib/gate/pass');
const maintenance = await import('./maintenance');
const schedule = await import('@/lib/maintenance/schedule');
const myWork = await import('@/lib/tickets/myWork');
const tickets = await import('./tickets');
const dialog = await import('@/pages/admin/tickets/MaintenanceTaskDialog');

/*
 * Tek kaynak korumasi: web'deki eski yollar (lib/api/gate.ts, lib/gate/*, bakim / Islerim) ortak paketin
 * AYNI nesnelerini yeniden disa aktarir. Biri yeniden yerel bir kopya yazarsa (sekli ayni olsa bile) bu
 * test kirilir; davranis testleri (gate.test.ts, tickets.test.tsx) sonucu ayrica dogrular.
 */

describe('kapi ve bakim: web eski yollari ortak paketin nesneleri', () => {
  it('sakin ve gorevli kapi semalari', () => {
    expect(web.vehicleSchema).toBe(shared.vehicleSchema);
    expect(web.myPassSchema).toBe(shared.myPassSchema);
    expect(web.courierSchema).toBe(shared.courierSchema);
    expect(web.gateLogSchema).toBe(shared.gateLogSchema);
    expect(web.gateLogPageSchema).toBe(shared.gateLogPageSchema);
    expect(web.portalOverviewSchema).toBe(shared.portalGateOverviewSchema);
    expect(web.unitOptionSchema).toBe(sharedDesk.unitOptionSchema);
    expect(web.deskPassSchema).toBe(sharedDesk.deskPassSchema);
    expect(web.plateLookupSchema).toBe(sharedDesk.plateLookupSchema);
    expect(web.plateHitSchema).toBe(sharedDesk.plateHitSchema);
  });

  it('plaka, kisa kod, okutma, kurye durumu ve misafir formu yardimcilari', () => {
    expect(plate.normalizePlate).toBe(shared.normalizePlate);
    expect(plate.plateError).toBe(shared.plateError);
    expect(plate.formatPlate).toBe(shared.formatPlate);
    expect(plate.isTurkishPlate).toBe(shared.isTurkishPlate);
    expect(plate.formatShortCode).toBe(shared.formatShortCode);
    expect(plate.passLink).toBe(shared.passLink);
    expect(plate.validityText).toBe(shared.validityText);
    expect(plate.VERDICT_TEXT).toBe(shared.VERDICT_TEXT);
    expect(plate.LOG_KIND_TEXT).toBe(shared.LOG_KIND_TEXT);
    expect(plate.DIRECTION_TEXT).toBe(shared.DIRECTION_TEXT);
    expect(plate.parseScan).toBe(sharedPlate.parseScan);
    expect(plate.normalizeShortCode).toBe(sharedPlate.normalizeShortCode);
    expect(plate.courierState).toBe(sharedPlate.courierState);
    expect(plate.COURIER_TEXT).toBe(sharedPlate.COURIER_TEXT);
    expect(pass.passFormError).toBe(shared.passFormError);
  });

  it('bakim gorevi semasi, durum etiketleri, Islerim gruplamasi ve kontrol listesi dogrulamasi', () => {
    expect(maintenance.taskSchema).toBe(sharedWork.taskSchema);
    expect(schedule.TASK_STATUSES).toBe(sharedWork.TASK_STATUSES);
    expect(schedule.TASK_STATUS_LABELS).toBe(sharedWork.TASK_STATUS_LABELS);
    expect(schedule.TASK_STATUS_TONES).toBe(sharedWork.TASK_STATUS_TONES);
    expect(myWork.groupMyWork).toBe(sharedWork.groupMyWork);
    expect(tickets.assigneesSchema).toBe(sharedWork.assigneesSchema);
    expect(dialog.checklistErrors).toBe(sharedWork.checklistErrors);
  });
});
