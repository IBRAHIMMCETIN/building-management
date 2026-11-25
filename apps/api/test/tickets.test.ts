/**
 * Faz 3 (O1-1): ariza / talep - yetki matrisi, durum makinesi, SLA, idempotent olusturma ve numara,
 * gorunurluk (malik/kiraci, gorevli havuzu), ic notlarin sakinden gizlenmesi, surum cakismasi, API.
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import { createCoreService, defaultSiteSettings } from '../src/modules/core/service.js';
import type { Block, Site, Unit } from '../src/modules/core/types.js';
import { ValidationError } from '../src/modules/core/validation.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { TicketError } from '../src/modules/tickets/errors.js';
import { type TicketActor, checkTransition, dueAtFor, isOverdue } from '../src/modules/tickets/model.js';
import { TicketConflictError, createTicketRepository } from '../src/modules/tickets/repository.js';
import { type TicketContext, createTicketService, ticketSettingsOf } from '../src/modules/tickets/service.js';
import { DEFAULT_TICKET_SETTINGS, type Ticket, type TicketSettings } from '../src/modules/tickets/types.js';
import { createFakeTicketRepo } from './fakes/ticketRepo.js';

const APT = 'apt-1';
const T0 = '2026-11-25T09:00:00.000Z';

const unit = (id: string, blockId: string) => ({ unitId: id, blockId, status: 'active', number: id.toUpperCase() }) as unknown as Unit;
const member = (userId: string, unitId: string, relation: 'owner' | 'tenant', residesInUnit = true) =>
  ({ userId, unitId, apartmentId: APT, relation, residesInUnit, status: 'active', startDate: '2026-01-01' }) as unknown as UnitMembership;
const role = (userId: string, r: string, extra: Partial<ApartmentRole> = {}) =>
  ({ userId, apartmentId: APT, role: r, status: 'active', startDate: '2026-01-01', displayName: `${userId} adı`, ...extra }) as unknown as ApartmentRole;

const ctxs = {
  mgr: { apartmentId: APT, userId: 'mgr', role: 'apartment_manager' },
  staff1: { apartmentId: APT, userId: 'staff-1', role: 'building_staff' },
  staff2: { apartmentId: APT, userId: 'staff-2', role: 'building_staff' },
  tenant: { apartmentId: APT, userId: 'tenant-u1', role: 'resident' },
  owner: { apartmentId: APT, userId: 'owner-u1', role: 'resident' },
  other: { apartmentId: APT, userId: 'owner-u2', role: 'resident' },
  observer: { apartmentId: APT, userId: 'obs', role: 'observer' },
  guard: { apartmentId: APT, userId: 'guard', role: 'security_guard' },
} satisfies Record<string, TicketContext>;

function world(settings?: Partial<TicketSettings>) {
  let now = new Date(T0);
  const fake = createFakeTicketRepo();
  const units = [unit('u1', 'b1'), unit('u2', 'b2')];
  const blocks = [{ blockId: 'b1', status: 'active' }, { blockId: 'b2', status: 'active' }] as unknown as Block[];
  const site = { siteId: APT, settings: { ...defaultSiteSettings(), ...(settings ? { tickets: { ...DEFAULT_TICKET_SETTINGS, ...settings } } : {}) } } as unknown as Site;
  const memberships = [member('tenant-u1', 'u1', 'tenant'), member('owner-u1', 'u1', 'owner', false), member('owner-u2', 'u2', 'owner')];
  const roles = [role('staff-1', 'building_staff'), role('staff-2', 'building_staff'), role('mgr', 'apartment_manager'), role('old-staff', 'building_staff', { status: 'inactive' } as never)];
  let n = 0;
  const service = createTicketService({
    repo: fake.repo,
    core: {
      getSite: async () => site,
      getUnit: async (_a, id) => units.find((u) => u.unitId === id),
      getBlock: async (_a, id) => blocks.find((b) => b.blockId === id),
    },
    memberships: { listMemberships: async (_a, userId) => memberships.filter((m) => m.userId === userId) },
    roles: { list: async () => roles },
    now: () => now,
    newId: () => `id${String(++n).padStart(6, '0')}`,
  });
  let k = 0;
  const open = (ctx: TicketContext, extra: Record<string, unknown> = {}) =>
    service.create(ctx, {
      idempotencyKey: `key-${++k}`,
      title: 'Mutfak lavabosu akıtıyor',
      description: 'Lavabonun altından su sızıyor.',
      category: 'plumbing',
      location: { kind: 'unit', unitId: 'u1' },
      ...extra,
    });
  const act = async (ctx: TicketContext, ticketId: string, action: string, extra: Record<string, unknown> = {}) => {
    const { ticket } = await service.get(ctxs.mgr, ticketId);
    return service.transition(ctx, ticketId, { version: ticket.version, action, ...extra });
  };
  const assign = async (ctx: TicketContext, ticketId: string, assigneeId: string | null) => {
    const { ticket } = await service.get(ctxs.mgr, ticketId);
    return service.assign(ctx, ticketId, { version: ticket.version, assigneeId });
  };
  return { fake, service, open, act, assign, site, setNow: (iso: string) => (now = new Date(iso)), advance: (h: number) => (now = new Date(now.getTime() + h * 3_600_000)) };
}

// ---------------------------------------------------------------------------
// Saf kurallar
// ---------------------------------------------------------------------------

describe('durum makinesi ve yetki matrisi (saf)', () => {
  const t = (over: Partial<Ticket> = {}) =>
    ({ ticketId: 't1', status: 'assigned', assigneeId: 'staff-1', createdBy: 'tenant-u1', location: { kind: 'unit', unitId: 'u1' }, dueAt: T0, ...over }) as Ticket;
  const a = (kind: TicketActor['kind'], userId: string, unitIds: string[] = []): TicketActor => ({ apartmentId: APT, userId, role: kind, kind, unitIds });
  const ctx = { now: new Date(T0), settings: DEFAULT_TICKET_SETTINGS };
  const ok = (actor: TicketActor, ticket: Ticket, action: Parameters<typeof checkTransition>[2]) => checkTransition(actor, ticket, action, ctx).ok;

  it('gorevli yalnizca kendi isinde; yonetici her yerde; sakin ve denetci isi yuruttemez', () => {
    expect(ok(a('staff', 'staff-1'), t(), 'start')).toBe(true);
    expect(ok(a('staff', 'staff-2'), t(), 'start')).toBe(false);
    expect(ok(a('manager', 'mgr'), t(), 'start')).toBe(true);
    expect(ok(a('resident', 'tenant-u1', ['u1']), t(), 'start')).toBe(false);
    expect(ok(a('observer', 'obs'), t(), 'resolve')).toBe(false);
    // Acik (atanmamis) talebi gorevli dogrudan cozemez; yonetici cozebilir.
    expect(ok(a('staff', 'staff-1'), t({ status: 'open', assigneeId: undefined }), 'resolve')).toBe(false);
    expect(ok(a('manager', 'mgr'), t({ status: 'open', assigneeId: undefined }), 'resolve')).toBe(true);
  });

  it('onay: acan kisi ve daire uyeleri; zorla kapama yalnizca yonetici; gecersiz durum ayri kod', () => {
    const resolved = t({ status: 'resolved', resolvedAt: T0 });
    expect(ok(a('resident', 'owner-u1', ['u1']), resolved, 'confirm')).toBe(true);
    expect(ok(a('resident', 'owner-u2', ['u2']), resolved, 'confirm')).toBe(false);
    expect(ok(a('manager', 'mgr'), resolved, 'confirm')).toBe(false);
    expect(ok(a('manager', 'mgr'), resolved, 'close')).toBe(true);
    expect(checkTransition(a('manager', 'mgr'), t({ status: 'closed' }), 'start', ctx)).toMatchObject({ ok: false, code: 'invalid_state' });
  });

  it('iptal: acan kisi yalnizca acikken ve gerekcesiz; yonetici her aktif durumda gerekceli', () => {
    expect(checkTransition(a('resident', 'tenant-u1', ['u1']), t({ status: 'open' }), 'cancel', ctx)).toMatchObject({ ok: true, noteRequired: false });
    expect(ok(a('resident', 'tenant-u1', ['u1']), t({ status: 'assigned' }), 'cancel')).toBe(false);
    expect(checkTransition(a('manager', 'mgr'), t({ status: 'in_progress' }), 'cancel', ctx)).toMatchObject({ ok: true, noteRequired: true });
  });

  it('SLA: oncelik suresi; cozulmus talep gecikmede sayilmaz', () => {
    expect(dueAtFor(T0, 'urgent', DEFAULT_TICKET_SETTINGS)).toBe('2026-11-25T13:00:00.000Z');
    expect(dueAtFor(T0, 'low', DEFAULT_TICKET_SETTINGS)).toBe('2026-12-02T09:00:00.000Z');
    const late = new Date('2026-11-26T00:00:00.000Z');
    expect(isOverdue({ status: 'in_progress', dueAt: T0 }, late)).toBe(true);
    expect(isOverdue({ status: 'resolved', dueAt: T0 }, late)).toBe(false);
  });

  it('ayarlar: kismi site ayari varsayilanlarla birlesir', () => {
    expect(ticketSettingsOf(undefined)).toEqual(DEFAULT_TICKET_SETTINGS);
    expect(ticketSettingsOf({ settings: { tickets: { slaHours: { urgent: 2 }, staffSelfAssign: false, autoCloseDays: 3 } } } as never)).toEqual({
      slaHours: { urgent: 2, high: 24, normal: 72, low: 168 },
      staffSelfAssign: false,
      autoCloseDays: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

describe('talep olusturma', () => {
  it('sakin: okunur numara, normal oncelik (sakin belirleyemez), SLA, indeksler, denetim', async () => {
    const w = world();
    const r = await w.open(ctxs.tenant, { priority: 'urgent' });
    expect(r.replayed).toBe(false);
    expect(r.ticket).toMatchObject({ number: 'T-000001', status: 'open', priority: 'normal', source: 'resident', dueAt: '2026-11-28T09:00:00.000Z', location: { kind: 'unit', unitId: 'u1', blockId: 'b1' } });
    expect(r.ticket).not.toHaveProperty('assigneeId');
    expect([...w.fake.items.keys()].filter((k) => k.includes('TKUSER#') || k.includes('TKUNIT#'))).toHaveLength(2);
    expect(w.fake.audits.map((a) => a.action)).toEqual(['ticket.create']);
    expect((await w.open(ctxs.guard, { location: { kind: 'common', area: 'Otopark girişi', blockId: 'b2' }, priority: 'high' })).ticket).toMatchObject({ number: 'T-000002', priority: 'high', source: 'security' });
  });

  it('idempotent: ayni anahtar + icerik ayni talep; farkli icerik 409', async () => {
    const w = world();
    const body = { idempotencyKey: 'same-key-1', title: 'Asansör durdu', description: 'B blok asansörü 3. katta kaldı', category: 'elevator', location: { kind: 'common', area: 'B blok asansör' } };
    const a = await w.service.create(ctxs.mgr, body);
    const b = await w.service.create(ctxs.mgr, body);
    expect(b).toMatchObject({ replayed: true, ticket: { ticketId: a.ticket.ticketId, number: 'T-000001' } });
    await expect(w.service.create(ctxs.mgr, { ...body, title: 'Başka' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await w.fake.repo.getCounter(APT)).toBe(1);
  });

  it('sayac yarisi yeniden denenir', async () => {
    const w = world();
    w.fake.failNextWith(new TicketConflictError('counter'));
    expect((await w.open(ctxs.mgr)).ticket.number).toBe('T-000001');
  });

  it('yetki: baska daire, guvenlikte daire ici, denetci; bilinmeyen daire/blok', async () => {
    const w = world();
    await expect(w.open(ctxs.other)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.open(ctxs.guard)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.open(ctxs.observer)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.open(ctxs.mgr, { location: { kind: 'unit', unitId: 'nope' } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.open(ctxs.mgr, { location: { kind: 'common', area: 'Bahçe', blockId: 'b9' } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.open(ctxs.mgr, { category: 'nope' })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.service.create({ ...ctxs.mgr, role: 'platform_admin' }, {})).rejects.toBeInstanceOf(TicketError);
  });
});

describe('gorunurluk', () => {
  it('malik kiracinin daire ici talebini gorur; baska sakin goremez (404); ortak alan yalnizca acan', async () => {
    const w = world();
    const { ticket } = await w.open(ctxs.tenant);
    const common = (await w.open(ctxs.tenant, { location: { kind: 'common', area: 'Bahçe' }, category: 'garden' })).ticket;
    expect((await w.service.list(ctxs.owner)).items.map((t) => t.ticketId)).toEqual([ticket.ticketId]);
    await expect(w.service.get(ctxs.other, ticket.ticketId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.get(ctxs.owner, common.ticketId)).rejects.toMatchObject({ code: 'not_found' });
    expect((await w.service.list(ctxs.tenant)).total).toBe(2);
  });

  it('gorevli havuzu: atanmamis acik talepleri gorur; ayar kapaliysa gormez; atanmis baska isi gormez', async () => {
    const w = world();
    const { ticket } = await w.open(ctxs.tenant);
    expect((await w.service.list(ctxs.staff1)).total).toBe(1);
    await w.assign(ctxs.mgr, ticket.ticketId, 'staff-1');
    expect((await w.service.list(ctxs.staff2)).total).toBe(0);
    await expect(w.service.get(ctxs.staff2, ticket.ticketId)).rejects.toMatchObject({ code: 'not_found' });

    const closed = world({ staffSelfAssign: false });
    await closed.open(ctxs.tenant);
    expect((await closed.service.list(ctxs.staff1)).total).toBe(0);
  });
});

describe('akis', () => {
  it('atama -> isleme alma -> bekletme (not zorunlu) -> cozum -> sakin onayi + puan', async () => {
    const w = world();
    const { ticket } = await w.open(ctxs.tenant);
    const id = ticket.ticketId;
    expect((await w.assign(ctxs.mgr, id, 'staff-1')).ticket).toMatchObject({ status: 'assigned', assigneeId: 'staff-1' });
    await expect(w.assign(ctxs.mgr, id, 'old-staff')).rejects.toMatchObject({ code: 'unprocessable' });

    expect((await w.act(ctxs.staff1, id, 'start')).ticket.status).toBe('in_progress');
    await expect(w.act(ctxs.staff1, id, 'hold')).rejects.toBeInstanceOf(ValidationError);
    expect((await w.act(ctxs.staff1, id, 'hold', { note: 'Conta bekleniyor' })).ticket.status).toBe('on_hold');
    expect((await w.act(ctxs.staff1, id, 'resume')).ticket.status).toBe('in_progress');
    w.advance(10);
    const resolved = (await w.act(ctxs.staff1, id, 'resolve', { note: 'Conta değiştirildi' })).ticket;
    expect(resolved).toMatchObject({ status: 'resolved', slaMet: true, resolvedAt: '2026-11-25T19:00:00.000Z' });
    // Gorevli cozulen iste baska gecis yapamaz (onay sakinde, yeniden acma sakin / yonetimde).
    expect(resolved.actions).toEqual([]);

    const tenantView = await w.service.get(ctxs.tenant, id);
    expect(tenantView.ticket.actions).toEqual(['confirm', 'reopen']);
    const closed = (await w.act(ctxs.tenant, id, 'confirm', { rating: 5, note: 'Teşekkürler' })).ticket;
    expect(closed).toMatchObject({ status: 'closed', closeKind: 'confirmed', rating: { score: 5, note: 'Teşekkürler' } });
    // Atanan kisi bilgisi kapanan talepte kalir.
    expect((await w.service.get(ctxs.mgr, id)).ticket).toMatchObject({ assigneeId: 'staff-1' });

    const kinds = (await w.service.get(ctxs.mgr, id)).events.map((e) => (e.kind === 'status_changed' ? `${e.from}>${e.to}` : e.kind));
    expect(kinds).toEqual(['created', 'assigned', 'open>assigned', 'assigned>in_progress', 'in_progress>on_hold', 'on_hold>in_progress', 'in_progress>resolved', 'resolved>closed', 'rated']);
  });

  it('yeniden acma: sakin yalnizca sure icinde; yonetici her zaman; SLA yeniden baslar', async () => {
    const w = world();
    const id = (await w.open(ctxs.tenant)).ticket.ticketId;
    await w.assign(ctxs.mgr, id, 'staff-1');
    await w.act(ctxs.staff1, id, 'resolve', { note: 'Tamir edildi' });
    w.advance(24 * 8);
    await expect(w.act(ctxs.tenant, id, 'reopen', { note: 'Yine akıtıyor' })).rejects.toThrow(/7 gün/);
    const re = (await w.act(ctxs.mgr, id, 'reopen', { note: 'Sakin aradı, sorun sürüyor' })).ticket;
    expect(re).toMatchObject({ status: 'assigned', reopenCount: 1, dueAt: '2026-12-06T09:00:00.000Z' });
    expect(re).not.toHaveProperty('resolvedAt');
    expect(w.fake.audits.at(-1)).toMatchObject({ action: 'ticket.reopen', reason: 'Sakin aradı, sorun sürüyor' });
  });

  it('ustlenme ve iptal: gorevli havuzdan kendine; sakin yalnizca acikken geri ceker; yonetici reddi gerekceli', async () => {
    const w = world();
    const a = (await w.open(ctxs.tenant)).ticket.ticketId;
    await expect(w.assign(ctxs.staff1, a, 'staff-2')).rejects.toMatchObject({ code: 'forbidden' });
    expect((await w.assign(ctxs.staff1, a, 'staff-1')).ticket).toMatchObject({ status: 'assigned', assigneeId: 'staff-1' });
    await expect(w.assign(ctxs.staff1, a, null)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.act(ctxs.tenant, a, 'cancel')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.act(ctxs.mgr, a, 'cancel')).rejects.toBeInstanceOf(ValidationError);
    expect((await w.act(ctxs.mgr, a, 'cancel', { note: 'Daire içi özel tesisat, malik sorumlu' })).ticket).toMatchObject({ status: 'cancelled', cancelKind: 'rejected' });

    const b = (await w.open(ctxs.tenant)).ticket.ticketId;
    expect((await w.act(ctxs.tenant, b, 'cancel')).ticket).toMatchObject({ status: 'cancelled', cancelKind: 'withdrawn' });

    const off = world({ staffSelfAssign: false });
    const c = (await off.open(ctxs.mgr)).ticket.ticketId;
    await expect(off.service.assign(ctxs.staff1, c, { version: 1, assigneeId: 'staff-1' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('yorum ve ic not: sakin ic notu goremez, gorevli kimligi sakine gitmez', async () => {
    const w = world();
    const id = (await w.open(ctxs.tenant)).ticket.ticketId;
    await w.assign(ctxs.mgr, id, 'staff-1');
    await w.service.comment(ctxs.staff1, id, { body: 'Malik daha önce de şikayet etmiş', visibility: 'internal' });
    await w.service.comment(ctxs.staff1, id, { body: 'Yarın 10:00 gibi geleceğim' });
    await expect(w.service.comment(ctxs.tenant, id, { body: 'x', visibility: 'internal' })).rejects.toMatchObject({ code: 'forbidden' });
    await w.service.comment(ctxs.tenant, id, { body: 'Tamam, evdeyim' });
    await expect(w.service.comment(ctxs.observer, id, { body: 'x' })).rejects.toMatchObject({ code: 'forbidden' });

    const resident = await w.service.get(ctxs.owner, id);
    expect(resident.events.filter((e) => e.kind === 'comment').map((e) => e.body)).toEqual(['Yarın 10:00 gibi geleceğim', 'Tamam, evdeyim']);
    expect(JSON.stringify(resident)).not.toContain('staff-1');
    expect(resident.ticket).toMatchObject({ assigned: true });
    const observer = await w.service.get(ctxs.observer, id);
    expect(observer.events.filter((e) => e.kind === 'comment')).toHaveLength(3);
  });

  it('yonetici duzeltmesi: oncelik SLA yeniden hesaplanir, konum degisince daire indeksi tasinir; surum cakismasi 409', async () => {
    const w = world();
    const id = (await w.open(ctxs.tenant)).ticket.ticketId;
    await expect(w.service.update(ctxs.staff1, id, { version: 1, priority: 'urgent' })).rejects.toMatchObject({ code: 'forbidden' });
    const u = (await w.service.update(ctxs.mgr, id, { version: 1, priority: 'urgent', location: { kind: 'unit', unitId: 'u2' } })).ticket;
    expect(u).toMatchObject({ priority: 'urgent', dueAt: '2026-11-25T13:00:00.000Z', version: 2 });
    const keys = [...w.fake.items.keys()];
    expect(keys.some((k) => k.includes(`TKUNIT#u2#${id}`))).toBe(true);
    // Eski daire indeksi silinmez (DeleteItem yok); okuma guncel konuma gore suzer (asagida malik goremez).
    // Daire tasindi: eski dairenin maliki artik goremez, yeni daire maliki gorur; acan kisi gorur.
    await expect(w.service.get(ctxs.owner, id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await w.service.get(ctxs.other, id)).ticket.ticketId).toBe(id);
    expect((await w.service.get(ctxs.tenant, id)).ticket.ticketId).toBe(id);
    await expect(w.service.transition(ctxs.mgr, id, { version: 1, action: 'resolve', note: 'eski sürüm' })).rejects.toMatchObject({ code: 'conflict' });
    const fieldEvent = (await w.service.get(ctxs.mgr, id)).events.find((e) => e.kind === 'field_changed');
    expect(fieldEvent).toMatchObject({ visibility: 'internal', changes: { priority: ['normal', 'urgent'] } });
  });
});

describe('liste ve pano', () => {
  it('filtreler, gecikme ve pano sutunlari', async () => {
    const w = world();
    const a = (await w.open(ctxs.tenant)).ticket.ticketId;
    const b = (await w.open(ctxs.mgr, { title: 'Hidrofor basınç düşük', category: 'water_pump', priority: 'urgent', location: { kind: 'common', area: 'Hidrofor odası' } })).ticket.ticketId;
    await w.assign(ctxs.mgr, b, 'staff-1');
    w.advance(5);
    expect((await w.service.list(ctxs.mgr, { overdue: 'true' })).items.map((t) => t.ticketId)).toEqual([b]);
    expect((await w.service.list(ctxs.staff1, { assignee: 'me' })).items.map((t) => t.ticketId)).toEqual([b]);
    expect((await w.service.list(ctxs.mgr, { assignee: 'none' })).items.map((t) => t.ticketId)).toEqual([a]);
    expect((await w.service.list(ctxs.mgr, { q: 'hidro' })).total).toBe(1);
    expect((await w.service.list(ctxs.mgr, { q: 'T-000001' })).items[0]?.ticketId).toBe(a);
    expect((await w.service.list(ctxs.mgr, { status: 'active', limit: '1' })).nextCursor).toBe('1');
    await expect(w.service.list(ctxs.mgr, { status: 'bogus' })).rejects.toBeInstanceOf(ValidationError);

    const board = await w.service.board(ctxs.mgr);
    expect(board.columns.map((c) => [c.status, c.count])).toEqual([['open', 1], ['assigned', 1], ['in_progress', 0], ['on_hold', 0], ['resolved', 0]]);
    expect(board).toMatchObject({ overdueCount: 1, urgentOpenCount: 1 });
    await expect(w.service.board(ctxs.tenant)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await w.service.assignees(ctxs.mgr)).items.map((s) => s.userId)).toEqual(['staff-1', 'staff-2']);
  });
});

describe('site ayarlari', () => {
  it('tickets ayari kismi guncellenir ve dogrulanir', async () => {
    let site = { siteId: APT, version: 1, settings: defaultSiteSettings() } as unknown as Site;
    const core = createCoreService({
      repository: { getSite: async () => structuredClone(site), updateSite: async (s: Site) => (site = structuredClone(s)) } as unknown as CoreRepository,
      now: () => new Date(T0),
    });
    const r = await core.updateSite('mgr', APT, { version: 1, settings: { tickets: { slaHours: { urgent: 2 }, staffSelfAssign: false } } });
    expect(r.settings.tickets).toEqual({ slaHours: { urgent: 2, high: 24, normal: 72, low: 168 }, staffSelfAssign: false, autoCloseDays: 7 });
    await expect(core.updateSite('mgr', APT, { version: 2, settings: { tickets: { autoCloseDays: 0 } } })).rejects.toBeInstanceOf(ValidationError);
    const cleared = await core.updateSite('mgr', APT, { version: 2, settings: { tickets: null } });
    expect(cleared.settings.tickets).toBeUndefined();
  });
});

describe('API uclari', () => {
  it('roller: denetci okur ama yazamaz; sakin /api/tickets kullanamaz; olusturma 201, tekrar 200', async () => {
    const w = world();
    const app = createApp({
      version: 'test',
      ticketService: w.service,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
    });
    const call = async (method: string, path: string, ctx: TicketContext, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { 'x-test-claims': JSON.stringify({ userId: ctx.userId, role: ctx.role, apartmentId: APT }), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    const body = { idempotencyKey: 'api-key-1', title: 'Koridor lambası yanmıyor', description: 'A blok 2. kat', category: 'electrical', location: { kind: 'common', area: 'A blok 2. kat koridor', blockId: 'b1' } };
    const created = await call('POST', '/api/tickets', ctxs.staff1, body);
    expect(created).toMatchObject({ status: 201, json: { ticket: { number: 'T-000001' } } });
    expect((await call('POST', '/api/tickets', ctxs.staff1, body)).status).toBe(200);
    expect((await call('POST', '/api/tickets', ctxs.observer, { ...body, idempotencyKey: 'api-key-2' })).status).toBe(403);
    expect((await call('GET', '/api/tickets', ctxs.observer)).json).toMatchObject({ total: 1 });
    expect((await call('GET', '/api/tickets', ctxs.tenant)).status).toBe(403);
    const id = created.json.ticket.ticketId as string;
    expect((await call('POST', `/api/tickets/${id}/status`, ctxs.staff1, { version: 1, action: 'confirm' })).json).toMatchObject({ error: 'invalid_state' });
    expect((await call('POST', `/api/tickets/${id}/assign`, ctxs.staff1, { version: 1, assigneeId: 'staff-1' })).json).toMatchObject({ ticket: { status: 'assigned' } });
    expect((await call('PATCH', `/api/tickets/${id}`, ctxs.staff1, { version: 2, priority: 'high' })).status).toBe(403);
    expect((await call('GET', '/api/tickets/board', ctxs.observer)).status).toBe(200);
  });
});

describe('talep deposu (DynamoDB)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });
  const ticket = { PK: `APT#${APT}`, SK: 'TICKET#t1', entityType: 'TICKET', apartmentId: APT, ticketId: 't1', updatedAt: T0, version: 1 } as unknown as Ticket;

  it('yeni talep: idempotency, surum, sayac ve indeksler tek islemde; kosul hatasi nedenine gore', async () => {
    const repo = createTicketRepository();
    ddb.on(TransactWriteCommand).resolvesOnce({});
    await repo.write(APT, {
      at: T0,
      ticket,
      expectedVersion: 0,
      counter: { expected: 4 },
      idempotency: { PK: `APT#${APT}`, SK: 'TKIDEM#k1', entityType: 'TICKET_IDEMPOTENCY', apartmentId: APT, ticketId: 't1', fingerprint: 'f', createdAt: T0 },
      putIndexes: [{ PK: `APT#${APT}`, SK: 'TKUSER#u#t1', entityType: 'TICKET_INDEX', apartmentId: APT, ticketId: 't1', createdAt: T0 }],
    });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    // Delete yok: API'nin DeleteItem yetkisi yok.
    expect(items.map((i) => Object.keys(i)[0])).toEqual(['Put', 'Put', 'Update', 'Put']);
    expect(items[2]?.Update).toMatchObject({ ConditionExpression: '#value = :expected', ExpressionAttributeValues: { ':next': 5, ':expected': 4 } });

    const failAt = (idx: number) =>
      ddb.on(TransactWriteCommand).callsFake((input: { TransactItems: unknown[] }) => {
        throw new TransactionCanceledException({ message: 'iptal', $metadata: {}, CancellationReasons: input.TransactItems.map((_, i) => ({ Code: i === idx ? 'ConditionalCheckFailed' : 'None' })) });
      });
    const base = { at: T0, ticket, expectedVersion: 0, counter: { expected: 0 }, idempotency: { PK: `APT#${APT}`, SK: 'TKIDEM#k1', entityType: 'TICKET_IDEMPOTENCY' as const, apartmentId: APT, ticketId: 't1', fingerprint: 'f', createdAt: T0 } };
    failAt(0);
    await expect(repo.write(APT, base)).rejects.toMatchObject({ reason: 'duplicate' });
    failAt(2);
    await expect(repo.write(APT, base)).rejects.toMatchObject({ reason: 'counter' });

    // Yalnizca olay (yorum): talep yazilmaz, varligi kontrol edilir.
    ddb.reset();
    ddb.on(TransactWriteCommand).resolvesOnce({});
    await repo.write(APT, { at: T0, exists: { PK: `APT#${APT}`, SK: 'TICKET#t1' }, events: [] });
    expect(ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems![0]).toMatchObject({ ConditionCheck: { Key: { SK: 'TICKET#t1' }, ConditionExpression: 'attribute_exists(PK)' } });
  });
});
