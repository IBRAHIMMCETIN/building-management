/**
 * Faz 3 (O1-2): sakin portali uclari, S3 fotograf yukleme / iliştirme / goruntuleme, outbox bildirim
 * olaylari, alici cozumleme, e-posta sablonlari ve ariza e-posta tercihi.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import { buildEvent, type DomainEvent, type TicketEventPayload } from '../src/events/publisher.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import { defaultSiteSettings } from '../src/modules/core/service.js';
import type { Block, Site, Unit } from '../src/modules/core/types.js';
import { ValidationError } from '../src/modules/core/validation.js';
import { createMemoryDocumentStore } from '../src/modules/documents/store.js';
import { createEmailNotifier } from '../src/modules/notifications/email.js';
import type { Notification } from '../src/modules/notifications/notifier.js';
import { parsePreferences } from '../src/modules/notifications/preferences.js';
import { renderEmail } from '../src/modules/notifications/templates.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { ticketRecipients } from '../src/modules/tickets/notifications.js';
import { ticketPhotoKeys } from '../src/modules/tickets/photos.js';
import { TicketConflictError } from '../src/modules/tickets/repository.js';
import { type TicketContext, createTicketService } from '../src/modules/tickets/service.js';
import { buildNotifications } from '../src/workers/notification-worker.js';
import { createFakeTicketRepo } from './fakes/ticketRepo.js';

const APT = 'apt-1';
const T0 = '2026-11-25T09:00:00.000Z';
const DAY = '2026-11-25';

const unit = (id: string, blockId: string) => ({ unitId: id, blockId, status: 'active', number: id.toUpperCase() }) as unknown as Unit;
const member = (userId: string, unitId: string, relation: 'owner' | 'tenant', residesInUnit = true) =>
  ({ userId, unitId, apartmentId: APT, relation, residesInUnit, status: 'active', startDate: '2026-01-01' }) as unknown as UnitMembership;
const role = (userId: string, r: string) => ({ userId, apartmentId: APT, role: r, status: 'active', startDate: '2026-01-01', displayName: userId }) as unknown as ApartmentRole;

const ctxs = {
  mgr: { apartmentId: APT, userId: 'mgr', role: 'apartment_manager' },
  staff1: { apartmentId: APT, userId: 'staff-1', role: 'building_staff' },
  tenant: { apartmentId: APT, userId: 'tenant-u1', role: 'resident' },
  owner: { apartmentId: APT, userId: 'owner-u1', role: 'resident' },
  other: { apartmentId: APT, userId: 'owner-u2', role: 'resident' },
  observer: { apartmentId: APT, userId: 'obs', role: 'observer' },
} satisfies Record<string, TicketContext>;

const memberships = [member('tenant-u1', 'u1', 'tenant'), member('owner-u1', 'u1', 'owner', false), member('owner-u2', 'u2', 'owner')];
const roles = [role('staff-1', 'building_staff'), role('staff-2', 'building_staff'), role('mgr', 'apartment_manager'), role('firm', 'management_company')];

function world(opts: { store?: boolean } = {}) {
  const fake = createFakeTicketRepo();
  const docs = createMemoryDocumentStore();
  const units = [unit('u1', 'b1'), unit('u2', 'b2')];
  const blocks = [{ blockId: 'b1', status: 'active' }] as unknown as Block[];
  const site = { siteId: APT, settings: defaultSiteSettings() } as unknown as Site;
  let n = 0;
  const service = createTicketService({
    repo: fake.repo,
    core: { getSite: async () => site, getUnit: async (_a, id) => units.find((u) => u.unitId === id), getBlock: async (_a, id) => blocks.find((b) => b.blockId === id) },
    memberships: { listMemberships: async (_a, userId) => memberships.filter((m) => m.userId === userId) },
    roles: { list: async () => roles },
    store: opts.store === false ? undefined : docs.store,
    now: () => new Date(T0),
    newId: () => `id${String(++n).padStart(6, '0')}`,
  });
  /** Tarayicinin S3'e PUT'unu taklit eder. */
  const upload = async (ctx: TicketContext, contentType = 'image/jpeg') => {
    const r = await service.photoUploadUrl(ctx, { contentType, size: 1000 });
    await docs.store.put(ticketPhotoKeys.pending(APT, ctx.userId, r.uploadId), new Uint8Array(1000), contentType);
    return r.uploadId;
  };
  let k = 0;
  const open = async (ctx: TicketContext, extra: Record<string, unknown> = {}) =>
    (
      await service.create(ctx, {
        idempotencyKey: `key-${++k}`,
        title: 'Banyo tavanından su damlıyor',
        description: 'Üst kattan sızıntı olabilir.',
        category: 'plumbing',
        location: { kind: 'unit', unitId: 'u1' },
        ...extra,
      })
    ).ticket;
  const version = async (id: string) => (await service.get(ctxs.mgr, id)).ticket.version;
  return { fake, docs, service, upload, open, version };
}

describe('fotograflar', () => {
  it('yukleme linki kullaniciya bagli gecici anahtar; olusturmada talebe tasinir; sakin acabilir', async () => {
    const w = world();
    const r = await w.service.photoUploadUrl(ctxs.tenant, { contentType: 'image/png', size: 2048 });
    expect(r).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/png' } });
    expect(r.uploadId).toMatch(/^[a-f0-9]{24}_png$/);
    expect(r.uploadUrl).toContain(`memory://put/tmp/${APT}/ticket-uploads/tenant-u1/`);
    await expect(w.service.photoUploadUrl(ctxs.tenant, { contentType: 'application/pdf', size: 10 })).rejects.toMatchObject({ code: 'unprocessable' });
    await expect(w.service.photoUploadUrl(ctxs.tenant, { contentType: 'image/jpeg', size: 11 * 1024 * 1024 })).rejects.toMatchObject({ code: 'unprocessable' });
    await expect(w.service.photoUploadUrl(ctxs.observer, { contentType: 'image/jpeg', size: 10 })).rejects.toMatchObject({ code: 'forbidden' });

    const a = await w.upload(ctxs.tenant);
    const b = await w.upload(ctxs.tenant, 'image/heic');
    const t = await w.open(ctxs.tenant, { photos: [a, b] });
    expect(t.photoCount).toBe(2);
    const created = (await w.service.get(ctxs.tenant, t.ticketId)).events[0];
    expect(created?.photoKeys).toEqual([`apartments/${APT}/tickets/${t.ticketId}/${a.replace('_', '.')}`, `apartments/${APT}/tickets/${t.ticketId}/${b.replace('_', '.')}`]);
    expect(w.docs.objects.has(created?.photoKeys?.[0] as string)).toBe(true);
    const link = await w.service.photo(ctxs.owner, t.ticketId, a);
    expect(link).toMatchObject({ contentType: 'image/jpeg', fileName: 'T-000001-foto.jpg' });
    expect(link.url).toContain(`memory://get/apartments/${APT}/tickets/${t.ticketId}/`);
    await expect(w.service.photo(ctxs.owner, t.ticketId, 'ffffffffffffffffffffffff_jpg')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('baskasinin yuklemesi, yuklenmemis dosya, gecersiz kimlik ve olay basina sinir', async () => {
    const w = world();
    const foreign = await w.upload(ctxs.owner);
    await expect(w.open(ctxs.tenant, { photos: [foreign] })).rejects.toMatchObject({ code: 'unprocessable' });
    await expect(w.open(ctxs.tenant, { photos: ['../../etc_jpg'] })).rejects.toBeInstanceOf(ValidationError);
    const many = await Promise.all(Array.from({ length: 7 }, () => w.upload(ctxs.tenant)));
    await expect(w.open(ctxs.tenant, { photos: many })).rejects.toThrow(/en fazla 6/);
    await expect(world({ store: false }).service.photoUploadUrl(ctxs.tenant, { contentType: 'image/jpeg', size: 10 })).rejects.toMatchObject({ code: 'unavailable', httpStatus: 503 });
  });

  it('ic nottaki fotograf sakine kapali; fotografli yorum sayaci guncel surumle artirir (yaris yeniden denenir)', async () => {
    const w = world();
    const t = await w.open(ctxs.tenant);
    await w.service.assign(ctxs.mgr, t.ticketId, { version: 1, assigneeId: 'staff-1' });
    const p1 = await w.upload(ctxs.staff1);
    await w.service.comment(ctxs.staff1, t.ticketId, { body: 'Tesisat şaftı çürük', visibility: 'internal', photos: [p1] });
    await expect(w.service.photo(ctxs.tenant, t.ticketId, p1)).rejects.toMatchObject({ code: 'not_found' });
    expect((await w.service.photo(ctxs.mgr, t.ticketId, p1)).url).toContain('memory://get/');

    const p2 = await w.upload(ctxs.staff1);
    w.fake.failNextWith(new TicketConflictError('version'));
    await w.service.comment(ctxs.staff1, t.ticketId, { body: 'Önce / sonra', photos: [p2] });
    expect((await w.service.get(ctxs.mgr, t.ticketId)).ticket.photoCount).toBe(2);

    // Durum gecisinde fotograf (cozum kaniti).
    const p3 = await w.upload(ctxs.staff1);
    const resolved = await w.service.transition(ctxs.staff1, t.ticketId, { version: await w.version(t.ticketId), action: 'resolve', note: 'Conta yenilendi', photos: [p3] });
    expect(resolved.ticket.photoCount).toBe(3);
    expect((await w.service.photo(ctxs.tenant, t.ticketId, p3)).fileName).toBe('T-000001-foto.jpg');
  });
});

describe('outbox olaylari', () => {
  it('olusturma, atama, durum ve herkese acik yorum olay yazar; ic not yazmaz', async () => {
    const w = world();
    const t = await w.open(ctxs.tenant);
    await w.service.assign(ctxs.mgr, t.ticketId, { version: 1, assigneeId: 'staff-1' });
    await w.service.comment(ctxs.staff1, t.ticketId, { body: 'iç not', visibility: 'internal' });
    await w.service.comment(ctxs.staff1, t.ticketId, { body: 'Yarın geliyorum' });
    await w.service.transition(ctxs.staff1, t.ticketId, { version: await w.version(t.ticketId), action: 'resolve', note: 'Tamam' });
    const types = w.fake.outbox.map((e) => (e.type === 'TICKET_STATUS_CHANGED' ? `${e.type}:${e.payload.action}` : e.type));
    expect(types).toEqual(['TICKET_CREATED', 'TICKET_ASSIGNED', 'TICKET_COMMENTED', 'TICKET_STATUS_CHANGED:resolve']);
    const created = w.fake.outbox[0] as DomainEvent<'TICKET_CREATED'>;
    expect(created).toMatchObject({ apartmentId: APT, actorId: 'tenant-u1', groupKey: `${APT}#${t.ticketId}` });
    expect(created.payload).toEqual({
      ticketId: t.ticketId,
      number: 'T-000001',
      title: 'Banyo tavanından su damlıyor',
      category: 'plumbing',
      priority: 'normal',
      location: { kind: 'unit', unitId: 'u1', blockId: 'b1' },
      createdBy: 'tenant-u1',
      createdByKind: 'resident',
      actorKind: 'resident',
    });
    // Aciklama ve yorum metni olaya girmez.
    expect(JSON.stringify(w.fake.outbox)).not.toContain('Yarın geliyorum');
    expect(JSON.stringify(w.fake.outbox)).not.toContain('sızıntı');
  });
});

describe('alici cozumleme', () => {
  const ev = (type: DomainEvent['type'], actorId: string, payload: Partial<TicketEventPayload> = {}) =>
    buildEvent(
      {
        eventId: `e-${type}`,
        type,
        apartmentId: APT,
        actorId,
        payload: {
          ticketId: 't1',
          number: 'T-000007',
          title: 'Kaçak',
          category: 'plumbing',
          priority: 'normal',
          location: { kind: 'unit', unitId: 'u1', blockId: 'b1' },
          createdBy: 'tenant-u1',
          createdByKind: 'resident',
          actorKind: 'resident',
          ...payload,
        },
      } as never,
      () => new Date(T0),
    ) as DomainEvent<'TICKET_CREATED'>;
  const who = (e: DomainEvent) => ticketRecipients(e as never, memberships, roles, DAY).map((r) => `${r.userId}:${r.template}:${r.data.link}`).sort();

  it('yeni talep: yonetim + (tesisat kategorisinde) dairenin kat maliki; acil talepte gorevliler; acan haric', () => {
    expect(who(ev('TICKET_CREATED', 'tenant-u1'))).toEqual(['firm:ticket_created:admin', 'mgr:ticket_created:admin', 'owner-u1:ticket_created:portal']);
    expect(who(ev('TICKET_CREATED', 'mgr', { category: 'garden', priority: 'urgent', createdBy: 'mgr', createdByKind: 'manager', actorKind: 'manager', location: { kind: 'common', area: 'Bahçe' } }))).toEqual([
      'firm:ticket_created:admin',
      'staff-1:ticket_created:admin',
      'staff-2:ticket_created:admin',
    ]);
  });

  it('atama gorevliye; cozum talep tarafina (onay istegi); sakin yorumu gorevliye, gorevli yorumu talep tarafina', () => {
    expect(who(ev('TICKET_ASSIGNED', 'mgr', { assigneeId: 'staff-1', actorKind: 'manager' }))).toEqual(['staff-1:ticket_assigned:admin']);
    expect(who(ev('TICKET_STATUS_CHANGED', 'staff-1', { assigneeId: 'staff-1', actorKind: 'staff', action: 'resolve', to: 'resolved' }))).toEqual([
      'owner-u1:ticket_resolved:portal',
      'tenant-u1:ticket_resolved:portal',
    ]);
    expect(who(ev('TICKET_COMMENTED', 'tenant-u1', { assigneeId: 'staff-1' }))).toEqual(['staff-1:ticket_comment:admin']);
    expect(who(ev('TICKET_COMMENTED', 'tenant-u1'))).toEqual(['firm:ticket_comment:admin', 'mgr:ticket_comment:admin']);
    expect(who(ev('TICKET_COMMENTED', 'staff-1', { assigneeId: 'staff-1', actorKind: 'staff' }))).toEqual(['owner-u1:ticket_comment:portal', 'tenant-u1:ticket_comment:portal']);
  });

  it('yeniden acma gorevliye + talep tarafina; sakin onayi yalnizca gorevliye; ortak alanda yalnizca acan sakin', () => {
    expect(who(ev('TICKET_STATUS_CHANGED', 'tenant-u1', { assigneeId: 'staff-1', action: 'reopen', from: 'resolved', to: 'assigned' }))).toEqual([
      'owner-u1:ticket_status:portal',
      'staff-1:ticket_reopened:admin',
    ]);
    expect(who(ev('TICKET_STATUS_CHANGED', 'tenant-u1', { assigneeId: 'staff-1', action: 'confirm', to: 'closed', closeKind: 'confirmed' }))).toEqual(['staff-1:ticket_status:admin']);
    expect(
      who(ev('TICKET_STATUS_CHANGED', 'mgr', { actorKind: 'manager', action: 'start', to: 'in_progress', location: { kind: 'common', area: 'Otopark' } })),
    ).toEqual(['tenant-u1:ticket_status:portal']);
  });

  it('worker: talep olayinda rol kayitlariyla bildirim uretir', () => {
    const out = buildNotifications(ev('TICKET_ASSIGNED', 'mgr', { assigneeId: 'staff-2', actorKind: 'manager' }), memberships, new Map(), DAY, roles);
    expect(out).toEqual([expect.objectContaining({ userId: 'staff-2', template: 'ticket_assigned', data: expect.objectContaining({ number: 'T-000007', link: 'admin' }) })]);
  });
});

describe('e-posta', () => {
  const note = (template: Notification['template'], data: Notification['data'], userId = 'tenant-u1'): Notification => ({ eventId: 'e1', apartmentId: APT, userId, template, data });
  const ctx = { siteName: 'Hamravat', unitLabel: () => 'Daire U1', portalUrl: 'https://site.example/app' };

  it('sablonlar: sakin portal baglantisi, yonetim paneli baglantisi, durum metni', () => {
    const resolved = renderEmail(note('ticket_resolved', { ticketId: 't1', number: 'T-000007', title: 'Kaçak', category: 'plumbing', unitId: 'u1', link: 'portal' }), ctx);
    expect(resolved?.subject).toMatch(/^Talebiniz çözüldü: T-000007/);
    expect(resolved?.text).toContain('https://site.example/app/talepler/t1');
    const assigned = renderEmail(note('ticket_assigned', { ticketId: 't1', number: 'T-000007', title: 'Kaçak', category: 'plumbing', priority: 'urgent', area: 'Kazan dairesi', link: 'admin' }), ctx);
    expect(assigned?.text).toContain('https://site.example/admin/tickets/t1');
    expect(assigned?.text).toContain('Kazan dairesi');
    const rejected = renderEmail(note('ticket_status', { ticketId: 't1', number: 'T-000007', title: 'Kaçak', category: 'plumbing', to: 'cancelled', cancelKind: 'rejected', link: 'portal' }), ctx);
    expect(rejected?.subject).toMatch(/^Talep durumu: T-000007 - Yönetim tarafından reddedildi/);
  });

  it('ariza e-postalari ayrica kapatilabilir; aidat e-postalari etkilenmez', async () => {
    const sent: string[] = [];
    const notifier = createEmailNotifier({
      sender: { send: async (m) => (sent.push(m.subject), { messageId: 'm' }) },
      preferences: { get: async () => ({ email: { enabled: true, tickets: false } }) },
      people: { get: async () => ({ email: 'a@b.co', fullName: 'A' }) as never },
      core: { getSite: async () => ({ name: 'Site' }) as never, listUnits: async () => [], listBlocks: async () => [] },
      sentLog: { has: async () => false, record: async () => {} } as never,
      portalUrl: 'https://site.example/app',
      now: () => new Date(T0),
      log: { info: () => {}, error: () => {} },
    });
    expect(await notifier.send(note('ticket_comment', { ticketId: 't1', number: 'T-1', title: 'x', category: 'other', link: 'portal' }))).toEqual({ status: 'skipped', reason: 'opted_out' });
    expect(await notifier.send(note('announcement_published', { announcementId: 'a', title: 'Duyuru' }))).toEqual({ status: 'sent' });
    expect(parsePreferences({ email: { enabled: true, tickets: false } })).toEqual({ email: { enabled: true, tickets: false } });
    expect(() => parsePreferences({ email: { enabled: true, sms: true } })).toThrow(ValidationError);
  });
});

describe('sakin portali API', () => {
  it('liste, olustur (201 / tekrar 200), onay, yeniden ac, geri cek; ic not ve bilinmeyen islem reddedilir; diger roller 403', async () => {
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
    const body = { idempotencyKey: 'portal-1', title: 'Kapı zili çalışmıyor', description: 'Bahçe kapısındaki zil', category: 'electrical', location: { kind: 'common', area: 'Bahçe kapısı', blockId: 'b1' } };
    const created = await call('POST', '/api/portal/tickets', ctxs.tenant, body);
    expect(created).toMatchObject({ status: 201, json: { ticket: { number: 'T-000001', priority: 'normal' } } });
    expect((await call('POST', '/api/portal/tickets', ctxs.tenant, body)).status).toBe(200);
    const id = created.json.ticket.ticketId as string;

    expect((await call('GET', '/api/portal/tickets', ctxs.tenant)).json).toMatchObject({ total: 1 });
    expect((await call('GET', '/api/portal/tickets', ctxs.other)).json).toMatchObject({ total: 0 });
    expect((await call('GET', '/api/portal/tickets/similar?category=electrical&blockId=b1', ctxs.other)).json.items).toEqual([
      expect.objectContaining({ number: 'T-000001', area: 'Bahçe kapısı', status: 'open', mine: false }),
    ]);
    expect((await call('POST', `/api/portal/tickets/${id}/comments`, ctxs.tenant, { body: 'x', visibility: 'internal' })).status).toBe(400);
    expect((await call('POST', `/api/portal/tickets/${id}/comments`, ctxs.tenant, { body: 'Akşam 6dan sonra evdeyim' })).status).toBe(201);
    expect((await call('POST', `/api/portal/tickets/${id}/resolve`, ctxs.tenant, { version: 1, note: 'x' })).status).toBe(404);

    await w.service.transition(ctxs.mgr, id, { version: 1, action: 'resolve', note: 'Zil değiştirildi' });
    expect((await call('POST', `/api/portal/tickets/${id}/reopen`, ctxs.tenant, { version: 2, note: 'Hâlâ çalışmıyor' })).json).toMatchObject({ ticket: { status: 'open', reopenCount: 1 } });
    await w.service.transition(ctxs.mgr, id, { version: 3, action: 'resolve', note: 'Kablo yenilendi' });
    expect((await call('POST', `/api/portal/tickets/${id}/confirm`, ctxs.tenant, { version: 4, rating: 4 })).json).toMatchObject({ ticket: { status: 'closed', rating: { score: 4 } } });

    const second = await call('POST', '/api/portal/tickets', ctxs.tenant, { ...body, idempotencyKey: 'portal-2' });
    expect((await call('POST', `/api/portal/tickets/${second.json.ticket.ticketId}/cancel`, ctxs.tenant, { version: 1 })).json).toMatchObject({ ticket: { status: 'cancelled', cancelKind: 'withdrawn' } });

    expect((await call('GET', '/api/portal/tickets', ctxs.staff1)).status).toBe(403);
    expect((await call('GET', `/api/portal/tickets/${id}`, ctxs.tenant)).json.events.every((e: { visibility: string }) => e.visibility === 'public')).toBe(true);
    expect((await call('POST', '/api/portal/tickets/photos/upload-url', ctxs.tenant, { contentType: 'image/jpeg', size: 100 })).json).toMatchObject({ method: 'PUT' });
  });
});
