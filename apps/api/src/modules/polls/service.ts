import { randomUUID } from 'node:crypto';
import { DataAccessError } from '../../config/dynamodb.js';
import { type DomainEvent, buildEvent } from '../../events/publisher.js';
import type { Role } from '../../auth/claims.js';
import type { AuditDraft } from '../audit/log.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import type { IsoDate, IsoDateTime, Unit } from '../core/types.js';
import { type Obj, ValidationError, asObject, assertId, optBool, optEnum, optString, reqInt, reqString } from '../core/validation.js';
import { type MembershipRepository, membershipRepository } from '../memberships/repository.js';
import { type VotingRollItem, buildVotingRoll } from '../ownership/register.js';
import { type OwnershipRepository, ownershipRepository } from '../ownership/repository.js';
import type { PortalService } from '../portal/service.js';
import type { UnitMembership } from '../portal/types.js';
import { PollError } from './errors.js';
import { type PollRepository, PollVoteConflictError, pollKeys, pollRepository } from './repository.js';
import { effectiveCloseAt, eligibleVoters, istanbulDate, participationRows, pollPhase, tallyPoll } from './results.js';
import { type RollChunk, type RollEntry, type RollMeta, type RollSnapshotStore, buildSnapshot, rollSnapshotStore } from './rollSnapshot.js';
import {
  MAX_OPTIONS,
  MIN_OPTIONS,
  POLL_AUDIENCES,
  POLL_PHASES,
  POLL_WEIGHTINGS,
  type Poll,
  type PollOption,
  type PollPhase,
  type PollResults,
  type PollUnitRow,
  type PollVote,
  type VoterRelation,
} from './types.js';

/**
 * Y1 - Anket / oylama.
 *
 * Yasam dongusu: `draft` -(yayin)-> `published` -(erken kapatma)-> `closed`; taslak `cancelled` olur.
 *  - Yalnizca taslak duzenlenir; yayindaki oylamanin sorusu, secenekleri ve kurallari degismez.
 *  - Yayinda `opensAt` gecmisteyse yayin ani olur; oy listesi tarihi (`rollDate`) o gun sabitlenir.
 *  - `published` oylama `closesAt` gelince kendiliginden biter (yazim gerekmez; evre hesaplanir).
 *    Yonetici bitisten once gerekceyle kapatabilir: denetime `poll.close` (early) yazilir.
 *  - Oy hakki ve agirlik mulkiyet modulunun oy listesinden (`buildVotingRoll`, `rollDate` gunu):
 *    bolum basina TEK oy; hisseli mulkiyette paydaslardan herhangi biri kullanir, sonraki oy
 *    (baska paydas dahil) oylama bitene kadar oncekinin yerine gecer. Kiraci yalnizca `residents`
 *    oylamasinda oy kullanir.
 *  - Gizli oylama (varsayilan): yonetim hangi bolumun neyi sectigini hicbir evrede goremez ve
 *    oylama surerken secenek dagilimi kimseye gosterilmez (canli sayim + bolum bazli katilim
 *    birlikte bireysel oyu ele verirdi). Acik oylamada yonetici bolum bazli secimi gorur.
 *  - Silme yok; tum degisiklikler `version` ile optimistic locking.
 */

const STATUS_FILTERS = [...POLL_PHASES, 'all'] as const;
const PORTAL_ROLES: readonly Role[] = ['resident'];
/** Gizli oylama bu kadar bolum oy kullanmadan erken kapatilamaz (az oyla acilan sonuc bireysel oyu gosterir). */
export const MIN_SECRET_CLOSE_VOTES = 3;
/** Oy listesi dondurma gibi sistem islemlerinin aktoru (denetim kaydi). */
const SYSTEM_ACTOR = 'system';

export type PollContext = { apartmentId: string; userId: string };
export type PollPortalContext = PollContext & { role: Role };

export type PollServiceDeps = {
  repository: PollRepository;
  core: Pick<CoreRepository, 'listUnits'>;
  ownership: Pick<OwnershipRepository, 'getHead' | 'listHeads' | 'listRecords'>;
  memberships: Pick<MembershipRepository, 'list'>;
  /** Yayinda dondurulan oy listesi (sonuc, katilim ve oy hakki yalnizca buradan). */
  rolls: RollSnapshotStore;
  /** Sakinin dairesini aktif uyelikleriyle cozer (portal ile ayni kural ve hatalar). */
  portal: Pick<PortalService, 'resolveUnit'>;
  now: () => Date;
  newId: () => string;
};

export type PollView = Omit<Poll, 'PK' | 'SK'> & { phase: PollPhase };

export type MyVoteView = {
  /** Bolumun oyunu bu kullanici mi kullandi? (hisseli mulkiyette baska paydas olabilir) */
  castByMe: boolean;
  /** Gizli oylamada yalnizca kendi kullandigi oyun secimi gosterilir. */
  optionId?: string;
  castAt?: IsoDateTime;
};

export type PortalPollView = {
  pollId: string;
  title: string;
  description?: string;
  options: PollOption[];
  audience: Poll['audience'];
  weighting: Poll['weighting'];
  secret: boolean;
  resultsVisibleBeforeClose: boolean;
  opensAt: IsoDateTime;
  closesAt: IsoDateTime;
  closedAt?: IsoDateTime;
  closedEarly?: boolean;
  rollDate: IsoDate;
  phase: PollPhase;
  unitId: string;
  eligible: boolean;
  canVote: boolean;
  ineligibleReason?: string;
  myVote?: MyVoteView;
  resultsAvailable: boolean;
  /** Acik oylamada ara sonuc acik ama bolum henuz oy kullanmadi: oy verince gorulur. */
  resultsAfterVote: boolean;
  results?: PollResults;
};

/** Saat dilimi icermeyen tarih-saat belirsizdir; `Z` veya `+03:00` zorunlu. */
function parseDateTime(o: Obj, key: string): IsoDateTime {
  const v = reqString(o, key, 40);
  const ms = Date.parse(v);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || !/(Z|[+-]\d{2}:\d{2})$/.test(v) || Number.isNaN(ms)) {
    throw new ValidationError(`${key} saat dilimli ISO 8601 tarih-saat olmalıdır (örnek 2026-11-10T09:00:00+03:00)`, key);
  }
  return new Date(ms).toISOString();
}

/** Secenekler: 2-10 benzersiz metin; kimlikler sirayla `o1`..`o10` (yayindan sonra degismez). */
function parseOptions(value: unknown): PollOption[] {
  if (!Array.isArray(value) || value.length < MIN_OPTIONS || value.length > MAX_OPTIONS) {
    throw new ValidationError(`En az ${MIN_OPTIONS}, en fazla ${MAX_OPTIONS} seçenek girilmeli`, 'options');
  }
  const seen = new Set<string>();
  return value.map((raw, i) => {
    const label = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Obj).label : raw;
    if (typeof label !== 'string' || label.trim().length < 1 || label.trim().length > 200) {
      throw new ValidationError(`${i + 1}. seçenek 1-200 karakter olmalıdır`, 'options');
    }
    const text = label.trim();
    const key = text.toLocaleLowerCase('tr');
    if (seen.has(key)) throw new ValidationError(`Aynı seçenek iki kez yazılmış: ${text}`, 'options');
    seen.add(key);
    return { optionId: `o${i + 1}`, label: text };
  });
}

export function createPollService(overrides: Partial<PollServiceDeps> & Pick<PollServiceDeps, 'portal'>) {
  const deps: PollServiceDeps = {
    repository: pollRepository,
    core: coreRepository,
    ownership: ownershipRepository,
    memberships: membershipRepository,
    rolls: rollSnapshotStore,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.repository;
  const stamp = (): IsoDateTime => deps.now().toISOString();

  const toView = (p: Poll, nowIso = stamp()): PollView => {
    const { PK: _pk, SK: _sk, ...rest } = p;
    return { ...rest, phase: pollPhase(p, nowIso) };
  };

  async function requirePoll(apartmentId: string, id: string): Promise<Poll> {
    assertId(id, 'pollId');
    const p = await repo.get(apartmentId, id);
    if (!p || p.apartmentId !== apartmentId) throw new PollError('not_found', 'Oylama bulunamadı');
    return p;
  }

  function assertVersion(current: Poll, version: number): void {
    if (current.version !== version) throw new PollError('conflict', 'Kayıt başka bir işlemle değiştirildi (sürüm uyuşmazlığı)');
  }

  async function save(next: Poll, expectedVersion: number, opts?: { audit?: AuditDraft; outbox?: DomainEvent[]; roll?: RollChunk[] }): Promise<PollView> {
    try {
      await repo.update(next, expectedVersion, opts);
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') {
        throw new PollError('conflict', 'Kayıt başka bir işlemle değiştirildi (sürüm uyuşmazlığı)');
      }
      throw err;
    }
    return toView(next);
  }

  const touch = (ctx: PollContext, p: Poll) => ({ updatedAt: stamp(), updatedBy: ctx.userId, version: p.version + 1 });

  /** Ayarlar: gizli oylamada ara sonuc acilamaz. */
  function settings(o: Obj, current?: Poll) {
    const audience = optEnum(o, 'audience', POLL_AUDIENCES) ?? current?.audience ?? 'owners';
    const weighting = optEnum(o, 'weighting', POLL_WEIGHTINGS) ?? current?.weighting ?? 'per_unit';
    const secret = optBool(o, 'secret') ?? current?.secret ?? true;
    const visible = optBool(o, 'resultsVisibleBeforeClose') ?? (o.secret === true ? false : (current?.resultsVisibleBeforeClose ?? false));
    if (secret && visible) {
      throw new ValidationError('Gizli oylamada sonuçlar oylama bitmeden gösterilemez', 'resultsVisibleBeforeClose');
    }
    return { audience, weighting, secret, resultsVisibleBeforeClose: visible };
  }

  function window(opensAt: IsoDateTime, closesAt: IsoDateTime): void {
    if (closesAt <= opensAt) throw new ValidationError('Bitiş zamanı başlangıç zamanından sonra olmalıdır', 'closesAt');
  }

  // -------------------------------------------------------------------------
  // Oy listesi (mulkiyet modulu)
  // -------------------------------------------------------------------------

  /**
   * Apartmanin `day` gunu CANLI oy listesi. Yalnizca yayinda, dondurulacak goruntuyu uretmek icin
   * okunur; sonuc, katilim ve oy hakki hep dondurulmus listeden gelir.
   */
  async function liveRoll(apartmentId: string, day: IsoDate): Promise<{ roll: VotingRollItem[]; members: UnitMembership[] }> {
    const [units, heads, records, members] = await Promise.all([
      deps.core.listUnits(apartmentId),
      deps.ownership.listHeads(apartmentId),
      deps.ownership.listRecords(apartmentId),
      deps.memberships.list(apartmentId, {}),
    ]);
    const own = members.filter((m) => m.apartmentId === apartmentId);
    const roll = buildVotingRoll({
      units: units.filter((u) => u.siteId === apartmentId),
      heads: heads.filter((h) => h.apartmentId === apartmentId),
      records: records.filter((r) => r.apartmentId === apartmentId),
      memberships: own,
      day,
    }).items;
    return { roll, members: own };
  }

  const snapshotOf = (p: Poll, live: { roll: VotingRollItem[]; members: UnitMembership[] }, frozenAt: IsoDateTime) =>
    buildSnapshot({
      apartmentId: p.apartmentId,
      ownerType: 'poll',
      ownerId: p.pollId,
      rollDate: p.rollDate,
      frozenAt,
      roll: live.roll,
      voters: (item) => eligibleVoters({ audience: p.audience, rollDate: p.rollDate }, item, live.members),
    });

  /**
   * Oy listesini dondurur: oylama `opensAt` anina geldiyse ve henuz dondurulmadiysa (planli yayinlanan
   * oylamanin ilk oyu / kapatilmasi). Kovalar oylama kaydiyla AYNI atomik yazimda; eszamanli ilk oyda
   * digerinin dondurdugu liste kullanilir. Okumalar hicbir zaman dondurmaz.
   *
   * Dondurma SISTEM islemidir: ilk oyu veren sakin denetim kaydina aktor olarak (istek bilgisiyle
   * birlikte) yazilmaz ve oylamanin `updatedBy` / `updatedAt` alanlari degismez; gizli oylamada
   * yonetim hicbir uctan ilk oyu kimin verdigini ogrenemez.
   */
  async function ensureRoll(p: Poll): Promise<Poll & { roll: RollMeta }> {
    if (p.roll) return p as Poll & { roll: RollMeta };
    const now = stamp();
    if (now < p.opensAt) throw new PollError('poll_closed', 'Oylama henüz başlamadı');
    const snapshot = snapshotOf(p, await liveRoll(p.apartmentId, p.rollDate), now);
    const next: Poll = { ...p, roll: snapshot.meta, version: p.version + 1 };
    try {
      await repo.update(next, p.version, {
        roll: snapshot.chunks,
        audit: {
          apartmentId: p.apartmentId,
          action: 'poll.roll_freeze',
          target: { type: 'poll', id: p.pollId },
          actorId: SYSTEM_ACTOR,
          systemActor: true,
          details: { rollDate: p.rollDate, units: snapshot.meta.units },
        },
      });
      return next as Poll & { roll: RollMeta };
    } catch (err) {
      if (!(err instanceof DataAccessError && err.code === 'conflict')) throw err;
      const fresh = await requirePoll(p.apartmentId, p.pollId);
      if (fresh.roll) return fresh as Poll & { roll: RollMeta };
      throw new PollError('conflict', 'Kayıt başka bir işlemle değiştirildi (sürüm uyuşmazlığı)');
    }
  }

  /** Tum liste: dondurulmussa anlik goruntu, degilse (planli oylama, henuz oy yok) canli on izleme. */
  async function rollOf(p: Poll): Promise<{ frozen: boolean; meta: RollMeta; entries: RollEntry[] }> {
    if (p.roll) return { frozen: true, meta: p.roll, entries: await deps.rolls.entries(p.apartmentId, 'poll', p.pollId) };
    const preview = snapshotOf(p, await liveRoll(p.apartmentId, p.rollDate), stamp());
    return { frozen: false, meta: preview.meta, entries: preview.entries };
  }

  /** Tek bolum: dondurulmussa tek kova; degilse yalnizca o bolumun canli kaydi (tum apartman okunmaz). */
  async function entryOf(p: Poll, unit: Unit): Promise<RollEntry | undefined> {
    if (p.roll) return deps.rolls.entry(p.apartmentId, 'poll', p.pollId, p.roll, unit.unitId);
    const [head, records, members] = await Promise.all([
      deps.ownership.getHead(p.apartmentId, unit.unitId),
      deps.ownership.listRecords(p.apartmentId, unit.unitId),
      deps.memberships.list(p.apartmentId, { unitId: unit.unitId }),
    ]);
    const own = members.filter((m) => m.apartmentId === p.apartmentId && m.unitId === unit.unitId);
    const roll = buildVotingRoll({
      units: [unit],
      heads: head && head.apartmentId === p.apartmentId ? [head] : [],
      records: records.filter((r) => r.apartmentId === p.apartmentId && r.unitId === unit.unitId),
      memberships: own,
      day: p.rollDate,
    }).items;
    return snapshotOf(p, { roll, members: own }, stamp()).entries[0];
  }

  // -------------------------------------------------------------------------
  // Yonetici: olustur / duzenle
  // -------------------------------------------------------------------------

  async function create(ctx: PollContext, body: unknown): Promise<PollView> {
    const o = asObject(body);
    const title = reqString(o, 'title', 150);
    const description = optString(o, 'description', 2000);
    const options = parseOptions(o.options);
    const s = settings(o);
    const ts = stamp();
    const opensAt = o.opensAt == null ? ts : parseDateTime(o, 'opensAt');
    const closesAt = parseDateTime(o, 'closesAt');
    window(opensAt, closesAt);

    const pollId = deps.newId();
    const poll: Poll = {
      ...pollKeys.poll(ctx.apartmentId, pollId),
      entityType: 'POLL',
      pollId,
      apartmentId: ctx.apartmentId,
      title,
      ...(description ? { description } : {}),
      options,
      ...s,
      opensAt,
      closesAt,
      rollDate: istanbulDate(opensAt),
      status: 'draft',
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    await repo.create(poll);
    return toView(poll);
  }

  async function list(ctx: PollContext, status?: string): Promise<PollView[]> {
    const filter = optEnum({ status }, 'status', STATUS_FILTERS) ?? 'all';
    const nowIso = stamp();
    return (await repo.list(ctx.apartmentId))
      .filter((p) => p.apartmentId === ctx.apartmentId)
      .map((p) => toView(p, nowIso))
      .filter((p) => filter === 'all' || p.phase === filter)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.pollId.localeCompare(a.pollId));
  }

  const get = async (ctx: PollContext, id: string) => toView(await requirePoll(ctx.apartmentId, id));

  async function update(ctx: PollContext, id: string, body: unknown): Promise<PollView> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await requirePoll(ctx.apartmentId, id);
    assertVersion(current, version);
    if (current.status !== 'draft') throw new PollError('conflict', 'Yayınlanan oylamanın sorusu ve seçenekleri değiştirilemez');

    const description = o.description === undefined ? current.description : o.description === null ? undefined : optString(o, 'description', 2000);
    const opensAt = o.opensAt === undefined ? current.opensAt : o.opensAt === null ? stamp() : parseDateTime(o, 'opensAt');
    const closesAt = o.closesAt === undefined ? current.closesAt : parseDateTime(o, 'closesAt');
    window(opensAt, closesAt);
    const { description: _d, ...rest } = current;
    const next: Poll = {
      ...rest,
      title: o.title === undefined ? current.title : reqString(o, 'title', 150),
      ...(description ? { description } : {}),
      options: o.options === undefined ? current.options : parseOptions(o.options),
      ...settings(o, current),
      opensAt,
      closesAt,
      rollDate: istanbulDate(opensAt),
      ...touch(ctx, current),
    };
    return save(next, current.version);
  }

  // -------------------------------------------------------------------------
  // Yayin / kapatma / iptal (denetimli)
  // -------------------------------------------------------------------------

  async function publish(ctx: PollContext, id: string, body: unknown): Promise<PollView> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await requirePoll(ctx.apartmentId, id);
    assertVersion(current, version);
    if (current.status !== 'draft') throw new PollError('conflict', `Oylama yayınlanamaz: durum ${current.status}`);

    const now = stamp();
    const opensAt = current.opensAt < now ? now : current.opensAt;
    if (current.closesAt <= opensAt) throw new ValidationError('Oylamanın bitiş zamanı geçmiş; bitiş zamanını güncelleyin', 'closesAt');
    const rollDate = istanbulDate(opensAt);
    // Oy listesi oy listesi gunu oncesinde DONDURULMAZ: hemen acilan oylamada yayinda, planli oylamada
    // acilistan sonraki ilk oy / kapatma yaziminda dondurulur. Yayinda canli liste yalnizca dogrulanir.
    const live = await liveRoll(ctx.apartmentId, rollDate);
    if (live.roll.length === 0) throw new PollError('unprocessable', 'Apartmanda aktif bağımsız bölüm yok');
    const opensNow = opensAt <= now;
    const snapshot = snapshotOf({ ...current, rollDate }, live, now);
    if (current.weighting === 'land_share' && snapshot.meta.missingLandShare > 0) {
      throw new PollError('unprocessable', `Arsa payı ağırlıklı oylama için tüm bölümlerin arsa payı girilmeli (${snapshot.meta.missingLandShare} bölümde eksik)`);
    }

    const next: Poll = {
      ...current,
      status: 'published',
      opensAt,
      rollDate,
      ...(opensNow ? { roll: snapshot.meta } : {}),
      publishedAt: now,
      publishedBy: ctx.userId,
      ...touch(ctx, current),
    };
    const event = buildEvent(
      {
        eventId: `POLL_PUBLISHED:${next.pollId}`,
        type: 'POLL_PUBLISHED',
        apartmentId: ctx.apartmentId,
        actorId: ctx.userId,
        payload: { pollId: next.pollId, title: next.title, audience: next.audience, opensAt: next.opensAt, closesAt: next.closesAt },
      },
      deps.now,
    );
    return save(next, current.version, {
      outbox: [event],
      ...(opensNow ? { roll: snapshot.chunks } : {}),
      audit: {
        apartmentId: ctx.apartmentId,
        action: 'poll.publish',
        target: { type: 'poll', id: next.pollId },
        actorId: ctx.userId,
        details: {
          title: next.title,
          audience: next.audience,
          weighting: next.weighting,
          secret: next.secret,
          options: next.options.length,
          opensAt: next.opensAt,
          closesAt: next.closesAt,
          rollDate: next.rollDate,
          rollUnits: snapshot.meta.units,
          rollFrozen: opensNow,
        },
      },
    });
  }

  async function close(ctx: PollContext, id: string, body: unknown): Promise<PollView> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const reason = reqString(o, 'reason', 500, 3);
    const loaded = await requirePoll(ctx.apartmentId, id);
    assertVersion(loaded, version);
    const phase = pollPhase(loaded, stamp());
    if (phase !== 'open' && phase !== 'scheduled') {
      throw new PollError('conflict', phase === 'closed' ? 'Oylama zaten sona erdi' : `Oylama kapatılamaz: durum ${loaded.status}`);
    }
    const votedUnits = (await repo.listVotes(ctx.apartmentId, loaded.pollId)).length;
    // Acilmis ama henuz oy almamis planli oylama: kesin sonucun paydasi kapanista dondurulur.
    const current = phase === 'open' ? await ensureRoll(loaded) : loaded;
    const now = stamp();
    // Gizli oylama: cok az oyla erken kapatip sonucu acmak bireysel oyu ele verir.
    if (current.secret && phase === 'open' && votedUnits < MIN_SECRET_CLOSE_VOTES) {
      throw new PollError(
        'unprocessable',
        `Gizli oylama en az ${MIN_SECRET_CLOSE_VOTES} bölüm oy kullanmadan erken kapatılamaz (şu an ${votedUnits}); oylama bitiş zamanında kendiliğinden sona erer`,
      );
    }
    const next: Poll = { ...current, status: 'closed', closedAt: now, closedBy: ctx.userId, closeReason: reason, closedEarly: true, ...touch(ctx, current) };
    return save(next, current.version, {
      audit: {
        apartmentId: ctx.apartmentId,
        action: 'poll.close',
        target: { type: 'poll', id: next.pollId },
        actorId: ctx.userId,
        reason,
        details: { early: true, phase, closesAt: current.closesAt, votedUnits },
      },
    });
  }

  async function cancel(ctx: PollContext, id: string, body: unknown): Promise<PollView> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await requirePoll(ctx.apartmentId, id);
    if (current.status === 'cancelled') return toView(current);
    assertVersion(current, version);
    if (current.status !== 'draft') {
      throw new PollError('conflict', 'Yalnızca taslak iptal edilir; yayındaki oylama erken kapatılır');
    }
    const next: Poll = { ...current, status: 'cancelled', cancelledAt: stamp(), cancelledBy: ctx.userId, ...touch(ctx, current) };
    return save(next, current.version, {
      audit: { apartmentId: ctx.apartmentId, action: 'poll.cancel', target: { type: 'poll', id: next.pollId }, actorId: ctx.userId, details: { title: next.title } },
    });
  }

  // -------------------------------------------------------------------------
  // Yonetici: sonuc ve katilim
  // -------------------------------------------------------------------------

  async function requireTallyable(ctx: PollContext, id: string): Promise<Poll> {
    const p = await requirePoll(ctx.apartmentId, id);
    if (p.status === 'draft' || p.status === 'cancelled') throw new PollError('conflict', 'Taslak veya iptal edilen oylamanın sonucu yoktur');
    return p;
  }

  /** Sonuc: okuma hicbir sey dondurmaz; liste dondurulmamissa `rollFrozen: false` (on izleme paydasi). */
  async function results(ctx: PollContext, id: string): Promise<{ poll: PollView; rollFrozen: boolean; results: PollResults }> {
    const p = await requireTallyable(ctx, id);
    const [roll, votes] = await Promise.all([rollOf(p), repo.listVotes(ctx.apartmentId, p.pollId)]);
    const nowIso = stamp();
    return { poll: toView(p, nowIso), rollFrozen: roll.frozen, results: tallyPoll({ poll: { ...p, roll: roll.meta }, entries: roll.entries, votes, nowIso }) };
  }

  /**
   * Bolum bazinda katilim. Gizli oylamada PLANLANAN bitise (`closesAt`, erken kapatilsa da) kadar
   * hangi bolumun oy kullandigi gosterilmez: yalnizca sayi (`votedUnits`).
   */
  async function participation(ctx: PollContext, id: string): Promise<{ secret: boolean; hidden: boolean; hiddenUntil?: IsoDateTime; votedUnits: number; items: PollUnitRow[] }> {
    const p = await requireTallyable(ctx, id);
    const votes = await repo.listVotes(ctx.apartmentId, p.pollId);
    if (p.secret && stamp() < p.closesAt) return { secret: true, hidden: true, hiddenUntil: p.closesAt, votedUnits: votes.length, items: [] };
    const { entries } = await rollOf(p);
    return { secret: p.secret, hidden: false, votedUnits: votes.length, items: participationRows(p, entries, votes) };
  }

  // -------------------------------------------------------------------------
  // Sakin portali
  // -------------------------------------------------------------------------

  function assertPortal(ctx: PollPortalContext): void {
    if (!PORTAL_ROLES.includes(ctx.role)) throw new PollError('forbidden', 'Sakin portalı yalnızca daire sakinlerine açıktır');
  }

  /** Sakinin gorebilecegi oylama: yayinda / bitmis, baslamis ve hedef kitle uyelik iliskisine uygun. */
  const visibleTo = (p: Poll, relation: UnitMembership['relation'], nowIso: IsoDateTime) =>
    (p.status === 'published' || (p.status === 'closed' && Boolean(p.publishedAt))) &&
    p.opensAt <= nowIso &&
    (p.audience === 'residents' || relation === 'owner');

  /** Oy hakki: dondurulmus listedeki bolum satiri (tek kova); dondurulmadiysa bolumun canli kaydi. */
  async function eligibility(p: Poll, unit: Unit, userId: string): Promise<{ relation?: VoterRelation; reason?: string }> {
    const entry = await entryOf(p, unit);
    const relation = entry?.voters.find((v) => v.userId === userId)?.relation;
    if (relation) return { relation };
    if (!entry) return { reason: `Bu bölüm ${p.rollDate} tarihli oy listesinde yok` };
    return {
      reason:
        p.audience === 'owners'
          ? `Oy listesi tarihinde (${p.rollDate}) bu bölümün malikleri arasında kayıtlı değilsiniz`
          : `Oy listesi tarihinde (${p.rollDate}) bu bölümde kayıtlı değilsiniz`,
    };
  }

  function myVoteView(p: Poll, vote: PollVote | undefined, userId: string): MyVoteView | undefined {
    if (!vote) return undefined;
    const mine = vote.voterUserId === userId;
    return { castByMe: mine, ...(mine || !p.secret ? { optionId: vote.optionId, castAt: vote.castAt } : {}) };
  }

  /** Ara sonuc yalnizca acik oylamada, ayarliysa ve bolumu OY KULLANMIS sakine. */
  const liveResultsAllowed = (p: Poll, phase: PollPhase) => phase === 'open' && !p.secret && p.resultsVisibleBeforeClose;

  function portalView(
    p: Poll,
    unitId: string,
    nowIso: IsoDateTime,
    elig: { relation?: VoterRelation; reason?: string },
    vote: PollVote | undefined,
    userId: string,
  ): PortalPollView {
    const phase = pollPhase(p, nowIso);
    const eligible = Boolean(elig.relation);
    const myVote = myVoteView(p, vote, userId);
    const live = liveResultsAllowed(p, phase);
    return {
      pollId: p.pollId,
      title: p.title,
      ...(p.description ? { description: p.description } : {}),
      options: p.options,
      audience: p.audience,
      weighting: p.weighting,
      secret: p.secret,
      resultsVisibleBeforeClose: p.resultsVisibleBeforeClose,
      opensAt: p.opensAt,
      closesAt: p.closesAt,
      ...(phase === 'closed' ? { closedAt: effectiveCloseAt(p), closedEarly: Boolean(p.closedEarly) } : {}),
      rollDate: p.rollDate,
      phase,
      unitId,
      eligible,
      canVote: eligible && phase === 'open',
      ...(elig.reason ? { ineligibleReason: elig.reason } : {}),
      ...(myVote ? { myVote } : {}),
      resultsAvailable: phase === 'closed' || (live && Boolean(vote)),
      resultsAfterVote: live && !vote,
    };
  }

  async function portalList(ctx: PollPortalContext, unitId?: string): Promise<{ unitId: string; items: PortalPollView[] }> {
    assertPortal(ctx);
    const r = await deps.portal.resolveUnit({ ...ctx }, unitId);
    const nowIso = stamp();
    const polls = (await repo.list(ctx.apartmentId)).filter((p) => visibleTo(p, r.membership.relation, nowIso));
    const items = await Promise.all(
      polls.map(async (p) => {
        const [vote, elig] = await Promise.all([repo.getVote(ctx.apartmentId, p.pollId, r.unit.unitId), eligibility(p, r.unit, ctx.userId)]);
        return portalView(p, r.unit.unitId, nowIso, elig, vote, ctx.userId);
      }),
    );
    // Acik oylamalar once (en yakin bitis), sonra bitenler (en yeni once).
    const rank = (v: PortalPollView) => (v.phase === 'open' ? 0 : 1);
    items.sort((a, b) =>
      rank(a) - rank(b) || (rank(a) === 0 ? a.closesAt.localeCompare(b.closesAt) : (b.closedAt ?? b.closesAt).localeCompare(a.closedAt ?? a.closesAt)),
    );
    return { unitId: r.unit.unitId, items };
  }

  async function portalDetail(ctx: PollPortalContext, id: string, unitId?: string): Promise<PortalPollView> {
    assertPortal(ctx);
    const r = await deps.portal.resolveUnit({ ...ctx }, unitId);
    const found = await requirePoll(ctx.apartmentId, id);
    const nowIso = stamp();
    if (!visibleTo(found, r.membership.relation, nowIso)) throw new PollError('not_found', 'Oylama bulunamadı');
    const p = found;
    const [elig, vote] = await Promise.all([eligibility(p, r.unit, ctx.userId), repo.getVote(ctx.apartmentId, p.pollId, r.unit.unitId)]);
    const view = portalView(p, r.unit.unitId, nowIso, elig, vote, ctx.userId);
    if (!view.resultsAvailable) return view;
    const [roll, votes] = await Promise.all([rollOf(p), repo.listVotes(ctx.apartmentId, p.pollId)]);
    return { ...view, results: tallyPoll({ poll: { ...p, roll: roll.meta }, entries: roll.entries, votes, nowIso }) };
  }

  async function vote(ctx: PollPortalContext, id: string, unitId: string | undefined, body: unknown): Promise<PortalPollView> {
    assertPortal(ctx);
    const o = asObject(body);
    const r = await deps.portal.resolveUnit({ ...ctx }, unitId);
    const found = await requirePoll(ctx.apartmentId, id);
    const nowIso = stamp();
    if (!visibleTo(found, r.membership.relation, nowIso)) {
      if (found.status === 'published' && found.audience === 'owners' && r.membership.relation !== 'owner') {
        throw new PollError('not_eligible', 'Bu oylamada yalnızca kat malikleri oy kullanır');
      }
      if (found.status === 'published' && found.opensAt > nowIso) throw new PollError('poll_closed', 'Oylama henüz başlamadı');
      throw new PollError('not_found', 'Oylama bulunamadı');
    }
    if (pollPhase(found, nowIso) !== 'open') throw new PollError('poll_closed', 'Oylama sona erdi; oy kabul edilmiyor');
    const optionId = reqString(o, 'optionId', 16);
    if (!found.options.some((x) => x.optionId === optionId)) throw new ValidationError('Geçersiz seçenek', 'optionId');
    // Planli yayinlanan oylamada ilk oy (acilistan sonra) oy listesini dondurur; oy hakki dondurulmus listeden.
    const p = await ensureRoll(found);

    const elig = await eligibility(p, r.unit, ctx.userId);
    if (!elig.relation) throw new PollError('not_eligible', elig.reason ?? 'Bu oylamada oy hakkınız yok');

    const sameAsMine = (v: PollVote | undefined) => Boolean(v && v.voterUserId === ctx.userId && v.optionId === optionId);
    const existing = await repo.getVote(ctx.apartmentId, p.pollId, r.unit.unitId);
    // Ayni kisinin ayni secimi: yazim yok (tekrar gonderim etkisiz).
    if (existing && sameAsMine(existing)) return portalView(p, r.unit.unitId, stamp(), elig, existing, ctx.userId);

    // Kapanis kontrolu icin zaman damgasi yazimdan HEMEN once alinir (okumalar sirasinda gecen sure
    // bitis anini asmasin): kosul `closesAt > writeAt` ile oylama kaydinda dogrulanir.
    const writeAt = stamp();
    const next: PollVote = {
      ...pollKeys.vote(ctx.apartmentId, p.pollId, r.unit.unitId),
      entityType: 'POLL_VOTE',
      apartmentId: ctx.apartmentId,
      pollId: p.pollId,
      unitId: r.unit.unitId,
      optionId,
      voterUserId: ctx.userId,
      voterRelation: elig.relation,
      castAt: writeAt,
      createdAt: existing?.createdAt ?? writeAt,
      version: (existing?.version ?? 0) + 1,
    };
    try {
      await repo.putVote(next, existing?.version ?? 0, writeAt);
    } catch (err) {
      if (!(err instanceof PollVoteConflictError)) throw err;
      if (err.reason === 'poll') throw new PollError('poll_closed', 'Oylama sona erdi; oy kabul edilmiyor');
      // Ayni oyun eszamanli ikinci gonderimi: kayitli oy gonderilenle ayniysa basari.
      const stored = await repo.getVote(ctx.apartmentId, p.pollId, r.unit.unitId);
      if (sameAsMine(stored)) return portalView(p, r.unit.unitId, stamp(), elig, stored, ctx.userId);
      throw new PollError('conflict', 'Dairenizin oyu bu arada başka bir paydaş tarafından değiştirildi; sayfayı yenileyip tekrar deneyin');
    }
    return portalView(p, r.unit.unitId, writeAt, elig, next, ctx.userId);
  }


  /**
   * Zamanlanmis is (`maintenance_tasks`, her gun): suresi dolmus (veya erken kapatilmis) ama hic
   * oy almadigi icin oy listesi dondurulmamis oylamalari SISTEM olarak dondurur; kesin sonucun
   * paydasi canli listede kalmaz. Acilmadan kapatilan oylama dondurulmaz (oy listesi gunu gelmedi).
   */
  async function freezeEnded(apartmentId: string): Promise<number> {
    const nowIso = stamp();
    const due = (await repo.list(apartmentId)).filter(
      (p) =>
        p.apartmentId === apartmentId &&
        !p.roll &&
        Boolean(p.publishedAt) &&
        p.opensAt <= nowIso &&
        (p.status === 'published' ? nowIso >= p.closesAt : p.status === 'closed' && (p.closedAt ?? p.closesAt) >= p.opensAt),
    );
    for (const p of due) await ensureRoll(p);
    return due.length;
  }

  return { create, list, get, update, publish, close, cancel, results, participation, portalList, portalDetail, vote, freezeEnded };
}

export type PollService = ReturnType<typeof createPollService>;
