/**
 * Tasinmada cari kapama ve borc devri (plan: claude/finans-cari-devri-plani.md).
 *
 * Bir dairenin bir tarafi (sakin `occupant` / malik `owner`) icin cikis tarihi D:
 *  1. D'ye kadar islemis (deftere yazilmamis) kistelyevm tazminati D tarihli kesinlestirilir.
 *  2. Kaynak ana cari D'ye kadarki NET bakiyesiyle kapatilir (`transfer`/close, kesim = D):
 *     hesap genelindeki hesaplamalar artik D sonrasini gorur (subledger.ts) ve hesaba D dahil
 *     oncesine kayit yazilamaz (`closedThrough` kilidi, repository kosulu).
 *  3. Borc kalemleriyle (orijinal vadeleri) hedefe acilir (`transfer`/open):
 *       former    ayrilan sakin/malik carisi `recv-<unit>-<taraf>-c<kapamaId>` (varsayilan)
 *       owner     malik carisi (yalnizca sakin tarafi; ornegin oturan malik kiraya veriyor)
 *       new_owner ayni malik carisi, yeni malikin baslangic gunu tarihli (yalnizca malik tarafi)
 *     Avans (alacak bakiyesi): refund (kasa/bankadan iade) / former / owner (yalnizca sakin).
 *  4. Uyelikler: kiraci ve satan malik icin `endDate = D`; oturan malik kiraya veriyorsa
 *     `residesInUnit = false` (malik olarak kalir).
 * Hepsi + kapama kaydi + idempotency TEK atomik yazimdir (`postBatch`).
 *
 * Geri alma: kapama/acilis islemleri ters kayitla iptal edilir, kilit onceki degerine doner,
 * kayit `reversed` olur. Tazminat yerinde kalir (o gune kadar islemis gercek borctur), uyelikler
 * geri alinmaz. Hedefte devredilen kalemlere tahsilat mahsup edildiyse veya avans iade edildiyse
 * geri alinamaz.
 */
import { createHash, randomUUID } from 'node:crypto';
import { getTenantItem, queryTenantAll, skKey, tenantPk } from '../../config/dynamodb.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { type IsoDate, type IsoDateTime, type Kurus, type LiableParty, type TableKeys, type Unit, toKurus } from '../core/types.js';
import { ValidationError, asObject, assertId, isIsoDate, optString, reqEnum, reqString } from '../core/validation.js';
import { type MembershipRepository, membershipGsi1, membershipRepository } from '../memberships/repository.js';
import type { UnitMembership } from '../portal/types.js';
import { feeLedgerFor, unpostedLateFee } from './lateFee.js';
import { coversDay } from './occupancy.js';
import { type FinanceRepository, LedgerConflictError, type ReplaceRecord, financeKeys, financeRepository } from './repository.js';
import { DEFAULT_LATE_FEE_BASIS_POINTS, FinanceError, type FinanceService, SYSTEM_ACCOUNTS } from './service.js';
import { allocate, cancelledIn, linesOfAccount, readSubledger, transferItemId } from './subledger.js';
import { type Account, type Transaction, type TransactionLine, type TransferItem, mainReceivableId } from './types.js';

export const DEBT_TARGETS = ['former', 'owner', 'new_owner'] as const;
export type DebtTarget = (typeof DEBT_TARGETS)[number];
export const ADVANCE_TARGETS = ['refund', 'former', 'owner'] as const;
export type AdvanceTarget = (typeof ADVANCE_TARGETS)[number];
const PARTIES = ['occupant', 'owner'] as const satisfies readonly LiableParty[];

export type MembershipChange = {
  userId: string;
  relation: UnitMembership['relation'];
  change: 'ended' | 'not_resident';
  previousEndDate?: IsoDate;
  /** Kapamadan onceki oturma bilgisi (`not_resident` geri alinirken). */
  previousResidesInUnit?: boolean;
};

/**
 *   PK = `APT#<apartmentId>`, SK = `CLOSURE#<closureId>`
 */
export type CariClosure = TableKeys & {
  entityType: 'CARI_CLOSURE';
  closureId: string;
  apartmentId: string;
  unitId: string;
  party: LiableParty;
  moveOutDate: IsoDate;
  sourceAccountId: string;
  userIds: string[];
  debtTo: DebtTarget;
  advanceTo: AdvanceTarget;
  newOwnerUserId?: string;
  refundAccountId?: string;
  /** Borcun / avansin gittigi hesap (net sifirsa yok). */
  targetAccountId?: string;
  lateFee: Kurus;
  debt: Kurus;
  advance: Kurus;
  items: TransferItem[];
  membershipChanges: MembershipChange[];
  transactionIds: { lateFee?: string; close?: string; open?: string; refund?: string };
  /** Bu kapamadan onceki kilit (geri almada geri yuklenir). */
  previousClosedThrough?: IsoDate;
  status: 'completed' | 'reversed';
  reason: string;
  reversal?: { at: IsoDateTime; by: string; reason: string; transactionIds: string[] };
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

export const closureKeys = {
  closure: (apartmentId: string, closureId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('CLOSURE', closureId) }),
};

export type ClosureRepository = {
  get(apartmentId: string, closureId: string): Promise<CariClosure | undefined>;
  list(apartmentId: string): Promise<CariClosure[]>;
};

export const closureRepository: ClosureRepository = {
  get: (apartmentId, closureId) => getTenantItem<CariClosure>(closureKeys.closure(apartmentId, closureId)),
  list: (apartmentId) => queryTenantAll<CariClosure>(apartmentId, 'CLOSURE#', { ConsistentRead: true }),
};

export type ClosureContext = { apartmentId: string; userId: string };

export type ClosureServiceDeps = {
  finance: Pick<FinanceService, 'ensureSystemAccounts'>;
  financeRepo: FinanceRepository;
  closures: ClosureRepository;
  memberships: Pick<MembershipRepository, 'list'>;
  core: Pick<CoreRepository, 'getUnit'> & Partial<Pick<CoreRepository, 'getSite'>>;
  now: () => Date;
  newId: () => string;
};

// ---------------------------------------------------------------------------
// Saf hesap: kapama plani
// ---------------------------------------------------------------------------

export type ClosurePlan = {
  /** D'ye kadar islemis, deftere yazilmamis tazminat (kapamada kesinlesir). */
  lateFee: number;
  /** D itibariyla net bakiye (tazminat dahil): pozitif borc, negatif avans. */
  net: number;
  debt: number;
  advance: number;
  /** Devredilecek acik kalemler (FIFO sirasinda; son kalem kesinlesen tazminat). */
  items: TransferItem[];
  /** Kaynakta D sonrasina tarihli hareketler (yeni doneme sayilir). */
  later: { charges: number; credits: number; creditAmount: number };
};

/**
 * Kaynak cari icin D tarihli kapama plani. `transactions` apartmanin tum defteri; kaynak hesabin
 * onceki kapamalari (kesim) dikkate alinir.
 */
export function planClosure(
  sourceAccountId: string,
  transactions: readonly Transaction[],
  moveOutDate: IsoDate,
  monthlyBasisPoints: number,
): ClosurePlan {
  const cancelled = cancelledIn(transactions);
  const upTo = transactions.filter((t) => t.date <= moveOutDate);
  const lateFee = monthlyBasisPoints > 0 ? unpostedLateFee(feeLedgerFor(sourceAccountId, upTo, cancelled), monthlyBasisPoints, moveOutDate) : 0;

  const lines = linesOfAccount(sourceAccountId, upTo);
  const sub = readSubledger(lines, cancelled);
  const { open } = allocate(sub, moveOutDate);
  const items: TransferItem[] = open.map((c) => ({
    sourceChargeId: c.id,
    category: c.lateFee ? 'late_fee' : 'principal',
    description: c.description,
    date: c.date,
    dueDate: c.dueDate,
    amount: c.remaining,
  }));
  const net = sub.balance + lateFee;
  if (lateFee > 0 && net > 0) {
    // Acik kalem yoksa (avans tazminattan kucuk) devreden borc yalnizca tazminatin avansi asan kismidir.
    const feeItem = items.length === 0 ? net : lateFee;
    items.push({
      sourceChargeId: 'late-fee-at-closure',
      category: 'late_fee',
      description: 'Gecikme tazminatı (çıkış tarihine kadar)',
      date: moveOutDate,
      dueDate: moveOutDate,
      amount: toKurus(feeItem),
    });
  }
  const laterSub = readSubledger(
    linesOfAccount(sourceAccountId, transactions).filter((l) => l.date > moveOutDate),
    cancelled,
  );
  return {
    lateFee,
    net,
    debt: Math.max(net, 0),
    advance: Math.max(-net, 0),
    items: net > 0 ? items : [],
    later: {
      charges: laterSub.charges.length,
      credits: laterSub.credits.length,
      creditAmount: laterSub.credits.reduce((s, c) => s + c.amount, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compact = (d: IsoDate) => d.replaceAll('-', '');
const trDate = (d: IsoDate) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

type Parsed = {
  idempotencyKey: string;
  party: LiableParty;
  moveOutDate: IsoDate;
  userIds: string[];
  debtTo: DebtTarget;
  advanceTo: AdvanceTarget;
  newOwnerUserId?: string;
  refundAccountId?: string;
  reason: string;
};

function parseUserIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw new ValidationError('userIds en fazla 10 kimlik iceren bir liste olmalidir', 'userIds');
  const ids = value.map((v, i) => assertId(v, `userIds[${i}]`));
  if (new Set(ids).size !== ids.length) throw new ValidationError('userIds tekrar iceremez', 'userIds');
  return ids.sort();
}

function reqDate(value: unknown, field: string): IsoDate {
  if (typeof value !== 'string' || !isIsoDate(value)) throw new ValidationError(`${field} YYYY-MM-DD olmalidir`, field);
  return value;
}

export function createClosureService(overrides: Partial<ClosureServiceDeps> & Pick<ClosureServiceDeps, 'finance'>) {
  const deps: ClosureServiceDeps = {
    financeRepo: financeRepository,
    closures: closureRepository,
    memberships: membershipRepository,
    core: coreRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.financeRepo;
  const stamp = () => deps.now().toISOString();
  const today = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());
  /** Kisa kapama kimligi: hesap kimligi (`recv-<unit>-<taraf>-c<id>`) 64 karakteri asmasin. */
  const newClosureId = () => deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 12);

  async function rate(apartmentId: string): Promise<number> {
    const site = deps.core.getSite ? await deps.core.getSite(apartmentId) : undefined;
    return site?.settings.lateFeeMonthlyBasisPoints ?? DEFAULT_LATE_FEE_BASIS_POINTS;
  }

  async function requireUnit(ctx: ClosureContext, unitId: string): Promise<Unit> {
    assertId(unitId, 'unitId');
    const unit = await deps.core.getUnit(ctx.apartmentId, unitId);
    if (!unit) throw new FinanceError('not_found', 'Bagimsiz bolum bulunamadi');
    return unit;
  }

  function account(ctx: ClosureContext, base: Pick<Account, 'accountId' | 'type' | 'name'> & Partial<Account>): Account {
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

  function tx(ctx: ClosureContext, p: Pick<Transaction, 'kind' | 'date' | 'description' | 'lines'> & Partial<Transaction>): Transaction {
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

  // ----- Uyelik kurallari -----


  /** Bu tarafin cikabilecek uyelikleri (D gunu dairede/malik olan). */
  function leavers(memberships: UnitMembership[], party: LiableParty, day: IsoDate): UnitMembership[] {
    return memberships.filter(
      (m) => coversDay(m, day) && (party === 'owner' ? m.relation === 'owner' : m.relation === 'tenant' || m.residesInUnit),
    );
  }

  function changeOf(m: UnitMembership, party: LiableParty): MembershipChange {
    // Oturan malik sakin carisini kapatiyorsa (kiraya veriyor) malik olarak kalir.
    if (party === 'occupant' && m.relation === 'owner') {
      return { userId: m.userId, relation: m.relation, change: 'not_resident', previousResidesInUnit: m.residesInUnit };
    }
    return { userId: m.userId, relation: m.relation, change: 'ended', ...(m.endDate ? { previousEndDate: m.endDate } : {}) };
  }

  // ----- Onizleme -----

  async function preview(ctx: ClosureContext, unitId: string, q: { party?: string; moveOutDate?: string; userIds?: string }) {
    const unit = await requireUnit(ctx, unitId);
    const party = reqEnum({ party: q.party }, 'party', PARTIES);
    const moveOutDate = reqDate(q.moveOutDate, 'moveOutDate');
    if (moveOutDate > today()) throw new ValidationError('Cikis tarihi bugunden sonra olamaz', 'moveOutDate');
    const sourceAccountId = mainReceivableId(unit.unitId, party);

    const [source, memberships, txPage, r] = await Promise.all([
      repo.getAccount(ctx.apartmentId, sourceAccountId),
      deps.memberships.list(ctx.apartmentId, { unitId: unit.unitId }),
      repo.listTransactions(ctx.apartmentId),
      rate(ctx.apartmentId),
    ]);
    const plan = planClosure(sourceAccountId, txPage.items, moveOutDate, r);
    const candidates = leavers(memberships.filter((m) => m.unitId === unit.unitId), party, moveOutDate);
    const selected = q.userIds ? parseUserIds(q.userIds.split(',').filter(Boolean)) : candidates.map((m) => m.userId);
    const remaining = memberships.filter(
      (m) => m.unitId === unit.unitId && !selected.includes(m.userId) && leavers([m], party, moveOutDate).length > 0,
    );
    const incomingOwners = memberships.filter(
      (m) => m.unitId === unit.unitId && m.status === 'active' && m.relation === 'owner' && m.startDate > moveOutDate,
    );

    const warnings: string[] = [];
    if (source?.closedThrough && moveOutDate <= source.closedThrough) {
      warnings.push(`Bu cari ${trDate(source.closedThrough)} tarihine kadar zaten kapatilmis; cikis tarihi bundan sonra olmali.`);
    }
    if (plan.later.credits > 0) {
      warnings.push(
        `Cikis tarihinden sonra bu cariye ${plan.later.credits} alacak kaydi girilmis; bunlar yeni doneme sayilir. Ayrilan kisinin odemesiyse ters kaydedip kapamadan sonra ayrilan carisine girin.`,
      );
    }
    if (remaining.length > 0) {
      warnings.push('Dairede ayni donemde kalan baska sakin/malik var; kapama tum cariyi devreder.');
    }
    if (candidates.length === 0) warnings.push('Bu tarihte bu tarafta kayitli uyelik yok.');

    return {
      unitId: unit.unitId,
      party,
      moveOutDate,
      sourceAccountId,
      closedThrough: source?.closedThrough,
      lateFeeMonthlyBasisPoints: r,
      ...plan,
      memberships: candidates.map((m) => ({
        userId: m.userId,
        relation: m.relation,
        residesInUnit: m.residesInUnit,
        startDate: m.startDate,
        endDate: m.endDate,
        change: changeOf(m, party).change,
      })),
      incomingOwners: incomingOwners.map((m) => ({ userId: m.userId, startDate: m.startDate })),
      targets: {
        debt: party === 'occupant' ? (['former', 'owner'] as DebtTarget[]) : (['former', ...(incomingOwners.length ? ['new_owner'] : [])] as DebtTarget[]),
        advance: party === 'occupant' ? (['refund', 'former', 'owner'] as AdvanceTarget[]) : (['refund', 'former'] as AdvanceTarget[]),
      },
      warnings,
    };
  }

  // ----- Kapama -----

  function parseCreate(body: unknown): Parsed {
    const o = asObject(body);
    const idempotencyKey = reqString(o, 'idempotencyKey', 100);
    if (idempotencyKey.length < 8) throw new ValidationError('idempotencyKey en az 8 karakter olmalidir', 'idempotencyKey');
    const party = reqEnum(o, 'party', PARTIES);
    const moveOutDate = reqDate(o.moveOutDate, 'moveOutDate');
    const userIds = parseUserIds(o.userIds);
    const debtTo = o.debtTo === undefined ? 'former' : reqEnum(o, 'debtTo', DEBT_TARGETS);
    const advanceTo = o.advanceTo === undefined ? 'former' : reqEnum(o, 'advanceTo', ADVANCE_TARGETS);
    if (party === 'owner' && (debtTo === 'owner' || advanceTo === 'owner')) {
      throw new ValidationError('Malik carisi kapatilirken hedef malik carisi olamaz', debtTo === 'owner' ? 'debtTo' : 'advanceTo');
    }
    if (party === 'occupant' && debtTo === 'new_owner') {
      throw new ValidationError('Yeni malike devir yalnizca malik carisi kapatilirken secilebilir', 'debtTo');
    }
    const newOwnerUserId = o.newOwnerUserId === undefined ? undefined : assertId(o.newOwnerUserId, 'newOwnerUserId');
    if (debtTo === 'new_owner' && !newOwnerUserId) throw new ValidationError('newOwnerUserId zorunlu', 'newOwnerUserId');
    const refundAccountId = o.refundAccountId === undefined ? undefined : assertId(o.refundAccountId, 'refundAccountId');
    const reason = optString(o, 'reason', 300) ?? '';
    if (reason.trim().length < 5) throw new ValidationError('Gerekce en az 5 karakter olmalidir', 'reason');
    return { idempotencyKey, party, moveOutDate, userIds, debtTo, advanceTo, newOwnerUserId, refundAccountId, reason: reason.trim() };
  }

  async function replay(ctx: ClosureContext, idemId: string, fp: string): Promise<CariClosure | undefined> {
    const existing = await repo.getIdempotency(ctx.apartmentId, idemId);
    if (!existing) return undefined;
    if (existing.fingerprint !== fp) throw new FinanceError('idempotency_conflict', 'Bu idempotencyKey farkli bir istekle kullanilmis');
    const closure = existing.recordId ? await deps.closures.get(ctx.apartmentId, existing.recordId) : undefined;
    if (!closure) throw new FinanceError('conflict', 'Kapama kaydi bulunamadi');
    return closure;
  }

  async function create(ctx: ClosureContext, unitId: string, body: unknown): Promise<{ closure: CariClosure; replayed: boolean }> {
    const unit = await requireUnit(ctx, unitId);
    const p = parseCreate(body);
    const idemId = `CLS_${p.idempotencyKey}`;
    const fp = fingerprint({ op: 'closure', unitId: unit.unitId, ...p, idempotencyKey: undefined });
    const prior = await replay(ctx, idemId, fp);
    if (prior) return { closure: prior, replayed: true };

    if (p.moveOutDate > today()) throw new ValidationError('Cikis tarihi bugunden sonra olamaz', 'moveOutDate');
    const sourceAccountId = mainReceivableId(unit.unitId, p.party);
    const [source, memberships, txPage, r] = await Promise.all([
      repo.getAccount(ctx.apartmentId, sourceAccountId),
      deps.memberships.list(ctx.apartmentId, { unitId: unit.unitId }),
      repo.listTransactions(ctx.apartmentId),
      rate(ctx.apartmentId),
    ]);
    if (source?.closedThrough && p.moveOutDate <= source.closedThrough) {
      throw new FinanceError('unprocessable', `Bu cari ${trDate(source.closedThrough)} tarihine kadar zaten kapatilmis`);
    }

    // Uyelikler: secilenler bu tarafta D gunu kayitli olmali.
    const unitMembers = memberships.filter((m) => m.unitId === unit.unitId && m.apartmentId === ctx.apartmentId);
    const eligible = leavers(unitMembers, p.party, p.moveOutDate);
    const leaving = p.userIds.map((id) => {
      const m = eligible.find((x) => x.userId === id);
      if (!m) throw new ValidationError(`Kullanici ${id} bu tarihte bu cariye bagli degil`, 'userIds');
      return m;
    });
    let newOwnerStart: IsoDate | undefined;
    if (p.debtTo === 'new_owner') {
      const m = unitMembers.find((x) => x.userId === p.newOwnerUserId && x.status === 'active' && x.relation === 'owner');
      if (!m || m.startDate <= p.moveOutDate) {
        throw new ValidationError('Yeni malikin uyeligi cikis tarihinden sonra baslamali (once yeni malik uyeligini ekleyin)', 'newOwnerUserId');
      }
      newOwnerStart = m.startDate;
    }

    const plan = planClosure(sourceAccountId, txPage.items, p.moveOutDate, r);
    const closureId = newClosureId();
    const formerId = `${sourceAccountId}-c${closureId}`;
    const ownerId = mainReceivableId(unit.unitId, 'owner');

    const targetOf = (to: DebtTarget | AdvanceTarget): string | undefined =>
      to === 'former' ? formerId : to === 'owner' ? ownerId : to === 'new_owner' ? sourceAccountId : p.refundAccountId;
    let targetAccountId: string | undefined;
    if (plan.debt > 0) targetAccountId = targetOf(p.debtTo);
    if (plan.advance > 0) {
      if (p.advanceTo === 'refund') {
        if (!p.refundAccountId) throw new ValidationError('Avans iadesi icin refundAccountId (kasa/banka) zorunlu', 'refundAccountId');
        const refund = await repo.getAccount(ctx.apartmentId, p.refundAccountId);
        if (!refund || refund.status !== 'active' || (refund.type !== 'cash' && refund.type !== 'bank')) {
          throw new ValidationError('refundAccountId aktif bir kasa veya banka hesabi olmali', 'refundAccountId');
        }
        if (refund.balance < plan.advance) throw new FinanceError('insufficient_funds', 'Iade icin hesapta yeterli bakiye yok');
      }
      targetAccountId = targetOf(p.advanceTo);
    }

    // Hesaplar (yoksa): sistem, ara hesap, ayrilan cari, malik carisi.
    await deps.finance.ensureSystemAccounts(ctx);
    const party = p.party;
    const ensure: Account[] = [
      account(ctx, { accountId: SYSTEM_ACCOUNTS.transferClearing, type: 'equity', name: 'Cari Devir Ara Hesabı', system: true }),
      account(ctx, {
        accountId: sourceAccountId,
        type: 'receivable',
        name: `Daire ${unit.unitId} - ${party === 'owner' ? 'Kat Maliki' : 'Kiraci/Sakin'}`,
        unitId: unit.unitId,
        liableParty: party,
      }),
    ];
    if (targetAccountId === formerId) {
      const starts = leaving.map((m) => m.startDate).sort();
      ensure.push(
        account(ctx, {
          accountId: formerId,
          type: 'receivable',
          name: `Daire ${unit.number} - Ayrılan ${party === 'owner' ? 'malik' : 'sakin'} (${trDate(p.moveOutDate)})`,
          unitId: unit.unitId,
          liableParty: party,
          closureId,
          holder: { userIds: p.userIds, ...(starts[0] ? { periodStart: starts[0] } : {}), periodEnd: p.moveOutDate },
        }),
      );
    }
    if (targetAccountId === ownerId) {
      ensure.push(account(ctx, { accountId: ownerId, type: 'receivable', name: `Daire ${unit.unitId} - Kat Maliki`, unitId: unit.unitId, liableParty: 'owner' }));
    }
    await repo.ensureAccounts(ensure);

    // Islemler
    const D = p.moveOutDate;
    const recvLine = (accountId: string, side: 'debit' | 'credit', amount: number, lp: LiableParty): TransactionLine => ({
      accountId,
      side,
      amount: toKurus(amount),
      unitId: unit.unitId,
      liableParty: lp,
    });
    const clearing = (side: 'debit' | 'credit', amount: number): TransactionLine => ({
      accountId: SYSTEM_ACCOUNTS.transferClearing,
      side,
      amount: toKurus(amount),
    });
    const targetParty: LiableParty = targetAccountId === ownerId ? 'owner' : party;
    const transactions: Transaction[] = [];
    const ids: CariClosure['transactionIds'] = {};

    if (plan.lateFee > 0) {
      const t = tx(ctx, {
        kind: 'late_fee',
        date: D,
        dueDate: D,
        description: 'Gecikme tazminatı (çıkış tarihine kadar)',
        reference: `LATE_FEE_CLOSE:${closureId}`,
        lines: [recvLine(sourceAccountId, 'debit', plan.lateFee, party), { accountId: SYSTEM_ACCOUNTS.incomeLateFee, side: 'credit', amount: toKurus(plan.lateFee) }],
      });
      transactions.push(t);
      ids.lateFee = t.transactionId;
    }
    if (plan.net !== 0) {
      const abs = Math.abs(plan.net);
      const debt = plan.net > 0;
      const close = tx(ctx, {
        kind: 'transfer',
        date: D,
        description: `Cari kapama (çıkış ${trDate(D)})`,
        reason: p.reason,
        transfer: { closureId, role: 'close', cutoff: D },
        lines: [recvLine(sourceAccountId, debt ? 'credit' : 'debit', abs, party), clearing(debt ? 'debit' : 'credit', abs)],
      });
      transactions.push(close);
      ids.close = close.transactionId;

      if (!debt && p.advanceTo === 'refund') {
        const refund = tx(ctx, {
          kind: 'refund',
          date: today(),
          description: `Avans iadesi (çıkış ${trDate(D)})`,
          reason: p.reason,
          lines: [clearing('debit', abs), { accountId: p.refundAccountId as string, side: 'credit', amount: toKurus(abs) }],
        });
        transactions.push(refund);
        ids.refund = refund.transactionId;
      } else {
        // Ayni hesaba yeni malik adina acilis: yeni malikin baslangic gunu (kesimden sonra).
        const openDate = p.debtTo === 'new_owner' && debt ? (newOwnerStart as IsoDate) : D;
        const open = tx(ctx, {
          kind: 'transfer',
          date: openDate,
          description: debt ? `Devreden borç (${trDate(D)} çıkış)` : `Devreden avans (${trDate(D)} çıkış)`,
          reason: p.reason,
          transfer: { closureId, role: 'open', ...(debt ? { items: plan.items } : {}) },
          lines: [recvLine(targetAccountId as string, debt ? 'debit' : 'credit', abs, targetParty), clearing(debt ? 'credit' : 'debit', abs)],
        });
        transactions.push(open);
        ids.open = open.transactionId;
      }
    }

    const ts = stamp();
    const changes = leaving.map((m) => changeOf(m, party));
    const replaceRecords: ReplaceRecord[] = leaving.map((m) => {
      const change = changeOf(m, party);
      const next: UnitMembership = {
        ...m,
        // Ayrilan uyelik kapamayla hemen sona erer: pasif + bitis = cikis tarihi (cikis bugun olsa
        // bile daire listesinde "aktif kiraci" olarak kalmaz). Kapama kimligi geri alma icin tutulur.
        ...(change.change === 'ended'
          ? { endDate: !m.endDate || m.endDate > D ? D : m.endDate, status: 'inactive' as const, endedByClosureId: closureId }
          : { residesInUnit: false }),
        updatedAt: ts,
        updatedBy: ctx.userId,
        version: m.version + 1,
      };
      return { item: { ...next, ...membershipGsi1(next) }, expectedVersion: m.version, label: `membership:${m.userId}` };
    });

    const closure: CariClosure = {
      ...closureKeys.closure(ctx.apartmentId, closureId),
      entityType: 'CARI_CLOSURE',
      closureId,
      apartmentId: ctx.apartmentId,
      unitId: unit.unitId,
      party,
      moveOutDate: D,
      sourceAccountId,
      userIds: p.userIds,
      debtTo: p.debtTo,
      advanceTo: p.advanceTo,
      ...(p.newOwnerUserId ? { newOwnerUserId: p.newOwnerUserId } : {}),
      ...(p.refundAccountId ? { refundAccountId: p.refundAccountId } : {}),
      ...(targetAccountId ? { targetAccountId } : {}),
      lateFee: toKurus(plan.lateFee),
      debt: toKurus(plan.debt),
      advance: toKurus(plan.advance),
      items: plan.items,
      membershipChanges: changes,
      transactionIds: ids,
      ...(source?.closedThrough ? { previousClosedThrough: source.closedThrough } : {}),
      status: 'completed',
      reason: p.reason,
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };

    try {
      await repo.postBatch({
        transactions,
        idempotency: { id: idemId, fingerprint: fp, recordId: closureId, transactionIds: transactions.map((t) => t.transactionId) },
        newDocs: [closure],
        replaceRecords,
        accountPatches: { [sourceAccountId]: { closedThrough: D } },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError) {
        if (err.reason === 'duplicate') {
          const again = await replay(ctx, idemId, fp);
          if (again) return { closure: again, replayed: true };
        }
        if (err.reason === 'closed') throw new FinanceError('unprocessable', 'Bu cari bu tarihe kadar zaten kapatilmis');
        if (err.reason === 'precondition') throw new FinanceError('conflict', 'Uyelik kaydi es zamanli degisti; tekrar deneyin');
        throw new FinanceError('conflict', 'Es zamanli bir islem cakismasi oldu, tekrar deneyin');
      }
      throw err;
    }
    return { closure, replayed: false };
  }

  // ----- Okuma -----

  async function listForUnit(ctx: ClosureContext, unitId: string) {
    const unit = await requireUnit(ctx, unitId);
    return (await deps.closures.list(ctx.apartmentId))
      .filter((c) => c.apartmentId === ctx.apartmentId && c.unitId === unit.unitId)
      .sort((a, b) => b.moveOutDate.localeCompare(a.moveOutDate) || b.createdAt.localeCompare(a.createdAt));
  }

  async function get(ctx: ClosureContext, closureId: string): Promise<CariClosure> {
    assertId(closureId, 'closureId');
    const c = await deps.closures.get(ctx.apartmentId, closureId);
    if (!c || c.apartmentId !== ctx.apartmentId) throw new FinanceError('not_found', 'Kapama kaydi bulunamadi');
    return c;
  }

  // ----- Geri alma -----

  /**
   * Kapamanin uyelik degisikliklerini geri yukler (ayni atomik yazimda, surum kosullu):
   * `ended` -> yeniden aktif, onceki bitis tarihi; `not_resident` -> onceki oturma bilgisi.
   * Kapamadan sonra elle degistirilmis (artik bu kapamayla bitmis gorunmeyen) uyelige dokunulmaz.
   * Bu duzeltmeden once yapilmis kapamalar (uyelik aktif, bitis = cikis tarihi) de geri yuklenir.
   */
  function restoreMemberships(closure: CariClosure, members: UnitMembership[], ts: IsoDateTime, userId: string): ReplaceRecord[] {
    const out: ReplaceRecord[] = [];
    for (const change of closure.membershipChanges) {
      const m = members.find((x) => x.userId === change.userId && x.unitId === closure.unitId && x.apartmentId === closure.apartmentId);
      if (!m) continue;
      let next: UnitMembership | undefined;
      if (change.change === 'ended') {
        const endedHere =
          m.endedByClosureId === closure.closureId || (!m.endedByClosureId && m.status === 'active' && m.endDate === closure.moveOutDate);
        if (!endedHere) continue;
        const { endDate: _e, endedByClosureId: _c, ...rest } = m;
        next = { ...rest, status: 'active', ...(change.previousEndDate ? { endDate: change.previousEndDate } : {}) } as UnitMembership;
      } else {
        const resides = change.previousResidesInUnit ?? true;
        if (m.residesInUnit === resides) continue;
        next = { ...m, residesInUnit: resides };
      }
      next = { ...next, updatedAt: ts, updatedBy: userId, version: m.version + 1 };
      out.push({ item: { ...next, ...membershipGsi1(next) }, expectedVersion: m.version, label: `membership:${m.userId}` });
    }
    return out;
  }

  async function reverse(ctx: ClosureContext, closureId: string, body: unknown): Promise<CariClosure> {
    const o = asObject(body);
    const reason = (optString(o, 'reason', 300) ?? '').trim();
    if (reason.length < 5) throw new ValidationError('Gerekce en az 5 karakter olmalidir', 'reason');
    const closure = await get(ctx, closureId);
    if (closure.status === 'reversed') throw new FinanceError('conflict', 'Kapama zaten geri alinmis');
    if (closure.transactionIds.refund) {
      throw new FinanceError('unprocessable', 'Avans iade edildigi icin kapama geri alinamaz; duzeltmeyi elle kayitla yapin');
    }

    const [txPage, source, unitMembers] = await Promise.all([
      repo.listTransactions(ctx.apartmentId),
      repo.getAccount(ctx.apartmentId, closure.sourceAccountId),
      deps.memberships.list(ctx.apartmentId, { unitId: closure.unitId }),
    ]);
    const all = txPage.items;
    const byId = new Map(all.map((t) => [t.transactionId, t]));
    const cancelled = cancelledIn(all);
    if (source?.closedThrough && source.closedThrough > closure.moveOutDate) {
      throw new FinanceError('unprocessable', 'Bu cari daha sonra tekrar kapatilmis; once sonraki kapamayi geri alin');
    }

    const toReverse: Transaction[] = [];
    const close = closure.transactionIds.close ? byId.get(closure.transactionIds.close) : undefined;
    const open = closure.transactionIds.open ? byId.get(closure.transactionIds.open) : undefined;
    if (close && !cancelled.has(close.transactionId)) toReverse.push(close);

    if (open && !cancelled.has(open.transactionId) && closure.targetAccountId) {
      const target = closure.targetAccountId;
      const own = new Set(Object.values(closure.transactionIds));
      const isFormer = target.endsWith(`-c${closure.closureId}`);
      if (isFormer) {
        // Ayrilan caride yalnizca bu kapamanin acilisi ve sistemin yazdigi tazminatlar olabilir.
        const others = linesOfAccount(target, all).filter((l) => !own.has(l.transaction.transactionId) && !cancelled.has(l.transaction.transactionId));
        if (others.some((l) => l.transaction.kind !== 'late_fee')) {
          throw new FinanceError('unprocessable', 'Ayrilan sakin carisinde tahsilat veya duzeltme var; kapama geri alinamaz');
        }
        toReverse.push(...[...new Set(others.map((l) => l.transaction))]);
      } else {
        // Paylasilan cari (malik / yeni malik): devredilen kalemler hic mahsup edilmemis olmali.
        const sub = readSubledger(linesOfAccount(target, all), cancelled);
        const { all: allocated, advance } = allocate(sub, today());
        if (closure.debt > 0) {
          const touched = (open.transfer?.items ?? []).some((_, i) => {
            const c = allocated.find((x) => x.id === transferItemId(open.transactionId, i));
            return !c || c.paid > 0;
          });
          if (touched) throw new FinanceError('unprocessable', 'Devredilen kalemlere tahsilat mahsup edilmis; kapama geri alinamaz');
        } else if (advance < closure.advance) {
          throw new FinanceError('unprocessable', 'Devredilen avans kullanilmis; kapama geri alinamaz');
        }
      }
      toReverse.push(open);
    }

    const date = today();
    const reversals = toReverse.map((t) =>
      tx(ctx, {
        kind: 'reversal',
        date,
        description: `Ters kayit: ${t.description}`,
        reversalOf: t.transactionId,
        reason,
        lines: t.lines.map((l) => ({ ...l, side: l.side === 'debit' ? 'credit' : 'debit' })),
      }),
    );
    const ts = stamp();
    const membershipRestores = restoreMemberships(closure, unitMembers, ts, ctx.userId);
    const next: CariClosure = {
      ...closure,
      status: 'reversed',
      reversal: { at: ts, by: ctx.userId, reason, transactionIds: reversals.map((t) => t.transactionId) },
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: closure.version + 1,
    };
    try {
      await repo.postBatch({
        transactions: reversals,
        idempotency: { id: `CLS_REV_${closure.closureId}`, fingerprint: fingerprint({ op: 'closure_reverse', closureId }), recordId: closure.closureId },
        replaceRecords: [{ item: next, expectedVersion: closure.version, label: 'closure' }, ...membershipRestores],
        accountPatches: {
          [closure.sourceAccountId]: { closedThrough: closure.previousClosedThrough ?? null, bypassLock: true },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError) {
        if (err.reason === 'duplicate' || err.reason === 'precondition') throw new FinanceError('conflict', 'Kapama zaten geri alinmis veya es zamanli degisti');
        throw new FinanceError('conflict', 'Es zamanli bir islem cakismasi oldu, tekrar deneyin');
      }
      throw err;
    }
    return next;
  }

  return { preview, create, listForUnit, get, reverse };
}

export type ClosureService = ReturnType<typeof createClosureService>;
