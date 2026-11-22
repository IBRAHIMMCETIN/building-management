/**
 * Finans 2.1 - Hisseli mulkiyet ve mulk/hisse devri (plan: claude/finans-2-1-hisseli-mulkiyet-plani.md).
 *
 * Sorumluluklar:
 *  - Mulkiyet sicili: tam pay tablolari (toplam tam 1), ilk sicil gecisi (uyeliklerden), elle duzeltme.
 *  - Faturalama modu: `joint` (tek ortak malik carisi) / `split` (paydas alt carileri).
 *  - Temsilci ve oy listesi hazirligi.
 *  - Mulk/hisse devri (tam satis, kismi hisse, miras): onizleme + TEK atomik yazim (sicil, sicil
 *    basi, uyelikler, gerekirse cari kapama, devir kaydi, denetim, idempotency) ve geri alma.
 *
 * Cari kurallari (onayli kararlar):
 *  - joint + tum maliklerin cikisi (tam satis): ortak malik carisi kapanir; borc ayrilan malik
 *    carisine (varsayilan) veya ayni cariye yeni malik adina (`new_owner`).
 *  - joint + kismi devir / bazi paydaslarin cikisi: cari degismez (paydaslar birlikte sorumlu).
 *  - split + paydasin tam cikisi: yalnizca onun alt carisi kapanir (ayrilan carisi / devralanin
 *    alt carisi). Avans her zaman ayrilan carisine.
 *  - split + kismi devir: devredenin gecmis borcu kendisinde kalir; gelecek tahakkuklar yeni
 *    paylarla bolunur.
 */
import { createHash, randomUUID } from 'node:crypto';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { type IsoDate, type IsoDateTime, type LiableParty, type Unit, toKurus } from '../core/types.js';
import { ValidationError, asObject, assertId, isIsoDate, optString, reqEnum, reqString } from '../core/validation.js';
import { type CariClosure, type ClosureRepository, closureKeys, closureRepository, planClosure, reversibleTransactions } from '../finance/closures.js';
import { type FinanceRepository, LedgerConflictError, type ReplaceRecord, financeKeys, financeRepository } from '../finance/repository.js';
import { DEFAULT_LATE_FEE_BASIS_POINTS, FinanceError, type FinanceService, SYSTEM_ACCOUNTS } from '../finance/service.js';
import { openPlanIds } from '../finance/subledger.js';
import {
  type Account,
  type Transaction,
  type TransactionLine,
  coOwnerReceivableId,
  mainReceivableId,
} from '../finance/types.js';
import { type MembershipRepository, membershipGsi1, membershipKeys, membershipRepository } from '../memberships/repository.js';
import { assertNoConflicts } from '../memberships/service.js';
import type { UnitMembership } from '../portal/types.js';
import {
  addDays,
  applyMoves,
  buildVotingRoll,
  deriveFromMemberships,
  diffTables,
  latestRecord,
  effectiveRecord,
  membershipMismatch,
  ownersOn,
  recordOrder,
  tableView,
} from './register.js';
import { type OwnershipRepository, ownershipKeys, ownershipRepository } from './repository.js';
import { MAX_OWNERS, type OwnerShare, assertCompleteTable, compareShares, parseShare, sameTable, sortOwners } from './shares.js';
import {
  OWNER_BILLING_MODES,
  type OwnerBilling,
  type OwnershipHead,
  type OwnershipMembershipChange,
  type OwnershipRecord,
  type OwnershipTransfer,
  type RecordSource,
  type ShareMove,
  TRANSFER_DEBT_TARGETS,
  TRANSFER_KINDS,
  type TransferClosure,
  type TransferDebtTarget,
  type TransferKind,
} from './types.js';

export type OwnershipContext = { apartmentId: string; userId: string };

export type OwnershipServiceDeps = {
  repository: OwnershipRepository;
  financeRepo: FinanceRepository;
  finance: Pick<FinanceService, 'ensureSystemAccounts'>;
  memberships: Pick<MembershipRepository, 'list'>;
  closures: Pick<ClosureRepository, 'get'>;
  core: Pick<CoreRepository, 'getUnit' | 'listUnits'> & Partial<Pick<CoreRepository, 'getSite'>>;
  now: () => Date;
  newId: () => string;
};

/** Tek devirde en fazla kapanacak cari (atomik yazim 100 oge sinirinin altinda kalsin). */
const MAX_TRANSFER_CLOSURES = 4;
const MAX_MOVES = 20;

const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compact = (d: IsoDate) => d.replaceAll('-', '');
const trDate = (d: IsoDate) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

function reqDate(value: unknown, field: string): IsoDate {
  if (typeof value !== 'string' || !isIsoDate(value)) throw new ValidationError(`${field} YYYY-MM-DD olmalidir`, field);
  return value;
}

function reqReason(o: Record<string, unknown>): string {
  const reason = (optString(o, 'reason', 300) ?? '').trim();
  if (reason.length < 5) throw new ValidationError('Gerekce en az 5 karakter olmalidir', 'reason');
  return reason;
}

function reqKey(o: Record<string, unknown>): string {
  const key = reqString(o, 'idempotencyKey', 100);
  if (key.length < 8 || !/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new ValidationError('idempotencyKey 8-100 karakter, yalnizca harf/rakam/-/_ olmalidir', 'idempotencyKey');
  }
  return key;
}

function parseOwners(value: unknown): OwnerShare[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OWNERS) {
    throw new ValidationError(`owners 1-${MAX_OWNERS} ogeli dizi olmalidir`, 'owners');
  }
  const owners = value.map((v, i) => {
    const o = asObject(v, `owners[${i}]`);
    return { userId: assertId(o.userId, `owners[${i}].userId`), share: parseShare(o.share, `owners[${i}].share`) };
  });
  const sorted = sortOwners(owners);
  assertCompleteTable(sorted);
  return sorted;
}

function parseMoves(value: unknown): ShareMove[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MOVES) {
    throw new ValidationError(`moves 1-${MAX_MOVES} ogeli dizi olmalidir`, 'moves');
  }
  return value.map((v, i) => {
    const o = asObject(v, `moves[${i}]`);
    return {
      fromUserId: assertId(o.fromUserId, `moves[${i}].fromUserId`),
      toUserId: assertId(o.toUserId, `moves[${i}].toUserId`),
      share: parseShare(o.share, `moves[${i}].share`),
    };
  });
}

type ParsedTransfer = {
  idempotencyKey: string;
  kind: TransferKind;
  effectiveDate: IsoDate;
  moves: ShareMove[];
  debtTo: TransferDebtTarget;
  /** Devralanlarin dairede oturup oturmayacagi (yeni uyelik icin; varsayilan false). */
  residents: string[];
  reason: string;
};

export function createOwnershipService(overrides: Partial<OwnershipServiceDeps> & Pick<OwnershipServiceDeps, 'finance'>) {
  const deps: OwnershipServiceDeps = {
    repository: ownershipRepository,
    financeRepo: financeRepository,
    memberships: membershipRepository,
    closures: closureRepository,
    core: coreRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.repository;
  const ledger = deps.financeRepo;
  const stamp = (): IsoDateTime => deps.now().toISOString();
  const today = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());
  const shortId = () => deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 12);

  async function requireUnit(ctx: OwnershipContext, unitId: string): Promise<Unit> {
    assertId(unitId, 'unitId');
    const unit = await deps.core.getUnit(ctx.apartmentId, unitId);
    if (!unit) throw new FinanceError('not_found', 'Bagimsiz bolum bulunamadi');
    return unit;
  }

  async function rate(apartmentId: string): Promise<number> {
    const site = deps.core.getSite ? await deps.core.getSite(apartmentId) : undefined;
    return site?.settings.lateFeeMonthlyBasisPoints ?? DEFAULT_LATE_FEE_BASIS_POINTS;
  }

  type UnitState = { unit: Unit; head?: OwnershipHead; records: OwnershipRecord[]; members: UnitMembership[] };

  async function loadState(ctx: OwnershipContext, unitId: string): Promise<UnitState> {
    const unit = await requireUnit(ctx, unitId);
    const [head, records, members] = await Promise.all([
      repo.getHead(ctx.apartmentId, unit.unitId),
      repo.listRecords(ctx.apartmentId, unit.unitId),
      deps.memberships.list(ctx.apartmentId, { unitId: unit.unitId }),
    ]);
    return {
      unit,
      ...(head && head.apartmentId === ctx.apartmentId ? { head } : {}),
      records: records.filter((r) => r.apartmentId === ctx.apartmentId && r.unitId === unit.unitId).sort(recordOrder),
      members: members.filter((m) => m.apartmentId === ctx.apartmentId && m.unitId === unit.unitId),
    };
  }

  function newRecord(
    ctx: OwnershipContext,
    unitId: string,
    p: { seq: number; validFrom: IsoDate; owners: OwnerShare[]; source: RecordSource; reason: string; transferId?: string },
  ): OwnershipRecord {
    return {
      ...ownershipKeys.record(ctx.apartmentId, unitId, p.validFrom, p.seq),
      entityType: 'OWNERSHIP_RECORD',
      apartmentId: ctx.apartmentId,
      unitId,
      seq: p.seq,
      validFrom: p.validFrom,
      owners: sortOwners(p.owners),
      source: p.source,
      ...(p.transferId ? { transferId: p.transferId } : {}),
      reason: p.reason,
      createdAt: stamp(),
      createdBy: ctx.userId,
    };
  }

  /** Sicil basinin yeni hali: ilk kez ise yeni belge, degilse surum kosullu degistirme. */
  function headWrite(
    ctx: OwnershipContext,
    unitId: string,
    prev: OwnershipHead | undefined,
    patch: Pick<OwnershipHead, 'seq' | 'currentValidFrom' | 'billing'> & { representativeUserId?: string | undefined },
  ): { head: OwnershipHead; newDocs: OwnershipHead[]; replace: ReplaceRecord[] } {
    const ts = stamp();
    const { representativeUserId, ...rest } = patch;
    const base: OwnershipHead = prev
      ? { ...prev, updatedAt: ts, updatedBy: ctx.userId, version: prev.version + 1 }
      : {
          ...ownershipKeys.head(ctx.apartmentId, unitId),
          entityType: 'OWNERSHIP_HEAD',
          apartmentId: ctx.apartmentId,
          unitId,
          seq: 0,
          currentValidFrom: rest.currentValidFrom,
          billing: 'joint',
          createdAt: ts,
          createdBy: ctx.userId,
          updatedAt: ts,
          updatedBy: ctx.userId,
          version: 1,
        };
    const { representativeUserId: _old, ...withoutRep } = base;
    const head: OwnershipHead = { ...withoutRep, ...rest, ...(representativeUserId ? { representativeUserId } : {}) };
    return prev
      ? { head, newDocs: [], replace: [{ item: head, expectedVersion: prev.version, label: 'ownership_head' }] }
      : { head, newDocs: [head], replace: [] };
  }

  /** Sicil yoksa uyeliklerden turetilen ilk tablo (tam degilse hata). */
  function initialTable(state: UnitState, day: IsoDate, context: string): { owners: OwnerShare[]; validFrom: IsoDate } {
    const derived = deriveFromMemberships(state.members, state.unit.unitId, day);
    if (derived.status === 'no_owner') {
      throw new FinanceError('unprocessable', `${trDate(day)} tarihinde bu bolumde kayitli malik yok; once malik uyeligini ekleyin`);
    }
    if (derived.status === 'incomplete') {
      throw new FinanceError('unprocessable', `${context}: hisse bilgisi eksik (${derived.reason}). Once sicili duzeltin.`);
    }
    return { owners: derived.owners, validFrom: derived.validFrom };
  }

  function mapWriteError(err: unknown): never {
    if (err instanceof LedgerConflictError) {
      if (err.reason === 'closed') throw new FinanceError('unprocessable', 'Bu cari bu tarihe kadar zaten kapatilmis');
      if (err.reason === 'precondition' || err.reason === 'duplicate') {
        throw new FinanceError('conflict', 'Kayit es zamanli degisti; sayfayi yenileyip tekrar deneyin');
      }
      throw new FinanceError('conflict', 'Es zamanli bir islem cakismasi oldu, tekrar deneyin');
    }
    throw err;
  }

  const viewRecord = (r: OwnershipRecord) => ({
    seq: r.seq,
    validFrom: r.validFrom,
    source: r.source,
    ...(r.transferId ? { transferId: r.transferId } : {}),
    reason: r.reason,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    owners: tableView(r.owners),
  });

  // -------------------------------------------------------------------------
  // Okuma
  // -------------------------------------------------------------------------

  async function getUnitOwnership(ctx: OwnershipContext, unitId: string, q: { date?: string } = {}) {
    const state = await loadState(ctx, unitId);
    const day = q.date ? reqDate(q.date, 'date') : today();
    const rec = effectiveRecord(state.records, state.unit.unitId, day);
    const warnings: string[] = [];
    let current: { source: 'register' | 'memberships'; validFrom?: IsoDate; seq?: number; owners: ReturnType<typeof tableView> } | undefined;
    let incomplete: { owners: { userId: string; share?: OwnerShare['share'] }[]; reason: string } | undefined;
    if (rec) {
      current = { source: 'register', validFrom: rec.validFrom, seq: rec.seq, owners: tableView(rec.owners) };
      const mm = membershipMismatch(rec.owners, state.members, state.unit.unitId, day);
      if (mm.missingMembership.length) warnings.push(`Sicilde olup uyeligi olmayan malik: ${mm.missingMembership.join(', ')}`);
      if (mm.notInRegister.length) warnings.push(`Uyeligi olup sicilde olmayan malik: ${mm.notInRegister.join(', ')}`);
    } else {
      const derived = deriveFromMemberships(state.members, state.unit.unitId, day);
      if (derived.status === 'complete') {
        current = { source: 'memberships', validFrom: derived.validFrom, owners: tableView(derived.owners) };
        if (!state.head) warnings.push('Mulkiyet sicili henuz olusturulmamis (uyeliklerden turetildi)');
      } else if (derived.status === 'incomplete') {
        incomplete = { owners: derived.owners, reason: derived.reason };
        warnings.push(`Hisse bilgisi eksik: ${derived.reason}`);
      } else {
        warnings.push('Bu tarihte kayitli malik yok');
      }
    }
    const owners = current?.owners ?? [];
    const representative = state.head?.representativeUserId;
    if (owners.length > 1 && !(representative && owners.some((o) => o.userId === representative))) warnings.push('temsilci yok');
    return {
      unitId: state.unit.unitId,
      asOf: day,
      registered: Boolean(state.head),
      billing: state.head?.billing ?? ('joint' as OwnerBilling),
      ...(representative ? { representativeUserId: representative } : {}),
      version: state.head?.version ?? 0,
      ...(current ? { current } : {}),
      ...(incomplete ? { incomplete } : {}),
      history: [...state.records].sort((a, b) => recordOrder(b, a)).map(viewRecord),
      warnings,
    };
  }

  /** Hisse tamligi ve sicil tutarliligi sorunlari (aktif bolumler). */
  async function issues(ctx: OwnershipContext) {
    const day = today();
    const [units, heads, records, members] = await Promise.all([
      deps.core.listUnits(ctx.apartmentId),
      repo.listHeads(ctx.apartmentId),
      repo.listRecords(ctx.apartmentId),
      deps.memberships.list(ctx.apartmentId, {}),
    ]);
    const headOf = new Map(heads.filter((h) => h.apartmentId === ctx.apartmentId).map((h) => [h.unitId, h]));
    const mine = members.filter((m) => m.apartmentId === ctx.apartmentId);
    const items: { unitId: string; number: string; blockId: string; code: string; message: string }[] = [];
    for (const u of units.filter((x) => x.status === 'active').sort((a, b) => a.number.localeCompare(b.number, 'tr', { numeric: true }))) {
      const push = (code: string, message: string) => items.push({ unitId: u.unitId, number: u.number, blockId: u.blockId, code, message });
      const head = headOf.get(u.unitId);
      const rec = effectiveRecord(records, u.unitId, day);
      if (head && rec) {
        const mm = membershipMismatch(rec.owners, mine, u.unitId, day);
        if (mm.missingMembership.length || mm.notInRegister.length) {
          push('register_mismatch', 'Mülkiyet sicili ile malik üyelikleri uyuşmuyor; devir veya sicil düzeltmesi gerekli');
        }
        if (rec.owners.length > 1 && !(head.representativeUserId && rec.owners.some((o) => o.userId === head.representativeUserId))) {
          push('no_representative', 'temsilci yok');
        }
        continue;
      }
      const derived = deriveFromMemberships(mine, u.unitId, day);
      if (derived.status === 'no_owner') push('no_owner', 'Kayıtlı malik yok');
      else if (derived.status === 'incomplete') push('incomplete_shares', `Hisse bilgisi eksik: ${derived.reason}`);
      else {
        push('not_registered', 'Mülkiyet sicili oluşturulmamış (otomatik geçişle oluşturulabilir)');
        if (derived.owners.length > 1) push('no_representative', 'temsilci yok');
      }
    }
    return { asOf: day, count: items.length, items };
  }

  // -------------------------------------------------------------------------
  // Ilk sicil gecisi (uyeliklerden)
  // -------------------------------------------------------------------------

  /**
   * Sicili olmayan aktif bolumler icin uyeliklerden ilk sicil kaydi. Hisse bilgisi tam olmayan
   * bolumler atlanir ve nedeniyle raporlanir (engellenmez). Tekrar calistirmak guvenlidir.
   */
  async function backfill(ctx: OwnershipContext) {
    const day = today();
    const [units, heads, members] = await Promise.all([
      deps.core.listUnits(ctx.apartmentId),
      repo.listHeads(ctx.apartmentId),
      deps.memberships.list(ctx.apartmentId, {}),
    ]);
    const registered = new Set(heads.filter((h) => h.apartmentId === ctx.apartmentId).map((h) => h.unitId));
    const mine = members.filter((m) => m.apartmentId === ctx.apartmentId);
    const created: { unitId: string; owners: number; validFrom: IsoDate }[] = [];
    const skipped: { unitId: string; reason: string }[] = [];
    for (const u of units.filter((x) => x.status === 'active').sort((a, b) => a.unitId.localeCompare(b.unitId))) {
      if (registered.has(u.unitId)) continue;
      const derived = deriveFromMemberships(mine, u.unitId, day);
      if (derived.status !== 'complete') {
        skipped.push({ unitId: u.unitId, reason: derived.status === 'no_owner' ? 'Kayıtlı malik yok' : derived.reason });
        continue;
      }
      const record = newRecord(ctx, u.unitId, { seq: 1, validFrom: derived.validFrom, owners: derived.owners, source: 'backfill', reason: 'İlk sicil (üyeliklerden)' });
      const { newDocs } = headWrite(ctx, u.unitId, undefined, { seq: 1, currentValidFrom: derived.validFrom, billing: 'joint' });
      try {
        await ledger.postBatch({
          transactions: [],
          idempotency: { id: `OWNINIT_${u.unitId}`, fingerprint: fingerprint({ op: 'ownership_backfill', unitId: u.unitId }) },
          newDocs: [...newDocs, record],
          audit: {
            apartmentId: ctx.apartmentId,
            action: 'ownership.backfill',
            target: { type: 'unit', id: u.unitId },
            actorId: ctx.userId,
            details: { validFrom: derived.validFrom, owners: derived.owners.length },
          },
        });
        created.push({ unitId: u.unitId, owners: derived.owners.length, validFrom: derived.validFrom });
      } catch (err) {
        // Es zamanli calisma: diger calisma olusturdu.
        if (err instanceof LedgerConflictError && err.reason === 'duplicate') continue;
        throw err;
      }
    }
    return { created, skipped };
  }

  // -------------------------------------------------------------------------
  // Elle sicil duzeltmesi / ilk kayit (eksik hisseli bolumler)
  // -------------------------------------------------------------------------

  /**
   * Pay tablosunu `validFrom` tarihinden itibaren elle yazar (ilk kayit veya duzeltme). Cari
   * hareketi YOKTUR. Tablodaki maliklerin o gun malik uyeligi olmali ve o gun malik olan herkes
   * tabloda yer almali (sicil = uyelikler). Uyeliklerdeki pay alanlari ayni yazimda guncellenir.
   */
  async function setRegister(ctx: OwnershipContext, unitId: string, body: unknown) {
    const o = asObject(body);
    const owners = parseOwners(o.owners);
    const validFrom = reqDate(o.validFrom, 'validFrom');
    const reason = reqReason(o);
    const version = o.version === undefined ? 0 : Number(o.version);
    const state = await loadState(ctx, unitId);
    if ((state.head?.version ?? 0) !== version) throw new FinanceError('conflict', 'Sicil baska bir islemle degisti (surum uyusmazligi)');
    if (state.head && validFrom < state.head.currentValidFrom) {
      throw new ValidationError(`validFrom son sicil kaydindan (${trDate(state.head.currentValidFrom)}) once olamaz`, 'validFrom');
    }
    const day = validFrom;
    const ownerMembers = ownersOn(state.members, state.unit.unitId, day);
    const listed = new Set(owners.map((x) => x.userId));
    const missing = owners.filter((x) => !ownerMembers.some((m) => m.userId === x.userId)).map((x) => x.userId);
    if (missing.length) throw new ValidationError(`Bu tarihte malik uyeligi olmayan kisi: ${missing.join(', ')}`, 'owners');
    const extra = ownerMembers.filter((m) => !listed.has(m.userId)).map((m) => m.userId);
    if (extra.length) throw new ValidationError(`Bu tarihte malik olan herkes tabloda olmali; eksik: ${extra.join(', ')}`, 'owners');
    const last = latestRecord(state.records, state.unit.unitId);
    if (last && sameTable(last.owners, owners)) throw new FinanceError('conflict', 'Pay tablosu degismedi');

    const seq = (state.head?.seq ?? 0) + 1;
    const record = newRecord(ctx, state.unit.unitId, { seq, validFrom, owners, source: state.head ? 'manual' : 'backfill', reason });
    const rep = state.head?.representativeUserId;
    const hw = headWrite(ctx, state.unit.unitId, state.head, {
      seq,
      currentValidFrom: validFrom,
      billing: state.head?.billing ?? 'joint',
      representativeUserId: rep && listed.has(rep) && owners.length > 1 ? rep : undefined,
    });
    const ts = stamp();
    const membershipReplaces: ReplaceRecord[] = [];
    for (const x of owners) {
      const m = ownerMembers.find((mm) => mm.userId === x.userId) as UnitMembership;
      if (m.ownershipShare && compareShares(m.ownershipShare, x.share) === 0) continue;
      const next: UnitMembership = { ...m, ownershipShare: x.share, updatedAt: ts, updatedBy: ctx.userId, version: m.version + 1 };
      membershipReplaces.push({ item: { ...next, ...membershipGsi1(next) }, expectedVersion: m.version, label: `membership:${m.userId}` });
    }
    try {
      await ledger.postBatch({
        transactions: [],
        idempotency: { id: `OWNREG_${state.unit.unitId}_${seq}`, fingerprint: fingerprint({ op: 'ownership_register', unitId, seq, owners, validFrom }) },
        newDocs: [...hw.newDocs, record],
        replaceRecords: [...hw.replace, ...membershipReplaces],
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'ownership.register',
          target: { type: 'unit', id: state.unit.unitId },
          actorId: ctx.userId,
          reason,
          details: { seq, validFrom, owners: owners.map((x) => `${x.userId}:${x.share.numerator}/${x.share.denominator}`) },
        },
      });
    } catch (err) {
      mapWriteError(err);
    }
    return getUnitOwnership(ctx, state.unit.unitId);
  }

  // -------------------------------------------------------------------------
  // Faturalama modu ve temsilci
  // -------------------------------------------------------------------------

  /**
   * joint -> split: sicil tam olmali ve ortak malik carisinin bakiyesi sifir olmali (eski ortak
   * borc paydaslara bolunmez; once tahsil/duzeltme). split -> joint: guncel paydaslarin alt
   * carilerinin bakiyesi sifir olmali.
   */
  async function setBilling(ctx: OwnershipContext, unitId: string, body: unknown) {
    const o = asObject(body);
    const mode = reqEnum(o, 'mode', OWNER_BILLING_MODES);
    const reason = reqReason(o);
    const version = o.version === undefined ? 0 : Number(o.version);
    const state = await loadState(ctx, unitId);
    if ((state.head?.version ?? 0) !== version) throw new FinanceError('conflict', 'Sicil baska bir islemle degisti (surum uyusmazligi)');
    const currentMode = state.head?.billing ?? 'joint';
    if (currentMode === mode) throw new FinanceError('conflict', `Faturalama modu zaten ${mode}`);

    const day = today();
    let initial: OwnershipRecord | undefined;
    let owners: OwnerShare[];
    if (state.head) {
      const rec = latestRecord(state.records, state.unit.unitId);
      owners = rec?.owners ?? [];
    } else {
      const t = initialTable(state, day, 'Paydaş carilerine geçiş');
      initial = newRecord(ctx, state.unit.unitId, { seq: 1, validFrom: t.validFrom, owners: t.owners, source: 'backfill', reason: 'İlk sicil (üyeliklerden)' });
      owners = t.owners;
    }
    if (mode === 'split') {
      const main = await ledger.getAccount(ctx.apartmentId, mainReceivableId(state.unit.unitId, 'owner'));
      if (main && main.balance !== 0) {
        throw new FinanceError('unprocessable', 'Ortak malik carisinin bakiyesi sıfır değil; paydaş carilerine geçmeden önce bakiyeyi kapatın');
      }
    } else {
      for (const x of owners) {
        const acc = await ledger.getAccount(ctx.apartmentId, coOwnerReceivableId(state.unit.unitId, x.userId));
        if (acc && acc.balance !== 0) {
          throw new FinanceError('unprocessable', 'Paydaş carilerinden birinin bakiyesi sıfır değil; ortak cariye dönmeden önce bakiyeleri kapatın');
        }
      }
    }
    const seq = state.head?.seq ?? 1;
    const hw = headWrite(ctx, state.unit.unitId, state.head, {
      seq,
      currentValidFrom: state.head?.currentValidFrom ?? (initial as OwnershipRecord).validFrom,
      billing: mode,
      representativeUserId: state.head?.representativeUserId,
    });
    try {
      await ledger.postBatch({
        transactions: [],
        idempotency: {
          id: `OWNBILL_${state.unit.unitId}_${hw.head.version}`,
          fingerprint: fingerprint({ op: 'ownership_billing', unitId, mode, version: hw.head.version }),
        },
        newDocs: [...hw.newDocs, ...(initial ? [initial] : [])],
        replaceRecords: hw.replace,
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'ownership.billing',
          target: { type: 'unit', id: state.unit.unitId },
          actorId: ctx.userId,
          reason,
          details: { from: currentMode, to: mode },
        },
      });
    } catch (err) {
      mapWriteError(err);
    }
    return getUnitOwnership(ctx, state.unit.unitId);
  }

  async function setRepresentative(ctx: OwnershipContext, unitId: string, body: unknown) {
    const o = asObject(body);
    const userId = o.userId === null || o.userId === undefined ? undefined : assertId(o.userId, 'userId');
    const version = o.version === undefined ? 0 : Number(o.version);
    const state = await loadState(ctx, unitId);
    if ((state.head?.version ?? 0) !== version) throw new FinanceError('conflict', 'Sicil baska bir islemle degisti (surum uyusmazligi)');
    let initial: OwnershipRecord | undefined;
    let owners: OwnerShare[];
    if (state.head) {
      owners = effectiveRecord(state.records, state.unit.unitId, today())?.owners ?? [];
    } else {
      const t = initialTable(state, today(), 'Temsilci seçimi');
      initial = newRecord(ctx, state.unit.unitId, { seq: 1, validFrom: t.validFrom, owners: t.owners, source: 'backfill', reason: 'İlk sicil (üyeliklerden)' });
      owners = t.owners;
    }
    if (userId && !owners.some((x) => x.userId === userId)) throw new ValidationError('Temsilci bolumun guncel paydaslarindan biri olmali', 'userId');
    if (userId && owners.length < 2) throw new ValidationError('Temsilci yalnizca paylı mülkiyette seçilir (tek malik oyu kendisi kullanır)', 'userId');
    const hw = headWrite(ctx, state.unit.unitId, state.head, {
      seq: state.head?.seq ?? 1,
      currentValidFrom: state.head?.currentValidFrom ?? (initial as OwnershipRecord).validFrom,
      billing: state.head?.billing ?? 'joint',
      representativeUserId: userId,
    });
    try {
      await ledger.postBatch({
        transactions: [],
        idempotency: {
          id: `OWNREP_${state.unit.unitId}_${hw.head.version}`,
          fingerprint: fingerprint({ op: 'ownership_representative', unitId, userId: userId ?? null, version: hw.head.version }),
        },
        newDocs: [...hw.newDocs, ...(initial ? [initial] : [])],
        replaceRecords: hw.replace,
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'ownership.representative',
          target: { type: 'unit', id: state.unit.unitId },
          actorId: ctx.userId,
          details: { representativeUserId: userId ?? null },
        },
      });
    } catch (err) {
      mapWriteError(err);
    }
    return getUnitOwnership(ctx, state.unit.unitId);
  }

  // -------------------------------------------------------------------------
  // Oy listesi hazirligi
  // -------------------------------------------------------------------------

  async function votingRoll(ctx: OwnershipContext, q: { date?: string } = {}) {
    const day = q.date ? reqDate(q.date, 'date') : today();
    const [units, heads, records, members] = await Promise.all([
      deps.core.listUnits(ctx.apartmentId),
      repo.listHeads(ctx.apartmentId),
      repo.listRecords(ctx.apartmentId),
      deps.memberships.list(ctx.apartmentId, {}),
    ]);
    return buildVotingRoll({
      units,
      heads: heads.filter((h) => h.apartmentId === ctx.apartmentId),
      records: records.filter((r) => r.apartmentId === ctx.apartmentId),
      memberships: members.filter((m) => m.apartmentId === ctx.apartmentId),
      day,
    });
  }

  // -------------------------------------------------------------------------
  // Mulk / hisse devri
  // -------------------------------------------------------------------------

  function parseTransfer(body: unknown): ParsedTransfer {
    const o = asObject(body);
    const idempotencyKey = reqKey(o);
    const kind = reqEnum(o, 'kind', TRANSFER_KINDS);
    const effectiveDate = reqDate(o.effectiveDate, 'effectiveDate');
    const moves = parseMoves(o.moves);
    const debtTo = o.debtTo === undefined ? 'former' : reqEnum(o, 'debtTo', TRANSFER_DEBT_TARGETS);
    const residents: string[] = [];
    if (o.residents !== undefined) {
      if (!Array.isArray(o.residents) || o.residents.length > MAX_OWNERS) throw new ValidationError('residents kullanici kimlikleri listesi olmalidir', 'residents');
      for (const [i, r] of o.residents.entries()) residents.push(assertId(r, `residents[${i}]`));
    }
    return { idempotencyKey, kind, effectiveDate, moves, debtTo, residents: [...new Set(residents)].sort(), reason: reqReason(o) };
  }

  type TransferPlan = {
    state: UnitState;
    p: ParsedTransfer;
    billing: OwnerBilling;
    cutoff: IsoDate;
    before: OwnerShare[];
    after: OwnerShare[];
    initial?: { owners: OwnerShare[]; validFrom: IsoDate };
    diff: ReturnType<typeof diffTables>;
    /** Kapanacak cariler (kaynak hesap -> hedef). */
    closures: { userIds: string[]; sourceAccountId: string; source?: Account; newOwnerAccountId?: string; newOwnerUserId?: string; plan: ReturnType<typeof planClosure> }[];
    membershipOps: { userId: string; change: OwnershipMembershipChange; next: UnitMembership; current?: UnitMembership }[];
    warnings: string[];
    representativeUserId?: string;
  };

  async function planTransfer(ctx: OwnershipContext, unitId: string, p: ParsedTransfer): Promise<TransferPlan> {
    const state = await loadState(ctx, unitId);
    if (state.unit.status !== 'active') throw new FinanceError('unprocessable', 'Bagimsiz bolum aktif degil');
    const E = p.effectiveDate;
    if (E > today()) throw new ValidationError('Devir tarihi bugünden sonra olamaz', 'effectiveDate');
    const cutoff = addDays(E, -1);
    const billing = state.head?.billing ?? 'joint';
    const warnings: string[] = [];

    let before: OwnerShare[];
    let initial: TransferPlan['initial'];
    if (state.head) {
      if (E <= state.head.currentValidFrom) {
        throw new ValidationError(`Devir tarihi son sicil kaydından (${trDate(state.head.currentValidFrom)}) sonra olmalı`, 'effectiveDate');
      }
      before = latestRecord(state.records, state.unit.unitId)?.owners ?? [];
      const mm = membershipMismatch(before, state.members, state.unit.unitId, cutoff);
      if (mm.missingMembership.length || mm.notInRegister.length) {
        throw new FinanceError('unprocessable', 'Mülkiyet sicili ile malik üyelikleri devir tarihinde uyuşmuyor; önce sicili düzeltin');
      }
    } else {
      const t = initialTable(state, cutoff, 'Devir');
      if (E <= t.validFrom) throw new ValidationError('Devir tarihi mevcut maliklerin başlangıcından sonra olmalı', 'effectiveDate');
      before = t.owners;
      initial = t;
    }
    const after = applyMoves(before, p.moves, p.kind);
    const diff = diffTables(before, after);

    // ----- Uyelik degisiklikleri -----
    const ts = stamp();
    const memberOf = (userId: string) => state.members.find((m) => m.userId === userId);
    const ops: TransferPlan['membershipOps'] = [];
    for (const x of after) {
      const m = memberOf(x.userId);
      const isNew = diff.entering.includes(x.userId);
      const resides = p.residents.includes(x.userId);
      if (!isNew) {
        if (!m) throw new FinanceError('unprocessable', `Paydaşın (${x.userId}) üyelik kaydı bulunamadı`);
        if (m.ownershipShare && compareShares(m.ownershipShare, x.share) === 0) continue;
        ops.push({
          userId: x.userId,
          current: m,
          change: { userId: x.userId, change: 'share', ...(m.ownershipShare ? { previousShare: m.ownershipShare } : {}) },
          next: { ...m, ownershipShare: x.share, updatedAt: ts, updatedBy: ctx.userId, version: m.version + 1 },
        });
        continue;
      }
      if (!m) {
        const created: UnitMembership = {
          ...membershipKeys.membership(ctx.apartmentId, x.userId, state.unit.unitId),
          entityType: 'UNIT_MEMBERSHIP',
          userId: x.userId,
          apartmentId: ctx.apartmentId,
          unitId: state.unit.unitId,
          relation: 'owner',
          residesInUnit: resides,
          ownershipShare: x.share,
          status: 'active',
          startDate: E,
          createdAt: ts,
          createdBy: ctx.userId,
          updatedAt: ts,
          updatedBy: ctx.userId,
          version: 1,
        };
        ops.push({ userId: x.userId, change: { userId: x.userId, change: 'created' }, next: created });
        continue;
      }
      if (m.relation !== 'owner' || m.endedByClosureId) {
        throw new FinanceError(
          'unprocessable',
          `Devralanın (${x.userId}) bu bölümde başka türde bir kaydı var (kiracılık veya kapama ile biten üyelik); önce o kaydı düzeltin`,
        );
      }
      const preCreated = m.status === 'active' && m.startDate >= E && (!m.endDate || m.endDate >= E);
      const ended = m.status === 'inactive' || (m.endDate !== undefined && m.endDate < E);
      if (m.status === 'active' && m.startDate > E) {
        throw new ValidationError(`Devralanın (${x.userId}) üyeliği devir tarihinden sonra başlıyor; tarihleri eşitleyin`, 'effectiveDate');
      }
      if (preCreated) {
        // Devirden once eklenmis (baslangic = devir tarihi) malik uyeligi: pay ve oturma bilgisi.
        ops.push({
          userId: x.userId,
          current: m,
          change: {
            userId: x.userId,
            change: 'share',
            ...(m.ownershipShare ? { previousShare: m.ownershipShare } : {}),
            previousResidesInUnit: m.residesInUnit,
          },
          next: { ...m, ownershipShare: x.share, residesInUnit: m.residesInUnit || resides, updatedAt: ts, updatedBy: ctx.userId, version: m.version + 1 },
        });
      } else if (ended) {
        const { endDate: _e, ...rest } = m;
        ops.push({
          userId: x.userId,
          current: m,
          change: {
            userId: x.userId,
            change: 'reactivated',
            previousStatus: m.status,
            previousStartDate: m.startDate,
            ...(m.endDate ? { previousEndDate: m.endDate } : {}),
            ...(m.ownershipShare ? { previousShare: m.ownershipShare } : {}),
            previousResidesInUnit: m.residesInUnit,
          },
          next: { ...rest, status: 'active', startDate: E, ownershipShare: x.share, residesInUnit: resides, updatedAt: ts, updatedBy: ctx.userId, version: m.version + 1 },
        });
      } else {
        throw new FinanceError('unprocessable', `Devralan (${x.userId}) devir tarihinde zaten malik görünüyor; önce sicili düzeltin`);
      }
    }
    for (const userId of diff.exiting) {
      const m = memberOf(userId);
      if (!m) throw new FinanceError('unprocessable', `Devredenin (${userId}) üyelik kaydı bulunamadı`);
      if (m.residesInUnit) {
        warnings.push(`Devreden (${userId}) dairede oturuyor; sakin carisi için ayrıca taşınma/cari kapama yapın.`);
      }
      const endDate = m.endDate && m.endDate < cutoff ? m.endDate : cutoff;
      ops.push({
        userId,
        current: m,
        change: { userId, change: 'ended', ...(m.endDate ? { previousEndDate: m.endDate } : {}) },
        next: { ...m, endDate, updatedAt: ts, updatedBy: ctx.userId, version: m.version + 1 },
      });
    }
    // Uyelik kurallari (oturan malik / kiraci cakismasi): sonuc kumesi uzerinde.
    const finalMembers = state.members.map((m) => ops.find((o) => o.userId === m.userId)?.next ?? m);
    for (const op of ops.filter((x) => x.change.change !== 'ended')) {
      const others = [...finalMembers, ...ops.filter((x) => x.change.change === 'created').map((x) => x.next)].filter((m) => m.userId !== op.userId);
      try {
        // Pay kurali sicilde (toplam tam 1, tarih bazli); uyelikteki pay alani tek degerli bir
        // aynadir ve gecmis donemlerle karsilastirilamaz. Burada yalnizca oturan malik/kiraci kurali.
        assertNoConflicts({ ...op.next, ownershipShare: undefined }, others);
      } catch (err) {
        throw new FinanceError('unprocessable', err instanceof Error ? err.message : 'Uyelik cakismasi');
      }
    }

    // ----- Cari kapamalar -----
    const closures: TransferPlan['closures'] = [];
    const txs = (await ledger.listTransactions(ctx.apartmentId)).items;
    const r = await rate(ctx.apartmentId);
    const recipientsOf = (userId: string) => [...new Set(p.moves.filter((m) => m.fromUserId === userId).map((m) => m.toUserId))];
    if (billing === 'joint') {
      const allExit = diff.exiting.length === before.length;
      if (allExit) {
        const sourceAccountId = mainReceivableId(state.unit.unitId, 'owner');
        const source = await ledger.getAccount(ctx.apartmentId, sourceAccountId);
        if (source) closures.push({ userIds: [...diff.exiting], sourceAccountId, source, plan: planClosure(sourceAccountId, txs, cutoff, r) });
      } else if (diff.exiting.length > 0) {
        warnings.push('Ortak malik carisinde borç paydaşlar arasında ayrıştırılmaz; çıkan paydaşın payına düşen geçmiş borç ortak caride kalır.');
      }
      if (p.debtTo === 'new_owner' && !allExit) {
        throw new ValidationError('Ortak caride borcun yeni malike devri yalnızca tüm malikler çıkarken seçilebilir', 'debtTo');
      }
    } else {
      for (const userId of diff.exiting) {
        const sourceAccountId = coOwnerReceivableId(state.unit.unitId, userId);
        const source = await ledger.getAccount(ctx.apartmentId, sourceAccountId);
        let newOwnerUserId: string | undefined;
        if (p.debtTo === 'new_owner') {
          const rec = recipientsOf(userId);
          if (rec.length !== 1) {
            throw new ValidationError('Borcun yeni malike devri için çıkan paydaşın payı tek bir kişiye devredilmeli', 'debtTo');
          }
          newOwnerUserId = rec[0];
        }
        if (!source) continue;
        closures.push({
          userIds: [userId],
          sourceAccountId,
          source,
          ...(newOwnerUserId ? { newOwnerUserId, newOwnerAccountId: coOwnerReceivableId(state.unit.unitId, newOwnerUserId) } : {}),
          plan: planClosure(sourceAccountId, txs, cutoff, r),
        });
      }
      if (diff.changed.length > 0 || diff.exiting.length < before.length) {
        warnings.push('Kısmi devirde devredenin geçmiş borcu kendi carisinde kalır; sonraki tahakkuklar yeni paylarla bölünür.');
      }
    }
    if (closures.length > MAX_TRANSFER_CLOSURES) {
      throw new ValidationError(`Tek devirde en fazla ${MAX_TRANSFER_CLOSURES} cari kapatılabilir; devri parçalara bölün`, 'moves');
    }
    for (const c of closures) {
      // Finans 2.2: aktif taksit plani olan cari devredilemez.
      if (openPlanIds(c.sourceAccountId, txs).length > 0) {
        throw new FinanceError('conflict', `${c.sourceAccountId} carisinde aktif bir borç yapılandırma planı var; önce planı kapatın veya iptal edin`);
      }
      if (c.source?.closedThrough && cutoff <= c.source.closedThrough) {
        throw new FinanceError('unprocessable', `Bu cari ${trDate(c.source.closedThrough)} tarihine kadar zaten kapatılmış`);
      }
      if (c.plan.later.credits > 0) {
        warnings.push(`Devir tarihinden sonra ${c.sourceAccountId} carisine ${c.plan.later.credits} alacak kaydı girilmiş; bunlar yeni döneme sayılır.`);
      }
    }

    const rep = state.head?.representativeUserId;
    const representativeUserId = rep && after.length > 1 && after.some((x) => x.userId === rep) ? rep : undefined;
    if (after.length > 1 && !representativeUserId) warnings.push('temsilci yok');

    return { state, p, billing, cutoff, before, after, ...(initial ? { initial } : {}), diff, closures, membershipOps: ops, warnings, ...(representativeUserId ? { representativeUserId } : {}) };
  }

  async function previewTransfer(ctx: OwnershipContext, unitId: string, body: unknown) {
    const o = asObject(body);
    const p = parseTransfer({ idempotencyKey: 'preview-only', reason: 'onizleme', ...o });
    const plan = await planTransfer(ctx, unitId, p);
    return {
      unitId: plan.state.unit.unitId,
      kind: p.kind,
      effectiveDate: p.effectiveDate,
      cutoff: plan.cutoff,
      billing: plan.billing,
      before: tableView(plan.before),
      after: tableView(plan.after),
      exiting: plan.diff.exiting,
      entering: plan.diff.entering,
      changed: plan.diff.changed,
      debtTo: p.debtTo,
      closures: plan.closures.map((c) => ({
        userIds: c.userIds,
        sourceAccountId: c.sourceAccountId,
        lateFee: toKurus(c.plan.lateFee),
        debt: toKurus(c.plan.debt),
        advance: toKurus(c.plan.advance),
        items: c.plan.items,
        target: c.plan.debt > 0 && p.debtTo === 'new_owner' ? 'new_owner' : 'former',
        ...(c.newOwnerUserId ? { newOwnerUserId: c.newOwnerUserId } : {}),
      })),
      membershipChanges: plan.membershipOps.map((x) => x.change),
      ...(plan.representativeUserId ? { representativeUserId: plan.representativeUserId } : {}),
      warnings: plan.warnings,
    };
  }

  async function transferReplay(ctx: OwnershipContext, idemId: string, fp: string): Promise<OwnershipTransfer | undefined> {
    const existing = await ledger.getIdempotency(ctx.apartmentId, idemId);
    if (!existing) return undefined;
    if (existing.fingerprint !== fp) throw new FinanceError('idempotency_conflict', 'Bu idempotencyKey farkli bir istekle kullanilmis');
    const t = existing.recordId ? await repo.getTransfer(ctx.apartmentId, existing.recordId) : undefined;
    if (!t) throw new FinanceError('conflict', 'Devir kaydi bulunamadi');
    return t;
  }

  function account(ctx: OwnershipContext, base: Pick<Account, 'accountId' | 'type' | 'name'> & Partial<Account>): Account {
    const ts = stamp();
    return {
      ...financeKeys.account(ctx.apartmentId, base.accountId),
      entityType: 'ACCOUNT',
      siteId: ctx.apartmentId,
      status: 'active',
      balance: toKurus(0),
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
      ...base,
    };
  }

  function tx(ctx: OwnershipContext, p: Pick<Transaction, 'kind' | 'date' | 'description' | 'lines'> & Partial<Transaction>): Transaction {
    const transactionId = `${compact(p.date)}-${deps.newId()}`;
    return {
      ...financeKeys.transaction(ctx.apartmentId, transactionId),
      entityType: 'TRANSACTION',
      transactionId,
      siteId: ctx.apartmentId,
      totalAmount: toKurus(p.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0)),
      createdAt: stamp(),
      createdBy: ctx.userId,
      ...p,
    };
  }

  async function createTransfer(ctx: OwnershipContext, unitId: string, body: unknown): Promise<{ transfer: OwnershipTransfer; replayed: boolean; warnings: string[] }> {
    const p = parseTransfer(body);
    assertId(unitId, 'unitId');
    const idemId = `OWNX_${p.idempotencyKey}`;
    const fp = fingerprint({ op: 'ownership_transfer', unitId, ...p, idempotencyKey: undefined });
    const prior = await transferReplay(ctx, idemId, fp);
    if (prior) return { transfer: prior, replayed: true, warnings: [] };

    const plan = await planTransfer(ctx, unitId, p);
    const { state, cutoff } = plan;
    const unit = state.unit;
    const E = p.effectiveDate;
    const transferId = shortId();

    // ----- Cari kapamalar (cari-devri modeliyle ayni islemler) -----
    await deps.finance.ensureSystemAccounts(ctx);
    const transactions: Transaction[] = [];
    const closureDocs: CariClosure[] = [];
    const transferClosures: TransferClosure[] = [];
    const accountPatches: Record<string, { closedThrough: IsoDate }> = {};
    const ensure: Account[] = [account(ctx, { accountId: SYSTEM_ACCOUNTS.transferClearing, type: 'equity', name: 'Cari Devir Ara Hesabı', system: true })];
    const ts = stamp();
    const line = (accountId: string, side: 'debit' | 'credit', amount: number, party: LiableParty = 'owner'): TransactionLine => ({
      accountId,
      side,
      amount: toKurus(amount),
      unitId: unit.unitId,
      liableParty: party,
    });
    const clearing = (side: 'debit' | 'credit', amount: number): TransactionLine => ({ accountId: SYSTEM_ACCOUNTS.transferClearing, side, amount: toKurus(amount) });

    for (const c of plan.closures) {
      const closureId = shortId();
      const formerId = `${c.sourceAccountId}-c${closureId}`;
      const { plan: cp } = c;
      const debt = cp.net > 0;
      const toNewOwner = debt && p.debtTo === 'new_owner';
      // joint: yeni malik ayni ortak cariyi devralir; split: devralanin paydas alt carisi.
      const newOwnerTarget = plan.billing === 'joint' ? c.sourceAccountId : c.newOwnerAccountId;
      const targetAccountId = cp.net === 0 ? undefined : toNewOwner ? newOwnerTarget : formerId;
      if (targetAccountId === formerId) {
        const starts = c.userIds.map((u) => state.members.find((m) => m.userId === u)?.startDate).filter((d): d is IsoDate => Boolean(d)).sort();
        ensure.push(
          account(ctx, {
            accountId: formerId,
            type: 'receivable',
            name: `Daire ${unit.number} - Ayrılan malik (${trDate(cutoff)})`,
            unitId: unit.unitId,
            liableParty: 'owner',
            closureId,
            holder: { userIds: c.userIds, ...(starts[0] ? { periodStart: starts[0] } : {}), periodEnd: cutoff },
          }),
        );
      } else if (targetAccountId && targetAccountId !== c.sourceAccountId && c.newOwnerUserId) {
        ensure.push(
          account(ctx, {
            accountId: targetAccountId,
            type: 'receivable',
            name: `Daire ${unit.number} - Kat Maliki (paydaş)`,
            unitId: unit.unitId,
            liableParty: 'owner',
            coOwner: { userId: c.newOwnerUserId },
          }),
        );
      }
      const ids: CariClosure['transactionIds'] = {};
      if (cp.lateFee > 0) {
        const t = tx(ctx, {
          kind: 'late_fee',
          date: cutoff,
          dueDate: cutoff,
          description: 'Gecikme tazminatı (devir tarihine kadar)',
          reference: `LATE_FEE_CLOSE:${closureId}`,
          lines: [line(c.sourceAccountId, 'debit', cp.lateFee), { accountId: SYSTEM_ACCOUNTS.incomeLateFee, side: 'credit', amount: toKurus(cp.lateFee) }],
        });
        transactions.push(t);
        ids.lateFee = t.transactionId;
      }
      if (cp.net !== 0 && targetAccountId) {
        const abs = Math.abs(cp.net);
        const close = tx(ctx, {
          kind: 'transfer',
          date: cutoff,
          description: `Cari kapama (mülk devri ${trDate(E)})`,
          reason: p.reason,
          transfer: { closureId, role: 'close', cutoff },
          lines: [line(c.sourceAccountId, debt ? 'credit' : 'debit', abs), clearing(debt ? 'debit' : 'credit', abs)],
        });
        const open = tx(ctx, {
          kind: 'transfer',
          // Yeni malik adina acilis devir gunu (kesimden sonra): kilit kosulunu gecer.
          date: toNewOwner ? E : cutoff,
          description: debt ? `Devreden borç (mülk devri ${trDate(E)})` : `Devreden avans (mülk devri ${trDate(E)})`,
          reason: p.reason,
          transfer: { closureId, role: 'open', ...(debt ? { items: cp.items } : {}) },
          lines: [line(targetAccountId, debt ? 'debit' : 'credit', abs), clearing(debt ? 'credit' : 'debit', abs)],
        });
        transactions.push(close, open);
        ids.close = close.transactionId;
        ids.open = open.transactionId;
      }
      accountPatches[c.sourceAccountId] = { closedThrough: cutoff };
      const debtTo: TransferDebtTarget = toNewOwner ? 'new_owner' : 'former';
      closureDocs.push({
        ...closureKeys.closure(ctx.apartmentId, closureId),
        entityType: 'CARI_CLOSURE',
        closureId,
        apartmentId: ctx.apartmentId,
        unitId: unit.unitId,
        party: 'owner',
        moveOutDate: cutoff,
        sourceAccountId: c.sourceAccountId,
        userIds: c.userIds,
        debtTo,
        advanceTo: 'former',
        ...(c.newOwnerUserId && toNewOwner ? { newOwnerUserId: c.newOwnerUserId } : {}),
        ...(targetAccountId ? { targetAccountId } : {}),
        lateFee: toKurus(cp.lateFee),
        debt: toKurus(cp.debt),
        advance: toKurus(cp.advance),
        items: cp.net > 0 ? cp.items : [],
        membershipChanges: [],
        transactionIds: ids,
        ...(c.source?.closedThrough ? { previousClosedThrough: c.source.closedThrough } : {}),
        ownershipTransferId: transferId,
        status: 'completed',
        reason: p.reason,
        createdAt: ts,
        createdBy: ctx.userId,
        updatedAt: ts,
        updatedBy: ctx.userId,
        version: 1,
      });
      transferClosures.push({
        closureId,
        userIds: c.userIds,
        sourceAccountId: c.sourceAccountId,
        ...(targetAccountId ? { targetAccountId } : {}),
        debtTo,
        debt: cp.debt,
        advance: cp.advance,
        lateFee: cp.lateFee,
      });
    }
    await ledger.ensureAccounts(ensure);

    // ----- Sicil -----
    const initialSeq = state.head ? undefined : 1;
    const recordSeq = (state.head?.seq ?? 1) + 1;
    const records: OwnershipRecord[] = [];
    if (plan.initial) {
      records.push(newRecord(ctx, unit.unitId, { seq: 1, validFrom: plan.initial.validFrom, owners: plan.initial.owners, source: 'backfill', reason: 'İlk sicil (üyeliklerden)' }));
    }
    records.push(newRecord(ctx, unit.unitId, { seq: recordSeq, validFrom: E, owners: plan.after, source: 'transfer', reason: p.reason, transferId }));
    const hw = headWrite(ctx, unit.unitId, state.head, {
      seq: recordSeq,
      currentValidFrom: E,
      billing: plan.billing,
      representativeUserId: plan.representativeUserId,
    });

    const transfer: OwnershipTransfer = {
      ...ownershipKeys.transfer(ctx.apartmentId, transferId),
      entityType: 'OWNERSHIP_TRANSFER',
      transferId,
      apartmentId: ctx.apartmentId,
      unitId: unit.unitId,
      kind: p.kind,
      effectiveDate: E,
      moves: p.moves,
      before: plan.before,
      after: plan.after,
      billing: plan.billing,
      recordSeq,
      ...(initialSeq ? { initialSeq } : {}),
      ...(state.head?.representativeUserId ? { previousRepresentativeUserId: state.head.representativeUserId } : {}),
      debtTo: p.debtTo,
      closures: transferClosures,
      membershipChanges: plan.membershipOps.map((x) => x.change),
      status: 'completed',
      reason: p.reason,
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };

    const withIndex = (m: UnitMembership) => ({ ...m, ...membershipGsi1(m) });
    const membershipNew = plan.membershipOps.filter((x) => !x.current).map((x) => withIndex(x.next));
    const membershipReplace: ReplaceRecord[] = plan.membershipOps
      .filter((x) => x.current)
      .map((x) => ({ item: withIndex(x.next), expectedVersion: (x.current as UnitMembership).version, label: `membership:${x.userId}` }));

    try {
      await ledger.postBatch({
        transactions,
        idempotency: { id: idemId, fingerprint: fp, recordId: transferId, transactionIds: transactions.map((t) => t.transactionId) },
        newDocs: [...hw.newDocs, ...records, transfer, ...closureDocs, ...membershipNew],
        replaceRecords: [...hw.replace, ...membershipReplace],
        accountPatches,
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'ownership.transfer',
          target: { type: 'ownership_transfer', id: transferId },
          actorId: ctx.userId,
          reason: p.reason,
          details: {
            unitId: unit.unitId,
            kind: p.kind,
            effectiveDate: E,
            billing: plan.billing,
            exiting: plan.diff.exiting,
            entering: plan.diff.entering,
            changed: plan.diff.changed,
            recordSeq,
            closures: transferClosures.map((c) => c.closureId),
            transactionIds: transactions.map((t) => t.transactionId),
          },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError && err.reason === 'duplicate') {
        const again = await transferReplay(ctx, idemId, fp);
        if (again) return { transfer: again, replayed: true, warnings: [] };
      }
      mapWriteError(err);
    }
    return { transfer, replayed: false, warnings: plan.warnings };
  }

  async function listTransfers(ctx: OwnershipContext, unitId: string) {
    const unit = await requireUnit(ctx, unitId);
    return (await repo.listTransfers(ctx.apartmentId))
      .filter((t) => t.apartmentId === ctx.apartmentId && t.unitId === unit.unitId)
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.createdAt.localeCompare(a.createdAt));
  }

  async function getTransfer(ctx: OwnershipContext, transferId: string): Promise<OwnershipTransfer> {
    assertId(transferId, 'transferId');
    const t = await repo.getTransfer(ctx.apartmentId, transferId);
    if (!t || t.apartmentId !== ctx.apartmentId) throw new FinanceError('not_found', 'Devir kaydi bulunamadi');
    return t;
  }

  /**
   * Devri geri alir (TEK atomik yazim): kapama islemleri ters kayitla iptal, kilitler eski haline,
   * sicile onceki tabloyu yeniden yazan `reversal` kaydi, uyelikler eski haline, temsilci eski
   * haline, devir ve kapama kayitlari `reversed`. Yalnizca dairenin SON sicil hareketi geri alinir.
   * Devir tarihinden sonra yazilmis bolunmus tahakkuklar yerinde kalir (append-only defter).
   */
  async function reverseTransfer(ctx: OwnershipContext, transferId: string, body: unknown): Promise<OwnershipTransfer> {
    const o = asObject(body);
    const reason = reqReason(o);
    const transfer = await getTransfer(ctx, transferId);
    if (transfer.status === 'reversed') throw new FinanceError('conflict', 'Devir zaten geri alinmis');
    const state = await loadState(ctx, transfer.unitId);
    if (!state.head || state.head.seq !== transfer.recordSeq) {
      throw new FinanceError('unprocessable', 'Bu devirden sonra sicilde başka bir değişiklik var; önce sonraki değişikliği geri alın');
    }
    const all = (await ledger.listTransactions(ctx.apartmentId)).items;
    const day = today();
    const reversals: Transaction[] = [];
    const replace: ReplaceRecord[] = [];
    const accountPatches: Record<string, { closedThrough: IsoDate | null; bypassLock: boolean }> = {};
    const ts = stamp();
    for (const c of transfer.closures) {
      const closure = await deps.closures.get(ctx.apartmentId, c.closureId);
      if (!closure || closure.ownershipTransferId !== transfer.transferId) throw new FinanceError('conflict', 'Devrin kapama kaydi bulunamadi');
      if (closure.status === 'reversed') continue;
      const source = await ledger.getAccount(ctx.apartmentId, closure.sourceAccountId);
      if (source?.closedThrough && source.closedThrough > closure.moveOutDate) {
        throw new FinanceError('unprocessable', 'Kapanan cari daha sonra tekrar kapatılmış; önce sonraki kapamayı geri alın');
      }
      for (const t of reversibleTransactions(closure, all, day)) {
        reversals.push(
          tx(ctx, {
            kind: 'reversal',
            date: day,
            description: `Ters kayit: ${t.description}`,
            reversalOf: t.transactionId,
            reason,
            lines: t.lines.map((l) => ({ ...l, side: l.side === 'debit' ? 'credit' : 'debit' })),
          }),
        );
      }
      accountPatches[closure.sourceAccountId] = { closedThrough: closure.previousClosedThrough ?? null, bypassLock: true };
      const reversedClosure: CariClosure = {
        ...closure,
        status: 'reversed',
        reversal: { at: ts, by: ctx.userId, reason, transactionIds: [] },
        updatedAt: ts,
        updatedBy: ctx.userId,
        version: closure.version + 1,
      };
      replace.push({ item: reversedClosure, expectedVersion: closure.version, label: `closure:${closure.closureId}` });
    }

    // Uyelikler: devirden sonra elle degistirilmemis olanlar eski haline.
    for (const change of transfer.membershipChanges) {
      const m = state.members.find((x) => x.userId === change.userId);
      if (!m) continue;
      let next: UnitMembership;
      if (change.change === 'created') {
        next = { ...m, status: 'inactive' };
      } else if (change.change === 'reactivated') {
        const { endDate: _e, ownershipShare: _s, ...rest } = m;
        next = {
          ...rest,
          status: change.previousStatus ?? m.status,
          startDate: change.previousStartDate ?? m.startDate,
          ...(change.previousEndDate ? { endDate: change.previousEndDate } : {}),
          ...(change.previousShare ? { ownershipShare: change.previousShare } : {}),
          residesInUnit: change.previousResidesInUnit ?? m.residesInUnit,
        } as UnitMembership;
      } else if (change.change === 'share') {
        const { ownershipShare: _s, ...rest } = m;
        next = {
          ...rest,
          ...(change.previousShare ? { ownershipShare: change.previousShare } : {}),
          ...(change.previousResidesInUnit !== undefined ? { residesInUnit: change.previousResidesInUnit } : {}),
        } as UnitMembership;
      } else {
        const { endDate: _e, ...rest } = m;
        next = { ...rest, ...(change.previousEndDate ? { endDate: change.previousEndDate } : {}) } as UnitMembership;
      }
      next = { ...next, updatedAt: ts, updatedBy: ctx.userId, version: m.version + 1 };
      replace.push({ item: { ...next, ...membershipGsi1(next) }, expectedVersion: m.version, label: `membership:${m.userId}` });
    }

    const seq = state.head.seq + 1;
    const record = newRecord(ctx, transfer.unitId, {
      seq,
      validFrom: transfer.effectiveDate,
      owners: transfer.before,
      source: 'reversal',
      reason,
      transferId: transfer.transferId,
    });
    const prevRep = transfer.previousRepresentativeUserId;
    const hw = headWrite(ctx, transfer.unitId, state.head, {
      seq,
      currentValidFrom: transfer.effectiveDate,
      billing: state.head.billing,
      representativeUserId: prevRep && transfer.before.some((x) => x.userId === prevRep) ? prevRep : undefined,
    });
    const next: OwnershipTransfer = {
      ...transfer,
      status: 'reversed',
      reversal: { at: ts, by: ctx.userId, reason, transactionIds: reversals.map((t) => t.transactionId), recordSeq: seq },
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: transfer.version + 1,
    };
    try {
      await ledger.postBatch({
        transactions: reversals,
        idempotency: {
          id: `OWNXREV_${transfer.transferId}`,
          fingerprint: fingerprint({ op: 'ownership_transfer_reverse', transferId }),
          recordId: transfer.transferId,
          transactionIds: reversals.map((t) => t.transactionId),
        },
        newDocs: [record],
        replaceRecords: [...hw.replace, { item: next, expectedVersion: transfer.version, label: 'ownership_transfer' }, ...replace],
        accountPatches,
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'ownership.transfer_reverse',
          target: { type: 'ownership_transfer', id: transfer.transferId },
          actorId: ctx.userId,
          reason,
          details: { unitId: transfer.unitId, recordSeq: seq, reversalTransactionIds: reversals.map((t) => t.transactionId) },
        },
      });
    } catch (err) {
      mapWriteError(err);
    }
    return next;
  }

  return {
    getUnitOwnership,
    issues,
    backfill,
    setRegister,
    setBilling,
    setRepresentative,
    votingRoll,
    previewTransfer,
    createTransfer,
    listTransfers,
    getTransfer,
    reverseTransfer,
  };
}

export type OwnershipService = ReturnType<typeof createOwnershipService>;
