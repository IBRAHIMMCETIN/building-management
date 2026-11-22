import { createHash } from 'node:crypto';
import type { Role } from '../../../auth/claims.js';
import { DataAccessError } from '../../../config/dynamodb.js';
import type { AuditDraft } from '../../audit/log.js';
import { type CoreRepository, coreRepository } from '../../core/repository.js';
import type { IsoDate, Kurus, LiableParty } from '../../core/types.js';
import { ID_PATTERN, isIsoDate } from '../../core/validation.js';
import { BANK_RECON_TEMPLATE_VERSION, type BankReconLine, renderBankReconPdf } from '../../documents/bankReconPdf.js';
import { bankReconReportKey, contentDisposition } from '../../documents/keys.js';
import { type DocumentStore, URL_TTL_SECONDS, createDocumentStoreFromEnv } from '../../documents/store.js';
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
import { AUTO_RUN_KEY_PATTERN, LINES_PAGE_MAX, MAX_LINES, bankKeys, isStatementId, istanbulDate, parseLineId } from './keys.js';
import {
  type MatchCandidate,
  type PayableCandidate,
  type Suggestion,
  refCodeFor,
  suggestMatches,
  suggestPayables,
  validateAllocations,
} from './matching.js';
import { payableSummary } from '../payables.js';
import { addLines, emptyBreakdown, ledgerBalanceThrough, pendingNetThrough, pickStatements } from './reconciliation.js';
import { type BankRepository, bankRepository } from './repository.js';
import { publicLine } from './service.js';
import {
  AUTO_MATCH_BATCH,
  AUTO_MATCH_DEFAULT_MIN_CONFIDENCE,
  AUTO_MATCH_MARGIN,
  AUTO_MATCH_MIN_CONFIDENCE_FLOOR,
  type AutoMatchSkipped,
  type BankAccountProfile,
  type BankAutoRun,
  type BankDecision,
  type BankLine,
  type BankPayee,
  type BankPayer,
  type BankRef,
  type BankRefOf,
  type BankStatement,
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
 *
 * Faz B3:
 *   GET  /statements/:id/auto-match        toplu onay on izlemesi (esik ustu, cakismasiz satirlar)
 *   POST /statements/:id/auto-match        toplu otomatik onay (istek basina en fazla AUTO_MATCH_BATCH satir)
 *   POST /lines/:lineId/expense            cikan satir -> gider (gider hesabi borc / banka alacak)
 *   POST /lines/:lineId/unmatch            gidere cevrilmis satiri da ters kayitla geri alir
 *
 * Faz B3.5:
 *   GET  /lines/:lineId/payable-suggestions  cikan satir -> tedarikci onerileri
 *   POST /lines/:lineId/settle-payable       tedarikci borcunu kapat (payable_payment + BANKMATCH + PAYEE)
 *   GET  /reconciliation/report              donemsel mutabakat PDF'i (S3 onbellek, 5 dk imzali URL)
 *   GET  /reconciliation?from&to           ayrintili mutabakat dokumu
 */

export type BankMatchContext = { apartmentId: string; userId: string; role: Role };

export type BankMatchDeps = {
  repo: BankRepository;
  finance: Pick<FinanceService, 'recordBankPayment' | 'reverseBankPayments' | 'recordBankExpense' | 'recordBankPayablePayment'>;
  accounts: Pick<FinanceRepository, 'getAccount' | 'listAccounts' | 'listTransactions'>;
  ledger: Pick<PortalRepository, 'listLedgerEntries' | 'getTransactions'>;
  core: Pick<CoreRepository, 'getSite' | 'getUnit' | 'listUnits' | 'listBlocks'>;
  memberships: Pick<MembershipRepository, 'list'>;
  people: Pick<PersonRepository, 'list'>;
  /** Sakin portali: daire ve gorunur alt cariler (uyelik kurallari tek kaynaktan). */
  portal?: Pick<PortalService, 'resolveUnit'>;
  /** Faz B3.5: mutabakat PDF onbellegi (S3; yoksa rapor 503). */
  documents?: DocumentStore;
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
const optText = (v: unknown, field: string, max: number): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) fail(`${field} en fazla ${max} karakter olmalidir`, field);
  const t = (v as string).replace(/\s+/g, ' ').trim();
  return t || undefined;
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
    // `documents: undefined` acikca verilirse (test) ortamdan okunmaz.
    documents: 'documents' in overrides ? overrides.documents : createDocumentStoreFromEnv(),
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

  type MatchOptions = { reason?: string; source: 'suggestion' | 'manual' | 'auto'; confidence?: number; autoRunId?: string };

  /**
   * Dogrulanmis dagilimla satiri tahsilata cevirir (tek atomik yazim). `match` ucu ve toplu
   * otomatik onay ayni yolu kullanir.
   */
  async function matchLine(ctx: BankMatchContext, line: BankLine, raw: readonly { accountId: string; amount: number }[], opts: MatchOptions) {
    const { reason, source, confidence } = opts;
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
          idempotencyId: `bankmatch-${line.lineId}-${decisionNo}`,
          depositAccountId: line.bankAccountId,
          paidAt,
          reference: `BANK:${line.bankReference ? line.bankReference.replace(/[^\w.-]/g, '').slice(0, 40) || line.lineId : line.lineId}`,
          ...(line.counterpartyName ? { payerName: line.counterpartyName.slice(0, 120) } : {}),
          note: 'Banka ekstresi eşleştirmesi',
          allocations,
          documents: ({ payments, transactions, allocations: resolved }) => {
            const now = stamp();
            const allocs: MatchAllocation[] = resolved.map((r: ResolvedBankAllocation) => ({ accountId: r.accountId, unitId: r.unitId, liableParty: r.liableParty, amount: r.amount, lateFee: r.lateFee }));
            const decision: BankDecision = {
              ...bankKeys.decision(ctx.apartmentId, line.lineId, decisionNo),
              entityType: 'BANK_MATCH',
              apartmentId: ctx.apartmentId,
              bankAccountId: line.bankAccountId,
              lineId: line.lineId,
              lineSk: line.SK,
              decisionNo,
              kind: 'match',
              allocations: allocs,
              transactionIds: transactions.map((t) => t.transactionId),
              paymentIds: payments.map((p) => p.paymentId),
              ...(reason ? { reason } : {}),
              source,
              ...(confidence !== undefined ? { confidence } : {}),
              ...(opts.autoRunId ? { autoRunId: opts.autoRunId } : {}),
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
              target: { type: 'bank_line', id: line.lineId },
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
                ...(opts.autoRunId ? { autoRunId: opts.autoRunId } : {}),
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
      const current = await deps.repo.getLine(ctx.apartmentId, line.bankAccountId, line.lineId);
      return { replayed: true, line: current ? publicLine(current) : publicLine(line), payments: result.payments.map((p) => ({ paymentId: p.paymentId, receiptNumber: p.receiptNumber, amount: p.amount })) };
    }
    return {
      replayed: false,
      line: publicLine(written.line),
      decision: publicDecision(written.decision),
      payments: result.payments.map((p) => ({ paymentId: p.paymentId, receiptNumber: p.receiptNumber, amount: p.amount, unitId: p.unitId, liableParty: p.liableParty })),
      lateFees: result.allocations.filter((a) => a.lateFee > 0).map((a) => ({ accountId: a.accountId, lateFee: a.lateFee })),
    };
  }

  // -------------------------------------------------------------------------
  // Faz B3: toplu otomatik onay ve cikan satirdan gider
  // -------------------------------------------------------------------------

  const EPS = 1e-9;
  const zeroSkipped = (): AutoMatchSkipped => ({ lowConfidence: 0, ambiguous: 0, closed: 0, conflict: 0 });

  function parseMinConfidence(v: unknown): number {
    if (v === undefined || v === null || v === '') return AUTO_MATCH_DEFAULT_MIN_CONFIDENCE;
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < AUTO_MATCH_MIN_CONFIDENCE_FLOOR - EPS || n > 1 + EPS) {
      fail(`minConfidence ${AUTO_MATCH_MIN_CONFIDENCE_FLOOR}-1 arasinda olmalidir`, 'minConfidence');
    }
    return Math.round((n as number) * 100) / 100;
  }

  async function requireStatement(ctx: BankMatchContext, statementIdRaw: string): Promise<BankStatement> {
    if (!isStatementId(statementIdRaw)) throw new BankError('not_found', 'Ekstre bulunamadi');
    const statement = await deps.repo.getStatement(ctx.apartmentId, statementIdRaw);
    if (!statement) throw new BankError('not_found', 'Ekstre bulunamadi');
    if (statement.status !== 'committed') throw new BankError('invalid_state', 'Ekstre henuz aktarilmadi (onizleme)');
    return statement;
  }

  /**
   * Ekstrenin donemindeki (yoksa ekstrenin kendi satirlari) eslesmemis satirlar, eskiden yeniye.
   * Donem bazli okuma, cakisan onceki ekstreyle aktarilmis ayni hareketleri de kapsar.
   */
  async function unmatchedLinesOf(apartmentId: string, statement: BankStatement): Promise<BankLine[]> {
    const out: BankLine[] = [];
    let cursor: string | undefined;
    for (let page = 0; page * LINES_PAGE_MAX < MAX_LINES; page++) {
      const r = await deps.repo.queryLines(apartmentId, {
        bankAccountId: statement.bankAccountId,
        status: 'unmatched',
        order: 'asc',
        limit: LINES_PAGE_MAX,
        ...(statement.period ? { from: statement.period.from, to: statement.period.to } : { statementId: statement.statementId }),
        ...(cursor ? { cursor } : {}),
      });
      out.push(...r.items);
      cursor = r.cursor;
      if (!cursor) break;
    }
    return out;
  }

  /**
   * Toplu onaya uygun satirlar: en iyi oneri esigin ustunde, ikinci oneri en az AUTO_MATCH_MARGIN
   * geride (cakismasiz) ve hicbir dagilim kapali (closedThrough) cariye dusmuyor.
   */
  async function planAuto(apartmentId: string, statement: BankStatement, minConfidence: number) {
    const lines = await unmatchedLinesOf(apartmentId, statement);
    const incoming = lines.filter((l) => l.direction === 'in');
    const skipped = zeroSkipped();
    const eligible: { line: BankLine; suggestion: ReturnType<typeof enrich> }[] = [];
    if (incoming.length > 0) {
      const loaded = await loadCandidates(apartmentId);
      const byId = new Map(loaded.candidates.map((c) => [c.accountId, c]));
      for (const line of incoming) {
        const [top, second] = await suggestFor(apartmentId, line, loaded, 2);
        if (!top || top.allocations.length === 0 || top.confidence + EPS < minConfidence) {
          skipped.lowConfidence++;
          continue;
        }
        if (second && second.confidence > top.confidence - AUTO_MATCH_MARGIN + EPS) {
          skipped.ambiguous++;
          continue;
        }
        const paidAt = line.valueDate ?? line.date;
        const closed = top.allocations.some((a) => {
          const closedThrough = byId.get(a.accountId)?.closedThrough;
          return Boolean(closedThrough && closedThrough >= paidAt);
        });
        if (closed) {
          skipped.closed++;
          continue;
        }
        eligible.push({ line, suggestion: top });
      }
    }
    return { unmatchedIn: incoming.length, unmatchedOut: lines.length - incoming.length, eligible, skipped };
  }

  const pctLabel = (n: number) => `%${Math.round(n * 100)}`;

  function autoSummary(run: BankAutoRun) {
    return {
      statementId: run.statementId,
      bankAccountId: run.bankAccountId,
      idempotencyKey: run.idempotencyKey,
      minConfidence: run.minConfidence,
      matchedCount: run.matchedCount,
      totalMatchedAmount: run.totalMatchedAmount,
      skippedLowConfidence: run.lastSkipped.lowConfidence,
      skippedAmbiguous: run.lastSkipped.ambiguous,
      skippedClosed: run.lastSkipped.closed,
      skippedConflict: run.lastSkipped.conflict,
      calls: run.calls,
      completed: run.status === 'completed',
    };
  }

  // -------------------------------------------------------------------------
  // Faz B3.5: tedarikci borcu
  // -------------------------------------------------------------------------

  /** Acik borcu olan aktif tedarikci hesaplari + acik faturalari (oneri ve diyalog). */
  async function loadPayables(apartmentId: string): Promise<PayableCandidate[]> {
    const accounts = (await deps.accounts.listAccounts(apartmentId)).filter((a) => a.type === 'payable' && a.status === 'active' && a.balance < 0);
    return Promise.all(
      accounts.map(async (a) => {
        const entries = (await deps.ledger.listLedgerEntries(apartmentId, a.accountId)).filter((e) => e.siteId === apartmentId && e.accountId === a.accountId);
        const ids = [...new Set(entries.map((e) => e.transactionId))];
        const txs = ids.length ? await deps.ledger.getTransactions(apartmentId, ids) : [];
        const sum = payableSummary(a.accountId, entries, new Map(txs.map((t) => [t.transactionId, t])));
        return {
          accountId: a.accountId,
          name: a.name,
          openBalance: -a.balance,
          openItems: sum.openItems.map((i) => ({ amount: i.open, description: i.description, ...(i.reference ? { reference: i.reference } : {}) })),
        };
      }),
    );
  }

  async function payableSuggestionsFor(apartmentId: string, line: BankLine, candidates: readonly PayableCandidate[], limit = 5) {
    const payee = line.counterpartyIbanMac ? await deps.repo.getPayee(apartmentId, line.counterpartyIbanMac) : undefined;
    return suggestPayables({ line, candidates, ...(payee ? { payee } : {}), limit });
  }

  function payeeUpdate(apartmentId: string, existing: BankPayee | undefined, mac: string, accountId: string, delta: 1 | -1) {
    const now = stamp();
    const accounts = [...(existing?.accounts ?? [])];
    const i = accounts.findIndex((x) => x.accountId === accountId);
    if (i >= 0) {
      const cur = accounts[i] as BankPayee['accounts'][number];
      accounts[i] = { ...cur, count: Math.max(0, cur.count + delta), ...(delta > 0 ? { lastPaidAt: now } : {}) };
    } else if (delta > 0) {
      accounts.push({ accountId, count: 1, lastPaidAt: now });
    }
    const item: BankPayee = {
      ...bankKeys.payee(apartmentId, mac),
      entityType: 'BANK_PAYEE',
      apartmentId,
      ibanMac: mac,
      accounts: accounts
        .filter((a) => a.count > 0)
        .sort((a, b) => b.lastPaidAt.localeCompare(a.lastPaidAt))
        .slice(0, MAX_ALLOCATIONS),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
    };
    return existing ? { replace: { item, expectedVersion: existing.version, label: 'bank_payee' } } : { create: item };
  }

  /** Rapor listelerinin ust siniri (PDF boyutu ve okuma maliyeti). */
  const REPORT_LIST_MAX = 500;
  const REPORT_REASON_MAX = 200;

  /** Mutabakat hesabi (rapor ve PDF ayni veriyi kullanir). */
  async function reconcile(ctx: BankMatchContext, q: { bankAccountId?: string; from?: string; to?: string }) {
    const bankAccountId = reqId(q.bankAccountId, 'bankAccountId');
    for (const k of ['from', 'to'] as const) if (q[k] !== undefined && q[k] !== '' && !isIsoDate(q[k] as string)) fail(`${k} YYYY-AA-GG olmalidir`, k);
    const range = { ...(q.from ? { from: q.from as IsoDate } : {}), ...(q.to ? { to: q.to as IsoDate } : {}) };
    if (range.from && range.to && range.from > range.to) fail('from, to tarihinden sonra olamaz', 'from');
    const account = await deps.accounts.getAccount(ctx.apartmentId, bankAccountId);
    if (!account || account.type !== 'bank') throw new BankError('not_found', 'Banka hesabi bulunamadi');
    const statements = await deps.repo.listStatements(ctx.apartmentId);
    const { opening, closing } = pickStatements(statements, bankAccountId, range);
    const entries = (await deps.ledger.listLedgerEntries(ctx.apartmentId, bankAccountId)).filter((e) => e.accountId === bankAccountId);

    // Tum satirlar sayfalanarak (bekleyen net etki araliktan bagimsiz, kapanis gunune kadar birikimlidir).
    const lines: BankLine[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await deps.repo.queryLines(ctx.apartmentId, { bankAccountId, limit: LINES_PAGE_MAX, order: 'asc', ...(cursor ? { cursor } : {}) });
      lines.push(...r.items);
      cursor = r.cursor;
      if (!cursor) break;
    }
    const breakdown = addLines(emptyBreakdown(), lines, range);
    const sum = (a: { count: number; amount: number }, b: { count: number; amount: number }) => ({ count: a.count + b.count, amount: a.amount + b.amount });

    const asOf = closing?.period?.to;
    const closingBalance = closing?.closingBalance;
    const ledgerAtEnd = asOf ? ledgerBalanceThrough(entries, bankAccountId, asOf) : undefined;
    const diff = closingBalance !== undefined && ledgerAtEnd !== undefined ? closingBalance - ledgerAtEnd : undefined;
    const pendingNet = asOf ? pendingNetThrough(lines, asOf) : undefined;
    const openFrom = opening?.period?.from;
    const ledgerAtStart = openFrom
      ? entries.filter((e) => e.date < openFrom).reduce((t, e) => t + (e.side === 'debit' ? e.amount : -e.amount), 0)
      : undefined;
    const inRangeStatements = statements.filter(
      (st) =>
        st.bankAccountId === bankAccountId &&
        st.status === 'committed' &&
        st.period &&
        (!range.to || st.period.from <= range.to) &&
        (!range.from || st.period.to >= range.from),
    ).length;
    const result = {
      bankAccountId,
      accountName: account.name,
      ledgerBalance: account.balance,
      period: range,
      statementCount: inRangeStatements,
      ...(closing
        ? {
            statement: {
              statementId: closing.statementId,
              fileName: closing.fileName,
              period: closing.period,
              ...(closingBalance !== undefined ? { closingBalance } : {}),
            },
          }
        : {}),
      ...(opening
        ? {
            openingStatement: {
              statementId: opening.statementId,
              fileName: opening.fileName,
              period: opening.period,
              ...(opening.openingBalance !== undefined ? { openingBalance: opening.openingBalance } : {}),
            },
          }
        : {}),
      ...(opening?.openingBalance !== undefined ? { openingBalance: opening.openingBalance } : {}),
      ...(ledgerAtStart !== undefined ? { ledgerBalanceAtStart: ledgerAtStart } : {}),
      ...(closingBalance !== undefined ? { closingBalance } : {}),
      ...(asOf ? { asOf } : {}),
      ...(ledgerAtEnd !== undefined ? { ledgerBalanceAtStatementEnd: ledgerAtEnd } : {}),
      ...(diff !== undefined ? { difference: diff, diff } : {}),
      ...(pendingNet !== undefined ? { pendingNet } : {}),
      ...(diff !== undefined && pendingNet !== undefined ? { unexplainedDiff: diff - pendingNet } : {}),
      // B2 ozeti (aralikta): eslesen/yoksayilan giren + cikan toplamlari.
      lines: {
        unmatchedIn: breakdown.unmatchedIn,
        unmatchedOut: breakdown.unmatchedOut,
        matched: sum(breakdown.matchedIn, breakdown.matchedOut),
        ignored: sum(breakdown.ignoredIn, breakdown.ignoredOut),
      },
      breakdown,
    };
    return { result, lines, range, account };
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
      // B3.5: cikan satirlar icin tedarikci onerisi (yalnizca oneri; toplu onaya girmez).
      const needsPayables = page.items.some((l) => l.status === 'unmatched' && l.direction === 'out');
      const payables = needsPayables ? await loadPayables(ctx.apartmentId) : undefined;
      const items = await Promise.all(
        page.items.map(async (l) => {
          const top = loaded && l.status === 'unmatched' && l.direction === 'in' ? (await suggestFor(ctx.apartmentId, l, loaded, 1))[0] : undefined;
          const payable =
            payables && l.status === 'unmatched' && l.direction === 'out' ? (await payableSuggestionsFor(ctx.apartmentId, l, payables, 1))[0] : undefined;
          return { ...publicLine(l), ...(top ? { suggestion: top } : {}), ...(payable ? { payableSuggestion: payable } : {}) };
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
      return matchLine(ctx, line, raw, { reason, source, confidence });
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
      // B3: gidere cevrilmis satir da ayni yolla (ters kayit) geri alinir.
      // B3.5: tedarikci odemesi de ayni yolla geri alinir.
      const matchDecision = decisions.find(
        (d) => d.decisionNo === line.match?.decisionNo && (d.kind === 'match' || d.kind === 'expense' || d.kind === 'payable'),
      );
      if (!matchDecision) throw new BankError('conflict', 'Eslestirme karari bulunamadi');
      const isExpense = matchDecision.kind === 'expense';
      const isPayable = matchDecision.kind === 'payable';
      const decisionNo = (line.decisionNo ?? 0) + 1;
      const payer =
        line.counterpartyIbanMac && matchDecision.kind === 'match' ? await deps.repo.getPayer(ctx.apartmentId, line.counterpartyIbanMac) : undefined;
      const payee = line.counterpartyIbanMac && isPayable ? await deps.repo.getPayee(ctx.apartmentId, line.counterpartyIbanMac) : undefined;
      let written: { decision: BankDecision; line: BankLine } | undefined;
      try {
        const r = await deps.finance.reverseBankPayments(
          { apartmentId: ctx.apartmentId, userId: ctx.userId },
          {
            idempotencyId: `bankunmatch-${lineId}-${decisionNo}`,
            transactionIds: matchDecision.transactionIds,
            reason: `${isExpense ? 'Banka gideri geri alındı' : isPayable ? 'Tedarikçi ödemesi geri alındı' : 'Banka eşleştirmesi geri alındı'}: ${reason}`.slice(0, 300),
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
              const pe =
                line.counterpartyIbanMac && payee && matchDecision.payable
                  ? payeeUpdate(ctx.apartmentId, payee, line.counterpartyIbanMac, matchDecision.payable.payableAccountId, -1)
                  : undefined;
              return {
                newDocs: [decision],
                replaceRecords: [
                  { item: next, expectedVersion: line.version, label: 'bank_line' },
                  ...(p?.replace ? [p.replace] : []),
                  ...(pe?.replace ? [pe.replace] : []),
                ],
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
                    reversedKind: matchDecision.kind,
                    ...(matchDecision.expense ? { expenseId: matchDecision.expense.expenseId } : {}),
                    ...(matchDecision.payable ? { payableAccountId: matchDecision.payable.payableAccountId } : {}),
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

    /**
     * Mutabakat dokumu. Aralik verilmezse son ekstreye gore (B2 alanlari korunur). Aralikta:
     * acilis = araligin basindan sonra baslayan ilk ekstrenin acilis bakiyesi, kapanis = araligin
     * sonundan once biten son ekstrenin kapanis bakiyesi; fark kapanis gunu sonundaki defter
     * bakiyesiyle hesaplanir. Satir dokumu (eslesen/bekleyen/yoksayilan, giren/cikan) araliktadir.
     */
    async reconciliation(ctx: BankMatchContext, q: { bankAccountId?: string; from?: string; to?: string }) {
      return (await reconcile(ctx, q)).result;
    },

    /** Toplu onay on izlemesi (yazim yok): esigi gecen, cakismasiz satirlar. */
    async autoMatchPreview(ctx: BankMatchContext, statementIdRaw: string, q: { minConfidence?: string }) {
      const statement = await requireStatement(ctx, statementIdRaw);
      const minConfidence = parseMinConfidence(q.minConfidence);
      const plan = await planAuto(ctx.apartmentId, statement, minConfidence);
      return {
        statementId: statement.statementId,
        bankAccountId: statement.bankAccountId,
        minConfidence,
        batchSize: AUTO_MATCH_BATCH,
        eligibleCount: plan.eligible.length,
        eligibleAmount: plan.eligible.reduce((t, e) => t + e.line.amount, 0),
        skippedLowConfidence: plan.skipped.lowConfidence,
        skippedAmbiguous: plan.skipped.ambiguous,
        skippedClosed: plan.skipped.closed,
        unmatchedIn: plan.unmatchedIn,
        unmatchedOut: plan.unmatchedOut,
        items: plan.eligible.slice(0, LINES_PAGE_MAX).map((e) => ({
          lineId: e.line.lineId,
          date: e.line.valueDate ?? e.line.date,
          amount: e.line.amount,
          description: e.line.description,
          suggestion: e.suggestion,
        })),
      };
    },

    /**
     * Toplu otomatik onay. Istek basina en fazla AUTO_MATCH_BATCH satir; `remaining > 0` ise ayni
     * `idempotencyKey` ile tekrar cagrilir. Her satir `match` ile ayni atomik yazimla islenir
     * (`source: 'auto'`, `autoRunId`); yarida kesilen calisma yalnizca hala eslesmemis satirlarla
     * devam eder. Calisma kaydi (BANKAUTO#) ayni anahtarla es zamanli ikinci cagriyi engeller.
     */
    async autoMatch(ctx: BankMatchContext, statementIdRaw: string, body: unknown) {
      const o = asObj(body);
      const statement = await requireStatement(ctx, statementIdRaw);
      if (typeof o.idempotencyKey !== 'string' || !AUTO_RUN_KEY_PATTERN.test(o.idempotencyKey)) {
        fail('idempotencyKey 8-64 karakter (harf, rakam, - _) olmalidir', 'idempotencyKey');
      }
      const key = o.idempotencyKey as string;
      const minConfidence = parseMinConfidence(o.minConfidence);
      const runId = `${statement.statementId}#${key}`;
      const existing = await deps.repo.getAutoRun(ctx.apartmentId, statement.statementId, key);
      if (existing && existing.minConfidence !== minConfidence) {
        throw new BankError('conflict', 'Bu anahtar farkli bir guven esigiyle kullanilmis', { minConfidence: existing.minConfidence });
      }
      if (existing?.status === 'completed') {
        return { replayed: true, ...autoSummary(existing), remaining: 0, thisCall: { matchedCount: 0, totalMatchedAmount: 0 }, items: [] };
      }

      // Calismayi sahiplen: ayni anahtarla es zamanli ikinci cagri burada durur.
      const started = stamp();
      const claimed: BankAutoRun = existing
        ? { ...existing, status: 'running', calls: existing.calls + 1, updatedAt: started, version: existing.version + 1 }
        : {
            ...bankKeys.autoRun(ctx.apartmentId, statement.statementId, key),
            entityType: 'BANK_AUTO_RUN',
            apartmentId: ctx.apartmentId,
            runId,
            statementId: statement.statementId,
            bankAccountId: statement.bankAccountId,
            idempotencyKey: key,
            minConfidence,
            status: 'running',
            calls: 1,
            matchedCount: 0,
            totalMatchedAmount: 0 as Kurus,
            lastSkipped: zeroSkipped(),
            createdAt: started,
            createdBy: ctx.userId,
            updatedAt: started,
            version: 1,
          };
      const busy = () => new BankError('version_conflict', 'Ayni toplu onay baska bir istekle suruyor; biraz sonra tekrar deneyin');
      try {
        await deps.repo.saveAutoRun(claimed, existing?.version);
      } catch (err) {
        if (err instanceof DataAccessError && err.code === 'conflict') throw busy();
        throw err;
      }

      const plan = await planAuto(ctx.apartmentId, statement, minConfidence);
      const skipped = { ...plan.skipped };
      const items: { lineId: string; amount: number; confidence: number; receiptNumbers: string[] }[] = [];
      let matched = 0;
      let amount = 0;
      let attempted = 0;
      let failure: unknown;
      try {
        for (const { line, suggestion } of plan.eligible) {
          if (attempted >= AUTO_MATCH_BATCH) break;
          attempted++;
          try {
            const r = await matchLine(
              ctx,
              line,
              suggestion.allocations.map((a) => ({ accountId: a.accountId, amount: a.amount })),
              { source: 'auto', confidence: suggestion.confidence, autoRunId: runId, reason: `Toplu otomatik onay (eşik ${pctLabel(minConfidence)})` },
            );
            matched++;
            amount += line.amount;
            items.push({ lineId: line.lineId, amount: line.amount, confidence: suggestion.confidence, receiptNumbers: r.payments.map((p) => p.receiptNumber) });
          } catch (err) {
            // Satir bazli beklenen durumlar calismayi durdurmaz.
            if (err instanceof BankError && err.code === 'account_closed') skipped.closed++;
            else if (err instanceof BankError && (err.code === 'version_conflict' || err.code === 'invalid_state')) skipped.conflict++;
            else throw err;
          }
        }
      } catch (err) {
        failure = err;
      }
      const remaining = failure ? plan.eligible.length - matched : plan.eligible.length - attempted;
      const completed = !failure && remaining === 0;
      const final: BankAutoRun = {
        ...claimed,
        status: completed ? 'completed' : 'running',
        matchedCount: claimed.matchedCount + matched,
        totalMatchedAmount: (claimed.totalMatchedAmount + amount) as Kurus,
        lastSkipped: skipped,
        updatedAt: stamp(),
        version: claimed.version + 1,
      };
      try {
        await deps.repo.saveAutoRun(final, claimed.version, {
          apartmentId: ctx.apartmentId,
          action: 'bank.statement.auto_match',
          target: { type: 'bank_statement', id: statement.statementId },
          actorId: ctx.userId,
          details: {
            bankAccountId: statement.bankAccountId,
            idempotencyKey: key,
            minConfidence,
            call: final.calls,
            matchedCount: matched,
            totalMatchedAmount: amount,
            cumulativeMatchedCount: final.matchedCount,
            cumulativeMatchedAmount: final.totalMatchedAmount,
            skippedLowConfidence: skipped.lowConfidence,
            skippedAmbiguous: skipped.ambiguous,
            skippedClosed: skipped.closed,
            skippedConflict: skipped.conflict,
            remaining,
            lineIds: items.map((i) => i.lineId),
            ...(failure ? { error: failure instanceof Error ? `${failure.name}: ${failure.message}`.slice(0, 300) : 'unknown' } : {}),
          },
        });
      } catch (err) {
        if (!failure && err instanceof DataAccessError && err.code === 'conflict') throw busy();
        if (!failure) throw err;
      }
      if (failure) throw failure;
      return { replayed: false, ...autoSummary(final), remaining, thisCall: { matchedCount: matched, totalMatchedAmount: amount }, items };
    },

    /**
     * Cikan satiri gidere cevirir: gider kaydi + islem (gider hesabi borc / banka alacak, valor
     * tarihli) + BANKMATCH (`kind: 'expense'`) + satir durumu + denetim (`bank.line.expense`) TEK yazim.
     */
    async expense(ctx: BankMatchContext, lineId: string, body: unknown) {
      const o = asObj(body);
      const line = await requireLine(ctx, o.bankAccountId, lineId);
      checkVersion(line, reqVersion(o.expectedVersion));
      if (line.status !== 'unmatched') throw new BankError('invalid_state', `Satir gidere cevrilemez (durum: ${line.status})`, { status: line.status });
      if (line.direction !== 'out') throw new BankError('invalid_state', 'Yalnizca bankadan cikan (borc) satir gidere cevrilebilir');
      const expenseAccountId = reqId(o.expenseAccountId, 'expenseAccountId');
      const description = optText(o.description, 'description', 200) ?? line.description.replace(/\s+/g, ' ').trim().slice(0, 200);
      if (description.length < 2) fail('description en az 2 karakter olmalidir', 'description');
      const supplier = optText(o.supplier, 'supplier', 120) ?? (line.counterpartyName ? line.counterpartyName.slice(0, 120) : undefined);
      const invoiceNumber = optText(o.invoiceNumber, 'invoiceNumber', 60);
      const reason = reqReason(o.reason, false);
      const date = line.valueDate ?? line.date;
      const decisionNo = (line.decisionNo ?? 0) + 1;
      let written: { decision: BankDecision; line: BankLine } | undefined;
      let result: Awaited<ReturnType<BankMatchDeps['finance']['recordBankExpense']>>;
      try {
        result = await deps.finance.recordBankExpense(
          { apartmentId: ctx.apartmentId, userId: ctx.userId },
          {
            idempotencyId: `bankexpense-${line.lineId}-${decisionNo}`,
            bankAccountId: line.bankAccountId,
            expenseAccountId,
            amount: line.amount,
            date,
            description,
            ...(supplier ? { supplier } : {}),
            ...(invoiceNumber ? { invoiceNumber } : {}),
            reference: `BANK:${line.bankReference ? line.bankReference.replace(/[^\w.-]/g, '').slice(0, 40) || line.lineId : line.lineId}`,
            documents: ({ expense, transaction }) => {
              const now = stamp();
              const decision: BankDecision = {
                ...bankKeys.decision(ctx.apartmentId, line.lineId, decisionNo),
                entityType: 'BANK_MATCH',
                apartmentId: ctx.apartmentId,
                bankAccountId: line.bankAccountId,
                lineId: line.lineId,
                lineSk: line.SK,
                decisionNo,
                kind: 'expense',
                expense: {
                  expenseId: expense.expenseId,
                  expenseAccountId,
                  description,
                  ...(supplier ? { supplier } : {}),
                  ...(invoiceNumber ? { invoiceNumber } : {}),
                },
                transactionIds: [transaction.transactionId],
                paymentIds: [],
                ...(reason ? { reason } : {}),
                source: 'manual',
                createdAt: now,
                createdBy: ctx.userId,
              };
              const next: BankLine = {
                ...line,
                status: 'matched',
                decisionNo,
                match: { decisionNo, transactionIds: decision.transactionIds, paymentIds: [], expenseId: expense.expenseId },
                updatedAt: now,
                updatedBy: ctx.userId,
                version: line.version + 1,
              };
              written = { decision, line: next };
              return {
                newDocs: [decision],
                replaceRecords: [{ item: next, expectedVersion: line.version, label: 'bank_line' }],
                audit: {
                  apartmentId: ctx.apartmentId,
                  action: 'bank.line.expense',
                  target: { type: 'bank_line', id: line.lineId },
                  actorId: ctx.userId,
                  ...(reason ? { reason } : {}),
                  details: {
                    bankAccountId: line.bankAccountId,
                    statementId: line.statementId,
                    date,
                    amount: line.amount,
                    decisionNo,
                    expenseAccountId,
                    expenseId: expense.expenseId,
                    transactionId: transaction.transactionId,
                    description,
                  },
                },
              };
            },
          },
        );
      } catch (err) {
        if (err instanceof LedgerConflictError && err.reason === 'precondition') {
          throw new BankError('version_conflict', 'Satir baska bir islemle degisti; listeyi yenileyin', { label: err.label });
        }
        if (err instanceof LedgerConflictError && err.reason === 'closed') {
          throw new BankError('invalid_state', 'Bu tarih kapatilmis bir doneme ait; gider yazilamaz', { closedThrough: err.closedThrough });
        }
        throw err;
      }
      if (result.replayed || !written) {
        const current = await deps.repo.getLine(ctx.apartmentId, line.bankAccountId, line.lineId);
        return { replayed: true, line: publicLine(current ?? line), expense: { expenseId: result.expense.expenseId, transactionId: result.transaction.transactionId } };
      }
      const w = written as { decision: BankDecision; line: BankLine };
      return {
        replayed: false,
        line: publicLine(w.line),
        decision: publicDecision(w.decision),
        expense: {
          expenseId: result.expense.expenseId,
          expenseAccountId,
          amount: result.expense.amount,
          date: result.expense.date,
          description: result.expense.description,
          transactionId: result.transaction.transactionId,
        },
      };
    },

    // ----- Faz B3.5 -----

    async payableSuggestions(ctx: BankMatchContext, lineId: string, q: { bankAccountId?: string }) {
      const line = await requireLine(ctx, q.bankAccountId, lineId);
      const candidates = await loadPayables(ctx.apartmentId);
      return {
        line: publicLine(line),
        suggestions: line.direction === 'out' ? await payableSuggestionsFor(ctx.apartmentId, line, candidates) : [],
        payables: candidates.map((c) => ({ accountId: c.accountId, name: c.name, openBalance: c.openBalance, openItems: c.openItems.slice(0, 20) })),
      };
    },

    /**
     * Cikan satirla tedarikci borcunu kapatir: `payable_payment` (borc: tedarikci, alacak: banka,
     * valor tarihli) + BANKMATCH (`kind: 'payable'`) + BANKTX (`matched`) + PAYEE + denetim
     * (`bank.line.payable`) TEK yazim. Tutar acik borcu asamaz.
     */
    async settlePayable(ctx: BankMatchContext, lineId: string, body: unknown) {
      const o = asObj(body);
      const line = await requireLine(ctx, o.bankAccountId, lineId);
      checkVersion(line, reqVersion(o.expectedVersion));
      if (line.status !== 'unmatched') throw new BankError('invalid_state', `Satir tedarikci odemesine cevrilemez (durum: ${line.status})`, { status: line.status });
      if (line.direction !== 'out') throw new BankError('invalid_state', 'Yalnizca bankadan cikan (borc) satir tedarikci odemesi olabilir');
      const payableAccountId = reqId(o.payableAccountId, 'payableAccountId');
      const reason = reqReason(o.reason, false);
      const source = o.source === 'suggestion' ? 'suggestion' : 'manual';
      const confidence = typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1 ? o.confidence : undefined;
      const description = optText(o.description, 'description', 200) ?? `Tedarikçi ödemesi: ${line.description.replace(/\s+/g, ' ').trim()}`.slice(0, 200);
      const date = line.valueDate ?? line.date;
      const decisionNo = (line.decisionNo ?? 0) + 1;
      const payee = line.counterpartyIbanMac ? await deps.repo.getPayee(ctx.apartmentId, line.counterpartyIbanMac) : undefined;
      let written: { decision: BankDecision; line: BankLine } | undefined;
      let result: Awaited<ReturnType<BankMatchDeps['finance']['recordBankPayablePayment']>>;
      try {
        result = await deps.finance.recordBankPayablePayment(
          { apartmentId: ctx.apartmentId, userId: ctx.userId },
          {
            idempotencyId: `bankpayable-${line.lineId}-${decisionNo}`,
            bankAccountId: line.bankAccountId,
            payableAccountId,
            amount: line.amount,
            date,
            description,
            reference: `BANK:${line.bankReference ? line.bankReference.replace(/[^\w.-]/g, '').slice(0, 40) || line.lineId : line.lineId}`,
            documents: ({ transaction, payable }) => {
              const now = stamp();
              const decision: BankDecision = {
                ...bankKeys.decision(ctx.apartmentId, line.lineId, decisionNo),
                entityType: 'BANK_MATCH',
                apartmentId: ctx.apartmentId,
                bankAccountId: line.bankAccountId,
                lineId: line.lineId,
                lineSk: line.SK,
                decisionNo,
                kind: 'payable',
                payable: { payableAccountId, payableName: payable.name, openBefore: Math.max(0, -payable.balance) },
                transactionIds: [transaction.transactionId],
                paymentIds: [],
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
                match: { decisionNo, transactionIds: decision.transactionIds, paymentIds: [] },
                updatedAt: now,
                updatedBy: ctx.userId,
                version: line.version + 1,
              };
              written = { decision, line: next };
              const pe = line.counterpartyIbanMac ? payeeUpdate(ctx.apartmentId, payee, line.counterpartyIbanMac, payableAccountId, 1) : undefined;
              return {
                newDocs: [decision, ...(pe?.create ? [pe.create] : [])],
                replaceRecords: [{ item: next, expectedVersion: line.version, label: 'bank_line' }, ...(pe?.replace ? [pe.replace] : [])],
                audit: {
                  apartmentId: ctx.apartmentId,
                  action: 'bank.line.payable',
                  target: { type: 'bank_line', id: line.lineId },
                  actorId: ctx.userId,
                  ...(reason ? { reason } : {}),
                  details: {
                    bankAccountId: line.bankAccountId,
                    statementId: line.statementId,
                    date,
                    amount: line.amount,
                    decisionNo,
                    payableAccountId,
                    payableName: payable.name,
                    openBefore: Math.max(0, -payable.balance),
                    transactionId: transaction.transactionId,
                    source,
                  },
                },
              };
            },
          },
        );
      } catch (err) {
        if (err instanceof LedgerConflictError && err.reason === 'precondition') {
          throw new BankError('version_conflict', 'Satir baska bir islemle degisti; listeyi yenileyin', { label: err.label });
        }
        if (err instanceof LedgerConflictError && err.reason === 'closed') {
          throw new BankError('invalid_state', 'Bu tarih kapatilmis bir doneme ait; odeme yazilamaz', { closedThrough: err.closedThrough });
        }
        throw err;
      }
      if (result.replayed || !written) {
        const current = await deps.repo.getLine(ctx.apartmentId, line.bankAccountId, line.lineId);
        return { replayed: true, line: publicLine(current ?? line), transactionId: result.transaction.transactionId };
      }
      const w = written as { decision: BankDecision; line: BankLine };
      return {
        replayed: false,
        line: publicLine(w.line),
        decision: publicDecision(w.decision),
        transactionId: result.transaction.transactionId,
        openBalanceAfter: Math.max(0, -result.payable.balance - line.amount),
      };
    },

    /**
     * Donemsel mutabakat PDF'i. Veri (mutabakat + bekleyen/yoksayilan satirlar + sablon surumu)
     * ozetlenir; ayni ozetli dosya S3'te varsa yeniden uretilmez. 5 dk imzali indirme linki.
     */
    async reconciliationReport(ctx: BankMatchContext, q: { bankAccountId?: string; from?: string; to?: string }) {
      const store = deps.documents;
      if (!store) throw new BankError('unavailable', 'Belge deposu yapilandirilmamis (DOCUMENTS_BUCKET)');
      const { result, lines, range, account } = await reconcile(ctx, q);
      const asOf = result.asOf ?? range.to ?? today();
      const inRange = (d: string) => (!range.from || d >= range.from) && (!range.to || d <= range.to);
      const pendingAll = lines.filter((l) => l.status === 'unmatched' && inRange(l.date));
      const ignoredAll = lines.filter((l) => l.status === 'ignored' && inRange(l.date));
      const toRow = (l: BankLine, reasonOf?: string): BankReconLine => ({
        date: l.date,
        direction: l.direction,
        amount: l.amount,
        description: l.description,
        ...(l.counterpartyName ? { counterpartyName: l.counterpartyName } : {}),
        ...(reasonOf ? { reason: reasonOf } : {}),
      });
      const ignoredShown = ignoredAll.slice(0, REPORT_LIST_MAX);
      const reasons = new Map<string, string>();
      for (const l of ignoredShown.slice(0, REPORT_REASON_MAX)) {
        const d = (await deps.repo.listDecisions(ctx.apartmentId, l.lineId)).filter((x) => x.kind === 'ignore').at(-1);
        if (d?.reason) reasons.set(l.lineId, d.reason);
      }
      const [site, profile] = await Promise.all([deps.core.getSite(ctx.apartmentId), deps.repo.getProfile(ctx.apartmentId, result.bankAccountId)]);
      const b = result.breakdown;
      const data = {
        apartmentName: site?.name ?? 'Apartman Yönetimi',
        bankAccountName: account.name,
        ...(profile?.iban ? { ibanMasked: maskIban(profile.iban) } : {}),
        period: range,
        ...(result.openingBalance !== undefined ? { openingBalance: result.openingBalance } : {}),
        ...(result.openingStatement?.period ? { openingDate: result.openingStatement.period.from } : {}),
        ...(result.ledgerBalanceAtStart !== undefined ? { ledgerBalanceAtStart: result.ledgerBalanceAtStart } : {}),
        ...(result.closingBalance !== undefined ? { closingBalance: result.closingBalance } : {}),
        ...(result.asOf ? { asOf: result.asOf } : {}),
        ...(result.ledgerBalanceAtStatementEnd !== undefined ? { ledgerBalanceAtEnd: result.ledgerBalanceAtStatementEnd } : {}),
        ...(result.difference !== undefined ? { difference: result.difference } : {}),
        ...(result.pendingNet !== undefined ? { pendingNet: result.pendingNet } : {}),
        ...(result.unexplainedDiff !== undefined ? { unexplainedDiff: result.unexplainedDiff } : {}),
        breakdown: [
          { label: 'Eşleşen giren (tahsilat)', ...b.matchedIn },
          { label: 'Eşleşen çıkan (gider / tedarikçi)', ...b.matchedOut },
          { label: 'Bekleyen giren', ...b.unmatchedIn },
          { label: 'Bekleyen çıkan', ...b.unmatchedOut },
          { label: 'Yoksayılan giren', ...b.ignoredIn },
          { label: 'Yoksayılan çıkan', ...b.ignoredOut },
        ],
        pending: pendingAll.slice(0, REPORT_LIST_MAX).map((l) => toRow(l)),
        ignored: ignoredShown.map((l) => toRow(l, reasons.get(l.lineId))),
        ...(pendingAll.length > REPORT_LIST_MAX ? { pendingOmitted: pendingAll.length - REPORT_LIST_MAX } : {}),
        ...(ignoredAll.length > REPORT_LIST_MAX ? { ignoredOmitted: ignoredAll.length - REPORT_LIST_MAX } : {}),
      };
      const dataHash = createHash('sha256').update(JSON.stringify({ v: BANK_RECON_TEMPLATE_VERSION, apartmentId: ctx.apartmentId, ...data })).digest('hex');
      const key = bankReconReportKey(ctx.apartmentId, asOf, result.bankAccountId, range, dataHash);
      const cached = Boolean(await store.head(key));
      if (!cached) {
        const pdf = await renderBankReconPdf({ ...data, generatedAt: stamp(), dataHash });
        await store.put(key, pdf, 'application/pdf');
      }
      const fileName = `Banka-Mutabakat-${account.name}-${range.from ?? 'baslangic'}_${range.to ?? asOf}.pdf`.replace(/[^\w.-]+/g, '-');
      const url = await store.presignGet(key, {
        contentDisposition: contentDisposition(fileName, 'attachment'),
        contentType: 'application/pdf',
        expiresIn: URL_TTL_SECONDS,
      });
      return {
        url,
        fileName,
        contentType: 'application/pdf',
        expiresAt: new Date(deps.now().getTime() + URL_TTL_SECONDS * 1000).toISOString(),
        cached,
        dataHash: dataHash.slice(0, 16),
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
