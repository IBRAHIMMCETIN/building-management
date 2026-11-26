/**
 * Finans 2.2 - Avans mahsubu (plan: claude/finans-2-2-mahsup-yapilandirma-plani.md).
 *
 * Bir alt carideki serbest avans (alacak bakiyesi) baska bir alt carinin acik borcuna mahsup
 * edilir. TEK `offset` islemi: borc kaynak alt cari (avansi tuketir), alacak hedef alt cari
 * (istege bagli `settles` ile secilen kalemlere; yoksa FIFO). Islemle ayni atomik yazimda
 * `OFFSET#<id>` kaydi, idempotency ve denetim kaydi yazilir.
 *
 * Kurallar:
 *  - Kaynak ve hedef ayni apartmanda, daireye bagli `receivable` hesaplar ve birbirinden farkli.
 *  - Tutar <= kaynagin serbest avansi ve <= hedefin acik borcu (kismi mahsup serbest).
 *  - Ayni kisi: kaynagin sahipleri (paydas carisi: paydas; ayrilan cari: `holder`; ana cari:
 *    bugun o tarafta kayitli uyeler) hedefin sahiplerinin alt kumesi. Degilse (ucuncu kisinin
 *    borcuna mahsup) "muvafakat alindi" beyani + aciklama zorunlu; kayitta ve denetimde isaretli.
 *  - Geri alma yalnizca bu modulden: ters kayit + kayit `reversed` (ters kayit ucu reddeder).
 *
 * Sakin talebi (`OFFSETREQ#<id>`): sakin portaldan kendi carileri arasinda talep acar; yonetici
 * onaylar (mahsup yazilir, talep `approved`) veya reddeder (`rejected`).
 */
import { createHash, randomUUID } from 'node:crypto';
import { getTenantItem, queryTenantAll, skKey, tenantPk } from '../../config/dynamodb.js';
import { type IsoDate, type IsoDateTime, type Kurus, type LiableParty, type TableKeys, toKurus } from '../core/types.js';
import { ValidationError, asObject, assertId, optString, reqString } from '../core/validation.js';
import { type MembershipRepository, membershipRepository } from '../memberships/repository.js';
import type { PortalContext, PortalService } from '../portal/service.js';
import { coversDay } from './occupancy.js';
import { type FinanceRepository, LedgerConflictError, accountTransactions, financeKeys, financeRepository } from './repository.js';
import { FinanceError } from './service.js';
import { type AllocatedCharge, allocate, cancelledIn, linesOfAccount, readSubledger } from './subledger.js';
import { type Account, type ChargeSettlement, type Transaction, mainReceivableId } from './types.js';

// ---------------------------------------------------------------------------
// Kayitlar
// ---------------------------------------------------------------------------

export type OffsetConsent = { thirdParty: true; note: string };

/** PK = `APT#<apartmentId>`, SK = `OFFSET#<offsetId>` */
export type AccountOffset = TableKeys & {
  entityType: 'ACCOUNT_OFFSET';
  offsetId: string;
  apartmentId: string;
  sourceAccountId: string;
  targetAccountId: string;
  sourceUnitId: string;
  targetUnitId: string;
  amount: Kurus;
  date: IsoDate;
  settles?: ChargeSettlement[];
  /** Kaynagin sahipleri hedefin sahiplerinin alt kumesi mi? */
  samePerson: boolean;
  /** Farkli kisiler arasi mahsupta muvafakat beyani (denetimde isaretli). */
  consent?: OffsetConsent;
  /** Sakin talebinden olustuysa. */
  requestId?: string;
  transactionId: string;
  status: 'completed' | 'reversed';
  reason: string;
  reversal?: { at: IsoDateTime; by: string; reason: string; transactionId: string };
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

export const OFFSET_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type OffsetRequestStatus = (typeof OFFSET_REQUEST_STATUSES)[number];

/** PK = `APT#<apartmentId>`, SK = `OFFSETREQ#<requestId>` */
export type OffsetRequest = TableKeys & {
  entityType: 'OFFSET_REQUEST';
  requestId: string;
  apartmentId: string;
  /** Talebi acan sakin. */
  userId: string;
  unitId: string;
  sourceAccountId: string;
  targetAccountId: string;
  amount: Kurus;
  note?: string;
  status: OffsetRequestStatus;
  decision?: { at: IsoDateTime; by: string; reason: string; offsetId?: string; amount?: Kurus };
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

export const offsetKeys = {
  offset: (apartmentId: string, offsetId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('OFFSET', offsetId) }),
  request: (apartmentId: string, requestId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('OFFSETREQ', requestId) }),
};

export type OffsetRepository = {
  get(apartmentId: string, offsetId: string): Promise<AccountOffset | undefined>;
  list(apartmentId: string): Promise<AccountOffset[]>;
  getRequest(apartmentId: string, requestId: string): Promise<OffsetRequest | undefined>;
  listRequests(apartmentId: string): Promise<OffsetRequest[]>;
};

export const offsetRepository: OffsetRepository = {
  get: (apartmentId, offsetId) => getTenantItem<AccountOffset>(offsetKeys.offset(apartmentId, offsetId)),
  // `OFFSET#` oneki `OFFSETREQ#` kayitlarini da kapsar; varlik turuyle ayrilir.
  list: async (apartmentId) =>
    (await queryTenantAll<AccountOffset>(apartmentId, 'OFFSET#', { ConsistentRead: true })).filter((o) => o.entityType === 'ACCOUNT_OFFSET'),
  getRequest: (apartmentId, requestId) => getTenantItem<OffsetRequest>(offsetKeys.request(apartmentId, requestId)),
  listRequests: (apartmentId) => queryTenantAll<OffsetRequest>(apartmentId, 'OFFSETREQ#', { ConsistentRead: true }),
};

// ---------------------------------------------------------------------------
// Saf yardimcilar
// ---------------------------------------------------------------------------

export type AccountPosition = { advance: Kurus; openDebt: Kurus; open: AllocatedCharge[] };

/** Alt carinin serbest avansi ve acik borcu (kapama kesimi ve hedefli kapamalar dahil). */
export function accountPosition(accountId: string, transactions: readonly Transaction[], today: IsoDate): AccountPosition {
  const sub = readSubledger(linesOfAccount(accountId, transactions), cancelledIn(transactions));
  const { open, advance } = allocate(sub, today);
  return { advance, openDebt: toKurus(open.reduce((s, c) => s + c.remaining, 0)), open };
}

type MemberLike = Parameters<typeof coversDay>[0] & { userId: string; apartmentId: string };

/** Alt carinin sahipleri (karar 5: ayni kisi kontrolu). */
export function holdersOf(account: Account, members: readonly MemberLike[], day: IsoDate): string[] {
  if (account.coOwner) return [account.coOwner.userId];
  if (account.holder) return [...account.holder.userIds].sort();
  if (!account.unitId || !account.liableParty || account.accountId !== mainReceivableId(account.unitId, account.liableParty)) return [];
  const party = account.liableParty;
  return [
    ...new Set(
      members
        .filter((m) => m.unitId === account.unitId && coversDay(m, day))
        .filter((m) => (party === 'owner' ? m.relation === 'owner' : m.relation === 'tenant' || m.residesInUnit))
        .map((m) => m.userId),
    ),
  ].sort();
}

/** Kaynagin her sahibi hedefin de sahibi mi? (bos kaynak: hayir) */
export const isSamePerson = (source: readonly string[], target: readonly string[]) =>
  source.length > 0 && source.every((u) => target.includes(u));

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

export type OffsetContext = { apartmentId: string; userId: string };

export type OffsetServiceDeps = {
  financeRepo: FinanceRepository;
  offsets: OffsetRepository;
  memberships: Pick<MembershipRepository, 'list'>;
  /** Sakin talepleri icin (portal erisim kurallari). */
  portal?: Pick<PortalService, 'resolveUnit'>;
  now: () => Date;
  newId: () => string;
};

const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compact = (d: IsoDate) => d.replaceAll('-', '');
const MAX_PENDING_REQUESTS = 5;

function reqReason(o: Record<string, unknown>, field = 'reason'): string {
  const reason = (optString(o, field, 300) ?? '').trim();
  if (reason.length < 5) throw new ValidationError('Gerekce en az 5 karakter olmalidir', field);
  return reason;
}

function reqKey(o: Record<string, unknown>): string {
  const key = reqString(o, 'idempotencyKey', 100);
  if (key.length < 8 || !/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new ValidationError('idempotencyKey 8-100 karakter, yalnizca harf/rakam/-/_ olmalidir', 'idempotencyKey');
  }
  return key;
}

function reqAmount(o: Record<string, unknown>, field = 'amount'): Kurus {
  const v = o[field];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new ValidationError(`${field} pozitif tam sayi (kurus) olmalidir`, field);
  return toKurus(v);
}

function parseSettles(value: unknown): ChargeSettlement[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) throw new ValidationError('settles 1-50 ogeli dizi olmalidir', 'settles');
  const out = value.map((v, i) => {
    const o = asObject(v, `settles[${i}]`);
    return { chargeId: assertId(o.chargeId, `settles[${i}].chargeId`), amount: reqAmount(o, 'amount') };
  });
  if (new Set(out.map((s) => s.chargeId)).size !== out.length) throw new ValidationError('settles ayni kalemi iki kez iceremez', 'settles');
  return out;
}

function parseConsent(value: unknown): OffsetConsent | undefined {
  if (value === undefined || value === null) return undefined;
  const o = asObject(value, 'consent');
  if (o.thirdParty !== true) throw new ValidationError('consent.thirdParty true olmalidir', 'consent.thirdParty');
  const note = (optString(o, 'note', 300) ?? '').trim();
  if (note.length < 5) throw new ValidationError('Muvafakat aciklamasi en az 5 karakter olmalidir', 'consent.note');
  return { thirdParty: true, note };
}

export type OffsetInput = {
  sourceAccountId: string;
  targetAccountId: string;
  amount: Kurus;
  settles?: ChargeSettlement[];
  consent?: OffsetConsent;
  reason: string;
  requestId?: string;
};

export function createOffsetService(overrides: Partial<OffsetServiceDeps> = {}) {
  const deps: OffsetServiceDeps = {
    financeRepo: financeRepository,
    offsets: offsetRepository,
    memberships: membershipRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.financeRepo;
  const stamp = (): IsoDateTime => deps.now().toISOString();
  const today = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());
  const shortId = () => deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 16);

  async function requireReceivable(ctx: OffsetContext, accountId: string, field: string): Promise<Account & { unitId: string; liableParty: LiableParty }> {
    assertId(accountId, field);
    const a = await repo.getAccount(ctx.apartmentId, accountId);
    if (!a || a.siteId !== ctx.apartmentId) throw new FinanceError('not_found', 'Hesap bulunamadi');
    if (a.type !== 'receivable' || !a.unitId || !a.liableParty) throw new ValidationError(`${field} daireye bagli bir alt cari olmali`, field);
    return a as Account & { unitId: string; liableParty: LiableParty };
  }

  /** Mahsubun on kosullari (yazmaz). */
  async function analyze(ctx: OffsetContext, sourceAccountId: string, targetAccountId: string) {
    if (sourceAccountId === targetAccountId) throw new ValidationError('Kaynak ve hedef ayni cari olamaz', 'targetAccountId');
    const [source, target] = await Promise.all([
      requireReceivable(ctx, sourceAccountId, 'sourceAccountId'),
      requireReceivable(ctx, targetAccountId, 'targetAccountId'),
    ]);
    const day = today();
    const unitIds = [...new Set([source.unitId, target.unitId])];
    // P1-a: yalnizca kaynak ve hedef carinin satirlari (tum defter okunmaz).
    const [txPage, ...memberLists] = await Promise.all([
      accountTransactions(repo, ctx.apartmentId, [source.accountId, target.accountId]).then((items) => ({ items })),
      ...unitIds.map((u) => deps.memberships.list(ctx.apartmentId, { unitId: u })),
    ]);
    const members = memberLists.flat().filter((m) => m.apartmentId === ctx.apartmentId);
    const txs = txPage.items;
    const src = accountPosition(source.accountId, txs, day);
    const tgt = accountPosition(target.accountId, txs, day);
    const sourceHolders = holdersOf(source, members, day);
    const targetHolders = holdersOf(target, members, day);
    const samePerson = isSamePerson(sourceHolders, targetHolders);
    return {
      day,
      source,
      target,
      sourceAdvance: src.advance,
      targetOpenDebt: tgt.openDebt,
      targetOpen: tgt.open,
      maxAmount: toKurus(Math.min(src.advance, tgt.openDebt)),
      samePerson,
      sourceHolders,
      targetHolders,
    };
  }

  async function preview(ctx: OffsetContext, body: unknown) {
    const o = asObject(body);
    const a = await analyze(ctx, assertId(o.sourceAccountId, 'sourceAccountId'), assertId(o.targetAccountId, 'targetAccountId'));
    return {
      sourceAccountId: a.source.accountId,
      targetAccountId: a.target.accountId,
      sourceAdvance: a.sourceAdvance,
      targetOpenDebt: a.targetOpenDebt,
      maxAmount: a.maxAmount,
      samePerson: a.samePerson,
      consentRequired: !a.samePerson,
      targetOpenItems: a.targetOpen.map((c) => ({
        chargeId: c.id,
        description: c.description,
        dueDate: c.dueDate,
        remaining: c.remaining,
        overdue: c.overdue,
        ...(c.lateFee ? { lateFee: true } : {}),
        ...(c.plan ? { plan: c.plan } : {}),
      })),
    };
  }

  async function replay(ctx: OffsetContext, idemId: string, fp: string): Promise<AccountOffset | undefined> {
    const existing = await repo.getIdempotency(ctx.apartmentId, idemId);
    if (!existing) return undefined;
    if (existing.fingerprint !== fp) throw new FinanceError('idempotency_conflict', 'Bu idempotencyKey farkli bir istekle kullanilmis');
    const offset = existing.recordId ? await deps.offsets.get(ctx.apartmentId, existing.recordId) : undefined;
    if (!offset) throw new FinanceError('conflict', 'Mahsup kaydi bulunamadi');
    return offset;
  }

  /** Dogrulanmis mahsubun atomik yazimi (yonetici ucu ve talep onayi ortak). */
  async function post(
    ctx: OffsetContext,
    input: OffsetInput,
    idem: { id: string; fp: string },
    extra: { request?: { current: OffsetRequest; next: OffsetRequest } } = {},
  ): Promise<AccountOffset> {
    const a = await analyze(ctx, input.sourceAccountId, input.targetAccountId);
    if (a.sourceAdvance < 1) throw new FinanceError('unprocessable', 'Kaynak caride mahsup edilebilir avans yok');
    if (a.targetOpenDebt < 1) throw new FinanceError('unprocessable', 'Hedef caride acik borc yok');
    if (input.amount > a.sourceAdvance) throw new FinanceError('unprocessable', `Tutar kaynagin serbest avansini (${a.sourceAdvance} kurus) asiyor`);
    if (input.amount > a.targetOpenDebt) throw new FinanceError('unprocessable', `Tutar hedefin acik borcunu (${a.targetOpenDebt} kurus) asiyor`);
    if (input.settles) {
      const total = input.settles.reduce((s, x) => s + x.amount, 0);
      if (total !== input.amount) throw new ValidationError('settles toplami tutara esit olmalidir', 'settles');
      for (const st of input.settles) {
        const c = a.targetOpen.find((x) => x.id === st.chargeId);
        if (!c) throw new ValidationError(`Kalem ${st.chargeId} hedef caride acik degil`, 'settles');
        if (st.amount > c.remaining) throw new ValidationError(`Kalem ${st.chargeId} icin tutar kalan borcu asiyor`, 'settles');
      }
    }
    if (!a.samePerson && !input.consent) {
      throw new FinanceError('unprocessable', 'Farkli kisiler arasi mahsup icin muvafakat beyani (consent) ve aciklama zorunlu');
    }
    for (const acc of [a.source, a.target]) {
      if (acc.closedThrough && a.day <= acc.closedThrough) throw new FinanceError('conflict', `${acc.accountId} bugune kadar kapatilmis`);
    }

    const offsetId = shortId();
    const ts = stamp();
    const transactionId = `${compact(a.day)}-${deps.newId()}`;
    const description = `Avans mahsubu: ${a.source.name} → ${a.target.name}`;
    const tx: Transaction = {
      ...financeKeys.transaction(ctx.apartmentId, transactionId),
      entityType: 'TRANSACTION',
      transactionId,
      siteId: ctx.apartmentId,
      kind: 'offset',
      date: a.day,
      description,
      reason: input.reason,
      reference: `OFFSET:${offsetId}`,
      offsetId,
      lines: [
        { accountId: a.source.accountId, side: 'debit', amount: input.amount, unitId: a.source.unitId, liableParty: a.source.liableParty },
        {
          accountId: a.target.accountId,
          side: 'credit',
          amount: input.amount,
          unitId: a.target.unitId,
          liableParty: a.target.liableParty,
          ...(input.settles ? { settles: input.settles } : {}),
        },
      ],
      totalAmount: input.amount,
      createdAt: ts,
      createdBy: ctx.userId,
    };
    const offset: AccountOffset = {
      ...offsetKeys.offset(ctx.apartmentId, offsetId),
      entityType: 'ACCOUNT_OFFSET',
      offsetId,
      apartmentId: ctx.apartmentId,
      sourceAccountId: a.source.accountId,
      targetAccountId: a.target.accountId,
      sourceUnitId: a.source.unitId,
      targetUnitId: a.target.unitId,
      amount: input.amount,
      date: a.day,
      ...(input.settles ? { settles: input.settles } : {}),
      samePerson: a.samePerson,
      ...(input.consent && !a.samePerson ? { consent: input.consent } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      transactionId,
      status: 'completed',
      reason: input.reason,
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    const request = extra.request ? { ...extra.request.next, decision: { ...(extra.request.next.decision as NonNullable<OffsetRequest['decision']>), offsetId } } : undefined;
    try {
      await repo.postBatch({
        transactions: [tx],
        idempotency: { id: idem.id, fingerprint: idem.fp, recordId: offsetId, transactionIds: [transactionId] },
        // Bakiyeye bagli kural: hesaplar okunduktan sonra degistiyse (es zamanli tahsilat) reddedilir.
        expectedVersions: { [a.source.accountId]: a.source.version, [a.target.accountId]: a.target.version },
        newDocs: [offset],
        ...(request && extra.request ? { replaceRecords: [{ item: request, expectedVersion: extra.request.current.version, label: 'offset_request' }] } : {}),
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.offset',
          target: { type: 'offset', id: offsetId },
          actorId: ctx.userId,
          reason: input.reason,
          details: {
            sourceAccountId: offset.sourceAccountId,
            targetAccountId: offset.targetAccountId,
            amount: offset.amount,
            transactionId,
            samePerson: offset.samePerson,
            thirdPartyConsent: Boolean(offset.consent),
            ...(offset.consent ? { consentNote: offset.consent.note } : {}),
            ...(offset.requestId ? { requestId: offset.requestId } : {}),
            ...(offset.settles ? { settles: offset.settles } : {}),
          },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError) {
        if (err.reason === 'duplicate') {
          const again = await replay(ctx, idem.id, idem.fp);
          if (again) return again;
        }
        if (err.reason === 'closed') throw new FinanceError('conflict', 'Cari bu tarihe kadar kapatilmis');
        if (err.reason === 'precondition') throw new FinanceError('conflict', 'Talep es zamanli degisti; tekrar deneyin');
        throw new FinanceError('conflict', 'Es zamanli bir islem cakismasi oldu, tekrar deneyin');
      }
      throw err;
    }
    return { ...offset };
  }

  function parseCreate(body: unknown): { key: string; input: OffsetInput } {
    const o = asObject(body);
    const key = reqKey(o);
    return {
      key,
      input: {
        sourceAccountId: assertId(o.sourceAccountId, 'sourceAccountId'),
        targetAccountId: assertId(o.targetAccountId, 'targetAccountId'),
        amount: reqAmount(o),
        settles: parseSettles(o.settles),
        consent: parseConsent(o.consent),
        reason: reqReason(o),
      },
    };
  }

  async function create(ctx: OffsetContext, body: unknown): Promise<{ offset: AccountOffset; replayed: boolean }> {
    const { key, input } = parseCreate(body);
    const idemId = `OFS_${key}`;
    const fp = fingerprint({ op: 'offset', ...input });
    const prior = await replay(ctx, idemId, fp);
    if (prior) return { offset: prior, replayed: true };
    return { offset: await post(ctx, input, { id: idemId, fp }), replayed: false };
  }

  async function get(ctx: OffsetContext, offsetId: string): Promise<AccountOffset> {
    assertId(offsetId, 'offsetId');
    const o = await deps.offsets.get(ctx.apartmentId, offsetId);
    if (!o || o.apartmentId !== ctx.apartmentId) throw new FinanceError('not_found', 'Mahsup kaydi bulunamadi');
    return o;
  }

  async function list(ctx: OffsetContext, q: { accountId?: string } = {}) {
    const accountId = q.accountId ? assertId(q.accountId, 'accountId') : undefined;
    return (await deps.offsets.list(ctx.apartmentId))
      .filter((o) => o.apartmentId === ctx.apartmentId && (!accountId || o.sourceAccountId === accountId || o.targetAccountId === accountId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Ters kayitla geri alma (kaynak avansa, hedef borca doner). */
  async function reverse(ctx: OffsetContext, offsetId: string, body: unknown): Promise<AccountOffset> {
    const reason = reqReason(asObject(body));
    const offset = await get(ctx, offsetId);
    if (offset.status === 'reversed') throw new FinanceError('conflict', 'Mahsup zaten geri alinmis');
    const [original, source, target] = await Promise.all([
      repo.getTransaction(ctx.apartmentId, offset.transactionId),
      repo.getAccount(ctx.apartmentId, offset.sourceAccountId),
      repo.getAccount(ctx.apartmentId, offset.targetAccountId),
    ]);
    if (!original) throw new FinanceError('conflict', 'Mahsup islemi bulunamadi');
    for (const acc of [source, target]) {
      if (acc?.closedThrough && acc.closedThrough >= offset.date) {
        throw new FinanceError('unprocessable', `${acc.accountId} mahsuptan sonra kapatilmis; mahsup geri alinamaz`);
      }
    }
    const day = today();
    const ts = stamp();
    const transactionId = `${compact(day)}-${deps.newId()}`;
    const rev: Transaction = {
      ...financeKeys.transaction(ctx.apartmentId, transactionId),
      entityType: 'TRANSACTION',
      transactionId,
      siteId: ctx.apartmentId,
      kind: 'reversal',
      date: day,
      description: `Ters kayit: ${original.description}`,
      reversalOf: original.transactionId,
      reason,
      offsetId,
      lines: original.lines.map(({ settles: _s, ...l }) => ({ ...l, side: l.side === 'debit' ? 'credit' : 'debit' })),
      totalAmount: original.totalAmount,
      createdAt: ts,
      createdBy: ctx.userId,
    };
    const next: AccountOffset = {
      ...offset,
      status: 'reversed',
      reversal: { at: ts, by: ctx.userId, reason, transactionId },
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: offset.version + 1,
    };
    try {
      await repo.postBatch({
        transactions: [rev],
        idempotency: { id: `OFS_REV_${offsetId}`, fingerprint: fingerprint({ op: 'offset_reverse', offsetId }), recordId: offsetId, transactionIds: [transactionId] },
        replaceRecords: [{ item: next, expectedVersion: offset.version, label: 'offset' }],
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.offset_reverse',
          target: { type: 'offset', id: offsetId },
          actorId: ctx.userId,
          reason,
          details: { reversalTransactionId: transactionId, originalTransactionId: original.transactionId, amount: offset.amount },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError) {
        if (err.reason === 'duplicate' || err.reason === 'precondition') throw new FinanceError('conflict', 'Mahsup zaten geri alinmis veya es zamanli degisti');
        if (err.reason === 'closed') throw new FinanceError('unprocessable', 'Cari kapatilmis; mahsup geri alinamaz');
        throw new FinanceError('conflict', 'Es zamanli bir islem cakismasi oldu, tekrar deneyin');
      }
      throw err;
    }
    return next;
  }

  // -------------------------------------------------------------------------
  // Sakin talepleri
  // -------------------------------------------------------------------------

  function requirePortal(): Pick<PortalService, 'resolveUnit'> {
    if (!deps.portal) throw new FinanceError('unprocessable', 'Portal baglantisi yok');
    return deps.portal;
  }

  /**
   * Sakinin bu dairede secebilecegi cariler: hedef yalnizca guncel (gordugu) alt carileri; kaynak
   * ayrica sahibi oldugu ayrilan / paydas carileri (ornegin onceki donemden kalan avans).
   */
  async function portalAccounts(ctx: PortalContext, unitId?: string) {
    const resolved = await requirePortal().resolveUnit(ctx, unitId);
    const targets = [...new Set(resolved.parties.map((p) => resolved.accounts[p]))];
    const all = await repo.listAccounts(ctx.apartmentId);
    const own = all.filter(
      (a) =>
        a.type === 'receivable' &&
        a.unitId &&
        (a.holder?.userIds.includes(ctx.userId) || a.coOwner?.userId === ctx.userId),
    );
    const sources = [...new Set([...targets, ...own.map((a) => a.accountId)])];
    const byId = new Map(all.map((a) => [a.accountId, a]));
    return { unitId: resolved.unit.unitId, targets, sources, byId };
  }

  async function portalOptions(ctx: PortalContext, unitId?: string) {
    const { unitId: u, targets, sources, byId } = await portalAccounts(ctx, unitId);
    const day = today();
    const txs = await accountTransactions(repo, ctx.apartmentId, [...new Set([...sources, ...targets])]);
    const name = (id: string) => byId.get(id)?.name ?? id;
    return {
      unitId: u,
      sources: sources
        .map((id) => ({ accountId: id, name: name(id), advance: accountPosition(id, txs, day).advance }))
        .filter((x) => x.advance > 0),
      targets: targets
        .map((id) => ({ accountId: id, name: name(id), openDebt: accountPosition(id, txs, day).openDebt }))
        .filter((x) => x.openDebt > 0),
    };
  }

  async function createRequest(ctx: PortalContext, body: unknown): Promise<{ request: OffsetRequest; replayed: boolean }> {
    const o = asObject(body);
    const key = reqKey(o);
    const unitId = o.unitId === undefined ? undefined : assertId(o.unitId, 'unitId');
    const sourceAccountId = assertId(o.sourceAccountId, 'sourceAccountId');
    const targetAccountId = assertId(o.targetAccountId, 'targetAccountId');
    const amount = reqAmount(o);
    const note = (optString(o, 'note', 300) ?? '').trim();
    const idemId = `OFSR_${ctx.userId}_${key}`.slice(0, 120);
    const fp = fingerprint({ op: 'offset_request', unitId, sourceAccountId, targetAccountId, amount, note });
    const existing = await repo.getIdempotency(ctx.apartmentId, idemId);
    if (existing) {
      if (existing.fingerprint !== fp) throw new FinanceError('idempotency_conflict', 'Bu idempotencyKey farkli bir istekle kullanilmis');
      const r = existing.recordId ? await deps.offsets.getRequest(ctx.apartmentId, existing.recordId) : undefined;
      if (!r) throw new FinanceError('conflict', 'Talep kaydi bulunamadi');
      return { request: r, replayed: true };
    }

    const acc = await portalAccounts(ctx, unitId);
    if (!acc.sources.includes(sourceAccountId)) throw new ValidationError('Kaynak cari sizin carileriniz arasinda degil', 'sourceAccountId');
    if (!acc.targets.includes(targetAccountId)) throw new ValidationError('Hedef cari bu dairedeki carileriniz arasinda degil', 'targetAccountId');
    if (sourceAccountId === targetAccountId) throw new ValidationError('Kaynak ve hedef ayni cari olamaz', 'targetAccountId');
    const day = today();
    const txs = await accountTransactions(repo, ctx.apartmentId, [sourceAccountId, targetAccountId]);
    const src = accountPosition(sourceAccountId, txs, day);
    const tgt = accountPosition(targetAccountId, txs, day);
    if (amount > Math.min(src.advance, tgt.openDebt)) {
      throw new FinanceError('unprocessable', `Tutar en fazla ${Math.min(src.advance, tgt.openDebt)} kurus olabilir`);
    }
    const pending = (await deps.offsets.listRequests(ctx.apartmentId)).filter((r) => r.userId === ctx.userId && r.status === 'pending');
    if (pending.length >= MAX_PENDING_REQUESTS) throw new FinanceError('conflict', 'Bekleyen mahsup talebiniz cok fazla; yonetimin karar vermesini bekleyin');

    const requestId = shortId();
    const ts = stamp();
    const request: OffsetRequest = {
      ...offsetKeys.request(ctx.apartmentId, requestId),
      entityType: 'OFFSET_REQUEST',
      requestId,
      apartmentId: ctx.apartmentId,
      userId: ctx.userId,
      unitId: acc.unitId,
      sourceAccountId,
      targetAccountId,
      amount,
      ...(note ? { note } : {}),
      status: 'pending',
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    try {
      await repo.postBatch({
        transactions: [],
        idempotency: { id: idemId, fingerprint: fp, recordId: requestId },
        newDocs: [request],
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.offset_request',
          target: { type: 'offset_request', id: requestId },
          actorId: ctx.userId,
          details: { sourceAccountId, targetAccountId, amount, unitId: acc.unitId },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError && err.reason === 'duplicate') return createRequest(ctx, body);
      throw err;
    }
    return { request, replayed: false };
  }

  async function myRequests(ctx: PortalContext) {
    return (await deps.offsets.listRequests(ctx.apartmentId))
      .filter((r) => r.apartmentId === ctx.apartmentId && r.userId === ctx.userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function listRequests(ctx: OffsetContext, q: { status?: string } = {}) {
    if (q.status !== undefined && !(OFFSET_REQUEST_STATUSES as readonly string[]).includes(q.status)) {
      throw new ValidationError(`status su degerlerden biri olmalidir: ${OFFSET_REQUEST_STATUSES.join(', ')}`, 'status');
    }
    return (await deps.offsets.listRequests(ctx.apartmentId))
      .filter((r) => r.apartmentId === ctx.apartmentId && (!q.status || r.status === q.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function requireRequest(ctx: OffsetContext, requestId: string): Promise<OffsetRequest> {
    assertId(requestId, 'requestId');
    const r = await deps.offsets.getRequest(ctx.apartmentId, requestId);
    if (!r || r.apartmentId !== ctx.apartmentId) throw new FinanceError('not_found', 'Mahsup talebi bulunamadi');
    return r;
  }

  /**
   * Talebi onaylar: mahsup (talep tutari veya daha azi) + talep `approved` TEK atomik yazim. Kaynak
   * ve hedef farkli kisilere aitse yonetici muvafakat beyanini (consent) burada verir.
   */
  async function approveRequest(ctx: OffsetContext, requestId: string, body: unknown): Promise<{ request: OffsetRequest; offset: AccountOffset }> {
    const o = asObject(body);
    const current = await requireRequest(ctx, requestId);
    if (current.status !== 'pending') throw new FinanceError('conflict', 'Talep zaten sonuclandirilmis');
    const amount = o.amount === undefined ? current.amount : reqAmount(o);
    if (amount > current.amount) throw new ValidationError('Onaylanan tutar talep tutarini asamaz', 'amount');
    const reason = (optString(o, 'reason', 300) ?? '').trim() || `Sakin mahsup talebi onaylandı${current.note ? `: ${current.note}` : ''}`.slice(0, 300);
    if (reason.length < 5) throw new ValidationError('Gerekce en az 5 karakter olmalidir', 'reason');
    const ts = stamp();
    const next: OffsetRequest = {
      ...current,
      status: 'approved',
      decision: { at: ts, by: ctx.userId, reason, amount },
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: current.version + 1,
    };
    const input: OffsetInput = {
      sourceAccountId: current.sourceAccountId,
      targetAccountId: current.targetAccountId,
      amount,
      consent: parseConsent(o.consent),
      reason,
      requestId,
    };
    const offset = await post(ctx, input, { id: `OFSREQ_${requestId}`, fp: fingerprint({ op: 'offset_request_approve', requestId, amount }) }, { request: { current, next } });
    return { request: { ...next, decision: { ...(next.decision as NonNullable<OffsetRequest['decision']>), offsetId: offset.offsetId } }, offset };
  }

  async function rejectRequest(ctx: OffsetContext, requestId: string, body: unknown): Promise<OffsetRequest> {
    const reason = reqReason(asObject(body));
    const current = await requireRequest(ctx, requestId);
    if (current.status !== 'pending') throw new FinanceError('conflict', 'Talep zaten sonuclandirilmis');
    const ts = stamp();
    const next: OffsetRequest = {
      ...current,
      status: 'rejected',
      decision: { at: ts, by: ctx.userId, reason },
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: current.version + 1,
    };
    try {
      await repo.postBatch({
        transactions: [],
        idempotency: { id: `OFSREQ_REJ_${requestId}`, fingerprint: fingerprint({ op: 'offset_request_reject', requestId }), recordId: requestId },
        replaceRecords: [{ item: next, expectedVersion: current.version, label: 'offset_request' }],
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.offset_request_reject',
          target: { type: 'offset_request', id: requestId },
          actorId: ctx.userId,
          reason,
          details: { userId: current.userId, amount: current.amount },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError) throw new FinanceError('conflict', 'Talep zaten sonuclandirilmis veya es zamanli degisti');
      throw err;
    }
    return next;
  }

  return { preview, create, get, list, reverse, portalOptions, createRequest, myRequests, listRequests, approveRequest, rejectRequest };
}

export type OffsetService = ReturnType<typeof createOffsetService>;
