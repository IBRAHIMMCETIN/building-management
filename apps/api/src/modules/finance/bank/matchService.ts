import type { Role } from '../../../auth/claims.js';
import { DataAccessError } from '../../../config/dynamodb.js';
import type { AuditDraft } from '../../audit/log.js';
import { type CoreRepository, coreRepository } from '../../core/repository.js';
import type { IsoDate, Kurus, LiableParty } from '../../core/types.js';
import { ID_PATTERN, isIsoDate } from '../../core/validation.js';
import { type MembershipRepository, membershipRepository } from '../../memberships/repository.js';
import { accruedLateFeeOf } from '../../payments/quote.js';
import { type PortalRepository, portalRepository } from '../../portal/repository.js';
import type { PortalContext, PortalService } from '../../portal/service.js';
import { type PersonRepository, personRepository } from '../../residents/repository.js';
import { type FinanceRepository, LedgerConflictError, financeRepository } from '../repository.js';
import { DEFAULT_LATE_FEE_BASIS_POINTS, type FinanceService, type ResolvedBankAllocation } from '../service.js';
import { type Account, mainReceivableId } from '../types.js';
import { BankError } from './errors.js';
import { isValidTrIban, maskIban, normalizeIban } from './iban.js';
import { LINES_PAGE_MAX, bankKeys, isStatementId, istanbulDate, parseLineId } from './keys.js';
import { type MatchCandidate, type Suggestion, refCodeFor, suggestMatches, validateAllocations } from './matching.js';
import { type BankRepository, bankRepository } from './repository.js';
import { publicLine } from './service.js';
import {
  type BankAccountProfile,
  type BankDecision,
  type BankLine,
  type BankPayer,
  type BankRef,
  type BankRefOf,
  type LineStatus,
  MAX_ALLOCATIONS,
  type MatchAllocation,
} from './types.js';

/*
 * Faz B2 - Banka satiri eslestirme.
 *
 *   GET  /lines/:lineId/suggestions   oneriler (guven sirasiyla)
 *   GET  /queue                       satirlar + ilk oneri (eslestirme kuyrugu)
 *   GET  /targets                     eslestirilebilir alt cariler (diyalog aramasi)
 *   POST /lines/:lineId/match         tazminat kesinlestirme + tahsilat + makbuz + BANKMATCH + BANKTX + PAYER (tek yazim)
 *   POST /lines/:lineId/ignore        yoksay (gerekceli, defter kaydi yok)
 *   POST /lines/:lineId/unmatch       eslesmis: ters kayit; yoksayilmis: yeniden ac
 *   GET  /reconciliation              ekstre kapanis bakiyesi <-> defter banka bakiyesi + kuyruk ozeti
 *   GET  /accounts, PUT /accounts/:id/profile   banka hesaplari ve sakine gosterilen IBAN
 *   (portal) GET /api/portal/my-payment-reference   apartman IBAN'i + alt cari referans kodu
 */

export type BankMatchContext = { apartmentId: string; userId: string; role: Role };

export type BankMatchDeps = {
  repo: BankRepository;
  finance: Pick<FinanceService, 'recordBankPayment' | 'reverseBankPayments'>;
  accounts: Pick<FinanceRepository, 'getAccount' | 'listAccounts' | 'listTransactions'>;
  ledger: Pick<PortalRepository, 'listLedgerEntries' | 'getTransactions'>;
  core: Pick<CoreRepository, 'getSite' | 'getUnit' | 'listUnits' | 'listBlocks'>;
  memberships: Pick<MembershipRepository, 'list'>;
  people: Pick<PersonRepository, 'list'>;
  /** Sakin portali: daire ve gorunur alt cariler (uyelik kurallari tek kaynaktan). */
  portal?: Pick<PortalService, 'resolveUnit'>;
  now: () => Date;
};

const PARTY_LABEL: Record<LiableParty, string> = { owner: 'Kat maliki', occupant: 'Sakin (kiracı / oturan)' };
const LINE_STATUSES: readonly LineStatus[] = ['unmatched', 'matched', 'ignored'];

const fail = (message: string, field?: string): never => {
  throw new BankError('unprocessable', message, field ? { field } : undefined);
};
const asObj = (v: unknown): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail('Govde bir nesne olmalidir');
  return v as Record<string, unknown>;
};
const reqId = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !ID_PATTERN.test(v)) fail(`${field} gecersiz`, field);
  return v as string;
};
const reqVersion = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) fail('expectedVersion pozitif tam sayi olmalidir', 'expectedVersion');
  return v as number;
};
const reqReason = (v: unknown, required: boolean): string | undefined => {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || v.trim().length < 3 || v.length > 300) fail('reason 3-300 karakter olmalidir', 'reason');
  return (v as string).trim();
};

/** Denetci icin ad maskesi: "Ayşe Yılmaz" -> "A. Y." */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `${t[0]?.toLocaleUpperCase('tr-TR')}.`)
    .join(' ');

function publicDecision(d: BankDecision, all: readonly BankDecision[] = []) {
  const { PK: _pk, SK: _sk, ...rest } = d;
  const reversedBy = all.find((x) => x.reverses === d.decisionNo && (x.kind === 'unmatch' || x.kind === 'restore'))?.decisionNo;
  return { ...rest, ...(reversedBy ? { reversedBy } : {}) };
}

export function createBankMatchService(overrides: Partial<BankMatchDeps> & Pick<BankMatchDeps, 'finance'>) {
  const deps: BankMatchDeps = {
    repo: bankRepository,
    accounts: financeRepository,
    ledger: portalRepository,
    core: coreRepository,
    memberships: membershipRepository,
    people: personRepository,
    now: () => new Date(),
    ...overrides,
  };
  const today = () => istanbulDate(deps.now());
  const stamp = () => deps.now().toISOString();

  // -------------------------------------------------------------------------
  // Aday alt cariler (istek basina bir kez)
  // -------------------------------------------------------------------------

  async function loadCandidates(apartmentId: string, opts: { maskNames?: boolean } = {}) {
    const asOf = today();
    const from = istanbulDate(new Date(deps.now().getTime() - 62 * 86_400_000));
    const [accounts, units, blocks, memberships, people, refs, recent] = await Promise.all([
      deps.accounts.listAccounts(apartmentId),
      deps.core.listUnits(apartmentId),
      deps.core.listBlocks(apartmentId),
      deps.memberships.list(apartmentId),
      deps.people.list(apartmentId),
      deps.repo.listRefs(apartmentId),
      deps.accounts.listTransactions(apartmentId, { from }),
    ]);
    const unitById = new Map(units.map((u) => [u.unitId, u]));
    const blockName = new Map(blocks.map((b) => [b.blockId, b.name]));
    const nameOf = new Map(people.map((p) => [p.userId, p.fullName]));
    const show = (n: string) => (opts.maskNames ? initials(n) : n);

    // Alt cari -> sorumlu kisiler (bugun aktif uyelikler).
    const holders = new Map<string, Set<string>>();
    const addHolder = (accountId: string, userId: string) => {
      const n = nameOf.get(userId);
      if (!n) return;
      const set = holders.get(accountId) ?? new Set<string>();
      set.add(n);
      holders.set(accountId, set);
    };
    for (const m of memberships) {
      if (m.status !== 'active' || m.startDate > asOf || (m.endDate && m.endDate < asOf)) continue;
      if (m.relation === 'owner') addHolder(mainReceivableId(m.unitId, 'owner'), m.userId);
      if (m.relation === 'tenant' || m.residesInUnit) addHolder(mainReceivableId(m.unitId, 'occupant'), m.userId);
    }
    // Son aidat tahakkuku (aylik aidat tahmini).
    const lastDues = new Map<string, number>();
    for (const tx of recent.items.filter((t) => t.kind === 'dues_charge').sort((a, b) => a.date.localeCompare(b.date))) {
      for (const l of tx.lines) if (l.side === 'debit' && l.unitId) lastDues.set(l.accountId, l.amount);
    }
    const codeOf = new Map(refs.map((r) => [r.accountId, r.code]));

    const candidates: (MatchCandidate & { refCode?: string; accountName: string; partyLabel: string })[] = [];
    for (const a of accounts) {
      if (a.type !== 'receivable' || !a.unitId || !a.liableParty) continue;
      const unit = unitById.get(a.unitId);
      if (!unit) continue;
      const bName = blockName.get(unit.blockId);
      const former = a.accountId !== mainReceivableId(a.unitId, a.liableParty);
      for (const userId of a.holder?.userIds ?? []) addHolder(a.accountId, userId);
      candidates.push({
        accountId: a.accountId,
        unitId: a.unitId,
        liableParty: a.liableParty,
        ...(bName ? { blockName: bName } : {}),
        unitNumber: unit.number,
        unitLabel: bName ? `${bName} · ${unit.number}` : unit.number,
        holderNames: [...(holders.get(a.accountId) ?? [])].map(show),
        openBalance: Math.max(0, a.balance),
        ...(lastDues.has(a.accountId) ? { monthlyDues: lastDues.get(a.accountId) as number } : {}),
        ...(former ? { former: true } : {}),
        ...(a.closedThrough ? { closedThrough: a.closedThrough } : {}),
        ...(codeOf.has(a.accountId) ? { refCode: codeOf.get(a.accountId) as string } : {}),
        accountName: a.name,
        partyLabel: former ? `Ayrılan ${a.liableParty === 'owner' ? 'malik' : 'sakin'} carisi` : PARTY_LABEL[a.liableParty],
      });
    }
    candidates.sort((x, y) => x.unitLabel.localeCompare(y.unitLabel, 'tr', { numeric: true }) || x.accountId.localeCompare(y.accountId));
    // Oneri motoru gercek adlarla calisir; maskeleme yalnizca yanit icindir.
    const engineCandidates = opts.maskNames
      ? candidates.map((c) => ({ ...c, holderNames: [...(holders.get(c.accountId) ?? [])] }))
      : candidates;
    return { candidates, engineCandidates, refCodes: new Map(refs.map((r) => [r.code, r.accountId])) };
  }

  type Loaded = Awaited<ReturnType<typeof loadCandidates>>;

  function enrich(s: Suggestion, ctxData: Loaded) {
    const byId = new Map(ctxData.candidates.map((c) => [c.accountId, c]));
    return {
      ...s,
      allocations: s.allocations.map((a) => {
        const c = byId.get(a.accountId);
        return { ...a, unitLabel: c?.unitLabel ?? a.unitId, partyLabel: c?.partyLabel ?? PARTY_LABEL[a.liableParty], former: Boolean(c?.former) };
      }),
    };
  }

  async function suggestFor(apartmentId: string, line: BankLine, loaded: Loaded, limit = 5) {
    if (line.direction !== 'in') return [];
    const payer = line.counterpartyIbanMac ? await deps.repo.getPayer(apartmentId, line.counterpartyIbanMac) : undefined;
    return suggestMatches({
      line: { date: line.valueDate ?? line.date, direction: line.direction, amount: line.amount, description: line.description, ...(line.counterpartyName ? { counterpartyName: line.counterpartyName } : {}) },
      candidates: loaded.engineCandidates,
      refCodes: loaded.refCodes,
      ...(payer ? { payer: { accounts: payer.accounts.map((a) => ({ accountId: a.accountId, count: a.count })) } } : {}),
      limit,
    }).map((s) => enrich(s, loaded));
  }

  async function requireLine(ctx: BankMatchContext, bankAccountIdRaw: unknown, lineId: string): Promise<BankLine> {
    const bankAccountId = reqId(bankAccountIdRaw, 'bankAccountId');
    if (!parseLineId(lineId)) throw new BankError('not_found', 'Banka satiri bulunamadi');
    const line = await deps.repo.getLine(ctx.apartmentId, bankAccountId, lineId);
    if (!line) throw new BankError('not_found', 'Banka satiri bulunamadi');
    return line;
  }

  function checkVersion(line: BankLine, expected: number) {
    if (line.version !== expected) {
      throw new BankError('version_conflict', 'Satir baska bir islemle degisti; listeyi yenileyin', { currentVersion: line.version, status: line.status });
    }
  }

  /** Kapali cari icin ayni dairenin ayrilan carileri (arayuz onerir). */
  async function closedError(apartmentId: string, account: Account | undefined, accountId: string, closedThrough?: string) {
    const all = await deps.accounts.listAccounts(apartmentId);
    const formerAccounts = all
      .filter((a) => a.type === 'receivable' && account?.unitId && a.unitId === account.unitId && a.closureId && !a.closedThrough)
      .map((a) => ({ accountId: a.accountId, name: a.name, liableParty: a.liableParty, balance: a.balance }));
    return new BankError('account_closed', `Bu cari taşınma kapamasıyla ${closedThrough ?? ''} tarihine kadar kapatıldı; ayrılan cariyi seçin`, {
      ledgerConflict: 'closed',
      accountId,
      closedThrough,
      formerAccounts,
    });
  }

  function payerUpdate(apartmentId: string, existing: BankPayer | undefined, mac: string, allocations: readonly { accountId: string; unitId: string; liableParty: LiableParty }[], delta: 1 | -1) {
    const now = stamp();
    const accounts = [...(existing?.accounts ?? [])];
    for (const a of allocations) {
      const i = accounts.findIndex((x) => x.accountId === a.accountId);
      if (i >= 0) {
        const cur = accounts[i] as BankPayer['accounts'][number];
        accounts[i] = { ...cur, count: Math.max(0, cur.count + delta), ...(delta > 0 ? { lastMatchedAt: now } : {}) };
      } else if (delta > 0) {
        accounts.push({ accountId: a.accountId, unitId: a.unitId, liableParty: a.liableParty, count: 1, lastMatchedAt: now });
      }
    }
    const kept = accounts
      .filter((a) => a.count > 0)
      .sort((a, b) => b.lastMatchedAt.localeCompare(a.lastMatchedAt))
      .slice(0, MAX_ALLOCATIONS);
    const item: BankPayer = {
      ...bankKeys.payer(apartmentId, mac),
      entityType: 'BANK_PAYER',
      apartmentId,
      ibanMac: mac,
      accounts: kept,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
    };
    return existing ? { replace: { item, expectedVersion: existing.version, label: 'bank_payer' } } : { create: item };
  }

  async function lateFeeOf(apartmentId: string, accountId: string, asOf: IsoDate, rate: number): Promise<Kurus> {
    const entries = (await deps.ledger.listLedgerEntries(apartmentId, accountId)).filter((e) => e.siteId === apartmentId && e.accountId === accountId);
    const ids = [...new Set(entries.map((e) => e.transactionId))];
    const txs = ids.length ? await deps.ledger.getTransactions(apartmentId, ids) : [];
    return accruedLateFeeOf(entries, new Map(txs.map((t) => [t.transactionId, t])), rate, asOf);
  }

  // -------------------------------------------------------------------------
  // Referans kodu
  // -------------------------------------------------------------------------

  async function ensureRef(apartmentId: string, accountId: string, unitId: string, liableParty: LiableParty, actor: string): Promise<string> {
    const existing = await deps.repo.getRefOf(apartmentId, accountId);
    if (existing) return existing.code;
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = refCodeFor(apartmentId, accountId, attempt);
      const now = stamp();
      const ref: BankRef = { ...bankKeys.ref(apartmentId, code), entityType: 'BANK_REF', apartmentId, code, accountId, unitId, liableParty, createdAt: now, createdBy: actor };
      const refOf: BankRefOf = { ...bankKeys.refOf(apartmentId, accountId), entityType: 'BANK_REF_OF', apartmentId, accountId, code, createdAt: now };
      const r = await deps.repo.createRef(ref, refOf);
      if (r === 'created') return code;
      if (r === 'account_has_code') {
        const again = await deps.repo.getRefOf(apartmentId, accountId);
        if (again) return again.code;
      }
    }
    throw new BankError('conflict', 'Odeme referans kodu uretilemedi; tekrar deneyin');
  }

  /** Defter kaydi olmayan karar (yoksay / yeniden ac): karar + satir durumu + denetim, tek yazim. */
  async function writePlainDecision(ctx: BankMatchContext, line: BankLine, kind: 'ignore' | 'restore', status: LineStatus, reason: string) {
    const decisionNo = (line.decisionNo ?? 0) + 1;
    const now = stamp();
    const decision: BankDecision = {
      ...bankKeys.decision(ctx.apartmentId, line.lineId, decisionNo),
      entityType: 'BANK_MATCH',
      apartmentId: ctx.apartmentId,
      bankAccountId: line.bankAccountId,
      lineId: line.lineId,
      lineSk: line.SK,
      decisionNo,
      kind,
      transactionIds: [],
      paymentIds: [],
      ...(kind === 'restore' && line.decisionNo ? { reverses: line.decisionNo } : {}),
      reason,
      createdAt: now,
      createdBy: ctx.userId,
    };
    const next: BankLine = { ...line, status, decisionNo, updatedAt: now, updatedBy: ctx.userId, version: line.version + 1 };
    try {
      await deps.repo.writeDecision(next, line.version, decision, {
        apartmentId: ctx.apartmentId,
        action: `bank.line.${kind}`,
        target: { type: 'bank_line', id: line.lineId },
        actorId: ctx.userId,
        reason,
        details: { bankAccountId: line.bankAccountId, amount: line.amount, direction: line.direction, decisionNo },
      });
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') {
        throw new BankError('version_conflict', 'Satir baska bir islemle degisti; listeyi yenileyin');
      }
      throw err;
    }
    return { replayed: false, line: publicLine(next), decision: publicDecision(decision) };
  }

  // -------------------------------------------------------------------------
  // Uclar
  // -------------------------------------------------------------------------

  return {
    async suggestions(ctx: BankMatchContext, lineId: string, q: { bankAccountId?: string }) {
      const line = await requireLine(ctx, q.bankAccountId, lineId);
      const loaded = await loadCandidates(ctx.apartmentId, { maskNames: ctx.role === 'observer' });
      return { line: publicLine(line), suggestions: await suggestFor(ctx.apartmentId, line, loaded) };
    },

    async targets(ctx: BankMatchContext) {
      const loaded = await loadCandidates(ctx.apartmentId, { maskNames: ctx.role === 'observer' });
      return {
        items: loaded.candidates.map((c) => ({
          accountId: c.accountId,
          unitId: c.unitId,
          unitLabel: c.unitLabel,
          liableParty: c.liableParty,
          partyLabel: c.partyLabel,
          former: Boolean(c.former),
          holderNames: c.holderNames,
          openBalance: c.openBalance,
          ...(c.closedThrough ? { closedThrough: c.closedThrough } : {}),
          ...(c.refCode ? { refCode: c.refCode } : {}),
        })),
      };
    },

    /** Eslestirme kuyrugu: satirlar (yeniden eskiye) + eslesmemis giris satirlarinda ilk oneri. */
    async queue(ctx: BankMatchContext, q: Record<string, string | undefined>) {
      const bankAccountId = reqId(q.bankAccountId, 'bankAccountId');
      if (q.status !== undefined && !(LINE_STATUSES as readonly string[]).includes(q.status)) fail('status gecersiz', 'status');
      for (const k of ['from', 'to'] as const) if (q[k] !== undefined && !isIsoDate(q[k] as string)) fail(`${k} YYYY-AA-GG olmalidir`, k);
      if (q.statementId !== undefined && !isStatementId(q.statementId)) fail('statementId gecersiz', 'statementId');
      const limit = q.limit === undefined ? 50 : Number(q.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > LINES_PAGE_MAX) fail(`limit 1-${LINES_PAGE_MAX} olmalidir`, 'limit');
      if (q.cursor !== undefined && (q.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(q.cursor))) fail('Gecersiz sayfalama imleci', 'cursor');
      const page = await deps.repo.queryLines(ctx.apartmentId, {
        bankAccountId,
        limit,
        ...(q.status ? { status: q.status as LineStatus } : {}),
        ...(q.from ? { from: q.from } : {}),
        ...(q.to ? { to: q.to } : {}),
        ...(q.statementId ? { statementId: q.statementId } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
      });
      const needs = page.items.some((l) => l.status === 'unmatched' && l.direction === 'in');
      const loaded = needs ? await loadCandidates(ctx.apartmentId, { maskNames: ctx.role === 'observer' }) : undefined;
      const items = await Promise.all(
        page.items.map(async (l) => {
          const top = loaded && l.status === 'unmatched' && l.direction === 'in' ? (await suggestFor(ctx.apartmentId, l, loaded, 1))[0] : undefined;
          return { ...publicLine(l), ...(top ? { suggestion: top } : {}) };
        }),
      );
      return { items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },

    async match(ctx: BankMatchContext, lineId: string, body: unknown) {
      const o = asObj(body);
      const line = await requireLine(ctx, o.bankAccountId, lineId);
      checkVersion(line, reqVersion(o.expectedVersion));
      if (line.status !== 'unmatched') throw new BankError('invalid_state', `Satir eslestirilemez (durum: ${line.status})`, { status: line.status });
      if (line.direction !== 'in') throw new BankError('invalid_state', 'Cikan (borc) satir tahsilata cevrilemez');
      const reason = reqReason(o.reason, false);
      const source = o.source === 'suggestion' ? 'suggestion' : 'manual';
      const confidence = typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1 ? o.confidence : undefined;
      if (!Array.isArray(o.allocations)) fail('allocations bir dizi olmalidir', 'allocations');
      const raw = (o.allocations as unknown[]).map((a, i) => {
        const x = asObj(a);
        const amount = x.amount;
        if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) fail(`allocations[${i}].amount kurus tam sayi olmalidir`, 'allocations');
        return { accountId: reqId(x.accountId, `allocations[${i}].accountId`), amount: amount as number };
      });
      const invalid = validateAllocations(line.amount, raw);
      if (invalid) fail(invalid, 'allocations');

      const paidAt = line.valueDate ?? line.date;
      const site = await deps.core.getSite(ctx.apartmentId);
      const rate = site?.settings.lateFeeMonthlyBasisPoints ?? DEFAULT_LATE_FEE_BASIS_POINTS;
      const allocations: { accountId: string; amount: Kurus; lateFee: Kurus }[] = [];
      for (const a of raw) {
        const acc = await deps.accounts.getAccount(ctx.apartmentId, a.accountId);
        if (!acc || acc.type !== 'receivable' || !acc.unitId || !acc.liableParty) fail(`Alt cari bulunamadi: ${a.accountId}`, 'allocations');
        if (acc?.closedThrough && acc.closedThrough >= paidAt) throw await closedError(ctx.apartmentId, acc, a.accountId, acc.closedThrough);
        allocations.push({ accountId: a.accountId, amount: a.amount as Kurus, lateFee: await lateFeeOf(ctx.apartmentId, a.accountId, paidAt, rate) });
      }

      const decisionNo = (line.decisionNo ?? 0) + 1;
      const payer = line.counterpartyIbanMac ? await deps.repo.getPayer(ctx.apartmentId, line.counterpartyIbanMac) : undefined;
      let written: { decision: BankDecision; line: BankLine } | undefined;
      let result: Awaited<ReturnType<BankMatchDeps['finance']['recordBankPayment']>>;
      try {
        result = await deps.finance.recordBankPayment(
          { apartmentId: ctx.apartmentId, userId: ctx.userId },
          {
            idempotencyId: `bankmatch-${lineId}-${decisionNo}`,
            depositAccountId: line.bankAccountId,
            paidAt,
            reference: `BANK:${line.bankReference ? line.bankReference.replace(/[^\w.-]/g, '').slice(0, 40) || lineId : lineId}`,
            ...(line.counterpartyName ? { payerName: line.counterpartyName.slice(0, 120) } : {}),
            note: 'Banka ekstresi eşleştirmesi',
            allocations,
            documents: ({ payments, transactions, allocations: resolved }) => {
              const now = stamp();
              const allocs: MatchAllocation[] = resolved.map((r: ResolvedBankAllocation) => ({ accountId: r.accountId, unitId: r.unitId, liableParty: r.liableParty, amount: r.amount, lateFee: r.lateFee }));
              const decision: BankDecision = {
                ...bankKeys.decision(ctx.apartmentId, lineId, decisionNo),
                entityType: 'BANK_MATCH',
                apartmentId: ctx.apartmentId,
                bankAccountId: line.bankAccountId,
                lineId,
                lineSk: line.SK,
                decisionNo,
                kind: 'match',
                allocations: allocs,
                transactionIds: transactions.map((t) => t.transactionId),
                paymentIds: payments.map((p) => p.paymentId),
                ...(reason ? { reason } : {}),
                source,
                ...(confidence !== undefined ? { confidence } : {}),
                createdAt: now,
                createdBy: ctx.userId,
              };
              const next: BankLine = {
                ...line,
                status: 'matched',
                decisionNo,
                match: { decisionNo, transactionIds: decision.transactionIds, paymentIds: decision.paymentIds },
                updatedAt: now,
                updatedBy: ctx.userId,
                version: line.version + 1,
              };
              written = { decision, line: next };
              const p = line.counterpartyIbanMac ? payerUpdate(ctx.apartmentId, payer, line.counterpartyIbanMac, allocs, 1) : undefined;
              const audit: AuditDraft = {
                apartmentId: ctx.apartmentId,
                action: 'bank.line.match',
                target: { type: 'bank_line', id: lineId },
                actorId: ctx.userId,
                ...(reason ? { reason } : {}),
                details: {
                  bankAccountId: line.bankAccountId,
                  statementId: line.statementId,
                  date: paidAt,
                  amount: line.amount,
                  decisionNo,
                  source,
                  confidence,
                  allocations: allocs.map((a) => ({ accountId: a.accountId, amount: a.amount, lateFee: a.lateFee })),
                  transactionIds: decision.transactionIds,
                  paymentIds: decision.paymentIds,
                },
              };
              return {
                newDocs: [decision, ...(p?.create ? [p.create] : [])],
                replaceRecords: [{ item: next, expectedVersion: line.version, label: 'bank_line' }, ...(p?.replace ? [p.replace] : [])],
                audit,
              };
            },
          },
        );
      } catch (err) {
        if (err instanceof LedgerConflictError && err.reason === 'closed') {
          const acc = err.label ? await deps.accounts.getAccount(ctx.apartmentId, err.label) : undefined;
          throw await closedError(ctx.apartmentId, acc, err.label ?? '', err.closedThrough);
        }
        if (err instanceof LedgerConflictError && err.reason === 'precondition') {
          throw new BankError('version_conflict', 'Satir veya gonderen kaydi baska bir islemle degisti; listeyi yenileyin', { label: err.label });
        }
        throw err;
      }
      if (result.replayed || !written) {
        const current = await deps.repo.getLine(ctx.apartmentId, line.bankAccountId, lineId);
        return { replayed: true, line: current ? publicLine(current) : publicLine(line), payments: result.payments.map((p) => ({ paymentId: p.paymentId, receiptNumber: p.receiptNumber, amount: p.amount })) };
      }
      return {
        replayed: false,
        line: publicLine(written.line),
        decision: publicDecision(written.decision),
        payments: result.payments.map((p) => ({ paymentId: p.paymentId, receiptNumber: p.receiptNumber, amount: p.amount, unitId: p.unitId, liableParty: p.liableParty })),
        lateFees: result.allocations.filter((a) => a.lateFee > 0).map((a) => ({ accountId: a.accountId, lateFee: a.lateFee })),
      };
    },

    async ignore(ctx: BankMatchContext, lineId: string, body: unknown) {
      const o = asObj(body);
      const line = await requireLine(ctx, o.bankAccountId, lineId);
      checkVersion(line, reqVersion(o.expectedVersion));
      if (line.status !== 'unmatched') throw new BankError('invalid_state', `Satir yoksayilamaz (durum: ${line.status})`, { status: line.status });
      const reason = reqReason(o.reason, true) as string;
      return writePlainDecision(ctx, line, 'ignore', 'ignored', reason);
    },

    async unmatch(ctx: BankMatchContext, lineId: string, body: unknown) {
      const o = asObj(body);
      const line = await requireLine(ctx, o.bankAccountId, lineId);
      checkVersion(line, reqVersion(o.expectedVersion));
      const reason = reqReason(o.reason, true) as string;
      if (line.status === 'ignored') return writePlainDecision(ctx, line, 'restore', 'unmatched', reason);
      if (line.status !== 'matched' || !line.match) throw new BankError('invalid_state', 'Yalnizca eslesmis veya yoksayilmis satir geri alinabilir', { status: line.status });

      const decisions = await deps.repo.listDecisions(ctx.apartmentId, lineId);
      const matchDecision = decisions.find((d) => d.decisionNo === line.match?.decisionNo && d.kind === 'match');
      if (!matchDecision) throw new BankError('conflict', 'Eslestirme karari bulunamadi');
      const decisionNo = (line.decisionNo ?? 0) + 1;
      const payer = line.counterpartyIbanMac ? await deps.repo.getPayer(ctx.apartmentId, line.counterpartyIbanMac) : undefined;
      let written: { decision: BankDecision; line: BankLine } | undefined;
      try {
        const r = await deps.finance.reverseBankPayments(
          { apartmentId: ctx.apartmentId, userId: ctx.userId },
          {
            idempotencyId: `bankunmatch-${lineId}-${decisionNo}`,
            transactionIds: matchDecision.transactionIds,
            reason: `Banka eşleştirmesi geri alındı: ${reason}`.slice(0, 300),
            documents: ({ reversals }) => {
              const now = stamp();
              const decision: BankDecision = {
                ...bankKeys.decision(ctx.apartmentId, lineId, decisionNo),
                entityType: 'BANK_MATCH',
                apartmentId: ctx.apartmentId,
                bankAccountId: line.bankAccountId,
                lineId,
                lineSk: line.SK,
                decisionNo,
                kind: 'unmatch',
                transactionIds: reversals.map((t) => t.transactionId),
                paymentIds: [],
                reverses: matchDecision.decisionNo,
                reversedTransactionIds: matchDecision.transactionIds,
                reason,
                createdAt: now,
                createdBy: ctx.userId,
              };
              const { match: _m, ...rest } = line;
              const next: BankLine = { ...rest, status: 'unmatched', decisionNo, updatedAt: now, updatedBy: ctx.userId, version: line.version + 1 };
              written = { decision, line: next };
              const p =
                line.counterpartyIbanMac && payer ? payerUpdate(ctx.apartmentId, payer, line.counterpartyIbanMac, matchDecision.allocations ?? [], -1) : undefined;
              return {
                newDocs: [decision],
                replaceRecords: [{ item: next, expectedVersion: line.version, label: 'bank_line' }, ...(p?.replace ? [p.replace] : [])],
                audit: {
                  apartmentId: ctx.apartmentId,
                  action: 'bank.line.unmatch',
                  target: { type: 'bank_line', id: lineId },
                  actorId: ctx.userId,
                  reason,
                  details: {
                    bankAccountId: line.bankAccountId,
                    amount: line.amount,
                    decisionNo,
                    reverses: matchDecision.decisionNo,
                    reversedTransactionIds: matchDecision.transactionIds,
                    reversalTransactionIds: decision.transactionIds,
                  },
                },
              };
            },
          },
        );
        if (r.replayed || !written) {
          const current = await deps.repo.getLine(ctx.apartmentId, line.bankAccountId, lineId);
          return { replayed: true, line: publicLine(current ?? line) };
        }
      } catch (err) {
        if (err instanceof LedgerConflictError && err.reason === 'precondition') {
          throw new BankError('version_conflict', 'Satir baska bir islemle degisti; listeyi yenileyin', { label: err.label });
        }
        throw err;
      }
      const w = written as { decision: BankDecision; line: BankLine };
      return { replayed: false, line: publicLine(w.line), decision: publicDecision(w.decision) };
    },

    async history(ctx: BankMatchContext, lineId: string, q: { bankAccountId?: string }) {
      const line = await requireLine(ctx, q.bankAccountId, lineId);
      const decisions = await deps.repo.listDecisions(ctx.apartmentId, lineId);
      return { line: publicLine(line), decisions: decisions.map((d) => publicDecision(d, decisions)) };
    },

    async reconciliation(ctx: BankMatchContext, q: { bankAccountId?: string }) {
      const bankAccountId = reqId(q.bankAccountId, 'bankAccountId');
      const account = await deps.accounts.getAccount(ctx.apartmentId, bankAccountId);
      if (!account || account.type !== 'bank') throw new BankError('not_found', 'Banka hesabi bulunamadi');
      const statements = (await deps.repo.listStatements(ctx.apartmentId)).filter(
        (s) => s.bankAccountId === bankAccountId && s.status === 'committed' && s.period,
      );
      const latest = statements.sort(
        (a, b) => (b.period?.to ?? '').localeCompare(a.period?.to ?? '') || (b.committed?.committedAt ?? '').localeCompare(a.committed?.committedAt ?? ''),
      )[0];
      let ledgerAtStatementEnd: number | undefined;
      if (latest?.period) {
        const entries = await deps.ledger.listLedgerEntries(ctx.apartmentId, bankAccountId);
        ledgerAtStatementEnd = entries
          .filter((e) => e.accountId === bankAccountId && e.date <= (latest.period as { to: IsoDate }).to)
          .reduce((s, e) => s + (e.side === 'debit' ? e.amount : -e.amount), 0);
      }
      // Kuyruk ozeti: tum satirlar sayfalanarak (satir basina tek okuma; buyuk sitede aylik birkac yuz).
      const totals = { unmatchedIn: { count: 0, amount: 0 }, unmatchedOut: { count: 0, amount: 0 }, matched: { count: 0, amount: 0 }, ignored: { count: 0, amount: 0 } };
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const r = await deps.repo.queryLines(ctx.apartmentId, { bankAccountId, limit: LINES_PAGE_MAX, order: 'asc', ...(cursor ? { cursor } : {}) });
        for (const l of r.items) {
          const bucket = l.status === 'unmatched' ? (l.direction === 'in' ? totals.unmatchedIn : totals.unmatchedOut) : l.status === 'matched' ? totals.matched : totals.ignored;
          bucket.count++;
          bucket.amount += l.amount;
        }
        cursor = r.cursor;
        if (!cursor) break;
      }
      const closing = latest?.closingBalance;
      return {
        bankAccountId,
        accountName: account.name,
        ledgerBalance: account.balance,
        ...(latest
          ? {
              statement: {
                statementId: latest.statementId,
                fileName: latest.fileName,
                period: latest.period,
                ...(closing !== undefined ? { closingBalance: closing } : {}),
              },
            }
          : {}),
        ...(ledgerAtStatementEnd !== undefined ? { ledgerBalanceAtStatementEnd: ledgerAtStatementEnd } : {}),
        ...(closing !== undefined && ledgerAtStatementEnd !== undefined ? { difference: closing - ledgerAtStatementEnd } : {}),
        lines: totals,
      };
    },

    async listAccounts(ctx: BankMatchContext) {
      const [accounts, profiles] = await Promise.all([deps.accounts.listAccounts(ctx.apartmentId), deps.repo.listProfiles(ctx.apartmentId)]);
      const byId = new Map(profiles.map((p) => [p.bankAccountId, p]));
      return {
        items: accounts
          .filter((a) => a.type === 'bank' && a.status === 'active')
          .map((a) => {
            const p = byId.get(a.accountId);
            return {
              accountId: a.accountId,
              name: a.name,
              balance: a.balance,
              system: Boolean(a.system),
              ...(p
                ? {
                    profile: {
                      // Denetci tam IBAN'i gormez (apartmanin hesabi da olsa salt okunur rolde gereksiz).
                      iban: ctx.role === 'observer' ? maskIban(p.iban) : p.iban,
                      accountHolderName: p.accountHolderName,
                      ...(p.bankName ? { bankName: p.bankName } : {}),
                      residentVisible: p.residentVisible,
                      version: p.version,
                    },
                  }
                : {}),
            };
          }),
      };
    },

    async saveProfile(ctx: BankMatchContext, bankAccountIdRaw: string, body: unknown) {
      const bankAccountId = reqId(bankAccountIdRaw, 'bankAccountId');
      const o = asObj(body);
      const account = await deps.accounts.getAccount(ctx.apartmentId, bankAccountId);
      if (!account || account.type !== 'bank' || account.status !== 'active') fail('Aktif bir banka hesabi secilmelidir', 'bankAccountId');
      if (typeof o.iban !== 'string' || !isValidTrIban(o.iban)) fail('Gecerli bir TR IBAN girilmelidir', 'iban');
      const holder = typeof o.accountHolderName === 'string' ? o.accountHolderName.replace(/\s+/g, ' ').trim() : '';
      if (holder.length < 2 || holder.length > 140) fail('accountHolderName 2-140 karakter olmalidir', 'accountHolderName');
      const bankName = typeof o.bankName === 'string' && o.bankName.trim() ? o.bankName.trim().slice(0, 80) : undefined;
      if (typeof o.residentVisible !== 'boolean') fail('residentVisible true/false olmalidir', 'residentVisible');
      const expected = o.expectedVersion === undefined ? undefined : reqVersion(o.expectedVersion);
      const current = await deps.repo.getProfile(ctx.apartmentId, bankAccountId);
      if (current && expected === undefined) throw new BankError('version_conflict', 'Kayitli profil var; expectedVersion verin', { currentVersion: current.version });
      if (current && expected !== current.version) throw new BankError('version_conflict', 'Profil baska bir istekle degisti', { currentVersion: current.version });
      const now = stamp();
      const profile: BankAccountProfile = {
        ...bankKeys.profile(ctx.apartmentId, bankAccountId),
        entityType: 'BANK_PROFILE',
        apartmentId: ctx.apartmentId,
        bankAccountId,
        iban: normalizeIban(o.iban as string),
        accountHolderName: holder,
        ...(bankName ? { bankName } : {}),
        residentVisible: o.residentVisible as boolean,
        createdAt: current?.createdAt ?? now,
        createdBy: current?.createdBy ?? ctx.userId,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: (current?.version ?? 0) + 1,
      };
      const others = profile.residentVisible
        ? (await deps.repo.listProfiles(ctx.apartmentId))
            .filter((p) => p.bankAccountId !== bankAccountId && p.residentVisible)
            .map((p) => ({ item: { ...p, residentVisible: false, updatedAt: now, updatedBy: ctx.userId, version: p.version + 1 }, expectedVersion: p.version }))
        : [];
      try {
        await deps.repo.saveProfile(profile, current ? current.version : undefined, others, {
          apartmentId: ctx.apartmentId,
          action: 'bank.account.profile',
          target: { type: 'bank_account', id: bankAccountId },
          actorId: ctx.userId,
          // Anahtar adi bilerek "iban" icermez: denetim maskelemesi yalnizca son 4 haneyi tutar.
          details: { accountLast4: profile.iban.slice(-4), residentVisible: profile.residentVisible, version: profile.version, hiddenFrom: others.map((x) => x.item.bankAccountId) },
        });
      } catch (err) {
        if (err instanceof DataAccessError && err.code === 'conflict') throw new BankError('version_conflict', 'Profil baska bir istekle degisti; yenileyin');
        throw err;
      }
      return { accountId: bankAccountId, profile: { iban: profile.iban, accountHolderName: holder, ...(bankName ? { bankName } : {}), residentVisible: profile.residentVisible, version: profile.version } };
    },

    /** Sakin portali: apartmanin tahsilat IBAN'i + sakinin gorebildigi alt carilerin referans kodlari. */
    async paymentReference(ctx: PortalContext, unitId?: string) {
      if (!deps.portal) throw new BankError('unavailable', 'Portal yapilandirilmamis');
      const resolved = await deps.portal.resolveUnit(ctx, unitId);
      const [profiles, blocks] = await Promise.all([deps.repo.listProfiles(ctx.apartmentId), deps.core.listBlocks(ctx.apartmentId)]);
      const profile = profiles.find((p) => p.residentVisible);
      const blockName = blocks.find((b) => b.blockId === resolved.unit.blockId)?.name;
      const references = [];
      for (const party of resolved.parties) {
        const accountId = mainReceivableId(resolved.unit.unitId, party);
        references.push({ liableParty: party, label: PARTY_LABEL[party], code: await ensureRef(ctx.apartmentId, accountId, resolved.unit.unitId, party, ctx.userId) });
      }
      return {
        unitId: resolved.unit.unitId,
        unitLabel: blockName ? `${blockName} · ${resolved.unit.number}` : resolved.unit.number,
        bank: profile ? { iban: profile.iban, accountHolderName: profile.accountHolderName, ...(profile.bankName ? { bankName: profile.bankName } : {}) } : null,
        references,
      };
    },
  };
}

export type BankMatchService = ReturnType<typeof createBankMatchService>;
