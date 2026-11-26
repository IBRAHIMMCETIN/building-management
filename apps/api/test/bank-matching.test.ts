import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Role } from '../src/auth/claims.js';
import type { Block, Site, Unit } from '../src/modules/core/types.js';
import { checkBankMatches } from '../src/modules/finance/audit.js';
import { createLocalIbanMacer } from '../src/modules/finance/bank/iban.js';
import { bankKeys, lineIdOf } from '../src/modules/finance/bank/keys.js';
import { createBankMatchService } from '../src/modules/finance/bank/matchService.js';
import {
  type MatchCandidate,
  REF_CODE_RE,
  findRefCodes,
  findUnitRefs,
  nameSimilarity,
  normalizeText,
  refCodeFor,
  suggestMatches,
  validateAllocations,
} from '../src/modules/finance/bank/matching.js';
import { createBankService } from '../src/modules/finance/bank/service.js';
import type { BankLine, BankStatement } from '../src/modules/finance/bank/types.js';
import { LedgerConflictError, toLedgerEntries } from '../src/modules/finance/repository.js';
import { createFinanceService } from '../src/modules/finance/service.js';
import type { Account, Transaction } from '../src/modules/finance/types.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { createFakeBankRepo } from './fakes/bankRepo.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';

const APT = 'apt-bm';
const NOW = new Date('2026-11-22T07:00:00.000Z');

/** Gecerli TR IBAN (mod-97). */
function trIban(bban22: string): string {
  let rem = 0;
  for (const d of `${bban22}292700`) rem = (rem * 10 + Number(d)) % 97;
  return `TR${String(98 - rem).padStart(2, '0')}${bban22}`;
}
const SITE_IBAN = trIban('0001200940100005000123');

// ---------------------------------------------------------------------------
// Oneri motoru (saf)
// ---------------------------------------------------------------------------

const cand = (over: Partial<MatchCandidate> & Pick<MatchCandidate, 'accountId' | 'unitId'>): MatchCandidate => ({
  liableParty: 'occupant',
  blockName: 'A Blok',
  unitNumber: '1',
  unitLabel: 'A Blok · 1',
  holderNames: [],
  openBalance: 0,
  ...over,
});
const C12 = cand({ accountId: 'recv-u12-occupant', unitId: 'u12', unitNumber: '12', unitLabel: 'A Blok · 12', holderNames: ['Ayşe Yılmaz'], openBalance: 150000, monthlyDues: 150000 });
const C3 = cand({ accountId: 'recv-u3-occupant', unitId: 'u3', blockName: 'B Blok', unitNumber: '3', unitLabel: 'B Blok · 3', holderNames: ['Şükrü Çelik'], openBalance: 200050 });
const C7 = cand({ accountId: 'recv-u7-occupant', unitId: 'u7', unitNumber: 'V-7', unitLabel: 'A Blok · V-7' });
const CANDS = [C12, C3, C7];
const line = (over: Partial<{ amount: number; description: string; counterpartyName: string; direction: 'in' | 'out'; date: string }>) => ({
  date: '2026-11-04',
  direction: 'in' as const,
  amount: 150000,
  description: '',
  ...over,
});

describe('oneri motoru', () => {
  it('Turkce karakterler normalize edilir; ad benzerligi', () => {
    expect(normalizeText('Ayşe Yılmaz / A-12 İĞNE çiçek')).toBe('AYSE YILMAZ A 12 IGNE CICEK');
    expect(nameSimilarity('Ayşe Yılmaz', 'HAVALE AYSE YILMAZ AIDAT')).toBe(1);
    expect(nameSimilarity('Ayşe Kaya', 'HAVALE AYSE YILMAZ')).toBe(0.5);
    expect(nameSimilarity('Ayşe', 'AYSE')).toBe(0.5); // tek tokenli ad en fazla 0.5
  });

  it('blok/daire kaliplari: "A Blok 12", "B-3", "D:12" (D blogu yoksa daire no)', () => {
    const blocks = new Set(['A', 'B']);
    expect(findUnitRefs('A BLOK 12 ve B-3 aidat', blocks)).toEqual([
      { block: 'A', number: '12', strength: 'block_unit' },
      { block: 'B', number: '3', strength: 'block_unit' },
    ]);
    expect(findUnitRefs('Aidat D:12', blocks)).toEqual([{ number: '12', strength: 'unit_only' }]);
    expect(findUnitRefs('VILLA 7 ODEME', blocks)).toEqual([{ number: '7', strength: 'unit_only' }]);
    expect(findUnitRefs('A12 kasim', blocks)).toEqual([{ block: 'A', number: '12', strength: 'block_unit' }]);
  });

  it('referans kodu: deterministik, okunakli bicim, bolunmus yazimla bulunur', () => {
    const code = refCodeFor(APT, 'recv-u12-occupant');
    expect(code).toMatch(REF_CODE_RE);
    expect(refCodeFor(APT, 'recv-u12-occupant')).toBe(code);
    expect(refCodeFor('baska-apt', 'recv-u12-occupant')).not.toBe(code);
    const spaced = `${code.slice(0, 2)} ${code.slice(2, 4)}-${code.slice(4)}`;
    expect(findRefCodes(`EFT ${spaced} kasim`, new Map([[code, 'x']]))).toEqual([code]);
  });

  it('1) referans kodu kesin eslesmedir (1.0)', () => {
    const s = suggestMatches({ line: line({ description: 'EFT K7 M2-QA', amount: 99 }), candidates: CANDS, refCodes: new Map([['K7M2QA', C12.accountId]]) });
    expect(s[0]).toMatchObject({ kind: 'reference', confidence: 1, allocations: [{ accountId: C12.accountId, amount: 99 }] });
    expect(s[0]?.reasons[0]).toContain('K7M2QA');
  });

  it('birden fazla referans kodu: acik bakiyelere sirayla bolunur', () => {
    const refs = new Map([
      ['K7M2QA', C12.accountId],
      ['B3C4DE', C3.accountId],
    ]);
    const s = suggestMatches({ line: line({ description: 'K7M2QA B3C4DE', amount: 350050 }), candidates: CANDS, refCodes: refs });
    expect(s[0]).toMatchObject({ kind: 'reference', confidence: 0.95 });
    expect(s[0]?.allocations.map((a) => [a.accountId, a.amount])).toEqual([
      [C12.accountId, 150000],
      [C3.accountId, 200050],
    ]);
  });

  it('2) ogrenilmis gonderen 0.9; tutar bakiyeye esitse 0.95; kapali cari geriye duser', () => {
    const payer = { accounts: [{ accountId: C3.accountId, count: 3 }] };
    const s = suggestMatches({ line: line({ amount: 200050 }), candidates: CANDS, refCodes: new Map(), payer });
    expect(s[0]).toMatchObject({ kind: 'payer', confidence: 0.95 });
    expect(s[0]?.reasons[0]).toContain('3 kez');
    const plain = suggestMatches({ line: line({ amount: 12345 }), candidates: CANDS, refCodes: new Map(), payer });
    expect(plain[0]?.confidence).toBe(0.9);
    const closed = suggestMatches({ line: line({ amount: 12345 }), candidates: [C12, { ...C3, closedThrough: '2026-11-10' }, C7], refCodes: new Map(), payer });
    expect(closed[0]?.confidence).toBe(0.6);
    expect(closed[0]?.reasons.join(' ')).toContain('kapalı');
  });

  it('3) blok/daire + ad + 4) tutar: "A Blok 12 Ayşe Yılmaz" 150.000', () => {
    const s = suggestMatches({ line: line({ description: 'HAVALE A BLOK 12 AIDAT', counterpartyName: 'AYŞE YILMAZ' }), candidates: CANDS, refCodes: new Map() });
    expect(s[0]).toMatchObject({ kind: 'unit', allocations: [{ accountId: C12.accountId }] });
    // 0.60 blok/daire + 0.20 ad + 0.10 tutar + 0.02 borclu cari
    expect(s[0]?.confidence).toBe(0.92);
    expect(s[0]?.reasons).toEqual(['Açıklamada blok/daire: A-12', 'Gönderen adı cari sahibiyle eşleşiyor', 'Tutar açık bakiyeye eşit']);
  });

  it('yalniz daire no (D:12) 0.47, yalniz ad 0.57, aidatin tam kati', () => {
    expect(suggestMatches({ line: line({ description: 'AIDAT D:12', amount: 99 }), candidates: CANDS, refCodes: new Map() })[0]?.confidence).toBe(0.47);
    const byName = suggestMatches({ line: line({ description: 'FAST', counterpartyName: 'ŞÜKRÜ ÇELİK', amount: 99 }), candidates: CANDS, refCodes: new Map() });
    expect(byName[0]).toMatchObject({ kind: 'name', confidence: 0.57, allocations: [{ accountId: C3.accountId }] });
    const dues = suggestMatches({ line: line({ description: 'A BLOK 12', amount: 450000 }), candidates: CANDS, refCodes: new Map() });
    expect(dues[0]?.reasons).toContain('Tutar aylık aidatın tam katı');
  });

  it('cikan satira ve kanitsiz satira oneri yok', () => {
    expect(suggestMatches({ line: line({ direction: 'out', description: 'A BLOK 12' }), candidates: CANDS, refCodes: new Map() })).toEqual([]);
    expect(suggestMatches({ line: line({ description: 'ELEKTRIK FATURASI', amount: 99 }), candidates: CANDS, refCodes: new Map() })).toEqual([]);
  });

  it('dagitim dogrulamasi: 1-10 alt cari, toplam = satir tutari, tekrar yok', () => {
    expect(validateAllocations(300, [{ accountId: 'a', amount: 100 }, { accountId: 'b', amount: 200 }])).toBeNull();
    expect(validateAllocations(300, [{ accountId: 'a', amount: 100 }])).toMatch(/esit/);
    expect(validateAllocations(200, [{ accountId: 'a', amount: 100 }, { accountId: 'a', amount: 100 }])).toMatch(/birden fazla/);
    expect(validateAllocations(0, [])).toMatch(/1-10/);
    expect(validateAllocations(11, Array.from({ length: 11 }, (_, i) => ({ accountId: `a${i}`, amount: 1 })))).toMatch(/1-10/);
    expect(validateAllocations(100, [{ accountId: 'a', amount: 100.5 }])).toMatch(/pozitif kurus/);
  });
});

// ---------------------------------------------------------------------------
// Defter entegrasyonu ve uclar
// ---------------------------------------------------------------------------

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

describe('banka eslestirme (defter + API)', () => {
  let role: Role;
  let fin: ReturnType<typeof createFakeFinanceRepo>;
  let bank: ReturnType<typeof createFakeBankRepo>;
  let app: ReturnType<typeof createApp>;
  let seq: number;
  const ctx = { apartmentId: APT, userId: 'u-manager' };

  beforeEach(async () => {
    role = 'apartment_manager';
    seq = 0;
    fin = createFakeFinanceRepo(APT);
    bank = createFakeBankRepo(fin.docs as unknown as Map<string, Record<string, unknown>>);
    const core = {
      getSite: async () => SITE,
      getUnit: async (_a: string, id: string) => UNITS.find((u) => u.unitId === id),
      listUnits: async () => UNITS,
      listBlocks: async () => BLOCKS,
    };
    const newId = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`;
    const finance = createFinanceService({ repository: fin.repo, core, now: () => NOW, newId });
    await finance.charge(ctx, { idempotencyKey: 'c12', unitId: 'u12', liableParty: 'occupant', amount: 150000, date: '2026-10-01', dueDate: '2026-10-05', description: 'Ekim aidatı' });
    await finance.charge(ctx, { idempotencyKey: 'c3', unitId: 'u3', liableParty: 'occupant', amount: 200050, date: '2026-11-01', dueDate: '2026-11-05', description: 'Kasım aidatı' });
    const allTx = () => [...fin.transactions.values()].filter((t) => t.siteId === APT);
    const match = createBankMatchService({
      repo: bank.repo,
      finance,
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
      portal: {
        resolveUnit: async () => ({ unit: UNITS[0] as Unit, membership: member('p-ayse', 'u12'), parties: ['occupant'] }) as never,
      },
      now: () => NOW,
    });
    const bankService = createBankService({ repo: bank.repo, store: undefined, macer: createLocalIbanMacer(), accounts: fin.repo, now: () => NOW });
    app = createApp({
      version: 't',
      authenticate: () => ({ userId: role === 'resident' ? 'p-ayse' : 'u-manager', role, apartmentId: APT }),
      bankService,
      bankMatchService: match,
    });
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
      statementId: '20261122-00000000-0000-4000-8000-00000000aaaa',
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
    bank.items.set(`${l.PK}|${l.SK}`, structuredClone(l) as unknown as Record<string, unknown>);
    return l;
  }
  const getLine = (l: BankLine) => bank.items.get(`${l.PK}|${l.SK}`) as unknown as BankLine;
  const acc = (id: string) => fin.accounts.get(`${APT}|${id}`) as Account;
  const txs = () => [...fin.transactions.values()] as Transaction[];
  const matchBody = (l: BankLine, allocations: { accountId: string; amount: number }[], expectedVersion = 1) => ({ bankAccountId: 'bank', expectedVersion, allocations });

  it('eslestirme: valorde tazminat kesinlesir, tahsilat + makbuz + olay + karar + satir + gonderen tek yazimda', async () => {
    const l = seedLine('a'.repeat(24));
    const r = await call('POST', `/api/bank/lines/${l.lineId}/match`, matchBody(l, [{ accountId: 'recv-u12-occupant', amount: 150000 }]));
    expect(r.status).toBe(200);
    expect(r.json.payments).toEqual([expect.objectContaining({ receiptNumber: 'MKB-000001', amount: 150000, unitId: 'u12', liableParty: 'occupant' })]);
    // 150.000 x 30 gun (05.10 -> 04.11) x %5 / 30 = 7.500
    expect(r.json.lateFees).toEqual([{ accountId: 'recv-u12-occupant', lateFee: 7500 }]);

    const fee = txs().find((t) => t.kind === 'late_fee') as Transaction;
    const pay = txs().find((t) => t.kind === 'payment') as Transaction;
    expect(fee).toMatchObject({ date: '2026-11-04', totalAmount: 7500 });
    expect(pay.lines).toEqual([
      { accountId: 'bank', side: 'debit', amount: 150000 },
      { accountId: 'recv-u12-occupant', side: 'credit', amount: 150000, unitId: 'u12', liableParty: 'occupant' },
    ]);
    expect(pay.reference).toBe(`BANK:${l.lineId}`);
    expect([...fin.payments.values()][0]).toMatchObject({ method: 'bank_transfer', depositAccountId: 'bank', paidAt: '2026-11-04', payerName: 'AYŞE YILMAZ' });
    expect(acc('recv-u12-occupant').balance).toBe(7500);
    expect(acc('bank').balance).toBe(150000);
    expect(fin.events('PAYMENT_RECEIVED')).toHaveLength(1);
    expect(fin.trialBalance()).toBe(0);

    expect(getLine(l)).toMatchObject({ status: 'matched', version: 2, decisionNo: 1, match: { decisionNo: 1, transactionIds: [fee.transactionId, pay.transactionId] } });
    expect(bank.decisions(APT)[0]).toMatchObject({
      kind: 'match',
      decisionNo: 1,
      SK: `BANKMATCH#${l.lineId}#001`,
      allocations: [{ accountId: 'recv-u12-occupant', unitId: 'u12', liableParty: 'occupant', amount: 150000, lateFee: 7500 }],
    });
    expect(fin.docs.get(`APT#${APT}|PAYER#l1:mac-ayse`)).toMatchObject({ version: 1, accounts: [{ accountId: 'recv-u12-occupant', count: 1 }] });
    const batch = fin.batches[fin.batches.length - 1];
    expect(batch?.audit).toMatchObject({ action: 'bank.line.match', target: { type: 'bank_line', id: l.lineId } });

    // Ayni surumla tekrar: satir degisti -> 409
    const again = await call('POST', `/api/bank/lines/${l.lineId}/match`, matchBody(l, [{ accountId: 'recv-u12-occupant', amount: 150000 }]));
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('version_conflict');
  });

  it('coklu daireye bolme; toplam ve en fazla 10 alt cari kurali', async () => {
    const l = seedLine('b'.repeat(24), { amount: 350050 as never, description: 'A BLOK 12 VE B BLOK 3' });
    expect((await call('POST', `/api/bank/lines/${l.lineId}/match`, matchBody(l, [{ accountId: 'recv-u12-occupant', amount: 100 }]))).json.error).toBe('unprocessable');
    const eleven = Array.from({ length: 11 }, (_, i) => ({ accountId: `recv-x${i}`, amount: i === 0 ? 350040 : 1 }));
    expect((await call('POST', `/api/bank/lines/${l.lineId}/match`, matchBody(l, eleven))).status).toBe(422);

    const r = await call('POST', `/api/bank/lines/${l.lineId}/match`, matchBody(l, [{ accountId: 'recv-u12-occupant', amount: 150000 }, { accountId: 'recv-u3-occupant', amount: 200050 }]));
    expect(r.status).toBe(200);
    expect(r.json.payments.map((p: any) => p.receiptNumber)).toEqual(['MKB-000001', 'MKB-000002']);
    // u3'un vadesi (05.11) valorden sonra: tazminat yok.
    expect(r.json.lateFees).toEqual([{ accountId: 'recv-u12-occupant', lateFee: 7500 }]);
    expect(acc('recv-u3-occupant').balance).toBe(0);
    expect(acc('bank').balance).toBe(350050);
  });

  it('kapali (closedThrough) cari: acik hata + ayrilan cari onerisi; ayrilan cariye eslestirme', async () => {
    const main = acc('recv-u3-occupant');
    fin.accounts.set(`${APT}|recv-u3-occupant`, { ...main, closedThrough: '2026-11-10' });
    fin.accounts.set(`${APT}|recv-u3-occupant-cX`, { ...main, accountId: 'recv-u3-occupant-cX', name: 'Daire 3 ayrılan sakin', closureId: 'cX', balance: 200050 as never });
    const l = seedLine('c'.repeat(24), { amount: 200050 as never });
    const closed = await call('POST', `/api/bank/lines/${l.lineId}/match`, matchBody(l, [{ accountId: 'recv-u3-occupant', amount: 200050 }]));
    expect(closed.status).toBe(409);
    expect(closed.json).toMatchObject({ error: 'account_closed', ledgerConflict: 'closed', accountId: 'recv-u3-occupant', closedThrough: '2026-11-10' });
    expect(closed.json.formerAccounts.map((a: any) => a.accountId)).toEqual(['recv-u3-occupant-cX']);
    expect(getLine(l).status).toBe('unmatched');

    const ok = await call('POST', `/api/bank/lines/${l.lineId}/match`, matchBody(l, [{ accountId: 'recv-u3-occupant-cX', amount: 200050 }]));
    expect(ok.status).toBe(200);
    expect([...fin.payments.values()][0]).toMatchObject({ receivableAccountId: 'recv-u3-occupant-cX', unitId: 'u3' });
  });

  it('finans cekirdegi kapali cari hatasini LedgerConflictError(closed) olarak iletir', async () => {
    const finance = createFinanceService({ repository: fin.repo, core: { getUnit: async () => UNITS[1], listUnits: async () => UNITS }, now: () => NOW });
    fin.accounts.set(`${APT}|recv-u3-occupant`, { ...acc('recv-u3-occupant'), closedThrough: '2026-11-10' });
    const p = finance.recordBankPayment(ctx, {
      idempotencyId: 'bankmatch-x-1',
      depositAccountId: 'bank',
      paidAt: '2026-11-04',
      reference: 'BANK:x',
      allocations: [{ accountId: 'recv-u3-occupant', amount: 100 as never, lateFee: 0 as never }],
      documents: () => ({}),
    });
    await expect(p).rejects.toBeInstanceOf(LedgerConflictError);
    await expect(p).rejects.toMatchObject({ reason: 'closed', label: 'recv-u3-occupant', closedThrough: '2026-11-10' });
  });

  it('yoksayma gerekce ister ve denetlenir; yeniden acma (restore)', async () => {
    const l = seedLine('d'.repeat(24), { direction: 'out', description: 'HESAP ISLETIM UCRETI', amount: 2500 as never });
    expect((await call('POST', `/api/bank/lines/${l.lineId}/ignore`, { bankAccountId: 'bank', expectedVersion: 1, reason: 'x' })).status).toBe(422);
    const r = await call('POST', `/api/bank/lines/${l.lineId}/ignore`, { bankAccountId: 'bank', expectedVersion: 1, reason: 'Banka masrafı' });
    expect(r.status).toBe(200);
    expect(getLine(l)).toMatchObject({ status: 'ignored', version: 2, decisionNo: 1 });
    expect(bank.decisions(APT)[0]).toMatchObject({ kind: 'ignore', reason: 'Banka masrafı', transactionIds: [] });
    expect(bank.audits.at(-1)).toMatchObject({ action: 'bank.line.ignore', reason: 'Banka masrafı' });
    // Cikan satir tahsilata cevrilemez; yoksayilan da eslestirilemez.
    expect((await call('POST', `/api/bank/lines/${l.lineId}/match`, matchBody(l, [{ accountId: 'recv-u12-occupant', amount: 2500 }], 2))).json.error).toBe('invalid_state');

    const restore = await call('POST', `/api/bank/lines/${l.lineId}/unmatch`, { bankAccountId: 'bank', expectedVersion: 2, reason: 'Yanlışlıkla yoksayıldı' });
    expect(restore.status).toBe(200);
    expect(getLine(l)).toMatchObject({ status: 'unmatched', version: 3, decisionNo: 2 });
    expect(bank.decisions(APT)[1]).toMatchObject({ kind: 'restore', reverses: 1 });
    expect(txs().filter((t) => t.kind === 'payment')).toHaveLength(0);
  });

  it('geri alma: tahsilat + tazminat ters kayitla iptal, satir yeniden acilir, gonderen sayaci azalir; tekrar eslestirilebilir', async () => {
    const l = seedLine('e'.repeat(24));
    await call('POST', `/api/bank/lines/${l.lineId}/match`, matchBody(l, [{ accountId: 'recv-u12-occupant', amount: 150000 }]));
    const matched = txs().filter((t) => t.kind === 'payment' || t.kind === 'late_fee').map((t) => t.transactionId);

    expect((await call('POST', `/api/bank/lines/${l.lineId}/unmatch`, { bankAccountId: 'bank', expectedVersion: 2 })).status).toBe(422);
    const r = await call('POST', `/api/bank/lines/${l.lineId}/unmatch`, { bankAccountId: 'bank', expectedVersion: 2, reason: 'Yanlış daire' });
    expect(r.status).toBe(200);
    const reversals = txs().filter((t) => t.kind === 'reversal');
    expect(reversals.map((t) => t.reversalOf).sort()).toEqual([...matched].sort());
    expect(acc('recv-u12-occupant').balance).toBe(150000);
    expect(acc('bank').balance).toBe(0);
    for (const id of matched) expect(fin.docs.has(`APT#${APT}|IDEM#REV_${id}`)).toBe(true);
    expect(getLine(l)).toMatchObject({ status: 'unmatched', version: 3, decisionNo: 2 });
    expect(getLine(l).match).toBeUndefined();
    expect(bank.decisions(APT)[1]).toMatchObject({ kind: 'unmatch', reverses: 1, reversedTransactionIds: matched });
    expect(fin.docs.get(`APT#${APT}|PAYER#l1:mac-ayse`)).toMatchObject({ version: 2, accounts: [] });
    expect(fin.batches.at(-1)?.audit).toMatchObject({ action: 'bank.line.unmatch', reason: 'Yanlış daire' });

    const hist = await call('GET', `/api/bank/lines/${l.lineId}/history?bankAccountId=bank`);
    expect(hist.json.decisions[0]).toMatchObject({ decisionNo: 1, reversedBy: 2 });

    const re = await call('POST', `/api/bank/lines/${l.lineId}/match`, matchBody(l, [{ accountId: 'recv-u12-occupant', amount: 150000 }], 3));
    expect(re.status).toBe(200);
    expect(re.json.lateFees).toEqual([{ accountId: 'recv-u12-occupant', lateFee: 7500 }]);
    expect(getLine(l)).toMatchObject({ status: 'matched', decisionNo: 3 });
  });

  it('oneriler, kuyruk ve sakin referans kodu', async () => {
    role = 'resident';
    const before = await call('GET', '/api/portal/my-payment-reference');
    expect(before.status).toBe(200);
    expect(before.json.bank).toBeNull();
    const code = before.json.references[0].code as string;
    expect(code).toMatch(REF_CODE_RE);
    expect(before.json).toMatchObject({ unitId: 'u12', unitLabel: 'A Blok · 12', references: [{ liableParty: 'occupant', code }] });
    expect((await call('GET', '/api/portal/my-payment-reference')).json.references[0].code).toBe(code);

    role = 'apartment_manager';
    expect((await call('GET', '/api/portal/my-payment-reference')).status).toBe(403);
    expect((await call('PUT', '/api/bank/accounts/bank/profile', { iban: 'TR00 1234', accountHolderName: 'Site Yönetimi', residentVisible: true })).status).toBe(422);
    const saved = await call('PUT', '/api/bank/accounts/bank/profile', { iban: SITE_IBAN, accountHolderName: 'Örnek Site Yönetimi', bankName: 'Ziraat', residentVisible: true });
    expect(saved.status).toBe(200);
    role = 'resident';
    expect((await call('GET', '/api/portal/my-payment-reference')).json.bank).toEqual({ iban: SITE_IBAN, accountHolderName: 'Örnek Site Yönetimi', bankName: 'Ziraat' });

    role = 'apartment_manager';
    const l = seedLine('f'.repeat(24), { description: `EFT ${code} KASIM`, counterpartyName: 'MEHMET KAYA', amount: 99 as never });
    delete (bank.items.get(`${l.PK}|${l.SK}`) as Record<string, unknown>).counterpartyIbanMac;
    const s = await call('GET', `/api/bank/lines/${l.lineId}/suggestions?bankAccountId=bank`);
    expect(s.json.suggestions[0]).toMatchObject({ kind: 'reference', confidence: 1, allocations: [{ accountId: 'recv-u12-occupant', unitLabel: 'A Blok · 12', amount: 99 }] });
    expect(s.json.line.counterpartyIbanMac).toBeUndefined();

    const byUnit = seedLine('9'.repeat(24));
    const q = await call('GET', '/api/bank/queue?bankAccountId=bank&status=unmatched');
    const row = q.json.items.find((i: any) => i.lineId === byUnit.lineId);
    expect(row.suggestion).toMatchObject({ kind: 'unit', confidence: 0.92, allocations: [{ accountId: 'recv-u12-occupant' }] });

    const t = await call('GET', '/api/bank/targets');
    expect(t.json.items.find((i: any) => i.accountId === 'recv-u12-occupant')).toMatchObject({ unitLabel: 'A Blok · 12', holderNames: ['Ayşe Yılmaz'], openBalance: 150000, refCode: code });
  });

  it('mutabakat: son ekstre kapanis bakiyesi - defter bakiyesi ve kuyruk ozeti', async () => {
    const st = {
      ...bankKeys.statement(APT, '20261130-00000000-0000-4000-8000-00000000bbbb'),
      entityType: 'BANK_STATEMENT',
      statementId: '20261130-00000000-0000-4000-8000-00000000bbbb',
      apartmentId: APT,
      bankAccountId: 'bank',
      status: 'committed',
      fileName: 'kasim.xlsx',
      period: { from: '2026-11-01', to: '2026-11-30' },
      closingBalance: 152500,
      committed: { newLines: 2, existingLines: 0, committedAt: NOW.toISOString(), committedBy: 'u-manager' },
    } as unknown as BankStatement;
    bank.items.set(`${st.PK}|${st.SK}`, st as unknown as Record<string, unknown>);
    const l = seedLine('1'.repeat(24));
    seedLine('2'.repeat(24), { direction: 'out', amount: 2500 as never, description: 'MASRAF' });
    await call('POST', `/api/bank/lines/${l.lineId}/match`, matchBody(l, [{ accountId: 'recv-u12-occupant', amount: 150000 }]));
    const r = await call('GET', '/api/bank/reconciliation?bankAccountId=bank');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      bankAccountId: 'bank',
      ledgerBalance: 150000,
      statement: { statementId: st.statementId, closingBalance: 152500 },
      ledgerBalanceAtStatementEnd: 150000,
      difference: 2500,
      lines: { unmatchedIn: { count: 0 }, unmatchedOut: { count: 1, amount: 2500 }, matched: { count: 1, amount: 150000 }, ignored: { count: 0 } },
    });
  });

  it('yetki: denetci okur (adlar maskeli) ama eslestiremez; sakin banka uclarina erisemez', async () => {
    const l = seedLine('3'.repeat(24));
    role = 'observer';
    const t = await call('GET', '/api/bank/targets');
    expect(t.json.items.find((i: any) => i.accountId === 'recv-u12-occupant').holderNames).toEqual(['A. Y.']);
    expect((await call('GET', `/api/bank/lines/${l.lineId}/suggestions?bankAccountId=bank`)).status).toBe(200);
    expect((await call('POST', `/api/bank/lines/${l.lineId}/match`, matchBody(l, [{ accountId: 'recv-u12-occupant', amount: 150000 }]))).status).toBe(403);
    expect((await call('POST', `/api/bank/lines/${l.lineId}/ignore`, { bankAccountId: 'bank', expectedVersion: 1, reason: 'Deneme' })).status).toBe(403);
    role = 'resident';
    expect((await call('GET', '/api/bank/queue?bankAccountId=bank')).status).toBe(403);
  });

  it('gece denetimi: tutarli eslestirme bulgu uretmez; tutarsizliklar bank_match_mismatch', async () => {
    const l = seedLine('4'.repeat(24));
    await call('POST', `/api/bank/lines/${l.lineId}/match`, matchBody(l, [{ accountId: 'recv-u12-occupant', amount: 150000 }]));
    const snapshot = () => ({ transactions: txs(), bankLines: bank.lines(APT), bankDecisions: bank.decisions(APT) });
    expect(checkBankMatches(snapshot())).toEqual([]);

    // Karar tutari bozulursa: dagilim toplami ve tahsilat eslesmesi bulgusu.
    const tampered = snapshot();
    const d = structuredClone(tampered.bankDecisions[0]);
    if (d?.allocations?.[0]) d.allocations[0].amount = 100 as never;
    expect(checkBankMatches({ ...tampered, bankDecisions: d ? [d] : [] }).map((f) => f.detail)).toEqual([
      'dagilim toplami satir tutarina esit degil',
      'tahsilat islemi defterde yok veya tutari uyusmuyor',
    ]);

    // Satir eslesmis ama tahsilat ters cevrilmis.
    const pay = txs().find((t) => t.kind === 'payment') as Transaction;
    const reversal = { ...pay, transactionId: 'rev-1', kind: 'reversal', reversalOf: pay.transactionId } as Transaction;
    expect(checkBankMatches({ ...snapshot(), transactions: [...txs(), reversal] }).map((f) => f.detail)).toContain('tahsilat ters kayitla iptal edilmis ama satir eslesmis');

    // Geri alma karari var ama islemler iptal edilmemis.
    await call('POST', `/api/bank/lines/${l.lineId}/unmatch`, { bankAccountId: 'bank', expectedVersion: 2, reason: 'Test' });
    expect(checkBankMatches(snapshot())).toEqual([]);
    const withoutReversals = { ...snapshot(), transactions: txs().filter((t) => t.kind !== 'reversal') };
    expect(checkBankMatches(withoutReversals).map((f) => f.detail)).toEqual([
      'geri alinan eslestirmenin islemi iptal edilmemis',
      'geri alinan eslestirmenin islemi iptal edilmemis',
    ]);
  });
});
