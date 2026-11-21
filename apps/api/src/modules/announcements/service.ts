import { randomUUID } from 'node:crypto';
import { DataAccessError } from '../../config/dynamodb.js';
import { type DomainEvent, buildEvent } from '../../events/publisher.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { CoreError } from '../core/service.js';
import type { IsoDateTime } from '../core/types.js';
import { type Obj, ValidationError, asObject, assertId, optEnum, reqInt, reqString } from '../core/validation.js';
import { ANNOUNCEMENT_STATUSES, type Announcement } from '../portal/types.js';
import { type AnnouncementRepository, announcementKeys, announcementRepository } from './repository.js';

/**
 * Yonetici tarafi duyuru yonetimi.
 *
 * Yasam dongusu: `draft` -(onay)-> `published` -(arsiv)-> `archived`.
 *  - Yalnizca taslaklar duzenlenebilir; yayinlanmis duyuru degistirilmez (sakinlerin gordugu
 *    metin sessizce degismesin). Duzeltme icin arsivlenip yenisi olusturulur.
 *  - Onayda `publishAt` gecmisteyse onay ani yayin zamani olur; gelecekteyse ileri tarihli
 *    yayinlanir (portal pencere disindakileri gostermez).
 *  - Onaylaninca `ANNOUNCEMENT_PUBLISHED` olayi yayinlanir (bildirim worker'i icin).
 *  - Silme yok: arsivleme. Tum degisiklikler `version` ile optimistic locking kullanir.
 */

const MAX_BLOCKS = 50;
const STATUS_FILTERS = [...ANNOUNCEMENT_STATUSES, 'all'] as const;

export type AnnouncementContext = { apartmentId: string; userId: string };

export type AnnouncementServiceDeps = {
  repository: AnnouncementRepository;
  core: Pick<CoreRepository, 'getBlock'>;
  now: () => Date;
  newId: () => string;
};

/** Saat dilimi icermeyen tarih-saat belirsizdir; `Z` veya `+03:00` zorunlu. */
function parseDateTime(o: Obj, key: string): IsoDateTime {
  const v = reqString(o, key, 40);
  const hasZone = /(Z|[+-]\d{2}:\d{2})$/.test(v);
  const ms = Date.parse(v);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || !hasZone || Number.isNaN(ms)) {
    throw new ValidationError(`${key} saat dilimli ISO 8601 tarih-saat olmalidir (ornek 2026-11-10T09:00:00+03:00)`, key);
  }
  return new Date(ms).toISOString();
}

export function createAnnouncementService(overrides: Partial<AnnouncementServiceDeps> = {}) {
  const deps: AnnouncementServiceDeps = {
    repository: announcementRepository,
    core: coreRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.repository;
  const stamp = () => deps.now().toISOString();

  async function requireAnnouncement(ctx: AnnouncementContext, id: string): Promise<Announcement> {
    assertId(id, 'announcementId');
    const a = await repo.get(ctx.apartmentId, id);
    if (!a) throw new CoreError('not_found', 'Duyuru bulunamadi');
    return a;
  }

  async function parseBlockIds(ctx: AnnouncementContext, value: unknown): Promise<string[] | undefined> {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.length > MAX_BLOCKS) {
      throw new ValidationError(`blockIds en fazla ${MAX_BLOCKS} ogeli bir dizi olmalidir`, 'blockIds');
    }
    const ids = [...new Set(value.map((v, i) => assertId(v, `blockIds[${i}]`)))];
    const blocks = await Promise.all(ids.map((id) => deps.core.getBlock(ctx.apartmentId, id)));
    const missing = ids.filter((_, i) => !blocks[i] || blocks[i]?.status !== 'active');
    if (missing.length) throw new CoreError('not_found', `Blok bulunamadi veya pasif: ${missing.join(', ')}`);
    return ids.length ? ids.sort() : undefined;
  }

  function assertWindow(publishAt: IsoDateTime, expiresAt: IsoDateTime | undefined): void {
    if (expiresAt && expiresAt <= publishAt) {
      throw new ValidationError('expiresAt, publishAt zamanindan sonra olmalidir', 'expiresAt');
    }
  }

  function assertVersion(current: Announcement, version: number): void {
    if (current.version !== version) {
      throw new CoreError('conflict', 'Kayit baska bir islemle degistirildi (surum uyusmazligi)');
    }
  }

  async function save(next: Announcement, expectedVersion: number, outbox?: DomainEvent[]): Promise<Announcement> {
    try {
      await repo.update(next, expectedVersion, outbox);
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') {
        throw new CoreError('conflict', 'Kayit baska bir islemle degistirildi (surum uyusmazligi)');
      }
      throw err;
    }
    return next;
  }

  const touch = (ctx: AnnouncementContext, a: Announcement) => ({
    updatedAt: stamp(),
    updatedBy: ctx.userId,
    version: a.version + 1,
  });

  // ----- Olustur (taslak) -----

  async function create(ctx: AnnouncementContext, body: unknown): Promise<Announcement> {
    const o = asObject(body);
    const title = reqString(o, 'title', 150);
    const text = reqString(o, 'body', 5000);
    const publishAt = o.publishAt == null ? stamp() : parseDateTime(o, 'publishAt');
    const expiresAt = o.expiresAt == null ? undefined : parseDateTime(o, 'expiresAt');
    assertWindow(publishAt, expiresAt);
    const blockIds = await parseBlockIds(ctx, o.blockIds);

    const ts = stamp();
    const announcementId = deps.newId();
    const announcement: Announcement = {
      ...announcementKeys.announcement(ctx.apartmentId, announcementId),
      entityType: 'ANNOUNCEMENT',
      announcementId,
      apartmentId: ctx.apartmentId,
      title,
      body: text,
      status: 'draft',
      blockIds,
      publishAt,
      expiresAt,
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    await repo.create(announcement);
    return announcement;
  }

  // ----- Oku -----

  async function list(ctx: AnnouncementContext, status?: string): Promise<Announcement[]> {
    const filter = optEnum({ status }, 'status', STATUS_FILTERS) ?? 'all';
    const all = await repo.list(ctx.apartmentId);
    return all
      .filter((a) => a.apartmentId === ctx.apartmentId && (filter === 'all' || a.status === filter))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.announcementId.localeCompare(a.announcementId));
  }

  const get = (ctx: AnnouncementContext, id: string) => requireAnnouncement(ctx, id);

  // ----- Taslak duzenle -----

  async function update(ctx: AnnouncementContext, id: string, body: unknown): Promise<Announcement> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await requireAnnouncement(ctx, id);
    assertVersion(current, version);
    if (current.status !== 'draft') {
      throw new CoreError('conflict', 'Yalnizca taslak duyurular duzenlenebilir');
    }

    const publishAt = o.publishAt === undefined ? current.publishAt : parseDateTime(o, 'publishAt');
    const expiresAt =
      o.expiresAt === undefined ? current.expiresAt : o.expiresAt === null ? undefined : parseDateTime(o, 'expiresAt');
    assertWindow(publishAt, expiresAt);

    const next: Announcement = {
      ...current,
      title: o.title === undefined ? current.title : reqString(o, 'title', 150),
      body: o.body === undefined ? current.body : reqString(o, 'body', 5000),
      blockIds: o.blockIds === undefined ? current.blockIds : await parseBlockIds(ctx, o.blockIds),
      publishAt,
      expiresAt,
      ...touch(ctx, current),
    };
    return save(next, current.version);
  }

  // ----- Onayla (yayinla) -----

  async function approve(ctx: AnnouncementContext, id: string, body: unknown): Promise<Announcement> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await requireAnnouncement(ctx, id);
    assertVersion(current, version);
    if (current.status !== 'draft') {
      throw new CoreError('conflict', `Duyuru onaylanamaz: durum ${current.status}`);
    }

    const now = stamp();
    const publishAt = current.publishAt < now ? now : current.publishAt;
    if (current.expiresAt && current.expiresAt <= publishAt) {
      throw new ValidationError('Duyurunun suresi dolmus; expiresAt guncellenmeli', 'expiresAt');
    }

    const next: Announcement = {
      ...current,
      status: 'published',
      publishAt,
      approvedBy: ctx.userId,
      approvedAt: now,
      ...touch(ctx, current),
    };
    // Onay ve ANNOUNCEMENT_PUBLISHED olayi tek atomik yazim (transactional outbox).
    const event = buildEvent(
      {
        eventId: `ANNOUNCEMENT_PUBLISHED:${next.announcementId}`,
        type: 'ANNOUNCEMENT_PUBLISHED',
        apartmentId: ctx.apartmentId,
        actorId: ctx.userId,
        payload: {
          announcementId: next.announcementId,
          title: next.title,
          blockIds: next.blockIds ?? [],
          publishAt: next.publishAt,
          expiresAt: next.expiresAt,
        },
      },
      deps.now,
    );
    return save(next, current.version, [event]);
  }

  // ----- Arsivle (silme yok) -----

  async function archive(ctx: AnnouncementContext, id: string, body: unknown): Promise<Announcement> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await requireAnnouncement(ctx, id);
    if (current.status === 'archived') return current;
    assertVersion(current, version);
    return save(
      { ...current, status: 'archived', archivedAt: stamp(), ...touch(ctx, current) },
      current.version,
    );
  }

  return { create, list, get, update, approve, archive };
}

export type AnnouncementService = ReturnType<typeof createAnnouncementService>;
