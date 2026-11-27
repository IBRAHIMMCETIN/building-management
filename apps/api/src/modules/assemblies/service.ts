import { createHash, randomUUID } from 'node:crypto';
import { DataAccessError } from '../../config/dynamodb.js';
import type { AuditDraft } from '../audit/log.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import type { IsoDateTime } from '../core/types.js';
import { type Obj, ValidationError, asObject, assertId, optString, reqEnum, reqInt, reqString } from '../core/validation.js';
import { DocumentError } from '../documents/errors.js';
import { assemblySheetKey, contentDisposition } from '../documents/keys.js';
import { renderReportPdf } from '../documents/reportPdf.js';
import { type DocumentStore, URL_TTL_SECONDS, createDocumentStoreFromEnv } from '../documents/store.js';
import { type MembershipRepository, membershipRepository } from '../memberships/repository.js';
import { formatDate, formatDateTime } from '../notifications/templates.js';
import { addDays, buildVotingRoll } from '../ownership/register.js';
import { type OwnershipRepository, ownershipRepository } from '../ownership/repository.js';
import { PollError } from '../polls/errors.js';
import { istanbulDate } from '../polls/results.js';
import { type RollEntry, type RollMeta, type RollSnapshotStore, buildSnapshot, rollSnapshotStore } from '../polls/rollSnapshot.js';
import { type PersonRepository, personRepository } from '../residents/repository.js';
import { type ProxyRef, type Quorum, assemblyQuorum, decide, proxyViolation } from './quorum.js';
import { type AssemblyRepository, assemblyKeys, assemblyRepository } from './repository.js';
import { ASSEMBLY_KINDS, ATTENDANCE_MODES, type AgendaItem, type Assembly, type AssemblyAttendance, MAX_AGENDA_ITEMS, type QuorumRecord } from './types.js';

/**
 * Y1-3 - Kat malikleri kurulu (genel kurul) hazirligi: toplanti kaydi (olagan / olaganustu, tarih,
 * yer veya cevrim ici baglanti, gundem), dondurulmus oy listesinden hazirun cetveli (PDF), katilim
 * girisi (asaleten / vekaleten), KMK m.30 yeter sayi, m.31 oy ve vekalet sinirlari, gundem sayimi.
 *  - Oy listesi toplanti gunu icin mulkiyet modulunden; ilk katilim, yeter sayi kaydi, sayim veya
 *    hazirun isteginde DONDURULUR. Yeter sayi, sayim ve hazirun yalnizca dondurulmus listeden.
 *  - Ikinci toplanti, yeter sayisinin saglanamadigi tutanaga gecmis ilk toplantiya baglanir ve ondan
 *    en gec 15 gun sonradir; yeter sayi aranmaz, karar katilanlarin oy cogunluguyla.
 *  - Olusturma, duzenleme, iptal, oy listesinin dondurulmasi, katilim, yeter sayi ve sayim denetim
 *    zincirine yazilir (ad bilgisi olmadan). Silme yok.
 */

/** Hata kodlari anket / oylama ile ortak (Y1). */
export class AssemblyError extends PollError {
  override name = 'AssemblyError';
}

export const KIND_LABELS = { ordinary: 'Olağan', extraordinary: 'Olağanüstü' } as const;
/** KMK m.30: ikinci toplanti ilk toplantidan en gec bu kadar gun sonra. */
export const SECOND_MEETING_MAX_DAYS = 15;

export type AssemblyContext = { apartmentId: string; userId: string };

export type AssemblyServiceDeps = {
  repository: AssemblyRepository;
  core: Pick<CoreRepository, 'listUnits' | 'listBlocks' | 'getSite'>;
  ownership: Pick<OwnershipRepository, 'listHeads' | 'listRecords'>;
  memberships: Pick<MembershipRepository, 'list'>;
  people: Pick<PersonRepository, 'list'>;
  rolls: RollSnapshotStore;
  store: DocumentStore | undefined;
  now: () => Date;
  newId: () => string;
};

export type AssemblyView = Omit<Assembly, 'PK' | 'SK'>;

export type AssemblyUnitRow = {
  unitId: string;
  blockId: string;
  number: string;
  landShare?: { numerator: number; denominator: number };
  owners: { userId: string; name?: string; share?: { numerator: number; denominator: number } }[];
  attendance?: { mode: AssemblyAttendance['mode']; attendee?: { userId: string; name?: string }; proxy?: ProxyRef; recordedAt: IsoDateTime; version: number };
  warnings: string[];
};

function parseDateTime(o: Obj, key: string): IsoDateTime {
  const v = reqString(o, key, 40);
  const ms = Date.parse(v);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || !/(Z|[+-]\d{2}:\d{2})$/.test(v) || Number.isNaN(ms)) {
    throw new ValidationError(`${key} saat dilimli ISO 8601 tarih-saat olmalıdır (örnek 2026-12-15T19:00:00+03:00)`, key);
  }
  return new Date(ms).toISOString();
}

function parseAgenda(value: unknown): AgendaItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_AGENDA_ITEMS) {
    throw new ValidationError(`Gündem 1-${MAX_AGENDA_ITEMS} maddeden oluşmalı`, 'agenda');
  }
  return value.map((raw, i) => {
    const o: Obj = typeof raw === 'string' ? { title: raw } : asObject(raw, `agenda[${i}]`);
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (title.length < 1 || title.length > 300) throw new ValidationError(`${i + 1}. gündem maddesi 1-300 karakter olmalıdır`, 'agenda');
    const description = typeof o.description === 'string' && o.description.trim() ? o.description.trim().slice(0, 2000) : undefined;
    return { itemId: `a${i + 1}`, title, ...(description ? { description } : {}) };
  });
}

function parseUrl(o: Obj): string | undefined {
  const v = optString(o, 'onlineUrl', 500);
  if (v === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new ValidationError('Çevrim içi bağlantı geçerli bir adres olmalıdır', 'onlineUrl');
  }
  if (url.protocol !== 'https:') throw new ValidationError('Çevrim içi bağlantı https:// ile başlamalıdır', 'onlineUrl');
  return url.toString();
}

const shareText = (s: { numerator: number | string; denominator: number | string }) => `${s.numerator}/${s.denominator}`;

export function createAssemblyService(overrides: Partial<AssemblyServiceDeps> = {}) {
  const deps: AssemblyServiceDeps = {
    repository: assemblyRepository,
    core: coreRepository,
    ownership: ownershipRepository,
    memberships: membershipRepository,
    people: personRepository,
    rolls: rollSnapshotStore,
    store: 'store' in overrides ? overrides.store : createDocumentStoreFromEnv(),
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.repository;
  const stamp = (): IsoDateTime => deps.now().toISOString();
  const view = (a: Assembly): AssemblyView => {
    const { PK: _pk, SK: _sk, ...rest } = a;
    return rest;
  };

  async function requireAssembly(ctx: AssemblyContext, id: string): Promise<Assembly> {
    assertId(id, 'assemblyId');
    const a = await repo.get(ctx.apartmentId, id);
    if (!a || a.apartmentId !== ctx.apartmentId) throw new AssemblyError('not_found', 'Genel kurul kaydı bulunamadı');
    return a;
  }

  const requirePlanned = (a: Assembly) => {
    if (a.status !== 'planned') throw new AssemblyError('conflict', 'İptal edilen toplantı değiştirilemez');
  };

  function assertVersion(a: Assembly, version: number): void {
    if (a.version !== version) throw new AssemblyError('conflict', 'Kayıt başka bir işlemle değiştirildi (sürüm uyuşmazlığı)');
  }

  async function save(next: Assembly, expectedVersion: number, audit?: AuditDraft): Promise<AssemblyView> {
    try {
      await repo.update(next, expectedVersion, audit);
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') throw new AssemblyError('conflict', 'Kayıt başka bir işlemle değiştirildi (sürüm uyuşmazlığı)');
      throw err;
    }
    return view(next);
  }

  const audit = (ctx: AssemblyContext, a: Assembly, action: string, details: Record<string, unknown>, reason?: string): AuditDraft => ({
    apartmentId: ctx.apartmentId,
    action,
    target: { type: 'assembly', id: a.assemblyId },
    actorId: ctx.userId,
    ...(reason ? { reason } : {}),
    details,
  });

  const meetingDetails = (a: Assembly) => ({
    kind: a.kind,
    scheduledAt: a.scheduledAt,
    secondMeeting: a.secondMeeting,
    ...(a.firstMeetingId ? { firstMeetingId: a.firstMeetingId } : {}),
    agendaItems: a.agenda.length,
  });

  /** Ikinci toplanti: ilk toplanti ayni apartmanda, yeter sayisizligi tutanakta, en gec 15 gun once. */
  async function assertFirstMeeting(ctx: AssemblyContext, firstMeetingId: string, scheduledAt: IsoDateTime, selfId?: string): Promise<void> {
    assertId(firstMeetingId, 'firstMeetingId');
    if (firstMeetingId === selfId) throw new ValidationError('Toplantı kendisinin ikinci toplantısı olamaz', 'firstMeetingId');
    const first = await repo.get(ctx.apartmentId, firstMeetingId);
    if (!first || first.apartmentId !== ctx.apartmentId) throw new AssemblyError('not_found', 'İlk toplantı bulunamadı');
    if (first.status !== 'planned') throw new AssemblyError('unprocessable', 'İptal edilen toplantıya ikinci toplantı bağlanamaz');
    if (first.secondMeeting) throw new AssemblyError('unprocessable', 'İkinci toplantıya yeniden ikinci toplantı bağlanamaz');
    if (first.quorumRecord?.met !== false) {
      throw new AssemblyError('unprocessable', 'İlk toplantıda yeter sayının sağlanamadığı tutanağa geçirilmemiş; önce ilk toplantının yeter sayısını kaydedin');
    }
    if (scheduledAt <= first.scheduledAt) throw new ValidationError('İkinci toplantı ilk toplantıdan sonra olmalıdır', 'scheduledAt');
    if (istanbulDate(scheduledAt) > addDays(istanbulDate(first.scheduledAt), SECOND_MEETING_MAX_DAYS)) {
      throw new ValidationError(`İkinci toplantı ilk toplantıdan en geç ${SECOND_MEETING_MAX_DAYS} gün sonra yapılmalıdır (KMK m.30)`, 'scheduledAt');
    }
  }

  async function meetingFields(ctx: AssemblyContext, o: Obj, current?: Assembly) {
    const kind = o.kind === undefined && current ? current.kind : reqEnum(o, 'kind', ASSEMBLY_KINDS);
    const scheduledAt = o.scheduledAt === undefined && current ? current.scheduledAt : parseDateTime(o, 'scheduledAt');
    const location = o.location === undefined ? current?.location : o.location === null ? undefined : optString(o, 'location', 300);
    const onlineUrl = o.onlineUrl === undefined ? current?.onlineUrl : o.onlineUrl === null ? undefined : parseUrl(o);
    if (!location && !onlineUrl) throw new ValidationError('Toplantı yeri veya çevrim içi bağlantı girilmeli', 'location');
    if (o.secondMeeting !== undefined) throw new ValidationError('İkinci toplantı için ilk toplantıyı seçin (firstMeetingId)', 'firstMeetingId');
    const firstMeetingId = o.firstMeetingId === undefined ? current?.firstMeetingId : o.firstMeetingId === null ? undefined : reqString(o, 'firstMeetingId', 64);
    if (firstMeetingId) await assertFirstMeeting(ctx, firstMeetingId, scheduledAt, current?.assemblyId);
    const agenda = o.agenda === undefined && current ? current.agenda : parseAgenda(o.agenda);
    return {
      kind,
      scheduledAt,
      rollDate: istanbulDate(scheduledAt),
      secondMeeting: Boolean(firstMeetingId),
      ...(firstMeetingId ? { firstMeetingId } : {}),
      agenda,
      ...(location ? { location } : {}),
      ...(onlineUrl ? { onlineUrl } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Oy listesi: canli onizleme ve dondurma
  // -------------------------------------------------------------------------

  async function liveSnapshot(ctx: AssemblyContext, a: Assembly, frozenAt: IsoDateTime) {
    const [units, heads, records, members] = await Promise.all([
      deps.core.listUnits(ctx.apartmentId),
      deps.ownership.listHeads(ctx.apartmentId),
      deps.ownership.listRecords(ctx.apartmentId),
      deps.memberships.list(ctx.apartmentId, {}),
    ]);
    const roll = buildVotingRoll({
      units: units.filter((u) => u.siteId === ctx.apartmentId),
      heads: heads.filter((h) => h.apartmentId === ctx.apartmentId),
      records: records.filter((r) => r.apartmentId === ctx.apartmentId),
      memberships: members.filter((m) => m.apartmentId === ctx.apartmentId),
      day: a.rollDate,
    }).items;
    return buildSnapshot({
      apartmentId: ctx.apartmentId,
      ownerType: 'assembly',
      ownerId: a.assemblyId,
      rollDate: a.rollDate,
      frozenAt,
      roll,
      voters: (item) => item.owners.map((o) => ({ userId: o.userId, relation: 'owner' as const })),
    });
  }

  /** Oy listesi dondurulmamissa toplanti kaydiyla ayni atomik yazimda dondurur (denetimli). */
  async function ensureRoll(ctx: AssemblyContext, a: Assembly): Promise<Assembly & { roll: RollMeta }> {
    if (a.roll) return a as Assembly & { roll: RollMeta };
    const now = stamp();
    const snapshot = await liveSnapshot(ctx, a, now);
    const next: Assembly = { ...a, roll: snapshot.meta, updatedAt: now, updatedBy: ctx.userId, version: a.version + 1 };
    try {
      await repo.update(next, a.version, audit(ctx, next, 'assembly.roll_freeze', { rollDate: a.rollDate, units: snapshot.meta.units }), snapshot.chunks);
      return next as Assembly & { roll: RollMeta };
    } catch (err) {
      if (!(err instanceof DataAccessError && err.code === 'conflict')) throw err;
      // Eszamanli ilk katilim: digeri dondurduysa onunkini kullan.
      const fresh = await requireAssembly(ctx, a.assemblyId);
      if (fresh.roll) return fresh as Assembly & { roll: RollMeta };
      throw new AssemblyError('conflict', 'Kayıt başka bir işlemle değiştirildi (sürüm uyuşmazlığı)');
    }
  }

  async function frozenState(ctx: AssemblyContext, a: Assembly & { roll: RollMeta }) {
    const [entries, attendance] = await Promise.all([deps.rolls.entries(ctx.apartmentId, 'assembly', a.assemblyId), repo.listAttendance(ctx.apartmentId, a.assemblyId)]);
    return { entries, attendance, quorum: assemblyQuorum({ entries, meta: a.roll, attendance, secondMeeting: a.secondMeeting }) };
  }

  async function rows(ctx: AssemblyContext, entries: readonly RollEntry[], attendance: readonly AssemblyAttendance[]): Promise<AssemblyUnitRow[]> {
    const people = await deps.people.list(ctx.apartmentId);
    const nameOf = new Map(people.filter((p) => p.apartmentId === ctx.apartmentId).map((p) => [p.userId, p.fullName]));
    const attOf = new Map(attendance.map((x) => [x.unitId, x]));
    return entries.map((r) => {
      const att = attOf.get(r.unitId);
      return {
        unitId: r.unitId,
        blockId: r.blockId,
        number: r.number,
        ...(r.landShare ? { landShare: r.landShare } : {}),
        owners: r.owners.map((o) => ({ userId: o.userId, ...(nameOf.get(o.userId) ? { name: nameOf.get(o.userId) } : {}), ...(o.share && r.owners.length > 1 ? { share: o.share } : {}) })),
        ...(att
          ? {
              attendance: {
                mode: att.mode,
                recordedAt: att.recordedAt,
                version: att.version,
                ...(att.attendee ? { attendee: { userId: att.attendee.userId, ...(nameOf.get(att.attendee.userId) ? { name: nameOf.get(att.attendee.userId) } : {}) } } : {}),
                ...(att.proxy ? { proxy: att.proxy } : {}),
              },
            }
          : {}),
        warnings: r.warnings,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Toplanti kaydi
  // -------------------------------------------------------------------------

  async function create(ctx: AssemblyContext, body: unknown): Promise<AssemblyView> {
    const o = asObject(body);
    const fields = await meetingFields(ctx, o);
    const ts = stamp();
    const assemblyId = deps.newId();
    const a: Assembly = {
      ...assemblyKeys.assembly(ctx.apartmentId, assemblyId),
      entityType: 'ASSEMBLY',
      assemblyId,
      apartmentId: ctx.apartmentId,
      ...fields,
      status: 'planned',
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    await repo.create(a, audit(ctx, a, 'assembly.create', meetingDetails(a)));
    return view(a);
  }

  async function list(ctx: AssemblyContext): Promise<AssemblyView[]> {
    return (await repo.list(ctx.apartmentId))
      .filter((a) => a.apartmentId === ctx.apartmentId)
      .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt) || b.assemblyId.localeCompare(a.assemblyId))
      .map(view);
  }

  /** Ayrinti: dondurulmussa anlik goruntuden; degilse canli onizleme (`rollFrozen: false`, katilim yok). */
  async function detail(ctx: AssemblyContext, id: string): Promise<{ assembly: AssemblyView; rollFrozen: boolean; quorum: Quorum; units: AssemblyUnitRow[] }> {
    const a = await requireAssembly(ctx, id);
    if (a.roll) {
      const s = await frozenState(ctx, a as Assembly & { roll: RollMeta });
      return { assembly: view(a), rollFrozen: true, quorum: s.quorum, units: await rows(ctx, s.entries, s.attendance) };
    }
    const preview = await liveSnapshot(ctx, a, stamp());
    const quorum = assemblyQuorum({ entries: preview.entries, meta: preview.meta, attendance: [], secondMeeting: a.secondMeeting });
    return { assembly: view(a), rollFrozen: false, quorum, units: await rows(ctx, preview.entries, []) };
  }

  async function update(ctx: AssemblyContext, id: string, body: unknown): Promise<AssemblyView> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await requireAssembly(ctx, id);
    assertVersion(current, version);
    requirePlanned(current);
    if (current.roll) throw new AssemblyError('conflict', 'Oy listesi dondurulduktan sonra toplantı bilgileri ve gündem değiştirilemez');
    const { location: _l, onlineUrl: _u, firstMeetingId: _f, ...rest } = current;
    const next: Assembly = { ...rest, ...(await meetingFields(ctx, o, current)), updatedAt: stamp(), updatedBy: ctx.userId, version: current.version + 1 };
    return save(next, current.version, audit(ctx, next, 'assembly.update', meetingDetails(next)));
  }

  async function cancel(ctx: AssemblyContext, id: string, body: unknown): Promise<AssemblyView> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const reason = reqString(o, 'reason', 500, 3);
    const current = await requireAssembly(ctx, id);
    assertVersion(current, version);
    requirePlanned(current);
    const now = stamp();
    const next: Assembly = { ...current, status: 'cancelled', cancelledAt: now, cancelReason: reason, updatedAt: now, updatedBy: ctx.userId, version: current.version + 1 };
    return save(next, current.version, audit(ctx, next, 'assembly.cancel', meetingDetails(next), reason));
  }

  // -------------------------------------------------------------------------
  // Katilim, yeter sayi, sayim
  // -------------------------------------------------------------------------

  async function setAttendance(ctx: AssemblyContext, id: string, unitId: string, body: unknown) {
    const o = asObject(body);
    assertId(unitId, 'unitId');
    const mode = reqEnum(o, 'mode', ATTENDANCE_MODES);
    const loaded = await requireAssembly(ctx, id);
    requirePlanned(loaded);
    const a = await ensureRoll(ctx, loaded);
    const entry = await deps.rolls.entry(ctx.apartmentId, 'assembly', a.assemblyId, a.roll, unitId);
    if (!entry) throw new AssemblyError('not_found', 'Bölüm dondurulmuş oy listesinde yok');

    let attendee: AssemblyAttendance['attendee'];
    let proxy: ProxyRef | undefined;
    if (mode === 'present' && o.attendeeUserId !== undefined && o.attendeeUserId !== null) {
      const userId = reqString(o, 'attendeeUserId', 64);
      if (!entry.owners.some((x) => x.userId === userId)) throw new ValidationError('Katılan kişi bu bölümün malikleri arasında değil', 'attendeeUserId');
      attendee = { userId };
    }
    if (mode === 'proxy') {
      if (o.proxyUserId !== undefined && o.proxyUserId !== null) {
        const userId = reqString(o, 'proxyUserId', 64);
        if (entry.owners.some((x) => x.userId === userId)) throw new ValidationError('Bölüm maliki kendi bölümünde vekil olamaz; asaleten katılım seçin', 'proxyUserId');
        const person = (await deps.people.list(ctx.apartmentId)).find((p) => p.apartmentId === ctx.apartmentId && p.userId === userId);
        if (!person) throw new ValidationError('Vekil apartmanın kişi kayıtlarında bulunamadı', 'proxyUserId');
        proxy = { userId, name: person.fullName };
      } else {
        proxy = { name: reqString(o, 'proxyName', 150, 3) };
      }
    }

    const attendance = await repo.listAttendance(ctx.apartmentId, a.assemblyId);
    const existing = attendance.find((x) => x.unitId === unitId);
    if (proxy) {
      const after = [...attendance.filter((x) => x.unitId !== unitId), { unitId, mode, proxy }];
      const entries = await deps.rolls.entries(ctx.apartmentId, 'assembly', a.assemblyId);
      const violation = proxyViolation(entries, after, proxy);
      if (violation) throw new AssemblyError('unprocessable', violation);
    }
    const same =
      existing && existing.mode === mode && existing.attendee?.userId === attendee?.userId && JSON.stringify(existing.proxy ?? null) === JSON.stringify(proxy ?? null);
    if (same) {
      const { PK: _pk, SK: _sk, ...rest } = existing;
      return { attendance: rest };
    }
    const att: AssemblyAttendance = {
      ...assemblyKeys.attendance(ctx.apartmentId, a.assemblyId, unitId),
      entityType: 'ASSEMBLY_ATTENDANCE',
      apartmentId: ctx.apartmentId,
      assemblyId: a.assemblyId,
      unitId,
      mode,
      ...(attendee ? { attendee } : {}),
      ...(proxy ? { proxy } : {}),
      recordedAt: stamp(),
      recordedBy: ctx.userId,
      version: (existing?.version ?? 0) + 1,
    };
    try {
      // Ad / vekil adi kisisel veri: denetim ayrintisina yazilmaz (yalnizca vekilin uye olup olmadigi).
      await repo.putAttendance(att, existing?.version ?? 0, audit(ctx, a, 'assembly.attendance', { unitId, mode, ...(proxy ? { proxyIsMember: Boolean(proxy.userId) } : {}) }));
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') throw new AssemblyError('conflict', 'Katılım bu arada değişti veya toplantı iptal edildi; sayfayı yenileyin');
      throw err;
    }
    const { PK: _pk, SK: _sk, ...rest } = att;
    return { attendance: rest };
  }

  const toRecord = (ctx: AssemblyContext, q: Quorum): QuorumRecord => ({
    met: q.met,
    presentUnits: q.presentUnits,
    totalUnits: q.totalUnits,
    presentVotes: q.presentVotes,
    totalVotes: q.totalVotes,
    unitsMajority: q.unitsMajority,
    landShareMajority: q.landShareMajority,
    landShareComputable: q.landShareComputable,
    recordedAt: stamp(),
    recordedBy: ctx.userId,
  });

  /** Toplanti yeter sayisini tutanaga gecirir (saglanamadiysa ikinci toplantinin dayanagi). */
  async function recordQuorum(ctx: AssemblyContext, id: string, body: unknown): Promise<{ assembly: AssemblyView; quorum: Quorum }> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const loaded = await requireAssembly(ctx, id);
    assertVersion(loaded, version);
    requirePlanned(loaded);
    if (loaded.agenda.some((i) => i.tally)) throw new AssemblyError('conflict', 'Sayım kaydedilmiş toplantının yeter sayısı yeniden kaydedilemez');
    const a = await ensureRoll(ctx, loaded);
    const { quorum } = await frozenState(ctx, a);
    const record = toRecord(ctx, quorum);
    const next: Assembly = { ...a, quorumRecord: record, updatedAt: record.recordedAt, updatedBy: ctx.userId, version: a.version + 1 };
    const saved = await save(next, a.version, audit(ctx, next, 'assembly.quorum', { ...record, recordedAt: undefined, recordedBy: undefined, reasons: quorum.reasons }));
    return { assembly: saved, quorum };
  }

  async function recordTally(ctx: AssemblyContext, id: string, itemId: string, body: unknown): Promise<{ assembly: AssemblyView; quorum: Quorum }> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const yes = reqInt(o, 'yes', 0, 100_000);
    const no = reqInt(o, 'no', 0, 100_000);
    const abstain = reqInt(o, 'abstain', 0, 100_000);
    const loaded = await requireAssembly(ctx, id);
    assertVersion(loaded, version);
    requirePlanned(loaded);
    const item = loaded.agenda.find((i) => i.itemId === itemId);
    if (!item) throw new AssemblyError('not_found', 'Gündem maddesi bulunamadı');
    if (loaded.quorumRecord?.met === false) {
      throw new AssemblyError('conflict', 'Bu toplantıda yeter sayının sağlanamadığı tutanağa geçti; karar için ikinci toplantı oluşturun');
    }
    const a = await ensureRoll(ctx, loaded);
    const { quorum } = await frozenState(ctx, a);
    if (!quorum.met) {
      throw new AssemblyError('unprocessable', `Toplantı yeter sayısı sağlanmadı: ${quorum.reasons.join('; ')}. İkinci toplantıda yeter sayı aranmaz.`);
    }
    if (yes + no + abstain > quorum.presentVotes) {
      throw new ValidationError(`Kabul + ret + çekimser toplamı katılan oy sayısını (${quorum.presentVotes}) aşamaz`, 'yes');
    }
    const decision = decide(yes, quorum.presentVotes);
    const tally = { yes, no, abstain, presentVotes: quorum.presentVotes, decision, recordedAt: stamp(), recordedBy: ctx.userId };
    const next: Assembly = {
      ...a,
      ...(a.quorumRecord ? {} : { quorumRecord: toRecord(ctx, quorum) }),
      agenda: a.agenda.map((i) => (i.itemId === itemId ? { ...i, tally } : i)),
      updatedAt: tally.recordedAt,
      updatedBy: ctx.userId,
      version: a.version + 1,
    };
    const saved = await save(next, a.version, audit(ctx, next, 'assembly.tally', { itemId, yes, no, abstain, presentVotes: quorum.presentVotes, decision, corrected: Boolean(item.tally) }));
    return { assembly: saved, quorum };
  }

  // -------------------------------------------------------------------------
  // Hazirun cetveli (PDF) - dondurulmus oy listesinden
  // -------------------------------------------------------------------------

  async function attendanceSheet(ctx: AssemblyContext, id: string) {
    if (!deps.store) throw new DocumentError('unavailable', 'Belge deposu yapılandırılmamış (DOCUMENTS_BUCKET)');
    const loaded = await requireAssembly(ctx, id);
    const a = loaded.status === 'planned' ? await ensureRoll(ctx, loaded) : loaded.roll ? (loaded as Assembly & { roll: RollMeta }) : undefined;
    if (!a) throw new AssemblyError('conflict', 'İptal edilen ve oy listesi dondurulmamış toplantının hazirun cetveli üretilemez');
    const [s, site, blocks] = await Promise.all([frozenState(ctx, a), deps.core.getSite(ctx.apartmentId), deps.core.listBlocks(ctx.apartmentId)]);
    const blockName = new Map(blocks.map((b) => [b.blockId, b.name]));
    const multiBlock = new Set(s.entries.map((r) => r.blockId)).size > 1;
    const units = await rows(ctx, s.entries, s.attendance);
    const apartmentName = site?.name ?? 'Apartman';
    const q = s.quorum;
    const place = [a.location, a.onlineUrl ? `Çevrim içi: ${a.onlineUrl}` : undefined].filter(Boolean).join(' · ');
    const modeText = { present: 'Asaleten', proxy: 'Vekaleten', absent: '' } as const;
    const sheet = {
      title: 'Hazirun Cetveli',
      subtitle: `${KIND_LABELS[a.kind]} Kat Malikleri Kurulu${a.secondMeeting ? ' (ikinci toplantı)' : ''} · ${formatDateTime(a.scheduledAt)} · ${place} · Oy listesi: ${formatDate(a.rollDate)}`,
      sections: [
        {
          columns: [
            { header: 'Sıra', width: 0.45 },
            { header: 'Blok / Daire', width: 1.1 },
            { header: 'Kat maliki (paydaşlar)', width: 3.2 },
            { header: 'Arsa payı', width: 0.9, align: 'right' as const },
            { header: 'Katılım', width: 1 },
            { header: 'Vekil', width: 1.7 },
            { header: 'İmza', width: 1.9 },
          ],
          rowHeight: 26,
          ruled: true,
          rows: [
            ...units.map((u, i) => ({
              cells: [
                String(i + 1),
                multiBlock ? `${blockName.get(u.blockId) ?? 'Blok'} / ${u.number}` : u.number,
                u.owners.length ? u.owners.map((o) => `${o.name ?? 'Kayıtlı kişi'}${o.share ? ` (${shareText(o.share)})` : ''}`).join(', ') : '— (malik kaydı yok)',
                u.landShare ? shareText(u.landShare) : '—',
                u.attendance ? modeText[u.attendance.mode] : '',
                u.attendance?.proxy?.name ?? '',
                '',
              ],
            })),
            {
              bold: true,
              rule: true,
              cells: ['', `${q.totalUnits} bölüm`, `${q.totalVotes} oy`, q.totalLandShare ? shareText(q.totalLandShare) : '—', `${q.presentVotes} katılan oy`, `${q.proxyUnits} vekaleten`, ''],
            },
          ],
        },
      ],
      notes: [
        'Toplantı yeter sayısı (KMK m.30): kat maliklerinin sayı ve arsa payı çoğunluğu (her ikisinde yarıdan fazlası); ikinci toplantıda aranmaz. Karar yeter sayısı: katılanların oy çokluğu.',
        'Oy (KMK m.31): her bağımsız bölüm bir oy; birden fazla bölümü olan malikin oyu toplam oyların üçte birini aşamaz. Vekil oyların %5\'inden fazlasını, 40 ve daha az bölümde ikiden fazla kat malikini temsil edemez.',
        `Kayıtlı katılım: ${q.presentVotes}/${q.totalVotes} oy${q.presentLandShare ? ` · arsa payı ${shareText(q.presentLandShare)}` : ''} · yeter sayı ${q.met ? 'sağlandı' : 'sağlanmadı'}${q.reasons.length ? ` (${q.reasons.join('; ')})` : ''}.`,
        ...q.warnings,
        'Toplantı Başkanı: ..............................   Yazman: ..............................   Oy Toplayıcı: ..............................',
      ],
    };
    const dataHash = createHash('sha256').update(JSON.stringify({ v: 2, apartmentName, assembly: view(a), sheet })).digest('hex');
    const key = assemblySheetKey(ctx.apartmentId, a.rollDate, a.assemblyId, dataHash);
    if (!(await deps.store.head(key))) {
      await deps.store.put(key, await renderReportPdf({ ...sheet, apartmentName, generatedAt: stamp(), dataHash }), 'application/pdf');
    }
    const fileName = `hazirun-cetveli-${a.rollDate}.pdf`;
    const url = await deps.store.presignGet(key, { contentDisposition: contentDisposition(fileName, 'inline'), contentType: 'application/pdf', expiresIn: URL_TTL_SECONDS });
    return { url, fileName, contentType: 'application/pdf', expiresAt: new Date(deps.now().getTime() + URL_TTL_SECONDS * 1000).toISOString() };
  }

  return { create, list, detail, update, cancel, setAttendance, recordQuorum, recordTally, attendanceSheet };
}

export type AssemblyService = ReturnType<typeof createAssemblyService>;
