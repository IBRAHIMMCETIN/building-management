import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Role } from '../src/auth/claims.js';
import type { Block, Site, Unit } from '../src/modules/core/types.js';
import { type AuditSnapshot, bankReconciliations, checkBankMatches, createLedgerAuditor } from '../src/modules/finance/audit.js';
import { createLocalIbanMacer } from '../src/modules/finance/bank/iban.js';
import { bankKeys, lineIdOf } from '../src/modules/finance/bank/keys.js';
import { createBankMatchService } from '../src/modules/finance/bank/matchService.js';
import { refCodeFor } from '../src/modules/finance/bank/matching.js';
import { addLines, emptyBreakdown, pendingNetThrough, pickStatements, reconcileAccount } from '../src/modules/finance/bank/reconciliation.js';
import { createBankService } from '../src/modules/finance/bank/service.js';
import { AUTO_MATCH_BATCH, type BankAutoRun, type BankLine, type BankStatement } from '../src/modules/finance/bank/types.js';
import { toLedgerEntries } from '../src/modules/finance/repository.js';
import { type FinanceService, createFinanceService } from '../src/modules/finance/service.js';
import type { Account, Expense, Transaction } from '../src/modules/finance/types.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { createSchedulerWorker } from '../src/workers/scheduler-worker.js';
import { createFakeBankRepo } from './fakes/bankRepo.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';

/*
 * Faz B3: toplu otomatik eslestirme, cikan satirdan gider (+ geri alma), ayrintili mutabakat ve
 * gece denetiminin `BankReconDiff` metrigi.
 */

const APT = 'apt-b3';
const NOW = new Date('2026-11-22T07:00:00.000Z');
const NOV = '20261130-00000000-0000-4000-8000-00000000b301';
const OCT = '20261031-00000000-0000-4000-8000-00000000b300';

const unit = (unitId: string, blockId: string, number: string) =>
  ({ unitId, siteId: APT, blockId, number, status: 'active', type: 'flat', grossAreaTenthsM2: 1000, exemptions: [] }) as unknown as Unit;
const UNITS = [unit('u12', 'bA', '12'), unit('u3', 'bB', '3'), unit('u7', 'bA', '7')];
const BLOCKS = [
  { blockId: 'bA', name: 'A Blok', status: 'active' },
  { blockId: 'bB', name: 'B Blok', status: 'active' },
] as unknown as Block[];
const SITE = { siteId: APT, settings: { lateFeeMonthlyBasisPoints: 500 } } as unknown as Site;
const member = (userId: string, unitId: string) =>
  ({ userId, unitId, apartmentId: APT, relation: 'tenant', residesInUnit: true, status: 'active', startDate: '2025-01-01' }) as unknown as UnitMembership;

describe('Faz B3 - banka', () => {
  let role: Role;
  let fin: ReturnType<typeof createFakeFinanceRepo>;
  let bank: ReturnType<typeof createFakeBankRepo>;
  let finance: FinanceService;
  let app: ReturnType<typeof createApp>;
  let seq: number;
  const ctx = { apartmentId: APT, userId: 'u-manager' };
  const core = {
    getSite: async () => SITE,
    getUnit: async (_a: string, id: string) => UNITS.find((u) => u.unitId === id),
    listUnits: async () => UNITS,
    listBlocks: async () => BLOCKS,
  };

  /** Banka uclari; `financeOverride` ile finans cekirdegi sarilabilir (yarida kesilme testi). */
  function build(financeOverride?: Partial<FinanceService>) {
    const allTx = () => [...fin.transactions.values()].filter((t) => t.siteId === APT);
    const match = createBankMatchService({
      repo: bank.repo,
      finance: { ...finance, ...financeOverride },
      accounts: fin.repo,
      ledger: {
        listLedgerEntries: async (_a, accountId) => allTx().flatMap(toLedgerEntries).filter((e) => e.accountId === accountId),
        getTransactions: async (_a, ids) => allTx().filter((t) => ids.includes(t.transactionId)),
      },
      core,
      memberships: { list: async () => [member('p-ayse', 'u12'), member('p-sukru', 'u3')] },
      people: {
        list: async () =>
          [
            { userId: 'p-ayse', fullName: 'Ayşe Yılmaz' },
            { userId: 'p-sukru', fullName: 'Şükrü Çelik' },
          ] as never,
      },
      now: () => NOW,
    });
    const bankService = createBankService({ repo: bank.repo, store: undefined, macer: createLocalIbanMacer(), accounts: fin.repo, now: () => NOW });
    app = createApp({
      version: 't',
      authenticate: () => ({ userId: 'u-manager', role, apartmentId: APT }),
      bankService,
      bankMatchService: match,
    });
  }

  beforeEach(async () => {
    role = 'apartment_manager';
    seq = 0;
    fin = createFakeFinanceRepo(APT);
    bank = createFakeBankRepo(fin.docs as unknown as Map<string, Record<string, unknown>>);
    const newId = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`;
    finance = createFinanceService({ repository: fin.repo, core, now: () => NOW, newId });
    await finance.charge(ctx, { idempotencyKey: 'c12', unitId: 'u12', liableParty: 'occupant', amount: 150000, date: '2026-10-01', dueDate: '2026-10-05', description: 'Ekim aidatı' });
    await finance.charge(ctx, { idempotencyKey: 'c3', unitId: 'u3', liableParty: 'occupant', amount: 200050, date: '2026-11-01', dueDate: '2026-11-05', description: 'Kasım aidatı' });
    build();
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };

  function seedLine(fp: string, over: Partial<BankLine> = {}): BankLine {
    const date = over.date ?? '2026-11-04';
    const l: BankLine = {
      ...bankKeys.line(APT, 'bank', date, fp),
      entityType: 'BANK_LINE',
      lineId: lineIdOf(date, fp),
      apartmentId: APT,
      bankAccountId: 'bank',
      statementId: NOV,
      sourceRow: 5,
      date,
      direction: 'in',
      amount: 150000 as never,
      description: 'HAVALE A BLOK 12 AIDAT',
      counterpartyName: 'AYŞE YILMAZ',
      counterpartyIbanMasked: 'TR** **** **** **** **** **13 26',
      counterpartyIbanMac: 'l1:mac-ayse',
      fingerprint: fp,
      fingerprintVersion: 1,
      status: 'unmatched',
      createdAt: NOW.toISOString(),
      createdBy: 'u-manager',
      version: 1,
      ...over,
    };
    // `undefined` verilen alanlar kayitta hic olmasin (DynamoDB'de oldugu gibi).
    const stored = Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined));
    bank.items.set(`${l.PK}|${l.SK}`, structuredClone(stored));
    return l;
  }
  const fp = (n: number) => n.toString(16).padStart(24, '0');
  const getLine = (l: BankLine) => bank.items.get(`${l.PK}|${l.SK}`) as unknown as BankLine;
  const acc = (id: string) => fin.accounts.get(`${APT}|${id}`) as Account;
  const txs = () => [...fin.transactions.values()] as Transaction[];

  function seedStatement(statementId: string, period: { from: string; to: string }, openingBalance: number, closingBalance: number) {
    const st = {
      ...bankKeys.statement(APT, statementId),
      entityType: 'BANK_STATEMENT',
      statementId,
      apartmentId: APT,
      bankAccountId: 'bank',
      status: 'committed',
      fileName: `${period.to.slice(0, 7)}.xlsx`,
      period,
      openingBalance,
      closingBalance,
      committed: { newLines: 0, existingLines: 0, committedAt: NOW.toISOString(), committedBy: 'u-manager' },
      version: 2,
    } as unknown as BankStatement;
    bank.items.set(`${st.PK}|${st.SK}`, st as unknown as Record<string, unknown>);
    return st;
  }

  function seedRef(accountId: string, unitId: string): string {
    const code = refCodeFor(APT, accountId, 0);
    const base = { apartmentId: APT, accountId, code, createdAt: NOW.toISOString() };
    bank.items.set(`APT#${APT}|BANKREF#${code}`, { ...bankKeys.ref(APT, code), entityType: 'BANK_REF', ...base, unitId, liableParty: 'occupant', createdBy: 'seed' });
    bank.items.set(`APT#${APT}|BANKREFOF#${accountId}`, { ...bankKeys.refOf(APT, accountId), entityType: 'BANK_REF_OF', ...base });
    return code;
  }

  const autoRun = (key: string) => bank.items.get(`APT#${APT}|BANKAUTO#${NOV}#${key}`) as unknown as BankAutoRun | undefined;

  // -------------------------------------------------------------------------
  // 1) Toplu otomatik eslestirme
  // -------------------------------------------------------------------------

  describe('toplu otomatik eslestirme', () => {
    /** A: blok/daire + ad (0.92), B: zayif (0.47), C: kapali cariye referans kodu (1.0), D: cikan. */
    function seedMixed() {
      seedStatement(NOV, { from: '2026-11-01', to: '2026-11-30' }, 0, 0);
      fin.accounts.set(`${APT}|recv-u3-occupant`, { ...acc('recv-u3-occupant'), closedThrough: '2026-11-10' });
      const code3 = seedRef('recv-u3-occupant', 'u3');
      const a = seedLine(fp(0xa));
      const b = seedLine(fp(0xb), { amount: 99 as never, description: 'AIDAT D:12', counterpartyName: undefined, counterpartyIbanMac: undefined });
      const c = seedLine(fp(0xc), { amount: 200050 as never, description: `EFT ${code3} KASIM`, counterpartyName: undefined, counterpartyIbanMac: undefined });
      const d = seedLine(fp(0xd), { direction: 'out', amount: 2500 as never, description: 'HESAP ISLETIM UCRETI', counterpartyName: undefined, counterpartyIbanMac: undefined });
      return { a, b, c, d };
    }

    it('on izleme yazim yapmaz: esik ustu + cakismasiz satirlar, atlanan ozetleri', async () => {
      seedMixed();
      const before = fin.batches.length;
      const r = await call('GET', `/api/bank/statements/${NOV}/auto-match`);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({
        statementId: NOV,
        minConfidence: 0.85,
        batchSize: AUTO_MATCH_BATCH,
        eligibleCount: 1,
        eligibleAmount: 150000,
        skippedLowConfidence: 1,
        skippedAmbiguous: 0,
        skippedClosed: 1,
        unmatchedIn: 3,
        unmatchedOut: 1,
      });
      expect(r.json.items[0].suggestion).toMatchObject({ kind: 'unit', confidence: 0.92, allocations: [{ accountId: 'recv-u12-occupant', unitLabel: 'A Blok · 12' }] });
      expect(fin.batches.length).toBe(before);
      // Esik %95: blok/daire onerisi de dusuk sayilir.
      expect((await call('GET', `/api/bank/statements/${NOV}/auto-match?minConfidence=0.95`)).json).toMatchObject({ eligibleCount: 0, skippedLowConfidence: 2 });
      expect((await call('GET', `/api/bank/statements/${NOV}/auto-match?minConfidence=0.5`)).status).toBe(422);
    });

    it('esik kontrolu, kapali cari atlama, ozet sonuc ve denetim kaydi', async () => {
      const { a, b, c, d } = seedMixed();
      const strict = await call('POST', `/api/bank/statements/${NOV}/auto-match`, { idempotencyKey: 'run-strict-01', minConfidence: 0.95 });
      expect(strict.status).toBe(200);
      expect(strict.json).toMatchObject({ matchedCount: 0, totalMatchedAmount: 0, skippedLowConfidence: 2, skippedClosed: 1, remaining: 0, completed: true });
      expect(getLine(a).status).toBe('unmatched');

      const r = await call('POST', `/api/bank/statements/${NOV}/auto-match`, { idempotencyKey: 'run-default-01' });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({
        replayed: false,
        minConfidence: 0.85,
        matchedCount: 1,
        totalMatchedAmount: 150000,
        skippedLowConfidence: 1,
        skippedAmbiguous: 0,
        skippedClosed: 1,
        skippedConflict: 0,
        remaining: 0,
        completed: true,
        thisCall: { matchedCount: 1, totalMatchedAmount: 150000 },
      });
      expect(r.json.items).toEqual([{ lineId: a.lineId, amount: 150000, confidence: 0.92, receiptNumbers: ['MKB-000001'] }]);

      // Satir match ile ayni yoldan islendi: tazminat + tahsilat + karar (source: auto) + satir.
      expect(getLine(a)).toMatchObject({ status: 'matched', version: 2, decisionNo: 1 });
      expect(bank.decisions(APT).find((x) => x.lineId === a.lineId)).toMatchObject({
        kind: 'match',
        source: 'auto',
        confidence: 0.92,
        autoRunId: `${NOV}#run-default-01`,
        reason: 'Toplu otomatik onay (eşik %85)',
      });
      expect(acc('bank').balance).toBe(150000);
      expect(fin.events('PAYMENT_RECEIVED')).toHaveLength(1);
      expect(fin.batches.at(-1)?.audit).toMatchObject({ action: 'bank.line.match', details: { source: 'auto', autoRunId: `${NOV}#run-default-01` } });
      // Kapali cariye dusen, dusuk guvenli ve cikan satirlar dokunulmadan kalir.
      for (const l of [b, c, d]) expect(getLine(l)).toMatchObject({ status: 'unmatched', version: 1 });

      expect(autoRun('run-default-01')).toMatchObject({ status: 'completed', calls: 1, matchedCount: 1, totalMatchedAmount: 150000, lastSkipped: { lowConfidence: 1, closed: 1 } });
      expect(bank.audits.at(-1)).toMatchObject({
        action: 'bank.statement.auto_match',
        target: { type: 'bank_statement', id: NOV },
        details: { minConfidence: 0.85, matchedCount: 1, totalMatchedAmount: 150000, skippedLowConfidence: 1, skippedClosed: 1, remaining: 0, lineIds: [a.lineId] },
      });

      // Ayni anahtar: tamamlanmis calismanin ozeti, yeni yazim yok.
      const batches = fin.batches.length;
      const again = await call('POST', `/api/bank/statements/${NOV}/auto-match`, { idempotencyKey: 'run-default-01' });
      expect(again.json).toMatchObject({ replayed: true, matchedCount: 1, totalMatchedAmount: 150000, completed: true, thisCall: { matchedCount: 0 } });
      expect(fin.batches.length).toBe(batches);
      // Ayni anahtar farkli esikle kullanilamaz.
      const other = await call('POST', `/api/bank/statements/${NOV}/auto-match`, { idempotencyKey: 'run-default-01', minConfidence: 0.9 });
      expect(other.status).toBe(409);
      expect(other.json).toMatchObject({ error: 'conflict', minConfidence: 0.85 });
    });

    it(`istek basina en fazla ${AUTO_MATCH_BATCH} satir; ayni anahtarla kalanlardan devam eder`, async () => {
      seedStatement(NOV, { from: '2026-11-01', to: '2026-11-30' }, 0, 0);
      const code = seedRef('recv-u12-occupant', 'u12');
      const lines = Array.from({ length: AUTO_MATCH_BATCH + 2 }, (_, i) =>
        seedLine(fp(0x100 + i), { amount: 1000 as never, description: `EFT ${code}`, counterpartyName: undefined, counterpartyIbanMac: undefined }),
      );
      const first = await call('POST', `/api/bank/statements/${NOV}/auto-match`, { idempotencyKey: 'batch-run-01' });
      expect(first.json).toMatchObject({ matchedCount: AUTO_MATCH_BATCH, remaining: 2, completed: false, thisCall: { matchedCount: AUTO_MATCH_BATCH } });
      expect(autoRun('batch-run-01')).toMatchObject({ status: 'running', calls: 1, matchedCount: AUTO_MATCH_BATCH });
      const pending = lines.filter((l) => getLine(l).status === 'unmatched');
      expect(pending).toHaveLength(2);

      // Arada satirlardan biri elle eslestirilir: devam cagrisi yalnizca hala eslesmemis olani isler.
      const manual = pending[0] as BankLine;
      expect((await call('POST', `/api/bank/lines/${manual.lineId}/match`, { bankAccountId: 'bank', expectedVersion: 1, allocations: [{ accountId: 'recv-u12-occupant', amount: 1000 }] })).status).toBe(200);
      const second = await call('POST', `/api/bank/statements/${NOV}/auto-match`, { idempotencyKey: 'batch-run-01' });
      expect(second.json).toMatchObject({ matchedCount: AUTO_MATCH_BATCH + 1, totalMatchedAmount: (AUTO_MATCH_BATCH + 1) * 1000, remaining: 0, completed: true, thisCall: { matchedCount: 1 } });
      expect(lines.every((l) => getLine(l).status === 'matched')).toBe(true);
      expect(autoRun('batch-run-01')).toMatchObject({ status: 'completed', calls: 2 });
      // Her satir tek karar (cift eslestirme yok).
      expect(bank.decisions(APT).filter((x) => x.kind === 'match')).toHaveLength(AUTO_MATCH_BATCH + 2);
    });

    it('yarida kesilme: hata calisma kaydina islenir, ayni anahtarla yalnizca kalan satirlar islenir', async () => {
      seedStatement(NOV, { from: '2026-11-01', to: '2026-11-30' }, 0, 0);
      const code = seedRef('recv-u12-occupant', 'u12');
      const lines = [1, 2, 3].map((i) => seedLine(fp(0x200 + i), { amount: 1000 as never, description: `EFT ${code}`, counterpartyName: undefined, counterpartyIbanMac: undefined }));
      let calls = 0;
      build({
        recordBankPayment: async (c, p) => {
          if (++calls === 2) throw new Error('ProvisionedThroughputExceeded');
          return finance.recordBankPayment(c, p);
        },
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failed = await call('POST', `/api/bank/statements/${NOV}/auto-match`, { idempotencyKey: 'crash-run-01' });
      errSpy.mockRestore();
      expect(failed.status).toBe(500);
      expect(lines.map((l) => getLine(l).status)).toEqual(['matched', 'unmatched', 'unmatched']);
      expect(autoRun('crash-run-01')).toMatchObject({ status: 'running', matchedCount: 1, version: 2 });
      expect(bank.audits.at(-1)).toMatchObject({ action: 'bank.statement.auto_match', details: { matchedCount: 1, error: 'Error: ProvisionedThroughputExceeded' } });

      const resumed = await call('POST', `/api/bank/statements/${NOV}/auto-match`, { idempotencyKey: 'crash-run-01' });
      expect(resumed.json).toMatchObject({ matchedCount: 3, totalMatchedAmount: 3000, completed: true, thisCall: { matchedCount: 2 } });
      expect(lines.every((l) => getLine(l).status === 'matched')).toBe(true);
      expect(fin.trialBalance()).toBe(0);
    });

    it('ayni anahtarla es zamanli ikinci cagri reddedilir', async () => {
      seedStatement(NOV, { from: '2026-11-01', to: '2026-11-30' }, 0, 0);
      const running: BankAutoRun = {
        ...bankKeys.autoRun(APT, NOV, 'busy-run-001'),
        entityType: 'BANK_AUTO_RUN',
        apartmentId: APT,
        runId: `${NOV}#busy-run-001`,
        statementId: NOV,
        bankAccountId: 'bank',
        idempotencyKey: 'busy-run-001',
        minConfidence: 0.85,
        status: 'running',
        calls: 1,
        matchedCount: 0,
        totalMatchedAmount: 0 as never,
        lastSkipped: { lowConfidence: 0, ambiguous: 0, closed: 0, conflict: 0 },
        createdAt: NOW.toISOString(),
        createdBy: 'u-manager',
        updatedAt: NOW.toISOString(),
        version: 3,
      };
      bank.items.set(`${running.PK}|${running.SK}`, running as unknown as Record<string, unknown>);
      const origGet = bank.repo.getAutoRun;
      // Okuma eski surumu dondurur (diger istek arada sahiplendi).
      bank.repo.getAutoRun = async (...args) => {
        const r = await origGet(...args);
        return r ? { ...r, version: 2 } : r;
      };
      const r = await call('POST', `/api/bank/statements/${NOV}/auto-match`, { idempotencyKey: 'busy-run-001' });
      expect(r.status).toBe(409);
      expect(r.json.error).toBe('version_conflict');
    });

    it('dogrulama ve yetki', async () => {
      seedStatement(NOV, { from: '2026-11-01', to: '2026-11-30' }, 0, 0);
      expect((await call('POST', `/api/bank/statements/${NOV}/auto-match`, {})).status).toBe(422);
      expect((await call('POST', `/api/bank/statements/${NOV}/auto-match`, { idempotencyKey: 'k' })).status).toBe(422);
      expect((await call('POST', `/api/bank/statements/${NOV}/auto-match`, { idempotencyKey: 'valid-key-01', minConfidence: 1.5 })).status).toBe(422);
      expect((await call('POST', `/api/bank/statements/${OCT}/auto-match`, { idempotencyKey: 'valid-key-01' })).status).toBe(404);
      expect((await call('POST', '/api/bank/statements/bozuk/auto-match', { idempotencyKey: 'valid-key-01' })).status).toBe(404);
      const previewed = seedStatement(OCT, { from: '2026-10-01', to: '2026-10-31' }, 0, 0);
      bank.items.set(`${previewed.PK}|${previewed.SK}`, { ...(previewed as unknown as Record<string, unknown>), status: 'previewed' });
      expect((await call('POST', `/api/bank/statements/${OCT}/auto-match`, { idempotencyKey: 'valid-key-01' })).json.error).toBe('invalid_state');
      role = 'observer';
      expect((await call('GET', `/api/bank/statements/${NOV}/auto-match`)).status).toBe(200);
      expect((await call('POST', `/api/bank/statements/${NOV}/auto-match`, { idempotencyKey: 'valid-key-01' })).status).toBe(403);
      role = 'resident';
      expect((await call('GET', `/api/bank/statements/${NOV}/auto-match`)).status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // 2) Cikan satirdan gider + geri alma
  // -------------------------------------------------------------------------

  describe('cikan satirdan gider', () => {
    const body = (expectedVersion = 1, over: Record<string, unknown> = {}) => ({ bankAccountId: 'bank', expectedVersion, expenseAccountId: 'exp-electricity', ...over });

    it('gider + islem + karar + satir + denetim tek yazimda; banka yetersiz bakiye kontrolu uygulanmaz', async () => {
      const l = seedLine(fp(0xe1), {
        direction: 'out',
        amount: 245075 as never,
        date: '2026-11-10',
        valueDate: '2026-11-11',
        description: 'ENERJISA FATURA 2026/10',
        counterpartyName: 'ENERJISA BASKENT',
        counterpartyIbanMac: undefined,
        bankReference: 'DK-4471',
      });
      const r = await call('POST', `/api/bank/lines/${l.lineId}/expense`, body(1, { invoiceNumber: 'EA2026000123', reason: 'Ekim faturası' }));
      expect(r.status).toBe(200);
      expect(r.json.expense).toMatchObject({ expenseAccountId: 'exp-electricity', amount: 245075, date: '2026-11-11', description: 'ENERJISA FATURA 2026/10' });

      const tx = txs().find((t) => t.kind === 'expense') as Transaction;
      expect(tx).toMatchObject({ date: '2026-11-11', reference: 'BANK:DK-4471', totalAmount: 245075 });
      expect(tx.lines).toEqual([
        { accountId: 'exp-electricity', side: 'debit', amount: 245075 },
        { accountId: 'bank', side: 'credit', amount: 245075 },
      ]);
      const expense = [...fin.expenses.values()][0] as Expense;
      expect(expense).toMatchObject({ creditAccountId: 'bank', supplier: 'ENERJISA BASKENT', invoiceNumber: 'EA2026000123', transactionId: tx.transactionId });
      expect(acc('bank').balance).toBe(-245075);
      expect(acc('exp-electricity').balance).toBe(245075);
      expect(fin.trialBalance()).toBe(0);

      expect(getLine(l)).toMatchObject({
        status: 'matched',
        version: 2,
        decisionNo: 1,
        match: { decisionNo: 1, transactionIds: [tx.transactionId], paymentIds: [], expenseId: expense.expenseId },
      });
      expect(bank.decisions(APT)[0]).toMatchObject({
        kind: 'expense',
        expense: { expenseId: expense.expenseId, expenseAccountId: 'exp-electricity', invoiceNumber: 'EA2026000123' },
        transactionIds: [tx.transactionId],
        reason: 'Ekim faturası',
      });
      const batch = fin.batches.at(-1);
      expect(batch?.audit).toMatchObject({ action: 'bank.line.expense', target: { type: 'bank_line', id: l.lineId }, details: { expenseId: expense.expenseId, amount: 245075 } });
      expect(batch?.idempotency.id).toBe(`bankexpense-${l.lineId}-1`);

      // Ayni surumla tekrar: satir degisti.
      const again = await call('POST', `/api/bank/lines/${l.lineId}/expense`, body(1));
      expect(again.status).toBe(409);
      expect(again.json.error).toBe('version_conflict');
      expect(checkBankMatches({ transactions: txs(), bankLines: bank.lines(APT), bankDecisions: bank.decisions(APT) })).toEqual([]);
    });

    it('yalnizca cikan + eslesmemis satir; gecersiz gider hesabi; yetki', async () => {
      const inLine = seedLine(fp(0xe2));
      expect((await call('POST', `/api/bank/lines/${inLine.lineId}/expense`, body())).json.error).toBe('invalid_state');
      const out = seedLine(fp(0xe3), { direction: 'out', amount: 1000 as never, description: 'MASRAF', counterpartyIbanMac: undefined });
      expect((await call('POST', `/api/bank/lines/${out.lineId}/expense`, body(1, { expenseAccountId: 'bank' }))).status).toBe(422);
      expect((await call('POST', `/api/bank/lines/${out.lineId}/expense`, body(1, { expenseAccountId: 'yok-boyle-hesap' }))).status).toBe(404);
      expect((await call('POST', `/api/bank/lines/${out.lineId}/expense`, body(1, { description: 'x'.repeat(201) }))).status).toBe(422);
      expect(getLine(out).status).toBe('unmatched');
      role = 'observer';
      expect((await call('POST', `/api/bank/lines/${out.lineId}/expense`, body())).status).toBe(403);
      role = 'apartment_manager';
      // Aciklama verilmezse banka aciklamasi kullanilir.
      const ok = await call('POST', `/api/bank/lines/${out.lineId}/expense`, body(1, { expenseAccountId: 'exp-other' }));
      expect(ok.status).toBe(200);
      expect(ok.json.expense.description).toBe('MASRAF');
      // Gidere cevrilen satir ayrica tahsilata cevrilemez / yoksayilamaz.
      expect((await call('POST', `/api/bank/lines/${out.lineId}/ignore`, { bankAccountId: 'bank', expectedVersion: 2, reason: 'Deneme' })).json.error).toBe('invalid_state');
    });

    it('geri alma: gider ters kayitla iptal, satir yeniden acilir; tekrar gider olusturulabilir', async () => {
      const l = seedLine(fp(0xe4), { direction: 'out', amount: 2500 as never, description: 'ASANSOR BAKIM', counterpartyIbanMac: undefined });
      await call('POST', `/api/bank/lines/${l.lineId}/expense`, body(1, { expenseAccountId: 'exp-elevator' }));
      const expenseTx = txs().find((t) => t.kind === 'expense') as Transaction;

      const r = await call('POST', `/api/bank/lines/${l.lineId}/unmatch`, { bankAccountId: 'bank', expectedVersion: 2, reason: 'Yanlış kalem' });
      expect(r.status).toBe(200);
      const reversal = txs().find((t) => t.kind === 'reversal') as Transaction;
      expect(reversal).toMatchObject({ reversalOf: expenseTx.transactionId, date: '2026-11-22' });
      expect(fin.docs.has(`APT#${APT}|IDEM#REV_${expenseTx.transactionId}`)).toBe(true);
      expect(acc('bank').balance).toBe(0);
      expect(acc('exp-elevator').balance).toBe(0);
      expect(getLine(l)).toMatchObject({ status: 'unmatched', version: 3, decisionNo: 2 });
      expect(getLine(l).match).toBeUndefined();
      expect(bank.decisions(APT)[1]).toMatchObject({ kind: 'unmatch', reverses: 1, reversedTransactionIds: [expenseTx.transactionId] });
      expect(fin.batches.at(-1)?.audit).toMatchObject({ action: 'bank.line.unmatch', reason: 'Yanlış kalem', details: { reversedKind: 'expense', expenseId: getLine(l).match?.expenseId ?? expect.any(String) } });
      expect(checkBankMatches({ transactions: txs(), bankLines: bank.lines(APT), bankDecisions: bank.decisions(APT) })).toEqual([]);
      // Ayni gider elle ikinci kez ters cevrilemez.
      expect((await finance.reverseTransaction(ctx, expenseTx.transactionId, { reason: 'tekrar' }).catch((e: Error) => e)) instanceof Error).toBe(true);

      const re = await call('POST', `/api/bank/lines/${l.lineId}/expense`, body(3, { expenseAccountId: 'exp-repair' }));
      expect(re.status).toBe(200);
      expect(acc('exp-repair').balance).toBe(2500);
      expect(getLine(l)).toMatchObject({ status: 'matched', decisionNo: 3 });
    });

    it('gece denetimi: gider islemi yoksa veya iptal edilmisse bank_match_mismatch', async () => {
      const l = seedLine(fp(0xe5), { direction: 'out', amount: 2500 as never, description: 'MASRAF', counterpartyIbanMac: undefined });
      await call('POST', `/api/bank/lines/${l.lineId}/expense`, body(1, { expenseAccountId: 'exp-other' }));
      const snapshot = () => ({ transactions: txs(), bankLines: bank.lines(APT), bankDecisions: bank.decisions(APT) });
      expect(checkBankMatches(snapshot())).toEqual([]);
      const withoutExpense = { ...snapshot(), transactions: txs().filter((t) => t.kind !== 'expense') };
      expect(checkBankMatches(withoutExpense).map((f) => f.detail)).toEqual(['gider islemi defterde yok veya tutari uyusmuyor']);
      const exp = txs().find((t) => t.kind === 'expense') as Transaction;
      const reversal = { ...exp, transactionId: 'rev-x', kind: 'reversal', reversalOf: exp.transactionId } as Transaction;
      expect(checkBankMatches({ ...snapshot(), transactions: [...txs(), reversal] }).map((f) => f.detail)).toEqual([
        'gider ters kayitla iptal edilmis ama satir eslesmis',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // 3) Ayrintili mutabakat + BankReconDiff
  // -------------------------------------------------------------------------

  describe('ayrintili mutabakat', () => {
    /**
     * Kasim: +150.000 (eslesen tahsilat), -2.500 (gider), +5.000 (bekleyen), -1.000 (yoksayilan,
     * deftere islenmemis masraf). Banka kapanisi 151.500; defter 147.500 -> fark 4.000, bekleyen
     * net +5.000, aciklanamayan -1.000 (yoksayilan masraf).
     */
    async function scenario() {
      seedStatement(OCT, { from: '2026-10-01', to: '2026-10-31' }, 0, 0);
      seedStatement(NOV, { from: '2026-11-01', to: '2026-11-30' }, 0, 151500);
      const paid = seedLine(fp(0xf1));
      const fee = seedLine(fp(0xf2), { direction: 'out', amount: 2500 as never, date: '2026-11-10', description: 'ASANSOR BAKIM', counterpartyIbanMac: undefined });
      seedLine(fp(0xf3), { amount: 5000 as never, date: '2026-11-20', description: 'HAVALE', counterpartyName: 'BILINMEYEN', counterpartyIbanMac: undefined });
      const ignored = seedLine(fp(0xf4), { direction: 'out', amount: 1000 as never, date: '2026-11-25', description: 'HESAP ISLETIM UCRETI', counterpartyIbanMac: undefined });
      expect((await call('POST', `/api/bank/lines/${paid.lineId}/match`, { bankAccountId: 'bank', expectedVersion: 1, allocations: [{ accountId: 'recv-u12-occupant', amount: 150000 }] })).status).toBe(200);
      expect((await call('POST', `/api/bank/lines/${fee.lineId}/expense`, { bankAccountId: 'bank', expectedVersion: 1, expenseAccountId: 'exp-elevator' })).status).toBe(200);
      expect((await call('POST', `/api/bank/lines/${ignored.lineId}/ignore`, { bankAccountId: 'bank', expectedVersion: 1, reason: 'Banka masrafı' })).status).toBe(200);
    }

    it('son ekstreye gore: acilis/kapanis, defter, fark, bekleyen net, aciklanamayan fark ve giren/cikan dokum', async () => {
      await scenario();
      const r = await call('GET', '/api/bank/reconciliation?bankAccountId=bank');
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({
        bankAccountId: 'bank',
        ledgerBalance: 147500,
        period: {},
        statementCount: 2,
        statement: { statementId: NOV, closingBalance: 151500 },
        openingStatement: { statementId: OCT, openingBalance: 0 },
        openingBalance: 0,
        ledgerBalanceAtStart: 0,
        closingBalance: 151500,
        asOf: '2026-11-30',
        ledgerBalanceAtStatementEnd: 147500,
        difference: 4000,
        diff: 4000,
        pendingNet: 5000,
        unexplainedDiff: -1000,
        breakdown: {
          matchedIn: { count: 1, amount: 150000 },
          matchedOut: { count: 1, amount: 2500 },
          unmatchedIn: { count: 1, amount: 5000 },
          unmatchedOut: { count: 0, amount: 0 },
          ignoredIn: { count: 0, amount: 0 },
          ignoredOut: { count: 1, amount: 1000 },
        },
        // B2 ozeti korunur.
        lines: { unmatchedIn: { count: 1 }, unmatchedOut: { count: 0 }, matched: { count: 2, amount: 152500 }, ignored: { count: 1, amount: 1000 } },
      });
    });

    it('tarih araligi: acilis ve kapanis aralikta secilir, dokum araliga gore', async () => {
      await scenario();
      const nov = await call('GET', '/api/bank/reconciliation?bankAccountId=bank&from=2026-11-01&to=2026-11-30');
      expect(nov.json).toMatchObject({ period: { from: '2026-11-01', to: '2026-11-30' }, statementCount: 1, openingStatement: { statementId: NOV }, statement: { statementId: NOV }, unexplainedDiff: -1000 });
      const lateNov = await call('GET', '/api/bank/reconciliation?bankAccountId=bank&from=2026-11-15&to=2026-11-30');
      expect(lateNov.json.breakdown).toMatchObject({ matchedIn: { count: 0 }, unmatchedIn: { count: 1, amount: 5000 }, ignoredOut: { count: 1 } });
      expect(lateNov.json.openingStatement).toBeUndefined();

      const oct = await call('GET', '/api/bank/reconciliation?bankAccountId=bank&to=2026-10-31');
      expect(oct.json).toMatchObject({ statement: { statementId: OCT }, closingBalance: 0, ledgerBalanceAtStatementEnd: 0, difference: 0, pendingNet: 0, unexplainedDiff: 0 });
      expect(oct.json.breakdown.matchedIn.count).toBe(0);

      expect((await call('GET', '/api/bank/reconciliation?bankAccountId=bank&from=2026-12-01&to=2026-11-01')).status).toBe(422);
      expect((await call('GET', '/api/bank/reconciliation?bankAccountId=bank&from=01.11.2026')).status).toBe(422);
    });

    it('saf hesaplar: ekstre secimi, bekleyen net ve dokum', () => {
      const st = (statementId: string, from: string, to: string, closingBalance?: number, committedAt = '2026-12-01T00:00:00Z') =>
        ({ statementId, bankAccountId: 'bank', status: 'committed', fileName: 'x', period: { from, to }, closingBalance, committed: { committedAt } }) as unknown as BankStatement;
      const list = [st('a', '2026-10-01', '2026-10-31', 10), st('b', '2026-11-01', '2026-11-30', 20), st('b2', '2026-11-01', '2026-11-30', 21, '2026-12-02T00:00:00Z')];
      expect(pickStatements(list, 'bank').closing?.statementId).toBe('b2');
      expect(pickStatements(list, 'bank', { to: '2026-11-15' }).closing?.statementId).toBe('a');
      expect(pickStatements(list, 'bank', { from: '2026-10-15' }).opening?.statementId).toBe('b');
      expect(pickStatements(list, 'other').closing).toBeUndefined();

      const lines = [
        { date: '2026-11-02', direction: 'in', amount: 300, status: 'unmatched' },
        { date: '2026-11-03', direction: 'out', amount: 100, status: 'unmatched' },
        { date: '2026-12-01', direction: 'in', amount: 999, status: 'unmatched' },
        { date: '2026-11-04', direction: 'in', amount: 50, status: 'matched' },
      ] as const;
      expect(pendingNetThrough(lines as never, '2026-11-30')).toBe(200);
      expect(addLines(emptyBreakdown(), lines as never, { to: '2026-11-30' })).toMatchObject({ unmatchedIn: { count: 1, amount: 300 }, unmatchedOut: { count: 1, amount: 100 }, matchedIn: { count: 1, amount: 50 } });
      expect(reconcileAccount({ bankAccountId: 'bank', statements: [st('n', '2026-11-01', '2026-11-30')], lines: [], entries: [] })).toBeUndefined();
    });

    it('gece denetimi raporu bankRecon uretir; zamanlayici BankReconDiff metrigini yayinlar', async () => {
      await scenario();
      const entries = txs().flatMap(toLedgerEntries);
      const snapshot: AuditSnapshot = {
        apartmentId: APT,
        intents: [],
        closures: [],
        transactions: txs(),
        entries,
        accounts: [...fin.accounts.values()],
        payments: [...fin.payments.values()],
        receiptCounter: fin.payments.size,
        bankLines: bank.lines(APT),
        bankDecisions: bank.decisions(APT),
        bankStatements: [OCT, NOV].map((id) => bank.items.get(`APT#${APT}|BANKSTMT#${id}`) as unknown as BankStatement),
      };
      expect(bankReconciliations(snapshot)).toEqual([
        { bankAccountId: 'bank', statementId: NOV, asOf: '2026-11-30', closingBalance: 151500, ledgerBalance: 147500, diff: 4000, pendingNet: 5000, unexplainedDiff: -1000 },
      ]);
      const auditor = createLedgerAuditor({
        load: async () => snapshot,
        getAccount: async (_a, id) => acc(id),
        listAccountEntries: async (_a, id) => entries.filter((e) => e.accountId === id),
        getTransaction: async (_a, id) => txs().find((t) => t.transactionId === id),
        listClosures: async () => [],
      });
      const report = await auditor.run(APT);
      expect(report.bankRecon).toEqual([expect.objectContaining({ bankAccountId: 'bank', unexplainedDiff: -1000 })]);
      expect(report.findings.filter((f) => f.code === 'bank_match_mismatch')).toEqual([]);

      const metrics = { emit: vi.fn() };
      const log = { info: vi.fn(), error: vi.fn() };
      const worker = createSchedulerWorker({
        core: { listSiteIds: async () => [APT, 'apt-eski'], getSite: async (id: string) => ({ siteId: id, status: 'active', settings: {} }) as unknown as Site },
        auditor: {
          run: async (apt: string) =>
            apt === APT ? report : { apartmentId: apt, counts: report.counts, findings: [], unstable: [] },
        },
        auditChain: { verify: async (scope: string) => ({ scope, checked: 0, findings: [] }) },
        metrics,
        log,
        now: () => NOW,
        finance: {} as never,
        payments: null,
        events: { publish: vi.fn() } as never,
        outbox: {} as never,
      });
      const res = await worker({ Records: [{ messageId: 'm1', body: JSON.stringify({ job: 'ledger_audit', scheduledTime: '2026-11-22T00:40:00Z' }) }] });
      expect(res.batchItemFailures).toEqual([]);
      expect(metrics.emit).toHaveBeenCalledWith(
        { BankReconDiff: 1000 },
        expect.objectContaining({ msg: 'bank_recon_metrics', apartmentId: APT, accounts: [expect.objectContaining({ bankAccountId: 'bank', unexplainedDiff: -1000 })] }),
        'None',
      );
      expect(metrics.emit).toHaveBeenCalledWith({ BankReconAccountsOff: 1 }, expect.objectContaining({ apartmentId: APT }));
      // bankRecon alani olmayan (eski) rapor icin banka metrigi yayinlanmaz.
      const forOld = metrics.emit.mock.calls.filter((c) => (c[1] as { apartmentId?: string })?.apartmentId === 'apt-eski').map((c) => Object.keys(c[0] as object));
      expect(forOld.flat()).not.toContain('BankReconDiff');
      const logged = [...log.info.mock.calls, ...log.error.mock.calls]
        .map((c) => JSON.parse(c[0] as string))
        .find((l) => l.msg === 'ledger_audit' && l.apartmentId === APT);
      expect(logged.bankRecon).toEqual([expect.objectContaining({ unexplainedDiff: -1000 })]);
    });
  });
});
