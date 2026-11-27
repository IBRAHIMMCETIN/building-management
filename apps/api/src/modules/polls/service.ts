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

export type PollContext = { apartmentId: string; userId: string };
export type PollPortalContext = PollContext & { role: Role };

export type PollServiceDeps = {
  repository: PollRepository;
  core: Pick<CoreRepository, 'getUnit' | 'listUnits'>;
  ownership: Pick<OwnershipRepository, 'getHead' | 'listHeads' | 'listRecords'>;
  memberships: Pick<MembershipRepository, 'list'>;
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

  async function save(next: Poll, expectedVersion: number, opts?: { audit?: AuditDraft; outbox?: DomainEvent[] }): Promise<PollView> {
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

  /** Apartmanin `day` gunu oy listesi (tum aktif bolumler; sonuc paydasi). */
  async function loadRoll(apartmentId: string, day: IsoDate): Promise<VotingRollItem[]> {
    const [units, heads, records, members] = await Promise.all([
      deps.core.listUnits(apartmentId),
      deps.ownership.listHeads(apartmentId),
      deps.ownership.listRecords(apartmentId),
      deps.memberships.list(apartmentId, {}),
    ]);
    return buildVotingRoll({
      units: units.filter((u) => u.siteId === apartmentId),
      heads: heads.filter((h) => h.apartmentId === apartmentId),
      records: records.filter((r) => r.apartmentId === apartmentId),
      memberships: members.filter((m) => m.apartmentId === apartmentId),
      day,
    }).items;
  }

  /** Tek bolumun kaydi: oy listesi tek bolum icin kurulur (oy aninda tum apartman okunmaz). */
  async function loadUnitRegister(apartmentId: string, unit: Unit) {
    const [head, records, members] = await Promise.all([
      deps.ownership.getHead(apartmentId, unit.unitId),
      deps.ownership.listRecords(apartmentId, unit.unitId),
      deps.memberships.list(apartmentId, { unitId: unit.unitId }),
    ]);
    const unitMembers = members.filter((m) => m.apartmentId === apartmentId && m.unitId === unit.unitId);
    return {
      members: unitMembers,
      rollOn: (day: IsoDate): VotingRollItem | undefined =>
        buildVotingRoll({
          units: [unit],
          heads: head && head.apartmentId === apartmentId ? [head] : [],
          records: records.filter((r) => r.apartmentId === apartmentId && r.unitId === unit.unitId),
          memberships: unitMembers,
          day,
        }).items[0],
    };
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
    const units = (await deps.core.listUnits(ctx.apartmentId)).filter((u) => u.siteId === ctx.apartmentId && u.status === 'active');
    if (units.length === 0) throw new PollError('unprocessable', 'Apartmanda aktif bağımsız bölüm yok');
    if (current.weighting === 'land_share') {
      const missing = units.filter((u) => !u.landShare || u.landShare.denominator <= 0).length;
      if (missing > 0) {
        throw new PollError('unprocessable', `Arsa payı ağırlıklı oylama için tüm bölümlerin arsa payı girilmeli (${missing} bölümde eksik)`);
      }
    }

    const next: Poll = {
      ...current,
      status: 'published',
      opensAt,
      rollDate: istanbulDate(opensAt),
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
        },
      },
    });
  }

  async function close(ctx: PollContext, id: string, body: unknown): Promise<PollView> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const reason = reqString(o, 'reason', 500, 3);
    const current = await requirePoll(ctx.apartmentId, id);
    assertVersion(current, version);
    const now = stamp();
    const phase = pollPhase(current, now);
    if (phase !== 'open' && phase !== 'scheduled') {
      throw new PollError('conflict', phase === 'closed' ? 'Oylama zaten sona erdi' : `Oylama kapatılamaz: durum ${current.status}`);
    }
    const votedUnits = (await repo.listVotes(ctx.apartmentId, current.pollId)).length;
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

  async function results(ctx: PollContext, id: string): Promise<{ poll: PollView; results: PollResults }> {
    const p = await requireTallyable(ctx, id);
    const [roll, votes] = await Promise.all([loadRoll(ctx.apartmentId, p.rollDate), repo.listVotes(ctx.apartmentId, p.pollId)]);
    const nowIso = stamp();
    return { poll: toView(p, nowIso), results: tallyPoll({ poll: p, roll, votes, nowIso }) };
  }

  async function participation(ctx: PollContext, id: string): Promise<{ secret: boolean; items: PollUnitRow[] }> {
    const p = await requireTallyable(ctx, id);
    const [roll, votes] = await Promise.all([loadRoll(ctx.apartmentId, p.rollDate), repo.listVotes(ctx.apartmentId, p.pollId)]);
    return { secret: p.secret, items: participationRows(p, roll, votes) };
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

  function eligibility(p: Poll, register: Awaited<ReturnType<typeof loadUnitRegister>>, userId: string): { relation?: VoterRelation; reason?: string } {
    const voters = eligibleVoters(p, register.rollOn(p.rollDate), register.members);
    const relation = voters.get(userId);
    if (relation) return { relation };
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

  const resultsVisible = (p: Poll, phase: PollPhase) => phase === 'closed' || (phase === 'open' && !p.secret && p.resultsVisibleBeforeClose);

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
      resultsAvailable: resultsVisible(p, phase),
    };
  }

  async function portalList(ctx: PollPortalContext, unitId?: string): Promise<{ unitId: string; items: PortalPollView[] }> {
    assertPortal(ctx);
    const r = await deps.portal.resolveUnit({ ...ctx }, unitId);
    const nowIso = stamp();
    const polls = (await repo.list(ctx.apartmentId)).filter((p) => visibleTo(p, r.membership.relation, nowIso));
    const register = await loadUnitRegister(ctx.apartmentId, r.unit);
    const items = await Promise.all(
      polls.map(async (p) => {
        const vote = await repo.getVote(ctx.apartmentId, p.pollId, r.unit.unitId);
        return portalView(p, r.unit.unitId, nowIso, eligibility(p, register, ctx.userId), vote, ctx.userId);
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
    const p = await requirePoll(ctx.apartmentId, id);
    const nowIso = stamp();
    if (!visibleTo(p, r.membership.relation, nowIso)) throw new PollError('not_found', 'Oylama bulunamadı');
    const [register, vote] = await Promise.all([loadUnitRegister(ctx.apartmentId, r.unit), repo.getVote(ctx.apartmentId, p.pollId, r.unit.unitId)]);
    const view = portalView(p, r.unit.unitId, nowIso, eligibility(p, register, ctx.userId), vote, ctx.userId);
    if (!view.resultsAvailable) return view;
    const [roll, votes] = await Promise.all([loadRoll(ctx.apartmentId, p.rollDate), repo.listVotes(ctx.apartmentId, p.pollId)]);
    return { ...view, results: tallyPoll({ poll: p, roll, votes, nowIso }) };
  }

  async function vote(ctx: PollPortalContext, id: string, unitId: string | undefined, body: unknown): Promise<PortalPollView> {
    assertPortal(ctx);
    const o = asObject(body);
    const r = await deps.portal.resolveUnit({ ...ctx }, unitId);
    const p = await requirePoll(ctx.apartmentId, id);
    const nowIso = stamp();
    if (!visibleTo(p, r.membership.relation, nowIso)) {
      if (p.status === 'published' && p.audience === 'owners' && r.membership.relation !== 'owner') {
        throw new PollError('not_eligible', 'Bu oylamada yalnızca kat malikleri oy kullanır');
      }
      if (p.status === 'published' && p.opensAt > nowIso) throw new PollError('poll_closed', 'Oylama henüz başlamadı');
      throw new PollError('not_found', 'Oylama bulunamadı');
    }
    if (pollPhase(p, nowIso) !== 'open') throw new PollError('poll_closed', 'Oylama sona erdi; oy kabul edilmiyor');
    const optionId = reqString(o, 'optionId', 16);
    if (!p.options.some((x) => x.optionId === optionId)) throw new ValidationError('Geçersiz seçenek', 'optionId');

    const register = await loadUnitRegister(ctx.apartmentId, r.unit);
    const elig = eligibility(p, register, ctx.userId);
    if (!elig.relation) throw new PollError('not_eligible', elig.reason ?? 'Bu oylamada oy hakkınız yok');

    const existing = await repo.getVote(ctx.apartmentId, p.pollId, r.unit.unitId);
    // Ayni kisinin ayni secimi: yazim yok (tekrar gonderim etkisiz).
    if (existing && existing.voterUserId === ctx.userId && existing.optionId === optionId) {
      return portalView(p, r.unit.unitId, nowIso, elig, existing, ctx.userId);
    }
    const next: PollVote = {
      ...pollKeys.vote(ctx.apartmentId, p.pollId, r.unit.unitId),
      entityType: 'POLL_VOTE',
      apartmentId: ctx.apartmentId,
      pollId: p.pollId,
      unitId: r.unit.unitId,
      optionId,
      voterUserId: ctx.userId,
      voterRelation: elig.relation,
      castAt: nowIso,
      createdAt: existing?.createdAt ?? nowIso,
      version: (existing?.version ?? 0) + 1,
    };
    try {
      await repo.putVote(next, existing?.version ?? 0, nowIso);
    } catch (err) {
      if (err instanceof PollVoteConflictError) {
        throw err.reason === 'poll'
          ? new PollError('poll_closed', 'Oylama sona erdi; oy kabul edilmiyor')
          : new PollError('conflict', 'Dairenizin oyu bu arada başka bir paydaş tarafından değiştirildi; sayfayı yenileyip tekrar deneyin');
      }
      throw err;
    }
    return portalView(p, r.unit.unitId, nowIso, elig, next, ctx.userId);
  }

  return { create, list, get, update, publish, close, cancel, results, participation, portalList, portalDetail, vote };
}

export type PollService = ReturnType<typeof createPollService>;
