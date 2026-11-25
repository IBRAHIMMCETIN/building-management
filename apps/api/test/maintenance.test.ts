/**
 * Faz 3 (O1-3): periyodik bakim (takvim hesabi, hazir sablonlar, sablon yonetimi ve gorev
 * uyarlama, idempotent gorev uretimi, gorev akisi, gorevden ariza), cozulen talebin otomatik
 * kapanisi, gunluk operasyon ozeti (alicilar, e-posta) ve zamanlayici isleri.
 */
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import { buildEvent, createInMemoryEventPublisher, type DomainEvent } from '../src/events/publisher.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import { defaultSiteSettings } from '../src/modules/core/service.js';
import type { Block, Site, Unit } from '../src/modules/core/types.js';
import { ValidationError } from '../src/modules/core/validation.js';
import { createMemoryDocumentStore } from '../src/modules/documents/store.js';
import type { Account } from '../src/modules/finance/types.js';
import { MaintenanceConflictError, type MaintenanceRepository } from '../src/modules/maintenance/repository.js';
import { addMonthsClamped, occurrences } from '../src/modules/maintenance/schedule.js';
import { type MaintenanceContext, createMaintenanceService } from '../src/modules/maintenance/service.js';
import type { MaintenanceTask, MaintenanceTemplate } from '../src/modules/maintenance/types.js';
import { renderEmail } from '../src/modules/notifications/templates.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { operationsDigestRecipients } from '../src/modules/tickets/notifications.js';
import { ticketPhotoKeys } from '../src/modules/tickets/photos.js';
import { createTicketService } from '../src/modules/tickets/service.js';
import { DEFAULT_TICKET_SETTINGS, type TicketSettings } from '../src/modules/tickets/types.js';
import { buildNotifications } from '../src/workers/notification-worker.js';
import { createSchedulerWorker } from '../src/workers/scheduler-worker.js';
import { createFakeTicketRepo } from './fakes/ticketRepo.js';

const APT = 'apt-1';
const T0 = '2026-11-25T06:00:00.000Z'; // Istanbul 09:00, 25.11.2026
const TODAY = '2026-11-25';

const role = (userId: string, r: string, extra: Partial<ApartmentRole> = {}) =>
  ({ userId, apartmentId: APT, role: r, status: 'active', startDate: '2026-01-01', displayName: userId, ...extra }) as unknown as ApartmentRole;
const roles = [role('staff-1', 'building_staff'), role('staff-2', 'building_staff'), role('mgr', 'apartment_manager')];
const ctxs = {
  mgr: { apartmentId: APT, userId: 'mgr', role: 'apartment_manager' },
  staff1: { apartmentId: APT, userId: 'staff-1', role: 'building_staff' },
  staff2: { apartmentId: APT, userId: 'staff-2', role: 'building_staff' },
  observer: { apartmentId: APT, userId: 'obs', role: 'observer' },
  resident: { apartmentId: APT, userId: 'res', role: 'resident' },
} satisfies Record<string, MaintenanceContext>;

function createFakeMaintenanceRepo() {
  const items = new Map<string, MaintenanceTemplate | MaintenanceTask>();
  const writes: Parameters<MaintenanceRepository['write']>[1][] = [];
  const repo: MaintenanceRepository = {
    getTemplate: async (_a, id) => structuredClone(items.get(`MTPL#${id}`) as MaintenanceTemplate | undefined),
    listTemplates: async () => [...items.values()].filter((x): x is MaintenanceTemplate => x.entityType === 'MAINT_TEMPLATE').map((x) => structuredClone(x)),
    getTask: async (_a, d, t) => structuredClone(items.get(`MTASK#${d}#${t}`) as MaintenanceTask | undefined),
    listTasks: async (_a, from, to) =>
      [...items.values()]
        .filter((x): x is MaintenanceTask => x.entityType === 'MAINT_TASK' && x.dueDate >= from && x.dueDate <= to)
        .sort((a, b) => a.SK.localeCompare(b.SK))
        .map((x) => structuredClone(x)),
    createTaskIfAbsent: async (t) => {
      if (items.has(t.SK)) return false;
      items.set(t.SK, structuredClone(t));
      return true;
    },
    write: async (_a, w) => {
      const all = [...(w.template ? [w.template] : []), ...(w.tasks ?? [])];
      for (const { item, expectedVersion } of all) {
        const cur = items.get(item.SK);
        if (expectedVersion === 0 ? !!cur : cur?.version !== expectedVersion) throw new MaintenanceConflictError();
      }
      for (const { item } of all) items.set(item.SK, structuredClone(item));
      writes.push(w);
    },
  };
  return { repo, items, writes };
}

function world(settings: Partial<TicketSettings> = {}) {
  let now = new Date(T0);
  const fakeTickets = createFakeTicketRepo();
  const fake = createFakeMaintenanceRepo();
  const docs = createMemoryDocumentStore();
  const site = { siteId: APT, settings: { ...defaultSiteSettings(), tickets: { ...DEFAULT_TICKET_SETTINGS, ...settings } } } as unknown as Site;
  const accounts = [
    { accountId: 'exp-elevator', type: 'expense', status: 'active' },
    { accountId: 'exp-garden', type: 'expense', status: 'active' },
    { accountId: 'sup-asansor', type: 'payable', status: 'active' },
  ] as Account[];
  let n = 0;
  const newId = () => `id${String(++n).padStart(6, '0')}`;
  const tickets = createTicketService({
    repo: fakeTickets.repo,
    core: { getSite: async () => site, getUnit: async () => ({ unitId: 'u1', blockId: 'b1', status: 'active' }) as Unit, getBlock: async () => ({ blockId: 'b1', status: 'active' }) as Block },
    memberships: { listMemberships: async () => [] as UnitMembership[] },
    roles: { list: async () => roles },
    store: docs.store,
    now: () => now,
    newId,
  });
  const service = createMaintenanceService({
    repo: fake.repo,
    tickets,
    roles: { list: async () => roles },
    core: { getBlock: async (_a, id) => (id === 'b1' ? ({ blockId: 'b1', status: 'active' } as Block) : undefined) },
    accounts: { getAccount: async (_a, id) => accounts.find((a) => a.accountId === id) },
    store: docs.store,
    now: () => now,
    newId,
  });
  const create = (extra: Record<string, unknown> = {}) =>
    service.createTemplate(ctxs.mgr, { name: 'A Blok asansör bakımı', category: 'elevator', schedule: { every: 1, unit: 'month', startDate: TODAY }, checklist: ['Fren', { text: 'Not defteri', required: false }], ...extra });
  const task = async (taskId: string) => (await service.getTask(ctxs.mgr, taskId)).task;
  return { fake, fakeTickets, tickets, service, docs, create, task, setNow: (iso: string) => (now = new Date(iso)) };
}

describe('takvim (saf)', () => {
  it('ay ekleme ay sonuna sabitlenir; adimlar baslangic gunune gore (kayma birikmez)', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsClamped('2026-12-15', 1)).toBe('2027-01-15');
    expect(occurrences({ every: 1, unit: 'month', startDate: '2026-01-31' }, '2026-01-01', '2026-05-31')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  });

  it('hafta / yil adimi, gecmis baslangic ve aralik', () => {
    expect(occurrences({ every: 2, unit: 'week', startDate: '2026-11-02' }, TODAY, '2026-12-31')).toEqual(['2026-11-30', '2026-12-14', '2026-12-28']);
    expect(occurrences({ every: 1, unit: 'year', startDate: '2020-03-15' }, TODAY, '2027-12-31')).toEqual(['2027-03-15']);
    expect(occurrences({ every: 3, unit: 'month', startDate: '2027-02-01' }, TODAY, '2027-01-31')).toEqual([]);
    expect(occurrences({ every: 1, unit: 'week', startDate: '2026-01-01' }, '2026-01-01', '2030-01-01', 5)).toHaveLength(5);
  });
});

describe('bakim sablonlari', () => {
  it('hazir sablondan olusturma: kontrol listesi, mevzuat notu, gider hesabi; pencere gorevleri ayni yazimda', async () => {
    const w = world();
    expect(w.service.presets(ctxs.staff1).items.map((p) => p.preset)).toContain('elevator_annual_inspection');
    const r = await w.service.createTemplate(ctxs.mgr, { preset: 'elevator_monthly', schedule: { startDate: '2026-11-28' }, asset: 'B Blok asansörü', defaultAssigneeId: 'staff-1' });
    expect(r.template).toMatchObject({ kind: 'elevator_monthly', name: 'Asansör aylık bakımı', category: 'elevator', expenseAccountId: 'exp-elevator', leadDays: 7, status: 'active' });
    expect(r.template.checklist[0]).toEqual({ id: 'c1', text: 'Kabin ve kat kapıları çalışıyor', required: true });
    expect(r.template.legalNote).toContain('ayda en az bir kez');
    // Pencere: 25.11 .. 25.11 + 7 + 30 = 01.01.2027
    expect(r.generated).toBe(2);
    const tasks = await w.service.listTasks(ctxs.mgr);
    expect(tasks.items.map((t) => [t.dueDate, t.assigneeId, t.status])).toEqual([
      ['2026-11-28', 'staff-1', 'scheduled'],
      ['2026-12-28', 'staff-1', 'scheduled'],
    ]);
    expect(w.fake.writes[0]?.audit).toMatchObject({ action: 'maintenance.template_create' });
  });

  it('dogrulama: zorunlu alanlar, tedarikci / gider hesabi turu, varsayilan gorevli, yalnizca yonetim', async () => {
    const w = world();
    await expect(w.service.createTemplate(ctxs.mgr, { name: 'x' })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.create({ schedule: { every: 1, unit: 'month', startDate: '2026-13-01' } })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.create({ supplierAccountId: 'exp-elevator' })).rejects.toThrow(/tedarikçi/);
    await expect(w.create({ expenseAccountId: 'sup-asansor' })).rejects.toThrow(/gider/);
    await expect(w.create({ defaultAssigneeId: 'mgr' })).rejects.toMatchObject({ code: 'unprocessable' });
    await expect(w.create({ blockIds: ['b9'] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.createTemplate(ctxs.staff1, { preset: 'pool', schedule: { startDate: TODAY } })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.listTemplates(ctxs.resident)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.createTemplate(ctxs.mgr, { preset: 'nope' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('duzenleme: baslamamis gorevler yeni takvime uyar, istenmeyen iptal, baslamis olana dokunulmaz, geri donus iptali geri alir', async () => {
    const w = world();
    const { template } = await w.create({ defaultAssigneeId: 'staff-1' });
    const ids = (await w.service.listTasks(ctxs.mgr)).items.map((t) => t.taskId);
    expect(ids).toEqual([`2026-11-25_${template.templateId}`, `2026-12-25_${template.templateId}`]);
    // Bugunku gorev basladi.
    await w.service.startTask(ctxs.staff1, ids[0] as string, { version: 1 });

    const weekly = await w.service.updateTemplate(ctxs.mgr, template.templateId, { version: 1, schedule: { every: 2, unit: 'week' }, name: 'Asansör kontrolü' });
    expect(weekly.template.version).toBe(2);
    const after = await w.service.listTasks(ctxs.mgr, { status: 'scheduled,in_progress,cancelled' });
    expect(after.items.map((t) => [t.dueDate, t.status, t.name])).toEqual([
      ['2026-11-25', 'in_progress', 'A Blok asansör bakımı'],
      ['2026-12-09', 'scheduled', 'Asansör kontrolü'],
      ['2026-12-23', 'scheduled', 'Asansör kontrolü'],
      ['2026-12-25', 'cancelled', 'A Blok asansör bakımı'],
    ]);

    await w.service.updateTemplate(ctxs.mgr, template.templateId, { version: 2, schedule: { every: 1, unit: 'month' } });
    const back = await w.service.listTasks(ctxs.mgr, { status: 'scheduled,cancelled' });
    expect(back.items.map((t) => [t.dueDate, t.status])).toEqual([
      ['2026-12-09', 'cancelled'],
      ['2026-12-23', 'cancelled'],
      ['2026-12-25', 'scheduled'],
    ]);
    await expect(w.service.updateTemplate(ctxs.mgr, template.templateId, { version: 1, name: 'eski' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('arsivleme gelecek gorevleri iptal eder; arsivlenmis sablon duzenlenemez ve gorev uretmez', async () => {
    const w = world();
    const { template } = await w.create();
    const r = await w.service.archiveTemplate(ctxs.mgr, template.templateId, { version: 1 });
    expect(r).toMatchObject({ template: { status: 'archived' }, tasksChanged: 2 });
    expect((await w.service.listTasks(ctxs.mgr)).items).toEqual([]);
    await expect(w.service.updateTemplate(ctxs.mgr, template.templateId, { version: 2, name: 'x' })).rejects.toMatchObject({ code: 'invalid_state' });
    expect(await w.service.generate(APT, TODAY)).toEqual({ templates: 0, created: 0, existing: 0 });
    expect((await w.service.listTemplates(ctxs.mgr, { status: 'all' })).items).toHaveLength(1);
  });

  it('gorev uretimi idempotent; pencere ilerledikce yeni gorev ekler', async () => {
    const w = world();
    await w.create();
    expect(await w.service.generate(APT, TODAY)).toEqual({ templates: 1, created: 0, existing: 2 });
    expect(await w.service.generate(APT, '2026-12-20')).toEqual({ templates: 1, created: 1, existing: 1 });
    expect((await w.service.listTasks(ctxs.mgr, { to: '2027-03-01' })).items.map((t) => t.dueDate)).toEqual(['2026-11-25', '2026-12-25', '2027-01-25']);
  });
});

describe('bakim gorevleri', () => {
  it('gorevli: havuzdan ustlenme, baslatma, kontrol listesiyle tamamlama; basarisiz madde ariza onerir', async () => {
    const w = world();
    await w.create();
    const id = (await w.service.listTasks(ctxs.staff1)).items[0]?.taskId as string;
    expect((await w.service.getTask(ctxs.staff1, id)).task.actions).toEqual(['assign']);
    await expect(w.service.assignTask(ctxs.staff1, id, { version: 1, assigneeId: 'staff-2' })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await w.service.assignTask(ctxs.staff1, id, { version: 1, assigneeId: 'staff-1' })).task.assigneeId).toBe('staff-1');
    // Baska gorevli artik goremez.
    await expect(w.service.getTask(ctxs.staff2, id)).rejects.toMatchObject({ code: 'not_found' });
    await w.service.startTask(ctxs.staff1, id, { version: 2 });

    await expect(w.service.completeTask(ctxs.staff1, id, { version: 3, checklistResults: [] })).rejects.toThrow(/Zorunlu madde/);
    await expect(w.service.completeTask(ctxs.staff1, id, { version: 3, checklistResults: [{ id: 'c1', ok: false }] })).rejects.toThrow(/açıklama gerekli/);
    await expect(w.service.completeTask(ctxs.staff1, id, { version: 3, checklistResults: [{ id: 'c9', ok: true }] })).rejects.toBeInstanceOf(ValidationError);

    const r = await w.service.photoUploadUrl(ctxs.staff1, { contentType: 'image/jpeg', size: 500 });
    await w.docs.store.put(ticketPhotoKeys.pending(APT, 'staff-1', r.uploadId), new Uint8Array(500), 'image/jpeg');
    const done = await w.service.completeTask(ctxs.staff1, id, { version: 3, checklistResults: [{ id: 'c1', ok: false, note: 'Fren balatası aşınmış' }], note: 'Firma bilgilendirildi', photos: [r.uploadId] });
    expect(done).toMatchObject({ failedItems: 1, suggestTicket: true, task: { status: 'done', completedBy: 'staff-1', note: 'Firma bilgilendirildi' } });
    expect(done.task.photoKeys?.[0]).toBe(`apartments/${APT}/maintenance/${id}/${r.uploadId.replace('_', '.')}`);
    expect((await w.service.photo(ctxs.mgr, id, r.uploadId)).url).toContain('memory://get/');
    expect(w.fake.writes.at(-1)?.audit).toMatchObject({ action: 'maintenance.task_complete', details: { failedItems: 1 } });

    // Gorevden ariza: kaynak bakim, aciklamada basarisiz madde; ayni anahtarla tekrar ikinci kez eklenmez.
    const t1 = await w.service.openTicket(ctxs.staff1, id, { idempotencyKey: 'mt-ticket-1' });
    expect(t1.ticket).toMatchObject({ source: 'maintenance', maintenanceTaskId: id, category: 'elevator', location: { kind: 'common', area: 'A Blok asansör bakımı' } });
    expect(t1.ticket.description).toContain('Fren: Fren balatası aşınmış');
    const t2 = await w.service.openTicket(ctxs.staff1, id, { idempotencyKey: 'mt-ticket-1' });
    expect(t2.replayed).toBe(true);
    expect((await w.task(id)).ticketIds).toEqual([t1.ticket.ticketId]);
  });

  it('atlama yalnizca yonetim (gerekceli); denetci salt okunur; gecikme ve takvim', async () => {
    const w = world();
    await w.create();
    const [first, second] = (await w.service.listTasks(ctxs.mgr)).items;
    await expect(w.service.skipTask(ctxs.staff1, first?.taskId as string, { version: 1, reason: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await w.service.skipTask(ctxs.mgr, first?.taskId as string, { version: 1, reason: 'Firma gelemedi' })).task).toMatchObject({ status: 'skipped', skipReason: 'Firma gelemedi' });
    expect((await w.service.getTask(ctxs.observer, second?.taskId as string)).task.actions).toEqual([]);

    w.setNow('2027-01-05T06:00:00.000Z');
    const cal = await w.service.calendar(ctxs.mgr, { month: '2027-01' });
    expect(cal.items).toEqual([]);
    expect(cal.overdue.map((t) => [t.dueDate, t.overdue])).toEqual([['2026-12-25', true]]);
    expect((await w.service.calendar(ctxs.mgr, { month: '2026-12' })).items.map((t) => t.dueDate)).toEqual(['2026-12-25']);
    expect((await w.service.listTasks(ctxs.mgr, { overdue: 'true' })).items).toHaveLength(1);
    expect(await w.service.digestItems(APT, '2027-01-05')).toEqual({ dueSoon: [], overdue: [{ taskId: second?.taskId, name: 'A Blok asansör bakımı', dueDate: '2026-12-25' }] });
    await expect(w.service.calendar(ctxs.mgr, { month: '2027-13' })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('talep otomatik kapanisi ve SLA listesi', () => {
  it('sure dolan cozum kapanir (closeKind auto, outbox); suresi dolmayan kalir; SLA asimi listelenir', async () => {
    const w = world({ autoCloseDays: 7 });
    let seq = 0;
    const mk = (title: string, priority = 'normal') =>
      w.tickets.create({ apartmentId: APT, userId: 'mgr', role: 'apartment_manager' }, { idempotencyKey: `auto-close-${++seq}`, title, description: 'x', category: 'other', priority, location: { kind: 'common', area: 'Lobi' } });
    const a = (await mk('Eski çözüm')).ticket;
    const b = (await mk('Yeni çözüm')).ticket;
    const c = (await mk('Acil kaçak', 'urgent')).ticket;
    const mgr = { apartmentId: APT, userId: 'mgr', role: 'apartment_manager' };
    await w.tickets.transition(mgr, a.ticketId, { version: 1, action: 'resolve', note: 'Tamam' });
    w.setNow('2026-11-30T06:00:00.000Z');
    await w.tickets.transition(mgr, b.ticketId, { version: 1, action: 'resolve', note: 'Tamam' });
    w.setNow('2026-12-02T07:00:00.000Z');

    const r = await w.tickets.runDaily(APT);
    expect(r).toMatchObject({ autoClosed: 1, conflicts: 0 });
    expect(r.breached.map((t) => [t.number, t.priority])).toEqual([[c.number, 'urgent']]);
    const closed = await w.tickets.get(mgr, a.ticketId);
    expect(closed.ticket).toMatchObject({ status: 'closed', closeKind: 'auto', updatedBy: 'system-scheduler' });
    expect(closed.events.at(-1)).toMatchObject({ kind: 'status_changed', from: 'resolved', to: 'closed', by: 'system-scheduler' });
    expect((await w.tickets.get(mgr, b.ticketId)).ticket.status).toBe('resolved');
    const ev = w.fakeTickets.outbox.at(-1) as DomainEvent<'TICKET_STATUS_CHANGED'>;
    expect(ev.payload).toMatchObject({ action: 'close', to: 'closed', closeKind: 'auto', actorKind: 'system' });
    // Ikinci calisma zararsiz.
    expect((await w.tickets.runDaily(APT)).autoClosed).toBe(0);
  });
});

describe('gunluk operasyon ozeti', () => {
  const digest = (payload: Partial<DomainEvent<'OPERATIONS_DIGEST'>['payload']> = {}) =>
    buildEvent(
      {
        eventId: `OPS_DIGEST:${APT}:${TODAY}`,
        type: 'OPERATIONS_DIGEST',
        apartmentId: APT,
        actorId: 'system-scheduler',
        payload: {
          date: TODAY,
          slaBreached: [
            { ticketId: 't1', number: 'T-000001', title: 'Kaçak', priority: 'urgent', dueAt: '2026-11-24T10:00:00.000Z', assigneeId: 'staff-1' },
            { ticketId: 't2', number: 'T-000002', title: 'Lamba', priority: 'normal', dueAt: '2026-11-20T10:00:00.000Z' },
          ],
          maintenanceDue: [{ taskId: 'm1', name: 'Hidrofor', dueDate: TODAY }],
          maintenanceOverdue: [{ taskId: 'm2', name: 'Asansör', dueDate: '2026-11-20', assigneeId: 'staff-2' }],
          autoClosed: 2,
          ...payload,
        },
      },
      () => new Date(T0),
    ) as DomainEvent<'OPERATIONS_DIGEST'>;

  it('yonetim tum kalemleri; gorevli kendi SLA talebini ve kendi + atanmamis bakimlari alir', () => {
    const r = operationsDigestRecipients(digest(), roles, TODAY);
    const by = Object.fromEntries(r.map((x) => [x.userId, x.data]));
    expect(by.mgr).toMatchObject({ slaCount: 2, dueCount: 1, overdueCount: 1, autoClosed: 2, link: 'admin' });
    expect(by['staff-1']).toMatchObject({ slaCount: 1, dueCount: 1, overdueCount: 0, autoClosed: 0 });
    expect(by['staff-2']).toMatchObject({ slaCount: 0, dueCount: 1, overdueCount: 1 });
    const quiet = operationsDigestRecipients(digest({ slaBreached: [], maintenanceDue: [], maintenanceOverdue: [{ taskId: 'm2', name: 'Asansör', dueDate: '2026-11-20', assigneeId: 'staff-2' }], autoClosed: 0 }), roles, TODAY);
    expect(quiet.map((x) => x.userId).sort()).toEqual(['mgr', 'staff-2']);
    expect(buildNotifications(digest(), [], new Map(), TODAY, roles).map((n) => n.template)).toEqual(['operations_digest', 'operations_digest', 'operations_digest']);
  });

  it('e-posta: konu ozetleri, tablolar ve yonetim baglantisi', () => {
    const [mgr] = operationsDigestRecipients(digest(), roles, TODAY);
    const mail = renderEmail({ eventId: 'e', apartmentId: APT, userId: 'mgr', template: 'operations_digest', data: mgr?.data ?? {} }, { siteName: 'Hamravat', unitLabel: () => '', portalUrl: 'https://site.example/app' });
    expect(mail?.subject).toMatch(/^Günlük özet 25\.11\.2026: 2 talep SLA süresini aştı, 1 bakım gecikti, 1 bakım yaklaşıyor, 2 talep otomatik kapandı/);
    expect(mail?.text).toContain('T-000001 Kaçak');
    expect(mail?.text).toContain('https://site.example/admin/tickets');
  });
});

describe('zamanlayici isleri', () => {
  const site = { siteId: APT, status: 'active', settings: defaultSiteSettings() } as unknown as Site;
  const base = (over: Record<string, unknown>) =>
    createSchedulerWorker({
      core: { listSiteIds: async () => [APT], getSite: async () => site },
      finance: {} as never,
      plans: {} as never,
      payments: null,
      payouts: null,
      invoices: null,
      now: () => new Date(T0),
      log: { info: () => {}, error: () => {} },
      ...over,
    });

  it('maintenance_tasks gorev uretimini Istanbul gunuyle cagirir', async () => {
    const maintenance = { generate: vi.fn(async () => ({ templates: 2, created: 3, existing: 1 })), digestItems: vi.fn() };
    const worker = base({ maintenance, tickets: {} as never, events: createInMemoryEventPublisher() });
    const out = await worker.runJob({ job: 'maintenance_tasks', scheduledTime: '2026-11-25T01:10:00Z' });
    expect(maintenance.generate).toHaveBeenCalledWith(APT, TODAY);
    expect(out).toEqual([{ apartmentId: APT, status: 'done', detail: { date: TODAY, templates: 2, created: 3, existing: 1 } }]);
  });

  it('ticket_maintenance: otomatik kapanis + gun bazli deterministik ozet olayi; bos gunde olay yok', async () => {
    const events = createInMemoryEventPublisher();
    const tickets = { runDaily: vi.fn(async () => ({ autoClosed: 1, conflicts: 0, breached: [{ ticketId: 't1', number: 'T-000001', title: 'Kaçak', priority: 'urgent', dueAt: T0 }] })) };
    const maintenance = { generate: vi.fn(), digestItems: vi.fn(async () => ({ dueSoon: [{ taskId: 'm1', name: 'Hidrofor', dueDate: TODAY }], overdue: [] })) };
    const worker = base({ tickets, maintenance, events });
    const out = await worker.runJob({ job: 'ticket_maintenance', scheduledTime: '2026-11-25T04:30:00Z' });
    expect(out[0]).toMatchObject({ status: 'done', detail: { autoClosed: 1, slaBreached: 1, maintenanceDue: 1, digest: true } });
    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toMatchObject({ eventId: `OPS_DIGEST:${APT}:${TODAY}`, type: 'OPERATIONS_DIGEST', payload: { date: TODAY, autoClosed: 1, maintenanceOverdue: [] } });

    const quietEvents = createInMemoryEventPublisher();
    const quiet = base({
      tickets: { runDaily: async () => ({ autoClosed: 0, conflicts: 0, breached: [] }) },
      maintenance: { generate: vi.fn(), digestItems: async () => ({ dueSoon: [], overdue: [] }) },
      events: quietEvents,
    });
    expect((await quiet.runJob({ job: 'ticket_maintenance', scheduledTime: '2026-11-25T04:30:00Z' }))[0]).toMatchObject({ detail: { digest: false } });
    expect(quietEvents.published).toHaveLength(0);
  });
});

describe('API uclari', () => {
  it('roller: sablon yonetimi yalnizca yonetim; gorevli gorev akisinda; sakin erisemez', async () => {
    const w = world();
    const app = createApp({
      version: 'test',
      ticketService: w.tickets,
      maintenanceService: w.service,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
    });
    const call = async (method: string, path: string, ctx: MaintenanceContext, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { 'x-test-claims': JSON.stringify({ userId: ctx.userId, role: ctx.role, apartmentId: APT }), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    const body = { preset: 'water_pump', schedule: { startDate: TODAY } };
    expect((await call('POST', '/api/maintenance/templates', ctxs.staff1, body)).status).toBe(403);
    const created = await call('POST', '/api/maintenance/templates', ctxs.mgr, body);
    expect(created).toMatchObject({ status: 201, json: { template: { kind: 'water_pump' }, generated: 1 } });
    expect((await call('GET', '/api/maintenance/presets', ctxs.observer)).json.items.length).toBeGreaterThan(5);
    const tasks = await call('GET', '/api/maintenance/tasks?status=open', ctxs.staff1);
    const id = tasks.json.items[0].taskId as string;
    expect((await call('POST', `/api/maintenance/tasks/${id}/assign`, ctxs.staff1, { version: 1, assigneeId: 'staff-1' })).json).toMatchObject({ task: { assigneeId: 'staff-1' } });
    expect((await call('POST', `/api/maintenance/tasks/${id}/skip`, ctxs.staff1, { version: 2, reason: 'xxx' })).status).toBe(403);
    expect((await call('GET', '/api/maintenance/calendar?month=2026-11', ctxs.mgr)).json.items).toHaveLength(1);
    expect((await call('GET', '/api/maintenance/tasks', ctxs.resident)).status).toBe(403);
  });
});
