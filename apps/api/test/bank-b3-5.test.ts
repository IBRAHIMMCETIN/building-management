import { PDFDocument } from 'pdf-lib';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Role } from '../src/auth/claims.js';
import type { Block, Site, Unit } from '../src/modules/core/types.js';
import { type BankReconPdfData, renderBankReconPdf } from '../src/modules/documents/bankReconPdf.js';
import { createMemoryDocumentStore } from '../src/modules/documents/store.js';
import { checkBankMatches } from '../src/modules/finance/audit.js';
import { createLocalIbanMacer } from '../src/modules/finance/bank/iban.js';
import { bankKeys, lineIdOf, statementFileKey } from '../src/modules/finance/bank/keys.js';
import { createBankMatchService } from '../src/modules/finance/bank/matchService.js';
import { suggestPayables } from '../src/modules/finance/bank/matching.js';
import { createBankService, sameSpec } from '../src/modules/finance/bank/service.js';
import { createMemoryBankFileStore } from '../src/modules/finance/bank/store.js';
import type { BankFormat, BankLine, BankStatement } from '../src/modules/finance/bank/types.js';
import { payableSummary } from '../src/modules/finance/payables.js';
import { toLedgerEntries } from '../src/modules/finance/repository.js';
import { type FinanceService, createFinanceService } from '../src/modules/finance/service.js';
import type { Account, Transaction } from '../src/modules/finance/types.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { createFakeBankRepo } from './fakes/bankRepo.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';

/*
 * Faz B3.5: sutun eslemesini aktarimla kaydetme, tedarikci borcu kapatma (bankadan ve elle) ve
 * donemsel mutabakat PDF raporu.
 */

const APT = 'apt-b35';
const NOW = new Date('2026-11-22T07:00:00.000Z');
const NOV = '20261130-00000000-0000-4000-8000-00000000b351';
const OCT = '20261031-00000000-0000-4000-8000-00000000b350';

const UNITS = [{ unitId: 'u12', siteId: APT, blockId: 'bA', number: '12', status: 'active', type: 'flat', grossAreaTenthsM2: 1000, exemptions: [] }] as unknown as Unit[];
const BLOCKS = [{ blockId: 'bA', name: 'A Blok', status: 'active' }] as unknown as Block[];
const SITE = { siteId: APT, name: 'Lale Apartmanı', settings: { lateFeeMonthlyBasisPoints: 500 } } as unknown as Site;

describe('Faz B3.5 - banka', () => {
  let role: Role;
  let fin: ReturnType<typeof createFakeFinanceRepo>;
  let bank: ReturnType<typeof createFakeBankRepo>;
  let finance: FinanceService;
  let docs: ReturnType<typeof createMemoryDocumentStore>;
  let files: ReturnType<typeof createMemoryBankFileStore>;
  let app: ReturnType<typeof createApp>;
  let seq: number;
  const ctx = { apartmentId: APT, userId: 'u-manager' };
  const core = {
    getSite: async () => SITE,
    getUnit: async (_a: string, id: string) => UNITS.find((u) => u.unitId === id),
    listUnits: async () => UNITS,
    listBlocks: async () => BLOCKS,
  };
  const allTx = () => [...fin.transactions.values()].filter((t) => t.siteId === APT);
  const ledger = {
    listLedgerEntries: async (_a: string, accountId: string) => allTx().flatMap(toLedgerEntries).filter((e) => e.accountId === accountId),
    getTransactions: async (_a: string, ids: string[]) => allTx().filter((t) => ids.includes(t.transactionId)),
  };

  function build(opts: { documents?: boolean } = {}) {
    const match = createBankMatchService({
      repo: bank.repo,
      finance,
      accounts: fin.repo,
      ledger,
      core,
      memberships: { list: async () => [] as UnitMembership[] },
      people: { list: async () => [] as never },
      documents: opts.documents === false ? undefined : docs.store,
      now: () => NOW,
    });
    const bankService = createBankService({
      repo: bank.repo,
      store: files.store,
      macer: createLocalIbanMacer(),
      accounts: fin.repo,
      now: () => NOW,
      newId: () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`,
    });
    app = createApp({
      version: 't',
      authenticate: () => ({ userId: 'u-manager', role, apartmentId: APT }),
      financeService: finance,
      bankService,
      bankMatchService: match,
    });
  }

  beforeEach(async () => {
    role = 'apartment_manager';
    seq = 0;
    fin = createFakeFinanceRepo(APT);
    bank = createFakeBankRepo(fin.docs as unknown as Map<string, Record<string, unknown>>);
    docs = createMemoryDocumentStore();
    files = createMemoryBankFileStore();
    const newId = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`;
    finance = createFinanceService({ repository: fin.repo, core, ledger, now: () => NOW, newId });
    // Tedarikci + iki vadeli fatura: acik borc 3.450,75 TL.
    await finance.createAccount(ctx, { accountId: 'pay-enerjisa', type: 'payable', name: 'Enerjisa Başkent' });
    await finance.recordExpense(ctx, {
      idempotencyKey: 'e1',
      expenseAccountId: 'exp-electricity',
      creditAccountId: 'pay-enerjisa',
      amount: 245075,
      date: '2026-10-20',
      description: 'Ekim ortak elektrik',
      invoiceNumber: 'EA2026000123',
    });
    await finance.recordExpense(ctx, {
      idempotencyKey: 'e2',
      expenseAccountId: 'exp-electricity',
      creditAccountId: 'pay-enerjisa',
      amount: 100000,
      date: '2026-11-05',
      description: 'Kasım ortak elektrik',
      invoiceNumber: 'EA2026000456',
    });
    build();
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const acc = (id: string) => fin.accounts.get(`${APT}|${id}`) as Account;
  const txs = () => [...fin.transactions.values()] as Transaction[];
  const fp = (n: number) => n.toString(16).padStart(24, '0');

  function seedLine(n: number, over: Partial<BankLine> = {}): BankLine {
    const date = over.date ?? '2026-11-10';
    const l: BankLine = {
      ...bankKeys.line(APT, 'bank', date, fp(n)),
      entityType: 'BANK_LINE',
      lineId: lineIdOf(date, fp(n)),
      apartmentId: APT,
      bankAccountId: 'bank',
      statementId: NOV,
      sourceRow: n,
      date,
      direction: 'out',
      amount: 245075 as never,
      description: 'ENERJISA FATURA ODEMESI EA2026000123',
      counterpartyName: 'ENERJISA BASKENT ELEKTRIK',
      counterpartyIbanMasked: 'TR** **** **** **** **** **00 01',
      counterpartyIbanMac: 'l1:mac-enerjisa',
      fingerprint: fp(n),
      fingerprintVersion: 1,
      status: 'unmatched',
      createdAt: NOW.toISOString(),
      createdBy: 'u-manager',
      version: 1,
      ...over,
    };
    const stored = Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined));
    bank.items.set(`${l.PK}|${l.SK}`, structuredClone(stored));
    return l;
  }
  const getLine = (l: BankLine) => bank.items.get(`${l.PK}|${l.SK}`) as unknown as BankLine;

  // -------------------------------------------------------------------------
  // A) Sutun eslemesini aktarimla kaydetme
  // -------------------------------------------------------------------------

  describe('sutun eslemesini hatirlama', () => {
    const csv = (month: '11' | '12') =>
      new TextEncoder().encode(
        [
          'İşlem Tarihi;Açıklama;Tutar;Bakiye;Dekont No',
          `01.${month}.2026;HAVALE A-12 AİDAT;1.500,00;11.500,00;D${month}1`,
          `03.${month}.2026;ELEKTRİK FATURASI;-750,25;10.749,75;D${month}2`,
        ].join('\r\n'),
      );

    async function upload(bytes: Uint8Array, name: string) {
      const u = await call('POST', '/api/bank/statements/upload-url', { bankAccountId: 'bank', fileName: name, contentType: 'text/csv', size: bytes.byteLength });
      expect(u.status).toBe(201);
      files.objects.set(statementFileKey(APT, u.json.statementId), { body: bytes, contentType: 'text/csv' });
      const p = await call('POST', '/api/bank/statements', { statementId: u.json.statementId, bankAccountId: 'bank', fileName: name });
      expect(p.status).toBe(200);
      return { statementId: u.json.statementId as string, statement: p.json.statement as Record<string, any> };
    }
    const format = () => bank.items.get(`APT#${APT}|BANKFMT#bank`) as unknown as BankFormat | undefined;

    it('rememberFormat: esleme ekstreyle ayni yazimda kaydedilir; iki denetim kaydi', async () => {
      const { statementId, statement } = await upload(csv('11'), 'kasim.csv');
      expect(statement.formatSource).toBe('detected');
      const auditsBefore = bank.audits.length;
      const r = await call('POST', `/api/bank/statements/${statementId}/commit`, { expectedVersion: statement.version, rememberFormat: true });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ alreadyCommitted: false, written: 2, formatSaved: { version: 1 } });
      expect(format()).toMatchObject({ entityType: 'BANK_FORMAT', bankAccountId: 'bank', version: 1, createdBy: 'u-manager' });
      expect(sameSpec(format()?.spec, statement.format)).toBe(true);
      expect(bank.audits.slice(auditsBefore).map((a) => a.action)).toEqual(['bank.statement.commit', 'bank.format.save']);
      expect(bank.audits.at(-2)?.details).toMatchObject({ rememberFormat: true, formatSaved: true });
      expect(bank.audits.at(-1)).toMatchObject({ target: { type: 'bank_format', id: 'bank' }, details: { version: 1, source: 'statement_commit', statementId } });

      // Sonraki ekstre kayitli eslemeyle okunur; ayni esleme yeniden kaydedilmez.
      const dec = await upload(csv('12'), 'aralik.csv');
      expect(dec.statement.formatSource).toBe('saved');
      const n = bank.audits.length;
      const again = await call('POST', `/api/bank/statements/${dec.statementId}/commit`, { expectedVersion: dec.statement.version, rememberFormat: true });
      expect(again.json.formatSaved).toBeNull();
      expect(format()?.version).toBe(1);
      expect(bank.audits.slice(n).map((a) => a.action)).toEqual(['bank.statement.commit']);
    });

    it('rememberFormat olmadan esleme kaydedilmez; yanitta formatSaved alani yok', async () => {
      const { statementId, statement } = await upload(csv('11'), 'kasim.csv');
      const r = await call('POST', `/api/bank/statements/${statementId}/commit`, { expectedVersion: statement.version });
      expect(r.status).toBe(200);
      expect(r.json.formatSaved).toBeUndefined();
      expect(format()).toBeUndefined();
    });

    it('kayitli esleme bu arada degistiyse aktarim reddedilir (ekstre onizlemede kalir), eslemesiz tekrar edilebilir', async () => {
      const { statementId, statement } = await upload(csv('11'), 'kasim.csv');
      // Baska bir istek eslemeyi arada kaydetti: okunan surum eski.
      const stale = { ...bankKeys.format(APT, 'bank'), entityType: 'BANK_FORMAT', apartmentId: APT, bankAccountId: 'bank', spec: { ...statement.format, headerRow: 99 }, version: 1 };
      bank.items.set(`APT#${APT}|BANKFMT#bank`, { ...stale, version: 2 });
      const origGet = bank.repo.getFormat;
      bank.repo.getFormat = async () => stale as unknown as BankFormat;
      const r = await call('POST', `/api/bank/statements/${statementId}/commit`, { expectedVersion: statement.version, rememberFormat: true });
      bank.repo.getFormat = origGet;
      expect(r.status).toBe(409);
      expect(r.json.error).toBe('version_conflict');
      expect((bank.items.get(`APT#${APT}|BANKSTMT#${statementId}`) as unknown as BankStatement).status).toBe('previewed');
      expect(format()?.version).toBe(2);
      const ok = await call('POST', `/api/bank/statements/${statementId}/commit`, { expectedVersion: statement.version });
      expect(ok.json).toMatchObject({ alreadyCommitted: false });
    });

    it('esleme karsilastirmasi anahtar sirasindan bagimsiz', () => {
      expect(sameSpec({ a: 1, b: { c: [1, 2], d: undefined } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
      expect(sameSpec({ a: 1 }, { a: 2 })).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // B) Tedarikci borcu
  // -------------------------------------------------------------------------

  describe('tedarikci borcu', () => {
    const settleBody = (expectedVersion = 1, over: Record<string, unknown> = {}) => ({ bankAccountId: 'bank', expectedVersion, payableAccountId: 'pay-enerjisa', ...over });

    it('acik kalemler: faturalar eskiden yeniye kapanir, iptal edilen islemler sayilmaz', async () => {
      const r = await call('GET', '/api/finance/payables');
      expect(r.status).toBe(200);
      const p = r.json.items.find((x: { accountId: string }) => x.accountId === 'pay-enerjisa');
      expect(p).toMatchObject({ name: 'Enerjisa Başkent', openBalance: 345075, billed: 345075, paid: 0, openItemCount: 2 });
      expect(p.openItems.map((i: { reference?: string; open: number }) => [i.reference, i.open])).toEqual([
        ['EA2026000123', 245075],
        ['EA2026000456', 100000],
      ]);
      expect(r.json.totalOpen).toBe(345075);

      // Saf hesap: kismi odeme + iptal edilen fatura.
      const paidTx = { transactionId: 'p1', kind: 'payable_payment', description: 'Ödeme', lines: [] } as unknown as Transaction;
      const e = (transactionId: string, side: 'debit' | 'credit', amount: number, date: string) =>
        ({ accountId: 'pay-x', transactionId, side, amount, date, createdAt: `${date}T00:00:00Z` }) as never;
      const s = payableSummary(
        'pay-x',
        [e('b1', 'credit', 1000, '2026-10-01'), e('b2', 'credit', 500, '2026-10-02'), e('b3', 'credit', 700, '2026-10-03'), e('r3', 'debit', 700, '2026-10-04'), e('p1', 'debit', 1200, '2026-10-05')],
        new Map([
          ['b1', { transactionId: 'b1', kind: 'expense', description: 'F1' }],
          ['b2', { transactionId: 'b2', kind: 'expense', description: 'F2', reference: 'R2' }],
          ['b3', { transactionId: 'b3', kind: 'expense', description: 'F3' }],
          ['r3', { transactionId: 'r3', kind: 'reversal', description: 'Ters', reversalOf: 'b3' }],
          ['p1', paidTx],
        ] as never),
      );
      expect(s).toMatchObject({ billed: 1500, paid: 1200, openBalance: 300, advance: 0, lastPaymentDate: '2026-10-05' });
      expect(s.openItems).toEqual([{ transactionId: 'b2', date: '2026-10-02', description: 'F2', reference: 'R2', amount: 500, open: 300 }]);
    });

    it('oneri: ad + fatura tutari + fatura no; kuyrukta cikan satirin tedarikci onerisi', async () => {
      const l = seedLine(1);
      const r = await call('GET', `/api/bank/lines/${l.lineId}/payable-suggestions?bankAccountId=bank`);
      expect(r.status).toBe(200);
      expect(r.json.suggestions[0]).toMatchObject({
        kind: 'payable',
        payableAccountId: 'pay-enerjisa',
        confidence: 0.95,
        reasons: ['Tedarikçi adı açıklamada geçiyor', 'Tutar açık bir faturaya eşit', 'Fatura numarası açıklamada geçiyor'],
      });
      expect(r.json.payables).toEqual([expect.objectContaining({ accountId: 'pay-enerjisa', openBalance: 345075 })]);
      const q = await call('GET', '/api/bank/queue?bankAccountId=bank&status=unmatched');
      expect(q.json.items[0]).toMatchObject({ lineId: l.lineId, payableSuggestion: { payableAccountId: 'pay-enerjisa', confidence: 0.95 } });
      expect(q.json.items[0].suggestion).toBeUndefined();

      // Acik borcu asan tutar icin oneri yapilmaz; ad eslesmeyen tedarikci onerilmez.
      expect(
        suggestPayables({
          line: { amount: 999999, description: 'ENERJISA', counterpartyName: 'ENERJISA BASKENT' },
          candidates: [{ accountId: 'pay-enerjisa', name: 'Enerjisa Başkent', openBalance: 345075, openItems: [] }],
        }),
      ).toEqual([]);
      expect(suggestPayables({ line: { amount: 100, description: 'MARKET' }, candidates: [{ accountId: 'x', name: 'Enerjisa Başkent', openBalance: 1000, openItems: [] }] })).toEqual([]);
    });

    it('settle-payable: islem + karar + satir + PAYEE + denetim tek yazimda; acik borc azalir', async () => {
      const l = seedLine(1, { valueDate: '2026-11-11', bankReference: 'DK-9001' });
      const r = await call('POST', `/api/bank/lines/${l.lineId}/settle-payable`, settleBody(1, { source: 'suggestion', confidence: 0.95 }));
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ replayed: false, openBalanceAfter: 100000 });

      const tx = txs().find((t) => t.kind === 'payable_payment') as Transaction;
      expect(tx).toMatchObject({ date: '2026-11-11', reference: 'BANK:DK-9001', totalAmount: 245075 });
      expect(tx.lines).toEqual([
        { accountId: 'pay-enerjisa', side: 'debit', amount: 245075 },
        { accountId: 'bank', side: 'credit', amount: 245075 },
      ]);
      expect(acc('pay-enerjisa').balance).toBe(-100000);
      expect(acc('bank').balance).toBe(-245075);
      expect(fin.trialBalance()).toBe(0);

      expect(getLine(l)).toMatchObject({ status: 'matched', version: 2, decisionNo: 1, match: { decisionNo: 1, transactionIds: [tx.transactionId], paymentIds: [] } });
      expect(bank.decisions(APT)[0]).toMatchObject({
        kind: 'payable',
        source: 'suggestion',
        confidence: 0.95,
        payable: { payableAccountId: 'pay-enerjisa', payableName: 'Enerjisa Başkent', openBefore: 345075 },
        transactionIds: [tx.transactionId],
      });
      expect(bank.items.get(`APT#${APT}|PAYEE#l1:mac-enerjisa`)).toMatchObject({ entityType: 'BANK_PAYEE', accounts: [{ accountId: 'pay-enerjisa', count: 1 }], version: 1 });
      const batch = fin.batches.at(-1);
      expect(batch?.audit).toMatchObject({ action: 'bank.line.payable', target: { type: 'bank_line', id: l.lineId }, details: { payableAccountId: 'pay-enerjisa', amount: 245075, openBefore: 345075 } });
      expect(batch?.idempotency.id).toBe(`bankpayable-${l.lineId}-1`);
      expect(batch?.expectedVersions).toHaveProperty('pay-enerjisa');

      // Acik kalemler FIFO: ilk fatura kapandi.
      const p = (await call('GET', '/api/finance/payables')).json.items.find((x: { accountId: string }) => x.accountId === 'pay-enerjisa');
      expect(p).toMatchObject({ openBalance: 100000, paid: 245075, lastPaymentDate: '2026-11-11', openItemCount: 1 });
      expect(p.openItems[0]).toMatchObject({ reference: 'EA2026000456', open: 100000 });

      // Ogrenilen IBAN: ayni aliciya giden sonraki satir (ad gecmese de) onerilir.
      const next = seedLine(2, { amount: 100000 as never, description: 'ODEME', counterpartyName: undefined });
      const s = await call('GET', `/api/bank/lines/${next.lineId}/payable-suggestions?bankAccountId=bank`);
      expect(s.json.suggestions[0]).toMatchObject({ payableAccountId: 'pay-enerjisa', confidence: 0.95 });
      expect(s.json.suggestions[0].reasons[0]).toContain('daha önce');
      expect(checkBankMatches({ transactions: txs(), bankLines: bank.lines(APT), bankDecisions: bank.decisions(APT) })).toEqual([]);
    });

    it('fazla odeme reddedilir; yalnizca cikan + eslesmemis satir; gecersiz hesap; yetki', async () => {
      const big = seedLine(3, { amount: 400000 as never });
      const over = await call('POST', `/api/bank/lines/${big.lineId}/settle-payable`, settleBody());
      expect(over.status).toBe(422);
      expect(over.json.message).toContain('acik borcunu asiyor');
      expect(getLine(big)).toMatchObject({ status: 'unmatched', version: 1 });
      expect(txs().some((t) => t.kind === 'payable_payment')).toBe(false);

      const inLine = seedLine(4, { direction: 'in', amount: 1000 as never });
      expect((await call('POST', `/api/bank/lines/${inLine.lineId}/settle-payable`, settleBody())).json.error).toBe('invalid_state');
      const l = seedLine(5, { amount: 1000 as never });
      expect((await call('POST', `/api/bank/lines/${l.lineId}/settle-payable`, settleBody(1, { payableAccountId: 'exp-electricity' }))).status).toBe(422);
      expect((await call('POST', `/api/bank/lines/${l.lineId}/settle-payable`, settleBody(1, { payableAccountId: 'yok-boyle' }))).status).toBe(404);
      expect((await call('POST', `/api/bank/lines/${l.lineId}/settle-payable`, settleBody(7))).json.error).toBe('version_conflict');
      role = 'observer';
      expect((await call('POST', `/api/bank/lines/${l.lineId}/settle-payable`, settleBody())).status).toBe(403);
      expect((await call('GET', `/api/bank/lines/${l.lineId}/payable-suggestions?bankAccountId=bank`)).status).toBe(200);
      expect((await call('GET', '/api/finance/payables')).status).toBe(200);
      expect((await call('POST', '/api/finance/payables/pay-enerjisa/payments', { idempotencyKey: 'k1', amount: 100 })).status).toBe(403);
    });

    it('geri alma: tedarikci odemesi ters kayitla iptal, borc geri gelir, PAYEE sayaci azalir; tekrar odenebilir', async () => {
      const l = seedLine(1);
      await call('POST', `/api/bank/lines/${l.lineId}/settle-payable`, settleBody());
      const payTx = txs().find((t) => t.kind === 'payable_payment') as Transaction;
      const r = await call('POST', `/api/bank/lines/${l.lineId}/unmatch`, { bankAccountId: 'bank', expectedVersion: 2, reason: 'Yanlış tedarikçi' });
      expect(r.status).toBe(200);
      expect(txs().find((t) => t.kind === 'reversal')).toMatchObject({ reversalOf: payTx.transactionId });
      expect(fin.docs.has(`APT#${APT}|IDEM#REV_${payTx.transactionId}`)).toBe(true);
      expect(acc('pay-enerjisa').balance).toBe(-345075);
      expect(acc('bank').balance).toBe(0);
      expect(getLine(l)).toMatchObject({ status: 'unmatched', version: 3, decisionNo: 2 });
      expect(bank.items.get(`APT#${APT}|PAYEE#l1:mac-enerjisa`)).toMatchObject({ accounts: [], version: 2 });
      expect(fin.batches.at(-1)?.audit).toMatchObject({ action: 'bank.line.unmatch', details: { reversedKind: 'payable', payableAccountId: 'pay-enerjisa' } });
      expect(checkBankMatches({ transactions: txs(), bankLines: bank.lines(APT), bankDecisions: bank.decisions(APT) })).toEqual([]);
      // Ters cevrilen odeme elle ikinci kez cevrilemez.
      await expect(finance.reverseTransaction(ctx, payTx.transactionId, { reason: 'tekrar' })).rejects.toThrow();

      const again = await call('POST', `/api/bank/lines/${l.lineId}/settle-payable`, settleBody(3));
      expect(again.status).toBe(200);
      expect(acc('pay-enerjisa').balance).toBe(-100000);
      const open = (await call('GET', '/api/finance/payables')).json.items.find((x: { accountId: string }) => x.accountId === 'pay-enerjisa');
      expect(open).toMatchObject({ openBalance: 100000, paid: 245075 });
    });

    it('gece denetimi: tedarikci odemesi yoksa veya iptal edilmisse bank_match_mismatch', async () => {
      const l = seedLine(1);
      await call('POST', `/api/bank/lines/${l.lineId}/settle-payable`, settleBody());
      const snap = () => ({ transactions: txs(), bankLines: bank.lines(APT), bankDecisions: bank.decisions(APT) });
      expect(checkBankMatches({ ...snap(), transactions: txs().filter((t) => t.kind !== 'payable_payment') }).map((f) => f.detail)).toEqual([
        'tedarikci odemesi defterde yok veya tutari uyusmuyor',
      ]);
      const pay = txs().find((t) => t.kind === 'payable_payment') as Transaction;
      const reversal = { ...pay, transactionId: 'rev-x', kind: 'reversal', reversalOf: pay.transactionId } as Transaction;
      expect(checkBankMatches({ ...snap(), transactions: [...txs(), reversal] }).map((f) => f.detail)).toEqual([
        'tedarikci odemesi ters kayitla iptal edilmis ama satir eslesmis',
      ]);
    });

    it('elle tedarikci odemesi: kasa bakiyesi ve acik borc kontrolu, idempotent', async () => {
      await finance.charge(ctx, { idempotencyKey: 'c12', unitId: 'u12', liableParty: 'occupant', amount: 150000, date: '2026-10-01', dueDate: '2026-10-05', description: 'Ekim aidatı' });
      await finance.recordPayment(ctx, { idempotencyKey: 'pay-u12', unitId: 'u12', liableParty: 'occupant', amount: 150000, method: 'cash', paidAt: '2026-11-01' });
      const body = { idempotencyKey: 'pp-1', fundsAccountId: 'cash', amount: 50000, date: '2026-11-20', reference: 'EA2026000123' };
      const r = await call('POST', '/api/finance/payables/pay-enerjisa/payments', body);
      expect(r.status).toBe(201);
      expect(r.json).toMatchObject({ replayed: false, openBalance: 295075, transaction: { kind: 'payable_payment', date: '2026-11-20' } });
      expect(acc('cash').balance).toBe(100000);
      const replay = await call('POST', '/api/finance/payables/pay-enerjisa/payments', body);
      expect(replay.status).toBe(200);
      expect(replay.json.replayed).toBe(true);
      expect(txs().filter((t) => t.kind === 'payable_payment')).toHaveLength(1);

      expect((await call('POST', '/api/finance/payables/pay-enerjisa/payments', { ...body, idempotencyKey: 'pp-2', amount: 120000 })).json.error).toBe('insufficient_funds');
      expect((await call('POST', '/api/finance/payables/pay-enerjisa/payments', { ...body, idempotencyKey: 'pp-3', fundsAccountId: 'bank', amount: 300000 })).status).toBe(422);
      expect((await call('POST', '/api/finance/payables/exp-electricity/payments', { ...body, idempotencyKey: 'pp-4' })).status).toBe(422);
      // Defter gorunumunde nakit cikisi (gider kategorisi).
      const list = await call('GET', '/api/finance/transactions');
      expect(list.json.items.find((t: { kind: string }) => t.kind === 'payable_payment')).toMatchObject({ category: 'expense' });
    });
  });

  // -------------------------------------------------------------------------
  // C) Donemsel mutabakat PDF raporu
  // -------------------------------------------------------------------------

  describe('mutabakat PDF raporu', () => {
    function seedStatement(statementId: string, period: { from: string; to: string }, closingBalance: number) {
      const st = {
        ...bankKeys.statement(APT, statementId),
        entityType: 'BANK_STATEMENT',
        statementId,
        apartmentId: APT,
        bankAccountId: 'bank',
        status: 'committed',
        fileName: `${period.to.slice(0, 7)}.xlsx`,
        period,
        openingBalance: 0,
        closingBalance,
        committed: { newLines: 0, existingLines: 0, committedAt: NOW.toISOString(), committedBy: 'u-manager' },
        version: 2,
      };
      bank.items.set(`${st.PK}|${st.SK}`, st as unknown as Record<string, unknown>);
    }

    async function scenario() {
      seedStatement(OCT, { from: '2026-10-01', to: '2026-10-31' }, 0);
      seedStatement(NOV, { from: '2026-11-01', to: '2026-11-30' }, -246075);
      const paid = seedLine(1);
      seedLine(2, { direction: 'in', amount: 5000 as never, date: '2026-11-20', description: 'HAVALE', counterpartyName: 'BILINMEYEN', counterpartyIbanMac: undefined });
      const fee = seedLine(3, { amount: 1000 as never, date: '2026-11-25', description: 'HESAP ISLETIM UCRETI', counterpartyName: undefined, counterpartyIbanMac: undefined });
      expect((await call('POST', `/api/bank/lines/${paid.lineId}/settle-payable`, { bankAccountId: 'bank', expectedVersion: 1, payableAccountId: 'pay-enerjisa' })).status).toBe(200);
      expect((await call('POST', `/api/bank/lines/${fee.lineId}/ignore`, { bankAccountId: 'bank', expectedVersion: 1, reason: 'Banka masrafı, ay sonu toplu işlenecek' })).status).toBe(200);
    }

    it('PDF uretilir, S3 anahtari veri ozetiyle; ayni veri onbellekten, veri degisince yeni dosya', async () => {
      await scenario();
      const q = '/api/bank/reconciliation/report?bankAccountId=bank&from=2026-11-01&to=2026-11-30';
      const r = await call('GET', q);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ cached: false, contentType: 'application/pdf', fileName: 'Banka-Mutabakat-Banka-2026-11-01_2026-11-30.pdf' });
      expect(r.json.url).toMatch(new RegExp(`^memory://get/apartments/${APT}/reports/2026/11/bank-recon-bank-20261101-20261130-[0-9a-f]{16}\\.pdf\\?ttl=300`));
      expect(r.json.url).toContain(encodeURIComponent('attachment'));
      const keys = [...docs.objects.keys()];
      expect(keys).toHaveLength(1);
      const stored = docs.objects.get(keys[0] as string);
      expect(stored?.contentType).toBe('application/pdf');
      expect(Buffer.from((stored?.body as Uint8Array).subarray(0, 5)).toString()).toBe('%PDF-');
      const pdf = await PDFDocument.load(stored?.body as Uint8Array);
      expect(pdf.getTitle()).toContain('Banka Mutabakat Raporu');
      expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);

      const again = await call('GET', q);
      expect(again.json.cached).toBe(true);
      expect(again.json.dataHash).toBe(r.json.dataHash);
      expect(docs.objects.size).toBe(1);

      // Veri degisti (bekleyen satir yoksayildi): yeni ozet, yeni dosya.
      const pending = bank.lines(APT).find((l) => l.status === 'unmatched') as BankLine;
      await call('POST', `/api/bank/lines/${pending.lineId}/ignore`, { bankAccountId: 'bank', expectedVersion: pending.version, reason: 'Hatalı havale, iade edilecek' });
      const changed = await call('GET', q);
      expect(changed.json.cached).toBe(false);
      expect(changed.json.dataHash).not.toBe(r.json.dataHash);
      expect(docs.objects.size).toBe(2);
    });

    it('denetci indirebilir; sakin indiremez; belge deposu yoksa 503; gecersiz aralik 422', async () => {
      await scenario();
      role = 'observer';
      expect((await call('GET', '/api/bank/reconciliation/report?bankAccountId=bank')).status).toBe(200);
      role = 'resident';
      expect((await call('GET', '/api/bank/reconciliation/report?bankAccountId=bank')).status).toBe(403);
      role = 'apartment_manager';
      expect((await call('GET', '/api/bank/reconciliation/report?bankAccountId=bank&from=2026-12-01&to=2026-11-01')).status).toBe(422);
      build({ documents: false });
      expect((await call('GET', '/api/bank/reconciliation/report?bankAccountId=bank')).status).toBe(503);
    });

    it('saf PDF: deterministik, uzun listede birden fazla sayfa', async () => {
      const data: BankReconPdfData = {
        apartmentName: 'Lale Apartmanı',
        bankAccountName: 'Banka',
        ibanMasked: 'TR** **** **** **** **** **13 26',
        period: { from: '2026-11-01', to: '2026-11-30' },
        openingBalance: 0,
        openingDate: '2026-11-01',
        closingBalance: -246075,
        asOf: '2026-11-30',
        ledgerBalanceAtEnd: -245075,
        difference: -1000,
        pendingNet: 5000,
        unexplainedDiff: -6000,
        breakdown: [{ label: 'Eşleşen çıkan (gider / tedarikçi)', count: 1, amount: 245075 }],
        pending: Array.from({ length: 120 }, (_, i) => ({ date: '2026-11-20', direction: 'in' as const, amount: 1000 + i, description: `HAVALE ${i} ŞÜKRÜ ÇELİK İĞDE` })),
        ignored: [{ date: '2026-11-25', direction: 'out', amount: 1000, description: 'HESAP İŞLETİM ÜCRETİ', reason: 'Banka masrafı' }],
        pendingOmitted: 3,
        generatedAt: NOW.toISOString(),
        dataHash: 'a'.repeat(64),
      };
      const a = await renderBankReconPdf(data);
      const b = await renderBankReconPdf(data);
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
      const doc = await PDFDocument.load(a);
      expect(doc.getPageCount()).toBeGreaterThan(1);
      expect(doc.getTitle()).toBe('Banka Mutabakat Raporu Banka 01 Kasım 2026 - 30 Kasım 2026');
    });
  });
});
