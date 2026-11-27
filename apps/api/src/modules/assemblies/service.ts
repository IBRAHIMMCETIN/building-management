import { createHash, randomUUID } from 'node:crypto';
import type { Role } from '../../auth/claims.js';
import { DataAccessError } from '../../config/dynamodb.js';
import { buildEvent } from '../../events/publisher.js';
import type { AuditDraft } from '../audit/log.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import type { IsoDate, IsoDateTime } from '../core/types.js';
import { type Obj, ValidationError, asObject, assertId, optBool, optString, reqEnum, reqInt, reqString } from '../core/validation.js';
import { DocumentError } from '../documents/errors.js';
import { assemblyDecisionBookKey, assemblyMinutesKey, assemblySheetKey, contentDisposition } from '../documents/keys.js';
import { REPORT_TEMPLATE_VERSION, renderReportPdf } from '../documents/reportPdf.js';
import { type DocumentStore, URL_TTL_SECONDS, createDocumentStoreFromEnv } from '../documents/store.js';
import { type MembershipRepository, membershipRepository } from '../memberships/repository.js';
import { formatDate, formatDateTime } from '../notifications/templates.js';
import { addDays, buildVotingRoll } from '../ownership/register.js';
import { type OwnershipRepository, ownershipRepository } from '../ownership/repository.js';
import { PollError } from '../polls/errors.js';
import { istanbulDate } from '../polls/results.js';
import { type RollEntry, type RollMeta, type RollSnapshotStore, buildSnapshot, rollSnapshotStore } from '../polls/rollSnapshot.js';
import type { UnitMembership } from '../portal/types.js';
import { type PersonRepository, personRepository } from '../residents/repository.js';
import {
  DECISION_KINDS,
  DECISION_PRESETS,
  type DecisionOutcome,
  LAND_RULES,
  MAJORITY_LABELS,
  MAJORITY_RULES,
  type MajorityRule,
  QUALIFIED_RULES,
  VOTE_CHOICES,
  type VoteChoice,
  decideByCounts,
  decideByUnits,
  landShareMissing,
  personKeys,
  unitVotesIssue,
  voterKeys,
} from './majority.js';
import { type ReportContent, decisionBookReport, itemKind, itemRule, minutesReport } from './minutes.js';
import { meetingHash } from './notifications.js';
import { type ProxyRef, type Quorum, assemblyQuorum, proxyViolation } from './quorum.js';
import { type AssemblyRepository, type AssemblyWriteExtras, assemblyKeys, assemblyRepository } from './repository.js';
import {
  ASSEMBLY_KINDS,
  ATTENDANCE_MODES,
  type AgendaItem,
  type AgendaTally,
  type Assembly,
  type AssemblyAttendance,
  type AssemblyCall,
  type AssemblyCallSummary,
  type AssemblyDecision,
  type AssemblyMinutes,
  CALL_NOTICE_DAYS,
  MAX_AGENDA_ITEMS,
  MAX_CALLS,
  type QuorumRecord,
  SECOND_MEETING_MIN_DAYS,
  type SecondMeetingPlan,
} from './types.js';

/**
 * Y1-3 - Kat malikleri kurulu (genel kurul) hazirligi ve devami: toplanti kaydi (olagan /
 * olaganustu, tarih, yer veya cevrim ici baglanti, gundem ve madde basina karar turu / gerekli
 * cogunluk), dondurulmus oy listesinden hazirun cetveli (PDF), katilim girisi (asaleten /
 * vekaleten), KMK m.30 yeter sayi, m.31 oy ve vekalet sinirlari, gundem karari, cagri e-postasi,
 * tutanak (divan, notlar, kesinlestirme) ve karar defteri PDF'i; kat maliki sakinler icin portal.
 *  - Oy listesi toplanti gunu icin mulkiyet modulunden; ilk katilim, yeter sayi kaydi veya karar
 *    yaziminda DONDURULUR. Yeter sayi, karar, hazirun ve tutanak yalnizca dondurulmus listeden.
 *  - Ikinci toplanti, yeter sayisinin saglanamadigi tutanaga gecmis ilk toplantiya baglanir ve ondan
 *    en gec 15 gun sonradir; yeter sayi aranmaz.
 *  - Kararlar DEGISMEZ (`ASMDEC#`): ayni madde icin ikinci kayit yalnizca gerekceli duzeltme olarak
 *    yeni sirayla eklenir; onceki kayit silinmez.
 *  - Cagri (`ASMCALL#` + `ASSEMBLY_CALLED` outbox olayi) toplanti kaydiyla ayni atomik yazimda;
 *    yeniden gonderim acik ve gerekcelidir. 15 gun kuralina uymayan cagri UYARI uretir, engellenmez.
 *  - Olusturma, duzenleme, iptal, dondurma, katilim, yeter sayi, karar, duzeltme, cagri, tutanak ve
 *    kesinlestirme denetim zincirine yazilir (ad bilgisi olmadan). Silme yok.
 */

/** Hata kodlari anket / oylama ile ortak (Y1). */
export class AssemblyError extends PollError {
  override name = 'AssemblyError';
}

export const KIND_LABELS = { ordinary: 'Olağan', extraordinary: 'Olağanüstü' } as const;
/** KMK m.30: ikinci toplanti ilk toplantidan en gec bu kadar gun sonra. */
export const SECOND_MEETING_MAX_DAYS = 15;
/** Tutanak metin alanlari ust siniri. */
const NOTE_MAX = 4000;

export type AssemblyContext = { apartmentId: string; userId: string };
export type AssemblyPortalContext = AssemblyContext & { role: Role };

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
export type DecisionView = Omit<AssemblyDecision, 'PK' | 'SK'>;

export type AssemblyUnitRow = {
  unitId: string;
  blockId: string;
  number: string;
  landShare?: { numerator: number; denominator: number };
  owners: { userId: string; name?: string; share?: { numerator: number; denominator: number } }[];
  attendance?: { mode: AssemblyAttendance['mode']; attendee?: { userId: string; name?: string }; proxy?: ProxyRef; recordedAt: IsoDateTime; version: number };
  /** Katilan bolumde oyu kullanan kisinin anahtari: ayni anahtarli bolumler birlikte oylanir (m.31). */
  voterKey?: string;
  /** Katilan bolumun kat maliki (kisi) anahtari: kisi sayimli kurallarda ayni anahtarli bolumler birlikte oylanir. */
  personKey?: string;
  warnings: string[];
};

/** Cagri oncesi denetim (ekranda gonderimden once gosterilir). */
export type CallCheck = { daysBefore: number; lateNotice: boolean; recipients: number; ownersWithoutAccount: number; warnings: string[] };

/** Sakin portali: toplanti gorunumu (baska maliklerin kisisel verisi ve bolum bazinda katilim YOK). */
export type PortalDecision = {
  decision: DecisionOutcome['decision'];
  rule: MajorityRule;
  votes: { yes: number; no: number; abstain: number };
  units: { yes: number; no: number; abstain: number } | null;
  landShareBps: { yes: number; no: number; abstain: number } | null;
  /** Kat maliki kisi sayilari (kisi sayimli kurallarda). */
  persons: { yes: number; no: number; abstain: number; total: number } | null;
  corrected: boolean;
  recordedAt: IsoDateTime;
};

export type PortalAssemblyView = {
  assemblyId: string;
  kind: Assembly['kind'];
  secondMeeting: boolean;
  scheduledAt: IsoDateTime;
  location?: string;
  onlineUrl?: string;
  rollDate: IsoDate;
  status: Assembly['status'];
  phase: 'upcoming' | 'awaiting_minutes' | 'held' | 'cancelled';
  cancelReason?: string;
  calledAt?: IsoDateTime;
  lastCalledAt?: IsoDateTime;
  secondMeetingPlan?: SecondMeetingPlan;
  heldAt?: IsoDateTime;
  agenda: { itemId: string; title: string; description?: string; decisionKind: AgendaItem['decisionKind']; majority: MajorityRule; decision?: PortalDecision }[];
  quorum?: { met: boolean; secondMeeting: boolean; noAttendance: boolean; presentOwners: number; totalOwners: number; presentVotes: number; totalVotes: number };
  minutesAvailable: boolean;
};

function parseDateTime(o: Obj, key: string, field = key): IsoDateTime {
  const v = reqString(o, key, 40);
  const ms = Date.parse(v);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || !/(Z|[+-]\d{2}:\d{2})$/.test(v) || Number.isNaN(ms)) {
    throw new ValidationError(`${key} saat dilimli ISO 8601 tarih-saat olmalıdır (örnek 2026-12-15T19:00:00+03:00)`, field);
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
    const decisionKind = o.decisionKind === undefined || o.decisionKind === null ? 'general' : o.decisionKind;
    if (typeof decisionKind !== 'string' || !(DECISION_KINDS as readonly string[]).includes(decisionKind)) {
      throw new ValidationError(`${i + 1}. gündem maddesi: geçersiz karar türü`, 'agenda');
    }
    const kind = decisionKind as AgendaItem['decisionKind'] & string;
    let majority: MajorityRule;
    if (kind === 'custom') {
      if (typeof o.majority !== 'string' || !(MAJORITY_RULES as readonly string[]).includes(o.majority)) {
        throw new ValidationError(`${i + 1}. gündem maddesi: özel karar türünde gerekli çoğunluğu seçin`, 'agenda');
      }
      majority = o.majority as MajorityRule;
    } else {
      const preset = DECISION_PRESETS[kind as Exclude<typeof kind, 'custom'>];
      if (o.majority !== undefined && o.majority !== null && o.majority !== preset.rule) {
        throw new ValidationError(`${i + 1}. gündem maddesi: ${preset.label} için gerekli çoğunluk kanundan gelir (${MAJORITY_LABELS[preset.rule]}, ${preset.legal}); farklı çoğunluk için "özel" türü seçin`, 'agenda');
      }
      majority = preset.rule;
    }
    return { itemId: `a${i + 1}`, title, ...(description ? { description } : {}), decisionKind: kind, majority };
  });
}

function parseHttps(v: string | undefined, field: string): string | undefined {
  if (v === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new ValidationError('Çevrim içi bağlantı geçerli bir adres olmalıdır', field);
  }
  if (url.protocol !== 'https:') throw new ValidationError('Çevrim içi bağlantı https:// ile başlamalıdır', field);
  return url.toString();
}

const parseUrl = (o: Obj) => parseHttps(optString(o, 'onlineUrl', 500), 'onlineUrl');

function parsePlan(raw: unknown): SecondMeetingPlan {
  const o = asObject(raw, 'secondMeetingPlan');
  const scheduledAt = parseDateTime(o, 'scheduledAt', 'secondMeetingPlan');
  const location = optString(o, 'location', 300);
  const onlineUrl = parseHttps(optString(o, 'onlineUrl', 500), 'secondMeetingPlan');
  if (!location && !onlineUrl) throw new ValidationError('İkinci toplantının yeri veya çevrim içi bağlantısı girilmeli', 'secondMeetingPlan');
  return { scheduledAt, ...(location ? { location } : {}), ...(onlineUrl ? { onlineUrl } : {}) };
}

/** Iki Istanbul takvim gunu arasi gun sayisi (`to - from`). */
export const dayDiff = (from: IsoDate, to: IsoDate) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const shareText = (s: { numerator: number | string; denominator: number | string }) => `${s.numerator}/${s.denominator}`;
const sha256 = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const activeOn = (m: UnitMembership, day: IsoDate) => m.status === 'active' && m.startDate <= day && (!m.endDate || m.endDate >= day);

export { meetingHash };

/**
 * KMK m.29/3 ve m.30: ikinci toplanti ilk toplantidan sonra, en az 7 en fazla 15 Istanbul takvim gunu
 * sonra. "Yedi gunden az olamaz": 7 gun dahil gecerli.
 */
function assertSecondMeetingGap(first: IsoDateTime, second: IsoDateTime, field: string): void {
  if (second <= first) throw new ValidationError('İkinci toplantı ilk toplantıdan sonra olmalıdır', field);
  const gap = dayDiff(istanbulDate(first), istanbulDate(second));
  if (gap < SECOND_MEETING_MIN_DAYS) throw new ValidationError(`İlk ve ikinci toplantı arasında en az ${SECOND_MEETING_MIN_DAYS} gün olmalıdır (KMK m.29/3; şu an ${gap} gün)`, field);
  if (istanbulDate(second) > addDays(istanbulDate(first), SECOND_MEETING_MAX_DAYS)) {
    throw new ValidationError(`İkinci toplantı ilk toplantıdan en geç ${SECOND_MEETING_MAX_DAYS} gün sonra yapılmalıdır (KMK m.30)`, field);
  }
}

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
  const decisionView = (d: AssemblyDecision): DecisionView => {
    const { PK: _pk, SK: _sk, ...rest } = d;
    return rest;
  };

  async function requireAssembly(ctx: AssemblyContext, id: string): Promise<Assembly> {
    assertId(id, 'assemblyId');
    const a = await repo.get(ctx.apartmentId, id);
    if (!a || a.apartmentId !== ctx.apartmentId) throw new AssemblyError('not_found', 'Genel kurul kaydı bulunamadı');
    return a;
  }

  const requirePlanned = (a: Assembly) => {
    if (a.status === 'cancelled') throw new AssemblyError('conflict', 'İptal edilen toplantı değiştirilemez');
    if (a.status !== 'planned') throw new AssemblyError('conflict', 'Tutanağı kesinleşmiş toplantı değiştirilemez');
  };

  function assertVersion(a: Assembly, version: number): void {
    if (a.version !== version) throw new AssemblyError('conflict', 'Kayıt başka bir işlemle değiştirildi (sürüm uyuşmazlığı)');
  }

  async function save(next: Assembly, expectedVersion: number, audit?: AuditDraft, extras?: AssemblyWriteExtras): Promise<AssemblyView> {
    try {
      await repo.update(next, expectedVersion, audit, extras);
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
    qualifiedItems: a.agenda.filter((i) => itemRule(i) !== 'attendees').length,
    ...(a.secondMeetingPlan ? { secondMeetingPlanAt: a.secondMeetingPlan.scheduledAt } : {}),
  });

  /** Ikinci toplanti: ilk toplanti ayni apartmanda, yeter sayisizligi tutanakta, en gec 15 gun once. */
  async function assertFirstMeeting(ctx: AssemblyContext, firstMeetingId: string, scheduledAt: IsoDateTime, selfId?: string): Promise<void> {
    assertId(firstMeetingId, 'firstMeetingId');
    if (firstMeetingId === selfId) throw new ValidationError('Toplantı kendisinin ikinci toplantısı olamaz', 'firstMeetingId');
    const first = await repo.get(ctx.apartmentId, firstMeetingId);
    if (!first || first.apartmentId !== ctx.apartmentId) throw new AssemblyError('not_found', 'İlk toplantı bulunamadı');
    if (first.status === 'cancelled') throw new AssemblyError('unprocessable', 'İptal edilen toplantıya ikinci toplantı bağlanamaz');
    if (first.secondMeeting) throw new AssemblyError('unprocessable', 'İkinci toplantıya yeniden ikinci toplantı bağlanamaz');
    if (first.quorumRecord?.met !== false) {
      throw new AssemblyError('unprocessable', 'İlk toplantıda yeter sayının sağlanamadığı tutanağa geçirilmemiş; önce ilk toplantının yeter sayısını kaydedin');
    }
    assertSecondMeetingGap(first.scheduledAt, scheduledAt, 'scheduledAt');
  }

  /**
   * Toplantiya iliskin uyarilar (engel degil): ikinci toplanti ilk toplantinin cagrisinda bildirilen
   * yer / zamandan farkliysa (KMK m.29/3); arsa payi gereken gundem maddesi varken arsa payi eksik
   * bolum varsa (oy listesi dondurulmadan once duzeltilmeli; sonra karar hesaplanamaz).
   */
  async function meetingWarnings(ctx: AssemblyContext, a: Assembly, meta?: Pick<RollMeta, 'missingLandShare' | 'denominator'>): Promise<string[]> {
    const out: string[] = [];
    if (a.secondMeeting && a.firstMeetingId) {
      const first = await repo.get(ctx.apartmentId, a.firstMeetingId);
      const plan = first?.apartmentId === ctx.apartmentId ? first.secondMeetingPlan : undefined;
      if (!plan) out.push('İlk toplantının çağrısında ikinci toplantının yeri ve zamanı kayıtlı değil; KMK m.29/3 uyarınca ilk çağrıda bildirilmiş olmalıdır.');
      else {
        const diff = [
          formatDateTime(plan.scheduledAt) !== formatDateTime(a.scheduledAt) ? `zaman (${formatDateTime(plan.scheduledAt)})` : '',
          (plan.location ?? '') !== (a.location ?? '') || (plan.onlineUrl ?? '') !== (a.onlineUrl ?? '') ? `yer (${[plan.location, plan.onlineUrl].filter(Boolean).join(' · ')})` : '',
        ].filter(Boolean);
        if (diff.length) out.push(`İkinci toplantı, ilk toplantının çağrısında bildirilenden farklı: ${diff.join(', ')} (KMK m.29/3).`);
      }
    }
    const landItems = a.agenda.filter((i) => LAND_RULES.includes(itemRule(i)));
    if (landItems.length && meta && landShareMissing(itemRule(landItems[0] as AgendaItem), meta)) {
      out.push(
        `${meta.missingLandShare || 'Bazı'} bölümün arsa payı girilmemiş: arsa payı çoğunluğu gereken ${landItems.length} gündem maddesi için karar hesaplanamaz.${a.roll ? '' : ' Oy listesi toplantı başlayınca dondurulur; arsa paylarını önce girin.'}`,
      );
    }
    return out;
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
    const plan = o.secondMeetingPlan === undefined ? current?.secondMeetingPlan : o.secondMeetingPlan === null ? undefined : parsePlan(o.secondMeetingPlan);
    if (plan && firstMeetingId) throw new ValidationError('İkinci toplantının çağrısına yeniden ikinci toplantı planı girilemez', 'secondMeetingPlan');
    if (plan) assertSecondMeetingGap(scheduledAt, plan.scheduledAt, 'secondMeetingPlan');
    return {
      kind,
      scheduledAt,
      rollDate: istanbulDate(scheduledAt),
      secondMeeting: Boolean(firstMeetingId),
      ...(firstMeetingId ? { firstMeetingId } : {}),
      agenda,
      ...(location ? { location } : {}),
      ...(onlineUrl ? { onlineUrl } : {}),
      ...(plan ? { secondMeetingPlan: plan } : {}),
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

  /** Toplanti basladi mi? Katilim, yeter sayi, karar ve tutanak yalnizca baslangictan sonra yazilir. */
  function requireStarted(a: Assembly, what: string): void {
    if (stamp() < a.scheduledAt) throw new AssemblyError('conflict', `${what} toplantı başladıktan sonra (${formatDateTime(a.scheduledAt)}) kaydedilir`);
  }

  /**
   * Oy listesi dondurulmamissa toplanti kaydiyla ayni atomik yazimda dondurur (denetimli). Yalnizca
   * toplanti basladiktan sonraki ilk katilim / yeter sayi / karar YAZIMINDA cagrilir; okumalar
   * (ayrinti, hazirun, tutanak) hicbir sey dondurmaz.
   */
  async function ensureRoll(ctx: AssemblyContext, a: Assembly): Promise<Assembly & { roll: RollMeta }> {
    if (a.roll) return a as Assembly & { roll: RollMeta };
    requireStarted(a, 'Oy listesi');
    const now = stamp();
    const snapshot = await liveSnapshot(ctx, a, now);
    const next: Assembly = { ...a, roll: snapshot.meta, updatedAt: now, updatedBy: ctx.userId, version: a.version + 1 };
    try {
      await repo.update(next, a.version, audit(ctx, next, 'assembly.roll_freeze', { rollDate: a.rollDate, units: snapshot.meta.units }), { roll: snapshot.chunks });
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
    const keys = voterKeys(entries, attendance);
    const pkeys = personKeys(entries, attendance);
    return entries.map((r) => {
      const att = attOf.get(r.unitId);
      const voterKey = keys.get(r.unitId);
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
        ...(voterKey ? { voterKey } : {}),
        ...(pkeys.get(r.unitId) ? { personKey: pkeys.get(r.unitId) } : {}),
        warnings: r.warnings,
      };
    });
  }

  const sortDecisions = (ds: AssemblyDecision[]) => {
    const order = (itemId: string) => Number(itemId.replace(/\D/g, '')) || 0;
    return ds.sort((x, y) => order(x.itemId) - order(y.itemId) || x.seq - y.seq);
  };

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

  /** Cagri alicilari: oy listesindeki (dondurulmussa ondan, degilse canli) malikler ∩ bugun apartmanda aktif uyeligi olan kullanicilar. */
  async function callAudience(ctx: AssemblyContext, a: Assembly, entries?: readonly RollEntry[]) {
    const list = entries ?? (a.roll ? await deps.rolls.entries(ctx.apartmentId, 'assembly', a.assemblyId) : (await liveSnapshot(ctx, a, stamp())).entries);
    const day = istanbulDate(stamp());
    const users = new Set((await deps.memberships.list(ctx.apartmentId, {})).filter((m) => m.apartmentId === ctx.apartmentId && activeOn(m, day)).map((m) => m.userId));
    const owners = [...new Set(list.flatMap((e) => e.owners.map((o) => o.userId)))];
    const recipients = owners.filter((u) => users.has(u)).sort();
    return { recipients, ownersWithoutAccount: owners.length - recipients.length };
  }

  /**
   * Cagri zamanlamasi. 15 gun ve imza / taahhutlu mektup kurali KMK m.29/2'de olaganustu toplanti
   * icindir: yalnizca olaganustu toplantida `lateNotice` uyarisi. Olagan toplanti yonetim planindaki
   * zamanda yapilir (m.29/1): yalnizca yumusak hatirlatma. Ikinci toplantinin yeri ve zamani ilk
   * cagrida bildirilir (m.29/3).
   */
  function callTiming(a: Assembly, extra: string[] = []): { daysBefore: number; lateNotice: boolean; warnings: string[] } {
    const daysBefore = dayDiff(istanbulDate(stamp()), a.rollDate);
    const lateNotice = !a.secondMeeting && a.kind === 'extraordinary' && daysBefore < CALL_NOTICE_DAYS;
    const warnings: string[] = [];
    if (lateNotice) {
      warnings.push(`KMK m.29/2: olağanüstü toplantıya çağrı toplantıdan en az ${CALL_NOTICE_DAYS} gün önce yapılır; toplantıya ${daysBefore} gün kaldı. E-posta gönderilebilir, ancak yasal çağrı süresi karşılanmamış olabilir.`);
    } else if (!a.secondMeeting && a.kind === 'ordinary' && daysBefore < CALL_NOTICE_DAYS) {
      warnings.push(`Olağan toplantı yönetim planında belirtilen zamanda yapılır (KMK m.29/1); yönetim planınız bir çağrı süresi öngörüyorsa ona uyulduğunu kontrol edin (toplantıya ${daysBefore} gün kaldı).`);
    }
    if (a.secondMeeting) warnings.push('İkinci toplantının yeri ve zamanı ilk toplantının çağrısında bildirilmiş olmalıdır (KMK m.29/3); bu e-posta hatırlatma niteliğindedir.');
    return { daysBefore, lateNotice, warnings: [...warnings, ...extra] };
  }

  /** Ayrinti: dondurulmussa anlik goruntuden; degilse canli onizleme (`rollFrozen: false`, katilim yok). */
  async function detail(ctx: AssemblyContext, id: string) {
    const a = await requireAssembly(ctx, id);
    const decisions = sortDecisions(await repo.listDecisions(ctx.apartmentId, a.assemblyId)).map(decisionView);
    const last = a.calls?.at(-1);
    const common = { decisions, callOutdated: Boolean(last && last.meetingHash !== meetingHash(a)) };
    if (a.roll) {
      const s = await frozenState(ctx, a as Assembly & { roll: RollMeta });
      return { assembly: view(a), rollFrozen: true, quorum: s.quorum, units: await rows(ctx, s.entries, s.attendance), ...common, warnings: await meetingWarnings(ctx, a, a.roll) };
    }
    const preview = await liveSnapshot(ctx, a, stamp());
    const quorum = assemblyQuorum({ entries: preview.entries, meta: preview.meta, attendance: [], secondMeeting: a.secondMeeting });
    const warnings = await meetingWarnings(ctx, a, preview.meta);
    let callCheck: CallCheck | undefined;
    if (a.status === 'planned' && stamp() < a.scheduledAt) {
      const audience = await callAudience(ctx, a, preview.entries);
      const t = callTiming(a, warnings);
      callCheck = { daysBefore: t.daysBefore, lateNotice: t.lateNotice, recipients: audience.recipients.length, ownersWithoutAccount: audience.ownersWithoutAccount, warnings: t.warnings };
    }
    return { assembly: view(a), rollFrozen: false, quorum, units: await rows(ctx, preview.entries, []), ...common, warnings, ...(callCheck ? { callCheck } : {}) };
  }

  async function update(ctx: AssemblyContext, id: string, body: unknown): Promise<AssemblyView> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await requireAssembly(ctx, id);
    assertVersion(current, version);
    requirePlanned(current);
    if (current.roll) throw new AssemblyError('conflict', 'Oy listesi dondurulduktan sonra toplantı bilgileri ve gündem değiştirilemez');
    const { location: _l, onlineUrl: _u, firstMeetingId: _f, secondMeetingPlan: _p, ...rest } = current;
    const next: Assembly = { ...rest, ...(await meetingFields(ctx, o, current)), updatedAt: stamp(), updatedBy: ctx.userId, version: current.version + 1 };
    return save(next, current.version, audit(ctx, next, 'assembly.update', { ...meetingDetails(next), called: Boolean(current.calls?.length) }));
  }

  async function cancel(ctx: AssemblyContext, id: string, body: unknown): Promise<AssemblyView> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const reason = reqString(o, 'reason', 500, 3);
    const current = await requireAssembly(ctx, id);
    assertVersion(current, version);
    requirePlanned(current);
    if (current.agenda.some((i) => i.tally)) throw new AssemblyError('conflict', 'Karar kaydedilmiş toplantı iptal edilemez; kararlar karar defterinde kalır');
    const now = stamp();
    const next: Assembly = { ...current, status: 'cancelled', cancelledAt: now, cancelReason: reason, updatedAt: now, updatedBy: ctx.userId, version: current.version + 1 };
    return save(next, current.version, audit(ctx, next, 'assembly.cancel', meetingDetails(next), reason));
  }

  // -------------------------------------------------------------------------
  // Cagri (davet) e-postasi
  // -------------------------------------------------------------------------

  /**
   * Cagriyi gonderir: cagri kaydi (alicilar), toplanti ozeti ve `ASSEMBLY_CALLED` outbox olayi tek
   * atomik yazimda. Ilk gonderimden sonra yalnizca `resend: true` + gerekceyle (denetimde
   * `assembly.call_resend`). 15 gun kuralina uyulmamissa uyari doner; gonderim engellenmez.
   */
  async function sendCall(ctx: AssemblyContext, id: string, body: unknown) {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const resend = optBool(o, 'resend') ?? false;
    const a = await requireAssembly(ctx, id);
    assertVersion(a, version);
    requirePlanned(a);
    if (stamp() >= a.scheduledAt) throw new AssemblyError('conflict', 'Toplantı başladıktan sonra çağrı gönderilemez');
    const calls = a.calls ?? [];
    if (calls.length > 0 && !resend) {
      throw new AssemblyError('conflict', `Çağrı ${formatDateTime(calls[0]?.calledAt)} tarihinde gönderildi; yeniden göndermek için gerekçe girerek "yeniden gönder" seçin`);
    }
    if (calls.length === 0 && resend) throw new ValidationError('Çağrı henüz gönderilmedi; yeniden gönderim seçilemez', 'resend');
    if (calls.length >= MAX_CALLS) throw new AssemblyError('unprocessable', `Bir toplantı için en fazla ${MAX_CALLS} çağrı gönderilebilir`);
    const reason = resend ? reqString(o, 'reason', 500, 3) : undefined;

    const audience = await callAudience(ctx, a);
    const t = callTiming(a, await meetingWarnings(ctx, a));
    const now = stamp();
    const seq = calls.length + 1;
    const eventId = `ASSEMBLY_CALLED:${a.assemblyId}:${seq}`;
    const summary: AssemblyCallSummary = {
      seq,
      calledAt: now,
      calledBy: ctx.userId,
      eventId,
      recipients: audience.recipients.length,
      ownersWithoutAccount: audience.ownersWithoutAccount,
      daysBefore: t.daysBefore,
      lateNotice: t.lateNotice,
      resend,
      ...(reason ? { reason } : {}),
      meetingHash: meetingHash(a),
    };
    const call: AssemblyCall = {
      ...assemblyKeys.call(ctx.apartmentId, a.assemblyId, seq),
      entityType: 'ASSEMBLY_CALL',
      apartmentId: ctx.apartmentId,
      assemblyId: a.assemblyId,
      seq,
      recipientUserIds: audience.recipients,
      calledAt: now,
      calledBy: ctx.userId,
    };
    const event = buildEvent(
      {
        eventId,
        type: 'ASSEMBLY_CALLED',
        apartmentId: ctx.apartmentId,
        actorId: ctx.userId,
        payload: {
          assemblyId: a.assemblyId,
          callSeq: seq,
          kind: a.kind,
          secondMeeting: a.secondMeeting,
          scheduledAt: a.scheduledAt,
          ...(a.location ? { location: a.location } : {}),
          ...(a.onlineUrl ? { onlineUrl: a.onlineUrl } : {}),
          agenda: a.agenda.map((i) => i.title),
          ...(a.secondMeetingPlan ? { secondMeetingPlan: a.secondMeetingPlan } : {}),
          resend,
        },
      },
      deps.now,
    );
    const next: Assembly = { ...a, calls: [...calls, summary], updatedAt: now, updatedBy: ctx.userId, version: a.version + 1 };
    const { meetingHash: _h, reason: _r, calledBy: _b, calledAt: _c, ...auditDetails } = summary;
    const saved = await save(next, a.version, audit(ctx, next, resend ? 'assembly.call_resend' : 'assembly.call', { ...auditDetails, scheduledAt: a.scheduledAt }, reason), { call, outbox: [event] });
    const warnings = [...t.warnings, ...(audience.recipients.length === 0 ? ['Oy listesinde e-posta gidecek kat maliki kullanıcısı yok; yasal çağrıyı ayrıca yapın.'] : [])];
    return { assembly: saved, call: summary, warnings };
  }

  // -------------------------------------------------------------------------
  // Katilim, yeter sayi, karar
  // -------------------------------------------------------------------------

  async function setAttendance(ctx: AssemblyContext, id: string, unitId: string, body: unknown) {
    const o = asObject(body);
    assertId(unitId, 'unitId');
    const mode = reqEnum(o, 'mode', ATTENDANCE_MODES);
    const loaded = await requireAssembly(ctx, id);
    requirePlanned(loaded);
    requireStarted(loaded, 'Katılım');
    // Ilk karardan sonra katilim donar: kararlarin ve tutanagin dayandigi oy / yeter sayi degismez.
    if (loaded.attendanceLockedAt || loaded.agenda.some((i) => i.tally)) {
      throw new AssemblyError('conflict', 'Karar kaydedildikten sonra katılım değiştirilemez; karar ve tutanak bu katılıma dayanır');
    }
    const a = await ensureRoll(ctx, loaded);
    const entry = await deps.rolls.entry(ctx.apartmentId, 'assembly', a.assemblyId, a.roll, unitId);
    if (!entry) throw new AssemblyError('not_found', 'Bölüm dondurulmuş oy listesinde yok');

    let attendee: AssemblyAttendance['attendee'];
    let proxy: ProxyRef | undefined;
    // Hisseli bolum: asaleten de vekaleten de paydaslarin temsilcisi (kisi) zorunlu; oy KMK m.31
    // siniri icin o kisiye yazilir (temsilcisiz sayilan bolumle sinirdan kacilamaz).
    const coOwned = entry.owners.length > 1;
    if (mode !== 'absent' && (coOwned || (o.attendeeUserId !== undefined && o.attendeeUserId !== null))) {
      if (coOwned && (o.attendeeUserId === undefined || o.attendeeUserId === null)) {
        throw new ValidationError('Hisseli bölümde paydaşların temsilcisini (bölümün oyunu kullanan paydaş) seçin', 'attendeeUserId');
      }
      const userId = reqString(o, 'attendeeUserId', 64);
      if (!entry.owners.some((x) => x.userId === userId)) throw new ValidationError('Temsilci bu bölümün malikleri arasında değil', 'attendeeUserId');
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

  const toRecord = (ctx: AssemblyContext, q: Quorum, noAttendance = false): QuorumRecord => ({
    met: q.met,
    presentUnits: q.presentUnits,
    totalUnits: q.totalUnits,
    presentOwners: q.presentOwners,
    totalOwners: q.totalOwners,
    presentVotes: q.presentVotes,
    totalVotes: q.totalVotes,
    noAttendance,
    ownersMajority: q.ownersMajority,
    landShareMajority: q.landShareMajority,
    landShareComputable: q.landShareComputable,
    // Tutanak yalnizca bu anlik goruntuden yazilir (canli katilimla karismaz).
    proxyUnits: q.proxyUnits,
    presentLandShare: q.presentLandShare,
    totalLandShare: q.totalLandShare,
    landShareBps: q.landShareBps,
    recordedAt: stamp(),
    recordedBy: ctx.userId,
  });

  /**
   * Toplanti yeter sayisini tutanaga gecirir (saglanamadiysa ikinci toplantinin dayanagi). Yalnizca
   * toplanti basladiktan sonra. "Saglanmadi" sonucu icin katilim girilmis olmali; hic kimse
   * gelmediyse `noAttendance: true` ile ve katilim kaydi olmadan acikca belirtilir.
   */
  async function recordQuorum(ctx: AssemblyContext, id: string, body: unknown): Promise<{ assembly: AssemblyView; quorum: Quorum }> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const noAttendance = optBool(o, 'noAttendance') ?? false;
    const loaded = await requireAssembly(ctx, id);
    assertVersion(loaded, version);
    requirePlanned(loaded);
    requireStarted(loaded, 'Yeter sayı');
    if (loaded.agenda.some((i) => i.tally)) throw new AssemblyError('conflict', 'Sayım kaydedilmiş toplantının yeter sayısı yeniden kaydedilemez');
    const a = await ensureRoll(ctx, loaded);
    const { quorum, attendance } = await frozenState(ctx, a);
    const recorded = attendance.length;
    if (noAttendance && quorum.presentUnits > 0) throw new ValidationError('Katılım kaydı varken "kimse gelmedi" seçilemez', 'noAttendance');
    if (!quorum.met && recorded === 0 && !noAttendance) {
      throw new AssemblyError('unprocessable', 'Yeter sayısızlığı tutanağa geçirmek için önce katılımı girin; kimse gelmediyse "kimse gelmedi" seçeneğiyle kaydedin');
    }
    const record = toRecord(ctx, quorum, noAttendance);
    const next: Assembly = { ...a, quorumRecord: record, updatedAt: record.recordedAt, updatedBy: ctx.userId, version: a.version + 1 };
    const saved = await save(next, a.version, audit(ctx, next, 'assembly.quorum', { ...record, recordedAt: undefined, recordedBy: undefined, reasons: quorum.reasons }));
    return { assembly: saved, quorum };
  }

  /** `votes`: `{ unitId: yes|no|abstain }` (yalnizca katilan bolumler; girilmeyen "oy kullanmadi"). */
  function parseUnitVotes(raw: unknown, max: number): Map<string, VoteChoice> {
    const o = asObject(raw, 'votes');
    const keys = Object.keys(o);
    if (keys.length > max) throw new ValidationError('Oy listesindeki bölüm sayısından fazla oy girilemez', 'votes');
    const out = new Map<string, VoteChoice>();
    for (const unitId of keys) {
      assertId(unitId, 'votes');
      const v = o[unitId];
      if (typeof v !== 'string' || !(VOTE_CHOICES as readonly string[]).includes(v)) throw new ValidationError('Oy kabul (yes), ret (no) veya çekimser (abstain) olmalıdır', 'votes');
      out.set(unitId, v as VoteChoice);
    }
    return out;
  }

  /**
   * Gundem maddesinin karari. Ilk kayit yalnizca toplanti `planned` iken; madde icin karar varsa
   * yalnizca `correctionReason` ile DUZELTME (yeni degismez kayit, toplanti `held` olsa da). Nitelikli
   * cogunluklarda bolum bazinda oy (`votes`) zorunlu; `attendees` kuralinda oy sayilari da kabul edilir.
   */
  async function recordTally(ctx: AssemblyContext, id: string, itemId: string, body: unknown) {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const loaded = await requireAssembly(ctx, id);
    assertVersion(loaded, version);
    if (loaded.status === 'cancelled') throw new AssemblyError('conflict', 'İptal edilen toplantı değiştirilemez');
    const item = loaded.agenda.find((i) => i.itemId === itemId);
    if (!item) throw new AssemblyError('not_found', 'Gündem maddesi bulunamadı');
    const correction = Boolean(item.tally);
    if (correction && (o.correctionReason === undefined || o.correctionReason === null)) {
      throw new AssemblyError('conflict', 'Bu maddenin kararı kaydedildi ve değiştirilemez; düzeltme gerekçesiyle yeni kayıt olarak eklenir');
    }
    const correctionReason = correction ? reqString(o, 'correctionReason', 500, 3) : undefined;
    if (!correction && o.correctionReason !== undefined) throw new ValidationError('Düzeltme gerekçesi yalnızca kaydedilmiş karar için girilir', 'correctionReason');
    if (!correction && loaded.status !== 'planned') throw new AssemblyError('conflict', 'Tutanağı kesinleşmiş toplantıya yeni karar eklenemez');
    requireStarted(loaded, 'Karar');
    if (loaded.quorumRecord?.met === false) {
      throw new AssemblyError('conflict', 'Bu toplantıda yeter sayının sağlanamadığı tutanağa geçti; karar için ikinci toplantı oluşturun');
    }
    const a = await ensureRoll(ctx, loaded);
    const { quorum, entries, attendance } = await frozenState(ctx, a);
    if (!quorum.met) {
      throw new AssemblyError('unprocessable', `Toplantı yeter sayısı sağlanmadı: ${quorum.reasons.join('; ')}. İkinci toplantıda yeter sayı aranmaz.`);
    }
    const rule = itemRule(item);
    // Arsa payi eksikse arsa payi gereken karar hesaplanamaz: ret olarak yazilmaz (kalici yanlis kayit olurdu).
    const missing = landShareMissing(rule, a.roll);
    if (missing) throw new AssemblyError('unprocessable', `${missing}; karar kaydedilmedi. Arsa payı oy listesi dondurulduğu andaki kayıtlardan alınır.`);
    let outcome: DecisionOutcome;
    let unitVotes: Record<string, VoteChoice> | undefined;
    if (o.votes !== undefined) {
      const votes = parseUnitVotes(o.votes, entries.length);
      const issue = unitVotesIssue(entries, attendance, votes, rule);
      if (issue) throw new ValidationError(issue, 'votes');
      outcome = decideByUnits({ rule, entries, meta: a.roll, attendance, votes });
      unitVotes = Object.fromEntries([...votes.entries()].sort(([x], [y]) => x.localeCompare(y)));
    } else {
      if (QUALIFIED_RULES.includes(rule)) throw new ValidationError(`${MAJORITY_LABELS[rule]} için bölüm bazında oy girin (votes)`, 'votes');
      const yes = reqInt(o, 'yes', 0, 100_000);
      const no = reqInt(o, 'no', 0, 100_000);
      const abstain = reqInt(o, 'abstain', 0, 100_000);
      if (yes + no + abstain > quorum.presentVotes) {
        throw new ValidationError(`Kabul + ret + çekimser toplamı katılan oy sayısını (${quorum.presentVotes}) aşamaz`, 'yes');
      }
      outcome = decideByCounts({ entries, meta: a.roll, attendance, yes, no, abstain });
    }

    const now = stamp();
    // Y1 (bu daldan once) sayimi: `seq` yok ve ASMDEC# kaydi yok. Duzeltme ilk degismez kayittir (sira 1);
    // eski sayim kaydin icinde `legacyTally` olarak korunur.
    const prevSeq = item.tally?.seq;
    const legacy = correction && prevSeq === undefined ? item.tally : undefined;
    const seq = (prevSeq ?? 0) + 1;
    const decision: AssemblyDecision = {
      ...assemblyKeys.decision(ctx.apartmentId, a.assemblyId, item.itemId, seq),
      entityType: 'ASSEMBLY_DECISION',
      apartmentId: ctx.apartmentId,
      assemblyId: a.assemblyId,
      itemId: item.itemId,
      seq,
      meetingAt: a.scheduledAt,
      meetingKind: a.kind,
      secondMeeting: a.secondMeeting,
      itemTitle: item.title,
      decisionKind: itemKind(item),
      outcome,
      ...(unitVotes ? { unitVotes } : {}),
      ...(correction ? { correctionReason } : {}),
      ...(correction && prevSeq !== undefined ? { supersedes: prevSeq } : {}),
      ...(legacy ? { legacyTally: legacy } : {}),
      recordedAt: now,
      recordedBy: ctx.userId,
    };
    const tally: AgendaTally = {
      yes: outcome.votes.yes,
      no: outcome.votes.no,
      abstain: outcome.votes.abstain,
      presentVotes: outcome.presentVotes,
      decision: outcome.decision,
      recordedAt: now,
      recordedBy: ctx.userId,
      rule,
      mode: outcome.mode,
      seq,
    };
    const next: Assembly = {
      ...a,
      ...(a.quorumRecord ? {} : { quorumRecord: toRecord(ctx, quorum) }),
      attendanceLockedAt: a.attendanceLockedAt ?? now,
      agenda: a.agenda.map((i) => (i.itemId === itemId ? { ...i, tally } : i)),
      updatedAt: now,
      updatedBy: ctx.userId,
      version: a.version + 1,
    };
    const details = {
      itemId,
      seq,
      rule,
      mode: outcome.mode,
      decision: outcome.decision,
      yes: outcome.votes.yes,
      no: outcome.votes.no,
      abstain: outcome.votes.abstain,
      presentVotes: outcome.presentVotes,
      allVotes: outcome.allVotes,
      ...(outcome.units ? { units: outcome.units } : {}),
      ...(unitVotes ? { votesHash: sha256(unitVotes) } : {}),
      corrected: correction,
      ...(decision.supersedes ? { supersedes: decision.supersedes } : {}),
      ...(legacy ? { correctsLegacyTally: true } : {}),
    };
    const saved = await save(next, a.version, audit(ctx, next, correction ? 'assembly.tally_correction' : 'assembly.tally', details, correctionReason), { decision });
    return { assembly: saved, quorum, decision: decisionView(decision) };
  }

  // -------------------------------------------------------------------------
  // Tutanak: divan, notlar, kesinlestirme
  // -------------------------------------------------------------------------

  function names(raw: unknown, field: string, max: number): string[] {
    if (!Array.isArray(raw) || raw.length > max) throw new ValidationError(`En fazla ${max} ad girilebilir`, field);
    return raw.map((v) => {
      const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
      if (s.length < 2 || s.length > 150) throw new ValidationError('Ad 2-150 karakter olmalıdır', field);
      return s;
    });
  }

  /** Divan (baskan, yazman, oy toplayici; yonetici adlari girer) ve gorusme notlari. Kesinlestirmeden once. */
  async function saveMinutes(ctx: AssemblyContext, id: string, body: unknown): Promise<AssemblyView> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const a = await requireAssembly(ctx, id);
    assertVersion(a, version);
    requirePlanned(a);
    requireStarted(a, 'Tutanak');
    const cur = a.minutes;
    const chair = o.chair === undefined ? cur?.chair : o.chair === null || o.chair === '' ? undefined : names([o.chair], 'chair', 1)[0];
    const clerks = o.clerks === undefined ? (cur?.clerks ?? []) : names(o.clerks, 'clerks', 3);
    const voteCounters = o.voteCounters === undefined ? (cur?.voteCounters ?? []) : names(o.voteCounters, 'voteCounters', 3);
    let notes = cur?.notes ?? {};
    if (o.notes !== undefined) {
      const n = asObject(o.notes, 'notes');
      notes = {};
      for (const [itemId, text] of Object.entries(n)) {
        if (!a.agenda.some((i) => i.itemId === itemId)) throw new ValidationError('Bilinmeyen gündem maddesi', 'notes');
        if (typeof text !== 'string' || text.length > NOTE_MAX) throw new ValidationError(`Görüşme notu en fazla ${NOTE_MAX} karakter olabilir`, 'notes');
        if (text.trim()) notes[itemId] = text.trim();
      }
    }
    // Bos metin / null notu temizler (web bos alani '' olarak gonderir).
    const rawGeneral = o.generalNotes;
    if (rawGeneral !== undefined && rawGeneral !== null && typeof rawGeneral !== 'string') throw new ValidationError('generalNotes metin olmalıdır', 'generalNotes');
    if (typeof rawGeneral === 'string' && rawGeneral.length > NOTE_MAX) throw new ValidationError(`Not en fazla ${NOTE_MAX} karakter olabilir`, 'generalNotes');
    const generalNotes = rawGeneral === undefined ? cur?.generalNotes : typeof rawGeneral === 'string' && rawGeneral.trim() ? rawGeneral.trim() : undefined;
    const minutes: AssemblyMinutes = {
      ...(chair ? { chair } : {}),
      clerks,
      voteCounters,
      notes,
      ...(generalNotes ? { generalNotes } : {}),
      updatedAt: stamp(),
      updatedBy: ctx.userId,
    };
    const next: Assembly = { ...a, minutes, updatedAt: minutes.updatedAt, updatedBy: ctx.userId, version: a.version + 1 };
    // Adlar ve notlar denetim ayrintisina yazilmaz (kisisel veri / serbest metin); yalnizca sayilar.
    return save(
      next,
      a.version,
      audit(ctx, next, 'assembly.minutes', { chair: Boolean(chair), clerks: clerks.length, voteCounters: voteCounters.length, itemNotes: Object.keys(notes).length, generalNotes: Boolean(generalNotes) }),
    );
  }

  /**
   * Tutanagi kesinlestirir (`held`): sonra katilim, yeter sayi, tutanak ve yeni karar yazilamaz;
   * karar duzeltmesi yeni kayitla mumkundur. Sakin portalinda kararlar ve tutanak bu andan sonra.
   */
  async function finalize(ctx: AssemblyContext, id: string, body: unknown) {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const a = await requireAssembly(ctx, id);
    assertVersion(a, version);
    requirePlanned(a);
    requireStarted(a, 'Tutanak');
    if (!a.quorumRecord) throw new AssemblyError('unprocessable', 'Önce toplantı yeter sayısını tutanağa geçirin');
    // Kimse gelmediyse (ikinci toplantida da) divan kurulamaz: baskan / yazman aranmaz.
    const decided = (a.quorumRecord.met || a.secondMeeting) && !a.quorumRecord.noAttendance;
    if (decided && !a.minutes?.chair) throw new AssemblyError('unprocessable', 'Tutanak için toplantı başkanını girin');
    if (decided && !a.minutes?.clerks.length) throw new AssemblyError('unprocessable', 'Tutanak için en az bir yazman girin');
    const pending = decided ? a.agenda.filter((i) => !i.tally).length : 0;
    const now = stamp();
    const next: Assembly = { ...a, status: 'held', heldAt: now, heldBy: ctx.userId, updatedAt: now, updatedBy: ctx.userId, version: a.version + 1 };
    const saved = await save(
      next,
      a.version,
      audit(ctx, next, 'assembly.finalize', { quorumMet: a.quorumRecord.met, decisions: a.agenda.filter((i) => i.tally).length, itemsWithoutDecision: pending }),
    );
    return { assembly: saved, warnings: pending ? [`${pending} gündem maddesi için karar kaydı yok; tutanakta "karar kaydı yok" olarak yer alır`] : [] };
  }

  // -------------------------------------------------------------------------
  // PDF'ler: hazirun cetveli, tutanak, karar defteri
  // -------------------------------------------------------------------------

  function requireStore(): DocumentStore {
    if (!deps.store) throw new DocumentError('unavailable', 'Belge deposu yapılandırılmamış (DOCUMENTS_BUCKET)');
    return deps.store;
  }

  async function signed(store: DocumentStore, key: string, fileName: string) {
    const url = await store.presignGet(key, { contentDisposition: contentDisposition(fileName, 'inline'), contentType: 'application/pdf', expiresIn: URL_TTL_SECONDS });
    return { url, fileName, contentType: 'application/pdf', expiresAt: new Date(deps.now().getTime() + URL_TTL_SECONDS * 1000).toISOString() };
  }

  /** Veri ozetiyle onbellek: ayni icerik ayni anahtar, yalnizca yoksa uretilir. */
  async function cachedPdf(store: DocumentStore, key: (hash: string) => string, content: ReportContent) {
    const dataHash = sha256({ v: REPORT_TEMPLATE_VERSION, t: 1, content });
    const k = key(dataHash);
    if (!(await store.head(k))) await store.put(k, await renderReportPdf({ ...content, generatedAt: stamp(), dataHash }), 'application/pdf');
    return k;
  }

  /**
   * Hazirun cetveli: okuma, HICBIR SEY dondurmaz (denetci de cagirabilir). Oy listesi dondurulmussa
   * anlik goruntuden; degilse (toplanti oncesi veya henuz katilim yokken) canli listeden "ön izleme".
   */
  async function attendanceSheet(ctx: AssemblyContext, id: string) {
    const store = requireStore();
    const a = await requireAssembly(ctx, id);
    const preview = !a.roll;
    const s = a.roll
      ? await frozenState(ctx, a as Assembly & { roll: RollMeta })
      : await (async () => {
          const live = await liveSnapshot(ctx, a, stamp());
          return { entries: live.entries, attendance: [] as AssemblyAttendance[], quorum: assemblyQuorum({ entries: live.entries, meta: live.meta, attendance: [], secondMeeting: a.secondMeeting }) };
        })();
    const [site, blocks] = await Promise.all([deps.core.getSite(ctx.apartmentId), deps.core.listBlocks(ctx.apartmentId)]);
    const blockName = new Map(blocks.map((b) => [b.blockId, b.name]));
    const multiBlock = new Set(s.entries.map((r) => r.blockId)).size > 1;
    const units = await rows(ctx, s.entries, s.attendance);
    const apartmentName = site?.name ?? 'Apartman';
    const q = s.quorum;
    const place = [a.location, a.onlineUrl ? `Çevrim içi: ${a.onlineUrl}` : undefined].filter(Boolean).join(' · ');
    const modeText = { present: 'Asaleten', proxy: 'Vekaleten', absent: '' } as const;
    const sheet = {
      title: preview ? 'Hazirun Cetveli (ön izleme)' : 'Hazirun Cetveli',
      subtitle: `${preview ? 'ÖN İZLEME - oy listesi henüz dondurulmadı · ' : ''}${KIND_LABELS[a.kind]} Kat Malikleri Kurulu${a.secondMeeting ? ' (ikinci toplantı)' : ''} · ${formatDateTime(a.scheduledAt)} · ${place} · Oy listesi: ${formatDate(a.rollDate)}`,
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
              cells: ['', `${q.totalUnits} bölüm`, `${q.totalOwners} kat maliki`, q.totalLandShare ? shareText(q.totalLandShare) : '—', `${q.presentOwners} malik / ${q.presentUnits} bölüm`, `${q.proxyUnits} vekaleten`, ''],
            },
          ],
        },
      ],
      notes: [
        'Toplantı yeter sayısı (KMK m.30): kat maliklerinin sayıca (ayrı kişiler; hisseli bölüm temsilcisiyle bir kez) ve toplam arsa payının yarısından fazlası; ikinci toplantıda aranmaz. Karar: gündem maddesinin gerekli çoğunluğu.',
        `Oy (KMK m.31): her bağımsız bölüm bir oy (bütün oylar ${q.totalVotes}); birden fazla bölümün oyunu kullanan kişinin oyu en fazla ${q.voteCap}. Vekil bütün oyların %5'inden fazlasını, 40 ve daha az bölümde ikiden fazla kat malikini temsil edemez.`,
        preview
          ? 'Ön izleme: katılım ve yeter sayı toplantıda girilir; oy listesi toplantı başladıktan sonraki ilk katılım kaydıyla dondurulur.'
          : `Kayıtlı katılım: ${q.presentOwners}/${q.totalOwners} kat maliki · ${q.presentVotes} oy${q.presentLandShare ? ` · arsa payı ${shareText(q.presentLandShare)}` : ''} · yeter sayı ${q.met ? 'sağlandı' : 'sağlanmadı'}${q.reasons.length ? ` (${q.reasons.join('; ')})` : ''}.`,
        ...q.warnings,
        'Toplantı Başkanı: ..............................   Yazman: ..............................   Oy Toplayıcı: ..............................',
      ],
    };
    const dataHash = createHash('sha256').update(JSON.stringify({ v: 3, preview, apartmentName, assembly: view(a), sheet })).digest('hex');
    const key = assemblySheetKey(ctx.apartmentId, a.rollDate, a.assemblyId, dataHash);
    if (!(await store.head(key))) {
      await store.put(key, await renderReportPdf({ ...sheet, apartmentName, generatedAt: stamp(), dataHash }), 'application/pdf');
    }
    const fileName = preview ? `hazirun-cetveli-${a.rollDate}-on-izleme.pdf` : `hazirun-cetveli-${a.rollDate}.pdf`;
    return { ...(await signed(store, key, fileName)), preview };
  }

  /** Tutanak PDF'i (okuma; hicbir sey dondurmaz). Kesinlesmemis toplantida "taslak". */
  async function minutesFile(ctx: AssemblyContext, a: Assembly) {
    const store = requireStore();
    if (!a.roll) throw new AssemblyError('conflict', 'Tutanak, toplantı başlayıp oy listesi dondurulduktan sonra (ilk katılım veya yeter sayı kaydı) hazırlanır');
    const [s, decisions, site] = await Promise.all([frozenState(ctx, a as Assembly & { roll: RollMeta }), repo.listDecisions(ctx.apartmentId, a.assemblyId), deps.core.getSite(ctx.apartmentId)]);
    const preview = a.status !== 'held';
    const content = minutesReport({ apartmentName: site?.name ?? 'Apartman', assembly: view(a), quorum: s.quorum, decisions: sortDecisions(decisions), preview });
    const key = await cachedPdf(store, (h) => assemblyMinutesKey(ctx.apartmentId, a.rollDate, a.assemblyId, h), content);
    return { ...(await signed(store, key, `toplanti-tutanagi-${a.rollDate}${preview ? '-taslak' : ''}.pdf`)), preview };
  }

  async function minutesPdf(ctx: AssemblyContext, id: string) {
    return minutesFile(ctx, await requireAssembly(ctx, id));
  }

  /** Karar defteri: apartmanin tum kararlari (duzeltmeler dahil), toplanti tarihi sirasiyla. */
  async function decisionBook(ctx: AssemblyContext) {
    const store = requireStore();
    const [assemblies, decisions, site] = await Promise.all([repo.list(ctx.apartmentId), repo.listDecisions(ctx.apartmentId), deps.core.getSite(ctx.apartmentId)]);
    const own = assemblies.filter((a) => a.apartmentId === ctx.apartmentId);
    const content = decisionBookReport({ apartmentName: site?.name ?? 'Apartman', assemblies: own.map(view), decisions: decisions.filter((d) => d.apartmentId === ctx.apartmentId) });
    const dates = own.filter((a) => decisions.some((d) => d.assemblyId === a.assemblyId)).map((a) => a.rollDate).sort();
    const asOf = dates.at(-1) ?? istanbulDate(stamp());
    const key = await cachedPdf(store, (h) => assemblyDecisionBookKey(ctx.apartmentId, asOf, h), content);
    return signed(store, key, `karar-defteri-${istanbulDate(stamp())}.pdf`);
  }

  // -------------------------------------------------------------------------
  // Sakin portali (yalnizca kat maliki sakinler)
  // -------------------------------------------------------------------------

  /** Rol `resident` ve bugun apartmanda aktif MALIK uyeligi. Kiraci ve diger roller 403. */
  async function requireOwner(ctx: AssemblyPortalContext): Promise<void> {
    if (ctx.role !== 'resident') throw new AssemblyError('forbidden', 'Sakin portalı yalnızca daire sakinlerine açıktır');
    const day = istanbulDate(stamp());
    const mine = (await deps.memberships.list(ctx.apartmentId, {})).filter((m) => m.apartmentId === ctx.apartmentId && m.userId === ctx.userId && activeOn(m, day));
    if (!mine.some((m) => m.relation === 'owner')) throw new AssemblyError('forbidden', 'Genel kurul bilgileri yalnızca kat maliklerine açıktır');
  }

  /** Sakin gorur: cagrisi gonderilmis toplanti (iptal edilmis olsa da) veya tutanagi kesinlesmis toplanti. */
  const portalVisible = (a: Assembly) => a.status === 'held' || (a.calls?.length ?? 0) > 0;

  function portalDecision(t: AgendaTally, record?: AssemblyDecision): PortalDecision {
    const o = record?.outcome;
    return {
      decision: t.decision,
      rule: t.rule ?? 'attendees',
      votes: { yes: t.yes, no: t.no, abstain: t.abstain },
      units: o?.units ? { yes: o.units.yes, no: o.units.no, abstain: o.units.abstain } : null,
      persons: o?.persons ? { yes: o.persons.yes, no: o.persons.no, abstain: o.persons.abstain, total: o.persons.total } : null,
      landShareBps: o?.landShareBps ?? null,
      corrected: (t.seq ?? 1) > 1 || Boolean(record?.correctionReason),
      recordedAt: t.recordedAt,
    };
  }

  function portalView(a: Assembly, decisions: readonly AssemblyDecision[] = []): PortalAssemblyView {
    const calls = a.calls ?? [];
    const held = a.status === 'held';
    const phase: PortalAssemblyView['phase'] = a.status === 'cancelled' ? 'cancelled' : held ? 'held' : stamp() < a.scheduledAt ? 'upcoming' : 'awaiting_minutes';
    const recordOf = (itemId: string, seq?: number) => decisions.find((d) => d.itemId === itemId && d.seq === (seq ?? 1));
    const q = a.quorumRecord;
    return {
      assemblyId: a.assemblyId,
      kind: a.kind,
      secondMeeting: a.secondMeeting,
      scheduledAt: a.scheduledAt,
      ...(a.location ? { location: a.location } : {}),
      ...(a.onlineUrl ? { onlineUrl: a.onlineUrl } : {}),
      rollDate: a.rollDate,
      status: a.status,
      phase,
      ...(a.status === 'cancelled' && a.cancelReason ? { cancelReason: a.cancelReason } : {}),
      ...(calls[0] ? { calledAt: calls[0].calledAt, lastCalledAt: calls[calls.length - 1]?.calledAt } : {}),
      ...(a.secondMeetingPlan ? { secondMeetingPlan: a.secondMeetingPlan } : {}),
      ...(held && a.heldAt ? { heldAt: a.heldAt } : {}),
      agenda: a.agenda.map((i) => ({
        itemId: i.itemId,
        title: i.title,
        ...(i.description ? { description: i.description } : {}),
        decisionKind: itemKind(i),
        majority: itemRule(i),
        ...(held && i.tally ? { decision: portalDecision(i.tally, recordOf(i.itemId, i.tally.seq)) } : {}),
      })),
      ...(held && q
        ? { quorum: { met: q.met, secondMeeting: a.secondMeeting, noAttendance: q.noAttendance, presentOwners: q.presentOwners, totalOwners: q.totalOwners, presentVotes: q.presentVotes, totalVotes: q.totalVotes } }
        : {}),
      minutesAvailable: held && Boolean(a.roll),
    };
  }

  async function portalList(ctx: AssemblyPortalContext): Promise<{ items: PortalAssemblyView[] }> {
    await requireOwner(ctx);
    const now = stamp();
    const items = (await repo.list(ctx.apartmentId)).filter((a) => a.apartmentId === ctx.apartmentId && portalVisible(a));
    // Yaklasan toplantilar once (en yakin), sonra gecmis toplantilar (en yeni once).
    const upcoming = (a: Assembly) => a.status === 'planned' && now < a.scheduledAt;
    items.sort((x, y) => Number(upcoming(y)) - Number(upcoming(x)) || (upcoming(x) ? x.scheduledAt.localeCompare(y.scheduledAt) : y.scheduledAt.localeCompare(x.scheduledAt)));
    return { items: items.map((a) => portalView(a)) };
  }

  async function portalAssembly(ctx: AssemblyPortalContext, id: string): Promise<Assembly> {
    await requireOwner(ctx);
    const a = await requireAssembly(ctx, id);
    if (!portalVisible(a)) throw new AssemblyError('not_found', 'Genel kurul kaydı bulunamadı');
    return a;
  }

  async function portalDetail(ctx: AssemblyPortalContext, id: string): Promise<PortalAssemblyView> {
    const a = await portalAssembly(ctx, id);
    return portalView(a, a.status === 'held' ? await repo.listDecisions(ctx.apartmentId, a.assemblyId) : []);
  }

  /** Kesinlesmis tutanak PDF'i (5 dk imzali link). */
  async function portalMinutes(ctx: AssemblyPortalContext, id: string) {
    const a = await portalAssembly(ctx, id);
    if (a.status !== 'held') throw new AssemblyError('conflict', 'Toplantı tutanağı henüz kesinleşmedi');
    const { preview: _p, ...file } = await minutesFile(ctx, a);
    return file;
  }

  return {
    create,
    list,
    detail,
    update,
    cancel,
    sendCall,
    setAttendance,
    recordQuorum,
    recordTally,
    saveMinutes,
    finalize,
    attendanceSheet,
    minutesPdf,
    decisionBook,
    portalList,
    portalDetail,
    portalMinutes,
  };
}

export type AssemblyService = ReturnType<typeof createAssemblyService>;
