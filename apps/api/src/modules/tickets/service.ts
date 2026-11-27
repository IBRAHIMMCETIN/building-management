/**
 * Faz 3 (O1-1) - Ariza / talep servisi: olusturma (idempotent, okunur numara), listeleme, pano,
 * detay + zaman cizelgesi, alan duzeltme, atama ve durum gecisleri, yorum / ic not.
 *
 * Tum yetki kararlari `model.ts`'teki saf kurallardan gelir; aktor JWT'deki `apartmentId` + rol ve
 * (sakinde) guncel daire uyelikleridir. Istek govdesindeki kimlik bilgisi kullanilmaz.
 */
import { createHash, randomUUID } from 'node:crypto';
import { type DomainEvent, type EventType, type TicketEventPayload, buildEvent } from '../../events/publisher.js';
import { type ApartmentRoleRepository, apartmentRoleRepository } from '../apartment-roles/repository.js';
import type { CoreRepository } from '../core/repository.js';
import { coreRepository } from '../core/repository.js';
import type { IsoDate, IsoDateTime, Site } from '../core/types.js';
import { type Obj, ValidationError, asObject, assertId, optString, reqEnum, reqInt, reqString } from '../core/validation.js';
import { type DocumentStore, createDocumentStoreFromEnv } from '../documents/store.js';
import { type EquipmentLookup, resolveEquipmentLink } from '../equipment/links.js';
import { equipmentRepository } from '../equipment/repository.js';
import { MAX_AMOUNT } from '../finance/service.js';
import { type PortalRepository, portalRepository } from '../portal/repository.js';
import { TicketError } from './errors.js';
import {
  type ActorKind,
  type TicketActor,
  type TransitionAction,
  TRANSITIONS,
  actorKindOf,
  availableActions,
  canComment,
  canCreate,
  canEditFields,
  canEstimate,
  canView,
  checkAssign,
  checkTransition,
  dueAtFor,
  isOverdue,
  seesInternal,
  sourceOf,
  statusAfterAssign,
  visibleEvents,
} from './model.js';
import { MAX_PHOTOS_PER_TICKET, parseUploadIds, photoIdOf, ticketPhotos } from './photos.js';
import { TicketConflictError, type TicketRepository, type TicketWrite, ticketRepository } from './repository.js';
import {
  ACTIVE_STATUSES,
  DEFAULT_TICKET_SETTINGS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TERMINAL_STATUSES,
  type Ticket,
  type TicketEvent,
  type TicketIndex,
  type TicketLocation,
  type TicketPriority,
  type TicketSettings,
  type TicketStatus,
  ticketKeys,
} from './types.js';

export type TicketContext = { apartmentId: string; userId: string; role: string };

export type TicketServiceDeps = {
  repo: TicketRepository;
  core: Pick<CoreRepository, 'getSite' | 'getUnit' | 'getBlock'>;
  memberships: Pick<PortalRepository, 'listMemberships'>;
  roles: Pick<ApartmentRoleRepository, 'list'>;
  /** O1-2: fotograf deposu (yoksa fotograf islemleri 503). */
  store: DocumentStore | undefined;
  /** v2: ekipman sicili (baglanti dogrulamasi). */
  equipment: EquipmentLookup;
  now: () => Date;
  newId: () => string;
};

const MAX_PAGE = 200;
/** Zamanlayici aktoru (finance SYSTEM_ACTOR ile ayni deger). */
const SYSTEM_USER = 'system-scheduler';
const WRITE_RETRIES = 3;

export function ticketSettingsOf(site: Pick<Site, 'settings'> | undefined): TicketSettings {
  const s = site?.settings.tickets;
  return s ? { ...DEFAULT_TICKET_SETTINGS, ...s, slaHours: { ...DEFAULT_TICKET_SETTINGS.slaHours, ...s.slaHours } } : DEFAULT_TICKET_SETTINGS;
}

export function createTicketService(overrides: Partial<TicketServiceDeps> = {}) {
  const deps: TicketServiceDeps = {
    repo: ticketRepository,
    core: coreRepository,
    memberships: portalRepository,
    roles: apartmentRoleRepository,
    equipment: equipmentRepository,
    store: 'store' in overrides ? overrides.store : createDocumentStoreFromEnv(),
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const photos = ticketPhotos(deps.store, () => deps.now());
  const repo = deps.repo;
  const stamp = () => deps.now().toISOString();
  const today = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());

  // -------------------------------------------------------------------------
  // Aktor, ayarlar, yardimcilar
  // -------------------------------------------------------------------------

  async function actorOf(ctx: TicketContext): Promise<TicketActor> {
    const kind: ActorKind | undefined = actorKindOf(ctx.role);
    if (!kind) throw new TicketError('forbidden', 'Bu rol arıza / talep modülünü kullanamaz');
    let unitIds: string[] = [];
    if (kind === 'resident') {
      const d = today();
      unitIds = (await deps.memberships.listMemberships(ctx.apartmentId, ctx.userId))
        .filter((m) => m.status === 'active' && m.startDate <= d && (!m.endDate || m.endDate >= d))
        .map((m) => m.unitId);
    }
    return { apartmentId: ctx.apartmentId, userId: ctx.userId, role: ctx.role, kind, unitIds };
  }

  async function settingsOf(apartmentId: string): Promise<TicketSettings> {
    return ticketSettingsOf(await deps.core.getSite(apartmentId));
  }

  async function load(ctx: TicketContext, ticketId: string) {
    assertId(ticketId, 'ticketId');
    const [actor, settings, ticket] = await Promise.all([actorOf(ctx), settingsOf(ctx.apartmentId), repo.get(ctx.apartmentId, ticketId)]);
    // Gorunmeyen talep varligi da sizdirilmaz: 404.
    if (!ticket || !canView(actor, ticket, settings)) throw new TicketError('not_found', 'Talep bulunamadı');
    return { actor, settings, ticket };
  }

  function newEvent(ctx: TicketContext, t: Pick<Ticket, 'ticketId'>, at: IsoDateTime, e: Omit<TicketEvent, 'PK' | 'SK' | 'entityType' | 'apartmentId' | 'ticketId' | 'eventId' | 'at' | 'by' | 'byRole'>, seq = 0): TicketEvent {
    const eventId = `${deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}${seq}`;
    return {
      ...ticketKeys.event(ctx.apartmentId, t.ticketId, at, eventId),
      entityType: 'TICKET_EVENT',
      apartmentId: ctx.apartmentId,
      ticketId: t.ticketId,
      eventId,
      at,
      by: ctx.userId,
      byRole: ctx.role,
      ...e,
    };
  }

  const index = (keys: { PK: string; SK: string }, t: Ticket): TicketIndex => ({
    ...keys,
    entityType: 'TICKET_INDEX',
    apartmentId: t.apartmentId,
    ticketId: t.ticketId,
    createdAt: t.createdAt,
  });

  /** O1-2: bildirim olayi (outbox). Govde tasinmaz; alicilar worker'da cozulur. */
  function domainEvent(type: Extract<EventType, `TICKET_${string}`>, ctx: TicketContext, actor: TicketActor, t: Ticket, extra: Partial<TicketEventPayload> = {}): DomainEvent {
    const payload: TicketEventPayload = {
      ticketId: t.ticketId,
      number: t.number,
      title: t.title,
      category: t.category,
      priority: t.priority,
      location: t.location.kind === 'unit' ? { kind: 'unit', unitId: t.location.unitId, ...(t.location.blockId ? { blockId: t.location.blockId } : {}) } : { kind: 'common', area: t.location.area, ...(t.location.blockId ? { blockId: t.location.blockId } : {}) },
      createdBy: t.createdBy,
      createdByKind: actorKindOf(t.createdByRole) ?? 'resident',
      ...(t.assigneeId ? { assigneeId: t.assigneeId } : {}),
      actorKind: actor.kind,
      ...extra,
    };
    return buildEvent({ eventId: `tk-${deps.newId()}`, type, apartmentId: ctx.apartmentId, actorId: ctx.userId, groupKey: `${ctx.apartmentId}#${t.ticketId}`, payload } as never, deps.now);
  }

  function assertPhotoRoom(t: Ticket, adding: number) {
    if (t.photoCount + adding > MAX_PHOTOS_PER_TICKET) throw new TicketError('unprocessable', `Bir talebe en fazla ${MAX_PHOTOS_PER_TICKET} fotoğraf eklenebilir`);
  }

  async function write(apartmentId: string, w: TicketWrite) {
    try {
      await repo.write(apartmentId, w);
    } catch (err) {
      if (err instanceof TicketConflictError && err.reason === 'version') throw new TicketError('conflict', err.message);
      throw err;
    }
  }

  function parseVersion(o: Obj): number {
    return reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
  }

  function assertVersion(t: Ticket, version: number) {
    if (t.version !== version) throw new TicketError('conflict', 'Talep başka bir işlemle değişti; sayfayı yenileyin');
  }

  // -------------------------------------------------------------------------
  // Gorunumler
  // -------------------------------------------------------------------------

  /** Sakine gorevli kimligi ve diger kisilerin kullanici kimlikleri gosterilmez. */
  function ticketView(actor: TicketActor, t: Ticket, settings: TicketSettings) {
    const { PK: _pk, SK: _sk, ...rest } = t;
    const now = deps.now();
    const base = {
      ...rest,
      overdue: isOverdue(t, now),
      mine: t.createdBy === actor.userId,
      actions: availableActions(actor, t, { now, settings }),
      canAssign: checkAssign(actor, t, actor.kind === 'staff' ? actor.userId : null, settings).ok,
      canEdit: canEditFields(actor),
      canEstimate: canEstimate(actor, t),
    };
    if (actor.kind !== 'resident' && actor.kind !== 'security') {
      // O1-4: masraflar yalnizca yonetim ve denetciye.
      if (actor.kind !== 'staff') return base;
      const { costSummary: _cost, ...staffView } = base;
      return staffView;
    }
    // v2: tahmini tutar ve ekipman baglantisi sakin / guvenlik uclarina donmez.
    const { assigneeId, createdBy: _cb, updatedBy: _ub, costSummary: _cs, estimate: _est, equipmentId: _eq, canEstimate: _ce, ...safe } = base;
    return { ...safe, assigned: !!assigneeId };
  }

  function eventView(actor: TicketActor, e: TicketEvent) {
    const { PK: _pk, SK: _sk, ...rest } = e;
    if (seesInternal(actor) || actor.kind === 'observer') return rest;
    const { by, assigneeId: _a, changes: _c, ...safe } = rest;
    return { ...safe, mine: by === actor.userId };
  }

  // -------------------------------------------------------------------------
  // Olusturma
  // -------------------------------------------------------------------------

  async function parseLocation(ctx: TicketContext, value: unknown): Promise<TicketLocation> {
    const o = asObject(value, 'location');
    const kind = reqEnum(o, 'kind', ['unit', 'common'] as const);
    if (kind === 'unit') {
      const unitId = assertId(o.unitId, 'location.unitId');
      const unit = await deps.core.getUnit(ctx.apartmentId, unitId);
      if (!unit || unit.status !== 'active') throw new TicketError('not_found', 'Bağımsız bölüm bulunamadı');
      return { kind, unitId, ...(unit.blockId ? { blockId: unit.blockId } : {}) };
    }
    const area = reqString(o, 'area', 80, 2);
    let blockId: string | undefined;
    if (o.blockId != null && o.blockId !== '') {
      blockId = assertId(o.blockId, 'location.blockId');
      const block = await deps.core.getBlock(ctx.apartmentId, blockId);
      if (!block || block.status !== 'active') throw new TicketError('not_found', 'Blok bulunamadı');
    }
    return { kind, area, ...(blockId ? { blockId } : {}) };
  }

  /**
   * Yeni talep. `idempotencyKey` ayni istegin tekrarini (cift tiklama, ag hatasi) ikinci talebe
   * cevirmez: ayni icerikse mevcut talep `replayed: true` ile doner, farkli icerikse 409.
   * Sakin oncelik belirleyemez (normal); yonetici sonradan duzeltir.
   */
  /**
   * `opts.maintenanceTaskId`: bakim gorevinden acilan ariza (O1-3; kaynak `maintenance`).
   * `opts.equipmentId`: gorevin ekipman baglantisi (v2; gorev kaydindan, ayni apartman).
   */
  async function create(ctx: TicketContext, body: unknown, opts: { maintenanceTaskId?: string; equipmentId?: string } = {}) {
    const [actor, settings] = await Promise.all([actorOf(ctx), settingsOf(ctx.apartmentId)]);
    const o = asObject(body);
    const key = assertId(o.idempotencyKey, 'idempotencyKey');
    const title = reqString(o, 'title', 120, 3);
    const description = reqString(o, 'description', 4000, 1);
    const category = reqEnum(o, 'category', TICKET_CATEGORIES);
    const priority = actor.kind === 'resident' || o.priority === undefined ? 'normal' : reqEnum(o, 'priority', TICKET_PRIORITIES);
    const location = await parseLocation(ctx, o.location);
    const uploadIds = parseUploadIds(o.photos);
    if (!canCreate(actor, location)) {
      throw new TicketError('forbidden', location.kind === 'unit' ? 'Yalnızca üyesi olduğunuz daire için talep açabilirsiniz' : 'Talep açma yetkiniz yok');
    }
    // v2: ekipman secimi yonetim ve gorevli ekranindadir (sakin ve guvenlik sicili gormez).
    if (o.equipmentId !== undefined && o.equipmentId !== null && o.equipmentId !== '' && actor.kind !== 'manager' && actor.kind !== 'staff') {
      throw new TicketError('forbidden', 'Ekipman seçimi yalnızca yönetim ve görevli içindir');
    }
    // Gorevden gelen baglanti da ayni apartmanda ve hizmette olmali (hizmetten cikmissa baglanmaz).
    const fromTask = opts.equipmentId ? await deps.equipment.get(ctx.apartmentId, opts.equipmentId) : undefined;
    const equipmentId =
      opts.equipmentId !== undefined
        ? fromTask && fromTask.apartmentId === ctx.apartmentId && fromTask.status !== 'retired'
          ? fromTask.equipmentId
          : undefined
        : (await resolveEquipmentLink(deps.equipment, ctx.apartmentId, o.equipmentId)).equipmentId;
    const fp = createHash('sha256')
      .update(JSON.stringify({ title, description, category, priority, location, by: ctx.userId, photos: uploadIds, ...(equipmentId ? { equipmentId } : {}) }))
      .digest('hex');

    const replay = async () => {
      const idem = await repo.getIdempotency(ctx.apartmentId, key);
      if (!idem) return undefined;
      if (idem.fingerprint !== fp) throw new TicketError('conflict', 'Bu idempotencyKey farklı bir talep için kullanılmış');
      const existing = await repo.get(ctx.apartmentId, idem.ticketId);
      if (!existing) throw new TicketError('conflict', 'Talep oluşturma sürüyor; tekrar deneyin');
      return { ticket: ticketView(actor, existing, settings), replayed: true };
    };
    const prior = await replay();
    if (prior) return prior;

    const ticketId = `${stamp().slice(0, 10).replaceAll('-', '')}-${deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
    const photoKeys = await photos.attach(ctx.apartmentId, ctx.userId, ticketId, uploadIds);
    for (let attempt = 1; ; attempt++) {
      const ts = stamp();
      const counter = await repo.getCounter(ctx.apartmentId);
      const ticket: Ticket = {
        ...ticketKeys.ticket(ctx.apartmentId, ticketId),
        entityType: 'TICKET',
        apartmentId: ctx.apartmentId,
        ticketId,
        number: `T-${String(counter + 1).padStart(6, '0')}`,
        title,
        description,
        category,
        priority,
        location,
        status: 'open',
        source: opts.maintenanceTaskId ? 'maintenance' : sourceOf(actor.kind),
        ...(opts.maintenanceTaskId ? { maintenanceTaskId: opts.maintenanceTaskId } : {}),
        ...(equipmentId ? { equipmentId } : {}),
        createdByRole: ctx.role,
        dueAt: dueAtFor(ts, priority, settings),
        reopenCount: 0,
        photoCount: photoKeys.length,
        createdAt: ts,
        createdBy: ctx.userId,
        updatedAt: ts,
        updatedBy: ctx.userId,
        version: 1,
      };
      const putIndexes = [index(ticketKeys.user(ctx.apartmentId, ctx.userId, ticketId), ticket)];
      if (location.kind === 'unit') putIndexes.push(index(ticketKeys.unit(ctx.apartmentId, location.unitId, ticketId), ticket));
      try {
        await repo.write(ctx.apartmentId, {
          at: ts,
          ticket,
          expectedVersion: 0,
          events: [newEvent(ctx, ticket, ts, { kind: 'created', visibility: 'public', to: 'open', ...(photoKeys.length ? { photoKeys } : {}) })],
          putIndexes,
          outbox: [domainEvent('TICKET_CREATED', ctx, actor, ticket)],
          counter: { expected: counter },
          idempotency: { ...ticketKeys.idempotency(ctx.apartmentId, key), entityType: 'TICKET_IDEMPOTENCY', apartmentId: ctx.apartmentId, ticketId, fingerprint: fp, createdAt: ts },
          audit: { apartmentId: ctx.apartmentId, action: 'ticket.create', target: { type: 'ticket', id: ticketId }, details: { number: ticket.number, category, priority, location: location.kind, ...(equipmentId ? { equipmentId } : {}) } },
        });
        return { ticket: ticketView(actor, ticket, settings), replayed: false };
      } catch (err) {
        if (err instanceof TicketConflictError && err.reason === 'duplicate') {
          const r = await replay();
          if (r) return r;
        }
        if (err instanceof TicketConflictError && err.reason === 'counter' && attempt < WRITE_RETRIES) continue;
        if (err instanceof TicketConflictError) throw new TicketError('conflict', 'Talep numarası alınamadı; tekrar deneyin');
        throw err;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Okuma
  // -------------------------------------------------------------------------

  async function visibleTickets(actor: TicketActor, settings: TicketSettings, opts: { consistent?: boolean } = {}): Promise<Ticket[]> {
    let tickets: Ticket[];
    if (actor.kind === 'resident' || actor.kind === 'security') {
      const ids = new Set(await repo.listIndexed(actor.apartmentId, ticketKeys.userPrefix(actor.userId)));
      for (const unitId of actor.unitIds) for (const id of await repo.listIndexed(actor.apartmentId, ticketKeys.unitPrefix(unitId))) ids.add(id);
      tickets = ids.size ? await repo.getMany(actor.apartmentId, [...ids]) : [];
    } else {
      tickets = await repo.list(actor.apartmentId, opts.consistent === false ? { consistent: false } : undefined);
    }
    return tickets.filter((t) => canView(actor, t, settings));
  }

  /**
   * Liste. Filtreler: `status` (virgulle; `active` = cozum bekleyenler), `assignee` (`me` | `none` |
   * kullanici), `category`, `priority`, `unitId`, `blockId`, `overdue=true`, `q` (numara/baslik),
   * `from`/`to` (olusturma tarihi). En yeni once; `cursor` sayfa ofseti.
   */
  async function list(ctx: TicketContext, q: Record<string, string | undefined> = {}) {
    const [actor, settings] = await Promise.all([actorOf(ctx), settingsOf(ctx.apartmentId)]);
    const now = deps.now();
    let statuses: readonly TicketStatus[] | undefined;
    if (q.status) {
      statuses = q.status === 'active' ? ACTIVE_STATUSES : q.status.split(',').map((s) => {
        if (!(TICKET_STATUSES as readonly string[]).includes(s)) throw new ValidationError('status geçersiz', 'status');
        return s as TicketStatus;
      });
    }
    if (q.category && !(TICKET_CATEGORIES as readonly string[]).includes(q.category)) throw new ValidationError('category geçersiz', 'category');
    if (q.priority && !(TICKET_PRIORITIES as readonly string[]).includes(q.priority)) throw new ValidationError('priority geçersiz', 'priority');
    const assignee = q.assignee === 'me' ? ctx.userId : q.assignee;
    const term = q.q?.trim().toLocaleLowerCase('tr');
    const limit = q.limit ? Math.min(Math.max(Number(q.limit) || 50, 1), MAX_PAGE) : 50;
    const offset = q.cursor ? Math.max(Number(q.cursor) || 0, 0) : 0;

    const all = (await visibleTickets(actor, settings))
      .filter((t) => !statuses || statuses.includes(t.status))
      .filter((t) => !assignee || (assignee === 'none' ? !t.assigneeId : t.assigneeId === assignee))
      .filter((t) => !q.category || t.category === q.category)
      .filter((t) => !q.priority || t.priority === q.priority)
      .filter((t) => !q.unitId || (t.location.kind === 'unit' && t.location.unitId === q.unitId))
      .filter((t) => !q.blockId || t.location.blockId === q.blockId)
      .filter((t) => !q.equipmentId || t.equipmentId === q.equipmentId)
      .filter((t) => q.overdue !== 'true' || isOverdue(t, now))
      .filter((t) => !q.from || t.createdAt.slice(0, 10) >= q.from)
      .filter((t) => !q.to || t.createdAt.slice(0, 10) <= q.to)
      .filter((t) => !term || t.number.toLocaleLowerCase('tr').includes(term) || t.title.toLocaleLowerCase('tr').includes(term))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const page = all.slice(offset, offset + limit);
    return {
      items: page.map((t) => ticketView(actor, t, settings)),
      total: all.length,
      ...(offset + limit < all.length ? { nextCursor: String(offset + limit) } : {}),
    };
  }

  /** Pano: cozum bekleyen + cozulmus talepler durum sutunlarinda; sayilar ve SLA ozeti. */
  async function board(ctx: TicketContext) {
    const [actor, settings] = await Promise.all([actorOf(ctx), settingsOf(ctx.apartmentId)]);
    if (actor.kind === 'resident' || actor.kind === 'security') throw new TicketError('forbidden', 'Pano yönetim ve görevli ekranıdır');
    const now = deps.now();
    const tickets = await visibleTickets(actor, settings);
    const columns: TicketStatus[] = ['open', 'assigned', 'in_progress', 'on_hold', 'resolved'];
    const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const byPriority = (a: Ticket, b: Ticket) =>
      TICKET_PRIORITIES.indexOf(b.priority) - TICKET_PRIORITIES.indexOf(a.priority) || a.dueAt.localeCompare(b.dueAt);
    return {
      columns: columns.map((status) => {
        const items = tickets.filter((t) => t.status === status).sort(byPriority);
        return { status, count: items.length, items: items.map((t) => ticketView(actor, t, settings)) };
      }),
      overdueCount: tickets.filter((t) => isOverdue(t, now)).length,
      urgentOpenCount: tickets.filter((t) => t.priority === 'urgent' && ACTIVE_STATUSES.includes(t.status)).length,
      closedLast30Days: tickets.filter((t) => t.status === 'closed' && (t.closedAt ?? '') >= since).length,
      settings,
    };
  }

  /**
   * Yalnizca sayilar (yonetim portfoyu): panoyla ayni okuma, gorunurluk ve SLA kurali, talep icerigi
   * yok. Durum indeksi olmadigindan panodaki gibi tum talepler okunur; sayi icin eventually consistent.
   * `openByPriority`: cozum bekleyen (SLA isleyen) talepler; `overdueCount`: SLA'si asilanlar.
   */
  async function stats(ctx: TicketContext) {
    const [actor, settings] = await Promise.all([actorOf(ctx), settingsOf(ctx.apartmentId)]);
    if (actor.kind === 'resident' || actor.kind === 'security') throw new TicketError('forbidden', 'Pano yönetim ve görevli ekranıdır');
    const now = deps.now();
    const active = (await visibleTickets(actor, settings, { consistent: false })).filter((t) => ACTIVE_STATUSES.includes(t.status));
    const openByPriority = Object.fromEntries(TICKET_PRIORITIES.map((p) => [p, active.filter((t) => t.priority === p).length])) as Record<TicketPriority, number>;
    return { openCount: active.length, openByPriority, overdueCount: active.filter((t) => isOverdue(t, now)).length };
  }

  async function get(ctx: TicketContext, ticketId: string) {
    const { actor, settings, ticket } = await load(ctx, ticketId);
    const events = await repo.listEvents(ctx.apartmentId, ticketId);
    return { ticket: ticketView(actor, ticket, settings), events: visibleEvents(actor, events).map((e) => eventView(actor, e)) };
  }

  // -------------------------------------------------------------------------
  // Yazim
  // -------------------------------------------------------------------------

  const touch = (ctx: TicketContext, t: Ticket, ts: IsoDateTime) => ({ updatedAt: ts, updatedBy: ctx.userId, version: t.version + 1 });

  /** Yonetici: baslik, aciklama, kategori, oncelik (SLA yeniden hesaplanir), konum, ekipman (v2; `null` kaldirir). */
  async function update(ctx: TicketContext, ticketId: string, body: unknown) {
    const o = asObject(body);
    const version = parseVersion(o);
    const { actor, settings, ticket } = await load(ctx, ticketId);
    if (!canEditFields(actor)) throw new TicketError('forbidden', 'Talep bilgilerini yalnızca yönetim düzeltebilir');
    if (TERMINAL_STATUSES.includes(ticket.status)) throw new TicketError('invalid_state', 'Kapanmış veya iptal edilmiş talep düzenlenemez');
    assertVersion(ticket, version);
    const next: Ticket = { ...ticket };
    const changes: Record<string, [unknown, unknown]> = {};
    const set = <K extends 'title' | 'description' | 'category' | 'priority' | 'location'>(k: K, v: Ticket[K] | undefined) => {
      if (v === undefined || JSON.stringify(v) === JSON.stringify(ticket[k])) return;
      changes[k] = [ticket[k], v];
      next[k] = v;
    };
    set('title', o.title === undefined ? undefined : reqString(o, 'title', 120, 3));
    set('description', o.description === undefined ? undefined : reqString(o, 'description', 4000, 1));
    set('category', o.category === undefined ? undefined : reqEnum(o, 'category', TICKET_CATEGORIES));
    set('priority', o.priority === undefined ? undefined : reqEnum(o, 'priority', TICKET_PRIORITIES));
    set('location', o.location === undefined ? undefined : await parseLocation(ctx, o.location));
    const link = await resolveEquipmentLink(deps.equipment, ctx.apartmentId, o.equipmentId, ticket.equipmentId);
    if (link.equipmentId !== ticket.equipmentId) {
      changes.equipmentId = [ticket.equipmentId ?? null, link.equipmentId ?? null];
      if (link.equipmentId) next.equipmentId = link.equipmentId;
      else delete next.equipmentId;
    }
    if (!Object.keys(changes).length) return { ticket: ticketView(actor, ticket, settings) };
    if (changes.priority) next.dueAt = dueAtFor(ticket.createdAt, next.priority, settings);

    const ts = stamp();
    Object.assign(next, touch(ctx, ticket, ts));
    // Indeksler yalnizca eklenir (API'nin DeleteItem yetkisi yok): eski dairenin indeksi kalir, okuma
    // `canView` ile talebin guncel konumuna gore suzer.
    const putIndexes: TicketIndex[] = [];
    if (changes.location && next.location.kind === 'unit') putIndexes.push(index(ticketKeys.unit(ctx.apartmentId, next.location.unitId, ticketId), next));
    await write(ctx.apartmentId, {
      at: ts,
      ticket: next,
      expectedVersion: version,
      events: [newEvent(ctx, next, ts, { kind: 'field_changed', visibility: 'internal', changes })],
      putIndexes,
      audit: { apartmentId: ctx.apartmentId, action: 'ticket.update', target: { type: 'ticket', id: ticketId }, details: { number: ticket.number, fields: Object.keys(changes) } },
    });
    return { ticket: ticketView(actor, next, settings) };
  }

  /**
   * v2: gorevlinin tahmini tutar notu `{ version, amount: kurus | null, note? }`. Yalnizca bilgi
   * amaclidir: Finans'a / deftere hicbir kayit yazilmaz. Ic olay (`estimate_set`) ve denetim kaydi
   * ayni yazimda; sakin ve guvenlik uclarina donmez. `amount: null` notu kaldirir.
   */
  async function estimate(ctx: TicketContext, ticketId: string, body: unknown) {
    const o = asObject(body);
    const version = parseVersion(o);
    const { actor, settings, ticket } = await load(ctx, ticketId);
    if (!canEstimate(actor, ticket)) {
      const closed = TERMINAL_STATUSES.includes(ticket.status);
      throw new TicketError(closed ? 'invalid_state' : 'forbidden', closed ? 'Kapanmış veya iptal edilmiş talebe tahmini tutar girilemez' : 'Tahmini tutarı yalnızca yönetim ve talebin güncel görevlisi (atanmamış talepte açan görevli) girebilir');
    }
    assertVersion(ticket, version);
    const clear = o.amount === null;
    const amount = clear ? undefined : reqInt(o, 'amount', 0, MAX_AMOUNT);
    const note = clear ? undefined : optString(o, 'note', 300)?.trim() || undefined;
    if (clear && !ticket.estimate) return { ticket: ticketView(actor, ticket, settings) };
    if (!clear && ticket.estimate?.amount === amount && ticket.estimate?.note === note) return { ticket: ticketView(actor, ticket, settings) };
    const ts = stamp();
    const { estimate: previous, ...rest } = ticket;
    const next: Ticket = {
      ...rest,
      ...(amount !== undefined ? { estimate: { amount, ...(note ? { note } : {}), at: ts, by: ctx.userId, byRole: ctx.role } } : {}),
      ...touch(ctx, ticket, ts),
    };
    await write(ctx.apartmentId, {
      at: ts,
      ticket: next,
      expectedVersion: version,
      events: [newEvent(ctx, next, ts, { kind: 'estimate_set', visibility: 'internal', ...(amount !== undefined ? { amount } : {}), ...(note ? { body: note } : {}) })],
      audit: {
        apartmentId: ctx.apartmentId,
        action: 'ticket.estimate',
        target: { type: 'ticket', id: ticketId },
        details: { number: ticket.number, amount: amount ?? null, previous: previous?.amount ?? null },
      },
    });
    return { ticket: ticketView(actor, next, settings) };
  }

  /** Atanabilir gorevliler: apartmanin aktif bina gorevlisi kayitlari. */
  async function assignees(ctx: TicketContext) {
    const actor = await actorOf(ctx);
    if (actor.kind !== 'manager' && actor.kind !== 'staff' && actor.kind !== 'observer') throw new TicketError('forbidden', 'Bu liste yönetim ekranıdır');
    const d = today();
    const items = (await deps.roles.list(ctx.apartmentId))
      .filter((r) => r.role === 'building_staff' && r.status === 'active' && r.startDate <= d && (!r.endDate || r.endDate >= d))
      .map((r) => ({ userId: r.userId, name: r.displayName ?? r.fullName ?? r.email ?? r.userId }))
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    return { items };
  }

  /**
   * Atama / yeniden atama / kaldirma (`assigneeId: null`). Gorevli yalnizca atanmamis acik talebi
   * kendine ustlenebilir. Gorevli indeksi ayni yazimda guncellenir.
   */
  async function assign(ctx: TicketContext, ticketId: string, body: unknown) {
    const o = asObject(body);
    const version = parseVersion(o);
    const assigneeId = o.assigneeId === null || o.assigneeId === '' ? null : assertId(o.assigneeId, 'assigneeId');
    const note = optString(o, 'note', 1000);
    const { actor, settings, ticket } = await load(ctx, ticketId);
    const check = checkAssign(actor, ticket, assigneeId, settings);
    if (!check.ok) throw new TicketError(ACTIVE_STATUSES.includes(ticket.status) ? 'forbidden' : 'invalid_state', check.reason);
    assertVersion(ticket, version);
    if (assigneeId === (ticket.assigneeId ?? null)) return { ticket: ticketView(actor, ticket, settings) };
    if (assigneeId) {
      const staff = (await assignees({ ...ctx, role: actor.kind === 'staff' ? 'building_staff' : ctx.role })).items;
      if (!staff.some((s) => s.userId === assigneeId)) throw new TicketError('unprocessable', 'Seçilen kişi bu apartmanın aktif bina görevlisi değil');
    }

    const ts = stamp();
    const status = statusAfterAssign(ticket, assigneeId);
    const { assigneeId: _old, assignedAt: _oldAt, ...rest } = ticket;
    const next: Ticket = { ...rest, ...(assigneeId ? { assigneeId, assignedAt: ts } : {}), status, ...touch(ctx, ticket, ts) };
    const events = [newEvent(ctx, next, ts, { kind: 'assigned', visibility: 'public', ...(assigneeId ? { assigneeId } : {}), ...(note ? { body: note } : {}) })];
    if (status !== ticket.status) events.push(newEvent(ctx, next, ts, { kind: 'status_changed', visibility: 'public', from: ticket.status, to: status }, 1));
    await write(ctx.apartmentId, {
      at: ts,
      ticket: next,
      expectedVersion: version,
      events,
      outbox: assigneeId ? [domainEvent('TICKET_ASSIGNED', ctx, actor, next)] : [],
      audit: { apartmentId: ctx.apartmentId, action: 'ticket.assign', target: { type: 'ticket', id: ticketId }, details: { number: ticket.number, from: ticket.assigneeId ?? null, to: assigneeId } },
    });
    return { ticket: ticketView(actor, next, settings) };
  }

  /**
   * Durum gecisi: `start | hold | resume | resolve | confirm | close | reopen | cancel`.
   * Not zorunlulugu kurala gore (bekletme, cozum, zorla kapama, yeniden acma, yonetici reddi).
   * Onayda istege bagli 1-5 puan.
   */
  async function transition(ctx: TicketContext, ticketId: string, body: unknown) {
    const o = asObject(body);
    const version = parseVersion(o);
    const action = reqEnum(o, 'action', TRANSITIONS) as TransitionAction;
    const note = optString(o, 'note', 2000)?.trim() || undefined;
    const { actor, settings, ticket } = await load(ctx, ticketId);
    const now = deps.now();
    const check = checkTransition(actor, ticket, action, { now, settings });
    if (!check.ok) throw new TicketError(check.code, check.reason);
    if (check.noteRequired && (!note || note.length < 3)) throw new ValidationError('Bu işlem için açıklama gerekli (en az 3 karakter)', 'note');
    let rating: number | undefined;
    if (action === 'confirm' && o.rating !== undefined && o.rating !== null) rating = reqInt(o, 'rating', 1, 5);
    const uploadIds = parseUploadIds(o.photos);
    assertVersion(ticket, version);
    assertPhotoRoom(ticket, uploadIds.length);
    const photoKeys = await photos.attach(ctx.apartmentId, ctx.userId, ticketId, uploadIds);

    const ts = now.toISOString();
    const next: Ticket = { ...ticket, status: check.to, photoCount: ticket.photoCount + photoKeys.length, ...touch(ctx, ticket, ts) };
    switch (action) {
      case 'resolve':
        next.resolvedAt = ts;
        next.slaMet = ts <= ticket.dueAt;
        break;
      case 'confirm':
      case 'close':
        next.closedAt = ts;
        next.closeKind = action === 'confirm' ? 'confirmed' : 'forced';
        if (rating) next.rating = { score: rating, ...(note ? { note } : {}), at: ts, by: ctx.userId };
        break;
      case 'reopen': {
        delete next.resolvedAt;
        delete next.slaMet;
        next.reopenCount = ticket.reopenCount + 1;
        // Yeniden acilan is icin SLA yeniden baslar.
        next.dueAt = dueAtFor(ts, ticket.priority, settings);
        break;
      }
      case 'cancel':
        next.cancelledAt = ts;
        next.cancelKind = actor.kind === 'manager' && ticket.createdBy !== ctx.userId ? 'rejected' : 'withdrawn';
        break;
    }

    const events = [
      newEvent(ctx, next, ts, { kind: 'status_changed', visibility: 'public', from: ticket.status, to: next.status, ...(note ? { body: note } : {}), ...(photoKeys.length ? { photoKeys } : {}) }),
    ];
    if (rating) events.push(newEvent(ctx, next, ts, { kind: 'rated', visibility: 'public', rating }, 1));
    const audited = actor.kind === 'manager' || action === 'cancel';
    await write(ctx.apartmentId, {
      at: ts,
      ticket: next,
      expectedVersion: version,
      events,
      outbox: [
        domainEvent('TICKET_STATUS_CHANGED', ctx, actor, next, {
          action,
          from: ticket.status,
          to: next.status,
          ...(next.closeKind && action !== 'reopen' ? { closeKind: next.closeKind } : {}),
          ...(next.cancelKind ? { cancelKind: next.cancelKind } : {}),
        }),
      ],
      ...(audited
        ? { audit: { apartmentId: ctx.apartmentId, action: `ticket.${action}`, target: { type: 'ticket', id: ticketId }, ...(note ? { reason: note } : {}), details: { number: ticket.number, from: ticket.status, to: next.status } } }
        : {}),
    });
    return { ticket: ticketView(actor, next, settings) };
  }

  /**
   * Yorum (herkese acik) veya ic not; istege bagli fotograf. Fotografsiz yorum talep kaydini
   * degistirmez (surum gerekmez); fotografli yorumda sayac guncel surumle artirilir (bir kez yeniden
   * denenir). Ic not bildirim uretmez.
   */
  async function comment(ctx: TicketContext, ticketId: string, body: unknown) {
    const o = asObject(body);
    const text = reqString(o, 'body', 2000, 1).trim();
    if (!text) throw new ValidationError('Yorum boş olamaz', 'body');
    const visibility = o.visibility === undefined ? 'public' : reqEnum(o, 'visibility', ['public', 'internal'] as const);
    const uploadIds = parseUploadIds(o.photos);
    const loaded = await load(ctx, ticketId);
    const { actor, settings } = loaded;
    let ticket = loaded.ticket;
    if (!canComment(actor, ticket, visibility, settings)) {
      throw new TicketError('forbidden', visibility === 'internal' ? 'İç notu yalnızca yönetim ve görevli ekleyebilir' : 'Bu talebe yorum ekleyemezsiniz');
    }
    if (TERMINAL_STATUSES.includes(ticket.status) && actor.kind !== 'manager') throw new TicketError('invalid_state', 'Kapanmış talebe yorum eklenemez');
    assertPhotoRoom(ticket, uploadIds.length);
    const photoKeys = await photos.attach(ctx.apartmentId, ctx.userId, ticketId, uploadIds);
    const ts = stamp();
    const event = newEvent(ctx, ticket, ts, { kind: 'comment', visibility, body: text, ...(photoKeys.length ? { photoKeys } : {}) });
    const outbox = visibility === 'public' ? [domainEvent('TICKET_COMMENTED', ctx, actor, ticket)] : [];
    if (!photoKeys.length) {
      await write(ctx.apartmentId, { at: ts, exists: ticketKeys.ticket(ctx.apartmentId, ticketId), events: [event], outbox });
      return { event: eventView(actor, event) };
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await repo.write(ctx.apartmentId, {
          at: ts,
          ticket: { ...ticket, photoCount: ticket.photoCount + photoKeys.length, ...touch(ctx, ticket, ts) },
          expectedVersion: ticket.version,
          events: [event],
          outbox,
        });
        return { event: eventView(actor, event) };
      } catch (err) {
        if (!(err instanceof TicketConflictError) || attempt >= 2) throw err instanceof TicketConflictError ? new TicketError('conflict', err.message) : err;
        const fresh = await repo.get(ctx.apartmentId, ticketId);
        if (!fresh) throw new TicketError('not_found', 'Talep bulunamadı');
        assertPhotoRoom(fresh, photoKeys.length);
        ticket = fresh;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Fotograflar ve benzer talepler (O1-2)
  // -------------------------------------------------------------------------

  /** Yukleme linki: denetci disindaki roller (talep acabilen / yorum yazabilen herkes). */
  async function photoUploadUrl(ctx: TicketContext, body: unknown) {
    const actor = await actorOf(ctx);
    if (actor.kind === 'observer') throw new TicketError('forbidden', 'Denetçi fotoğraf yükleyemez');
    return photos.presignUpload(ctx.apartmentId, ctx.userId, body);
  }

  /** Fotograf goruntuleme: fotografi tasiyan olay aktore gorunur olmali. */
  async function photo(ctx: TicketContext, ticketId: string, photoId: string) {
    const { actor, ticket } = await load(ctx, ticketId);
    const events = visibleEvents(actor, await repo.listEvents(ctx.apartmentId, ticketId));
    const key = events.flatMap((e) => e.photoKeys ?? []).find((k) => photoIdOf(k) === photoId);
    if (!key) throw new TicketError('not_found', 'Fotoğraf bulunamadı');
    return photos.presignDownload(key, `${ticket.number}-foto`);
  }

  /**
   * Ortak alanda benzer acik talepler (tekrar bildirimi azaltmak icin). Baskasinin talebinin
   * metni ve kimligi donmez; yalnizca numara, kategori, alan ve durum.
   */
  async function similar(ctx: TicketContext, q: { category?: string; blockId?: string } = {}) {
    await actorOf(ctx);
    if (q.category && !(TICKET_CATEGORIES as readonly string[]).includes(q.category)) throw new ValidationError('category geçersiz', 'category');
    const items = (await repo.list(ctx.apartmentId))
      .filter((t) => ACTIVE_STATUSES.includes(t.status) && t.location.kind === 'common')
      .filter((t) => !q.category || t.category === q.category)
      .filter((t) => !q.blockId || t.location.blockId === q.blockId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5)
      .map((t) => ({
        number: t.number,
        category: t.category,
        area: t.location.kind === 'common' ? t.location.area : '',
        ...(t.location.blockId ? { blockId: t.location.blockId } : {}),
        status: t.status,
        createdAt: t.createdAt,
        mine: t.createdBy === ctx.userId,
      }));
    return { items };
  }

  // -------------------------------------------------------------------------
  // Gunluk is (O1-3, zamanlayici `ticket_maintenance`)
  // -------------------------------------------------------------------------

  /**
   * 1) Cozuldu durumunda `autoCloseDays` gun bekleyip sakin onayi gelmeyen talepleri kapatir
   *    (`closeKind: auto`, aktor sistem; talep tarafina bildirim outbox ile). Es zamanli degisiklikte
   *    (surum) o talep atlanir, ertesi gun yeniden denenir.
   * 2) SLA hedefini asmis cozum bekleyen talepleri gunluk ozet icin dondurur.
   * Zamanlayicinin DeleteItem yetkisi yok; bu yol yalnizca Put / outbox yazar.
   */
  async function runDaily(apartmentId: string) {
    const ctx: TicketContext = { apartmentId, userId: SYSTEM_USER, role: 'system' };
    const actor: TicketActor = { apartmentId, userId: SYSTEM_USER, role: 'system', kind: 'manager', unitIds: [] };
    const settings = await settingsOf(apartmentId);
    const now = deps.now();
    const ts = now.toISOString();
    const limit = settings.autoCloseDays * 86_400_000;
    const tickets = await repo.list(apartmentId);
    let autoClosed = 0;
    let conflicts = 0;
    for (const t of tickets) {
      if (t.status !== 'resolved' || !t.resolvedAt || now.getTime() - Date.parse(t.resolvedAt) < limit) continue;
      const next: Ticket = { ...t, status: 'closed', closedAt: ts, closeKind: 'auto', updatedAt: ts, updatedBy: SYSTEM_USER, version: t.version + 1 };
      try {
        await repo.write(apartmentId, {
          at: ts,
          ticket: next,
          expectedVersion: t.version,
          events: [newEvent(ctx, next, ts, { kind: 'status_changed', visibility: 'public', from: 'resolved', to: 'closed', body: `Sakin onayı ${settings.autoCloseDays} gün içinde gelmediği için otomatik kapatıldı` })],
          outbox: [domainEvent('TICKET_STATUS_CHANGED', ctx, actor, next, { action: 'close', from: 'resolved', to: 'closed', closeKind: 'auto', actorKind: 'system' })],
        });
        autoClosed++;
      } catch (err) {
        if (err instanceof TicketConflictError) conflicts++;
        else throw err;
      }
    }
    const breached = tickets
      .filter((t) => isOverdue(t, now))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .map((t) => ({ ticketId: t.ticketId, number: t.number, title: t.title, priority: t.priority, dueAt: t.dueAt, ...(t.assigneeId ? { assigneeId: t.assigneeId } : {}) }));
    return { autoClosed, conflicts, breached };
  }

  return { create, list, board, stats, get, update, estimate, assignees, assign, transition, comment, photoUploadUrl, photo, similar, runDaily, actorOf, settingsOf };
}

export type TicketService = ReturnType<typeof createTicketService>;
