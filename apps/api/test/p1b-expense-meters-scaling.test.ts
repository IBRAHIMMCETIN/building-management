/**
 * P1-b: gider tarih dizini ve sayac doneminin buyuk olcek dayanikliligi.
 *
 *  A. 1.200 bolumlu sitede (~27 bin defter islemi) gider tarih araligi sorgusu ve Hareketler'in
 *     Gelir / Gider sekmesi TAM TARAMA yapmaz (ne `listTransactions` ne `listExpenses`), sayfalar
 *     dogru sirali ve kurusu kurusuna eski (tam liste + bellekte suzme) sonucla aynidir.
 *  B. 303 bolumlu sayac donemi: onay 202 ile arka plan isinde parca parca yazilir; defter ve sayac
 *     yazimlarinda cekisme (gecici hata) enjekte edilir, veri kaybi / cift kayit olmadan tamamlanir.
 *     FSUM ozetleri tazelenir ve hesap bakiyeleriyle bire bir (mizan 0). Toplu geri alma da 202 ile
 *     arka plan isinde, yinelenen mesaja ragmen idempotent tamamlanir; bakiyeler onay oncesine doner.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import { WriteContentionError } from '../src/modules/audit/log.js';
import { createMemoryBulkJobQueue } from '../src/modules/bulkjobs/queue.js';
import { createMemoryBulkJobRepository } from '../src/modules/bulkjobs/repository.js';
import { type BulkJobDeps, type BulkJobService, createBulkJobService } from '../src/modules/bulkjobs/service.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import { type IsoDate, type LiableParty, type Unit, toKurus } from '../src/modules/core/types.js';
import { buildDuesStatus, toTransactionView } from '../src/modules/finance/reports.js';
import type { FinanceRepository, TransactionQuery } from '../src/modules/finance/repository.js';
import { type FinanceContext, createFinanceService } from '../src/modules/finance/service.js';
import type { Account, LedgerEntry, Transaction, TransactionKind, TransactionLine } from '../src/modules/finance/types.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';
import { APT, manager, meterPostingWorld } from './fakes/meterPostingWorld.js';

const ctx: FinanceContext = { apartmentId: APT, userId: 'mgr-1' };

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// A. Gider tarih dizini + Gelir / Gider sekmesi
// ---------------------------------------------------------------------------

const UNITS = 1200;
const TODAY = '2026-12-02';

function unit(id: string): Unit {
  return {
    PK: `APT#${APT}`,
    SK: `UNIT#${id}`,
    entityType: 'UNIT',
    unitId: id,
    siteId: APT,
    blockId: 'b1',
    number: id.slice(1),
    type: 'flat',
    grossAreaTenthsM2: 1000,
    exemptions: [],
    status: 'active',
    createdAt: '2025-01-01T00:00:00.000Z',
    createdBy: 'seed',
    updatedAt: '2025-01-01T00:00:00.000Z',
    updatedBy: 'seed',
    version: 1,
  } as Unit;
}

function recv(accountId: string, unitId: string, party: LiableParty): Account {
  return {
    PK: `APT#${APT}`,
    SK: `ACCT#${accountId}`,
    entityType: 'ACCOUNT',
    accountId,
    siteId: APT,
    type: 'receivable',
    name: accountId,
    status: 'active',
    balance: toKurus(0),
    unitId,
    liableParty: party,
    createdAt: '2025-01-01T00:00:00.000Z',
    createdBy: 'seed',
    updatedAt: '2025-01-01T00:00:00.000Z',
    updatedBy: 'seed',
    version: 0,
  } as Account;
}

let seq = 0;
function tx(kind: TransactionKind, date: IsoDate, lines: TransactionLine[], extra: Partial<Transaction> = {}): Transaction {
  const id = `${date.replaceAll('-', '')}-${String(++seq).padStart(8, '0')}`;
  return {
    PK: `APT#${APT}`,
    SK: `TX#${id}`,
    entityType: 'TRANSACTION',
    transactionId: id,
    siteId: APT,
    kind,
    date,
    description: kind,
    lines,
    totalAmount: toKurus(lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0)),
    createdAt: `${date}T08:00:00.000Z`,
    createdBy: 'seed',
    ...extra,
  };
}

type Counts = { fullScans: number; rangedScans: number; listExpenses: number; entryPages: number; entryItems: number };

function instrument(fake: ReturnType<typeof createFakeFinanceRepo>) {
  const counts: Counts = { fullScans: 0, rangedScans: 0, listExpenses: 0, entryPages: 0, entryItems: 0 };
  let indexedAt = -1;
  let index = new Map<string, LedgerEntry[]>();
  const entriesOf = (accountId: string) => {
    if (indexedAt !== fake.transactions.size) {
      index = new Map();
      for (const t of [...fake.transactions.values()].sort((a, b) => a.transactionId.localeCompare(b.transactionId))) {
        t.lines.forEach((l, i) => {
          const list = index.get(l.accountId) ?? [];
          list.push({ PK: t.PK, SK: `LE#${l.accountId}#${t.transactionId}#${i + 1}`, entityType: 'LEDGER_ENTRY', entryId: `${t.transactionId}:${i + 1}`, transactionId: t.transactionId, siteId: t.siteId, accountId: l.accountId, side: l.side, amount: l.amount, date: t.date, lineNo: i + 1, createdAt: t.createdAt, createdBy: t.createdBy } as LedgerEntry);
          index.set(l.accountId, list);
        });
      }
      indexedAt = fake.transactions.size;
    }
    return index.get(accountId) ?? [];
  };
  const repo: FinanceRepository = {
    ...fake.repo,
    listTransactions: async (apt, q: TransactionQuery = {}) => {
      if (!q.from && !q.to && !q.limit && !q.cursor) counts.fullScans++;
      else counts.rangedScans++;
      return fake.repo.listTransactions(apt, q);
    },
    listExpenses: async (apt) => {
      counts.listExpenses++;
      return fake.repo.listExpenses!(apt);
    },
    listAccountEntries: async (_apt, accountId, range = {}) =>
      entriesOf(accountId).filter((e) => e.date >= (range.from ?? '0000-00-00') && e.date <= (range.to ?? '9999-99-99')),
    // Gercek depodaki `queryAccountEntriesPage` ile ayni sozlesme (en yeni once, taraf suzgeci, before haric).
    listAccountEntriesPage: async (_apt, accountId, q) => {
      counts.entryPages++;
      const rows = entriesOf(accountId)
        .filter((e) => e.date >= (q.from ?? '0000-00-00') && e.date <= (q.to ?? '9999-99-99') && (!q.side || e.side === q.side) && (!q.before || e.transactionId < q.before))
        .reverse();
      counts.entryItems += Math.min(rows.length, q.limit + 1);
      return { items: rows.slice(0, q.limit), more: rows.length > q.limit };
    },
  };
  return { repo, counts };
}

describe(`gider tarih dizini ve Gelir/Gider sekmesi (${UNITS} bolum)`, () => {
  const fake = createFakeFinanceRepo(APT);
  const io = instrument(fake);
  const units = Array.from({ length: UNITS }, (_, i) => unit(`u${i + 1}`));
  const core: Pick<CoreRepository, 'getUnit' | 'listUnits'> = { getUnit: async (_a, id) => units.find((u) => u.unitId === id), listUnits: async () => units };
  let n = 0;
  const finance = createFinanceService({ repository: io.repo, core, now: () => new Date(`${TODAY}T09:00:00.000Z`), newId: () => `e${String(++n).padStart(6, '0')}` });
  const all = () => [...fake.transactions.values()];

  beforeAll(async () => {
    await finance.ensureSystemAccounts(ctx);
    await fake.repo.ensureAccounts([
      ...units.map((u) => recv(`recv-${u.unitId}-owner`, u.unitId, 'owner')),
      { ...recv('exp-cleaning', '', 'owner'), type: 'expense', unitId: undefined, liableParty: undefined, name: 'Temizlik' } as Account,
      { ...recv('exp-energy', '', 'owner'), type: 'expense', unitId: undefined, liableParty: undefined, name: 'Enerji' } as Account,
    ]);
    const post = (t: Transaction) => fake.repo.postBatch({ transactions: [t], idempotency: { id: `seed-${t.transactionId}`, fingerprint: 'seed' } });
    const r = rng(11);
    for (let m = 0; m < 11; m++) {
      const month = new Date(Date.UTC(2026, m, 1)).toISOString().slice(0, 7);
      for (const u of units) {
        const acc = `recv-${u.unitId}-owner`;
        await post(tx('dues_charge', `${month}-01`, [{ accountId: acc, side: 'debit', amount: toKurus(150_050), unitId: u.unitId, liableParty: 'owner' }, { accountId: 'income-dues', side: 'credit', amount: toKurus(150_050) }], { dueDate: `${month}-10` }));
        if (r() < 0.9) {
          const day = String(1 + Math.floor(r() * 27)).padStart(2, '0');
          await post(tx('payment', `${month}-${day}`, [{ accountId: r() < 0.5 ? 'bank' : 'cash', side: 'debit', amount: toKurus(150_050) }, { accountId: acc, side: 'credit', amount: toKurus(150_050), unitId: u.unitId, liableParty: 'owner' }]));
        }
      }
      // Giderler gercek yazim yoluyla (GSI1 tarih dizini anahtarlari ayni atomik yazimda).
      for (let k = 0; k < 120; k++) {
        const day = String(1 + Math.floor(r() * 27)).padStart(2, '0');
        await finance.recordExpense(ctx, {
          idempotencyKey: `exp-${month}-${k}`,
          expenseAccountId: r() < 0.5 ? 'exp-cleaning' : 'exp-energy',
          creditAccountId: r() < 0.5 ? 'bank' : 'cash',
          amount: 1 + Math.floor(r() * 900_000),
          date: `${month}-${day}`,
          description: `Gider ${month} #${k}`,
        });
      }
      // Kasadan bankaya virman: gider de gelir de degildir (her iki sekmeden elenmeli).
      await post(tx('expense', `${month}-15`, [{ accountId: 'bank', side: 'debit', amount: toKurus(5_000) }, { accountId: 'cash', side: 'credit', amount: toKurus(5_000) }]));
    }
  }, 240_000);

  it('defter buyuk; giderler tarih dizininde', () => {
    expect(fake.transactions.size).toBeGreaterThan(25_000);
    expect(fake.expenses.size).toBe(11 * 120);
    expect([...fake.expenses.values()].every((e) => e.GSI1PK === `EXPDATE#${APT}` && e.GSI1SK === `${e.date}#${e.expenseId}`)).toBe(true);
  });

  it('gider tarih araligi: sayfali, azalan sirali, kurusu kurusuna; tam tarama yok', async () => {
    const from = '2026-03-10';
    const to = '2026-07-20';
    const expected = [...fake.expenses.values()]
      .filter((e) => e.date >= from && e.date <= to)
      .sort((a, b) => `${b.date}#${b.expenseId}`.localeCompare(`${a.date}#${a.expenseId}`));
    io.counts.fullScans = 0;
    io.counts.listExpenses = 0;
    const got: string[] = [];
    let total = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const r = await finance.listExpenses(ctx, { from, to, limit: '50', ...(cursor ? { cursor } : {}) });
      expect(r.items.length).toBeLessThanOrEqual(50);
      expect(r.pageTotal).toBe(r.items.reduce((s, e) => s + e.amount, 0));
      got.push(...r.items.map((e) => e.expenseId));
      total += r.pageTotal;
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    expect(got).toEqual(expected.map((e) => e.expenseId));
    expect(total).toBe(expected.reduce((s, e) => s + e.amount, 0));
    expect(io.counts).toMatchObject({ fullScans: 0, listExpenses: 0 });
    // Artan sira da desteklenir.
    const asc = await finance.listExpenses(ctx, { from, to, limit: '5', order: 'asc' });
    expect(asc.items.map((e) => e.expenseId)).toEqual(expected.slice(-5).reverse().map((e) => e.expenseId));
    await expect(finance.listExpenses(ctx, { from: '2026-05-01', to: '2026-04-01' })).rejects.toMatchObject({ field: 'from' });
  });

  it('Hareketler > Gider / Gelir: yalnizca kasa/banka satirlari okunur, sonuc eski bellekte suzmeyle birebir', async () => {
    const accounts = new Map([...fake.accounts.values()].map((a) => [a.accountId, a]));
    const numbers = new Map(units.map((u) => [u.unitId, u.number]));
    const legacy = (category: 'income' | 'expense', from?: string, to?: string) =>
      all()
        .filter((t) => (!from || t.date >= from) && (!to || t.date <= to))
        .sort((a, b) => b.transactionId.localeCompare(a.transactionId))
        .map((t) => toTransactionView(t, accounts, numbers))
        .filter((v) => v.category === category)
        .map((v) => v.transactionId);

    for (const [category, from, to] of [
      ['expense', undefined, undefined],
      ['income', '2026-06-01', '2026-06-30'],
    ] as const) {
      io.counts.fullScans = 0;
      io.counts.rangedScans = 0;
      io.counts.entryItems = 0;
      const got: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 200; page++) {
        const r = await finance.listTransactions(ctx, { category, limit: '100', ...(from ? { from } : {}), ...(to ? { to } : {}), ...(cursor ? { cursor } : {}) });
        expect(r.items.every((v) => v.category === category)).toBe(true);
        got.push(...r.items.map((v) => v.transactionId));
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      expect(got).toEqual(legacy(category, from, to));
      // Hic tum defter / tarih araligi taramasi yok; okunan satirlar kasa/banka satirlariyla sinirli.
      expect(io.counts.fullScans + io.counts.rangedScans).toBe(0);
    }
    // Gider sekmesi: okunan satir sayisi gider sayisinin birkac kati (aidat tahakkuklari hic okunmaz).
    expect(fake.expenses.size).toBeLessThan(2000);
  }, 120_000);

  it('gecersiz kategori / imlec 400', async () => {
    await expect(finance.listTransactions(ctx, { category: 'accrual' })).rejects.toMatchObject({ field: 'category' });
    await expect(finance.listTransactions(ctx, { category: 'expense', cursor: 'bozuk' })).rejects.toMatchObject({ field: 'cursor' });
    const income = Buffer.from(JSON.stringify({ k: 'income', b: '20260601-00000001' })).toString('base64url');
    await expect(finance.listTransactions(ctx, { category: 'expense', cursor: income })).rejects.toMatchObject({ field: 'cursor' });
  });
});

// ---------------------------------------------------------------------------
// B. 303 bolumlu sayac donemi: onay ve toplu geri alma (cekisme altinda)
// ---------------------------------------------------------------------------

const METER_UNITS = 303;
const SILENT = { info: () => undefined, error: () => undefined };

async function drain(service: BulkJobService, messages: { type: 'bulk_job'; apartmentId: string; jobId: string; seq: number }[], limit = 400) {
  let invocations = 0;
  let errors = 0;
  while (messages.length > 0) {
    if (++invocations > limit) throw new Error('Toplu is bitmedi (sonsuz dongu?)');
    const m = messages.shift() as (typeof messages)[number];
    try {
      await service.handle(m);
    } catch {
      errors++;
      messages.push(m); // SQS tekrar teslimi
    }
  }
  return { invocations, errors };
}

describe(`sayac donemi (${METER_UNITS} bolum): 202 onay ve toplu geri alma, cekisme altinda`, () => {
  it('veri kaybi / cift kayit yok; FSUM ozetleri bakiyelerle bire bir; geri alma idempotent', async () => {
    const w = meterPostingWorld('2026-12-05');
    for (let i = 4; i <= METER_UNITS; i++) w.ow.addUnit(`u${String(i).padStart(4, '0')}`, String(i));
    const jobs = createMemoryBulkJobRepository();
    const q = createMemoryBulkJobQueue();
    const options: BulkJobDeps['options'] = { batchSize: 25, concurrency: 4, maxUnitsPerInvocation: 100, retryBaseMs: 0, maxTransientFailures: 6 };
    const service = createBulkJobService({ repository: jobs.repository, queue: q.queue, finance: w.ow.finance, meters: w.posting, meterReversal: w.reversal, now: w.ow.now, options, log: SILENT });
    const app = createApp({
      version: 'test',
      financeService: w.ow.finance,
      meterService: w.service,
      meterReadingService: w.readings,
      meterPostingService: w.posting,
      meterReversalService: w.reversal,
      bulkJobService: service,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
    });
    // biome-ignore lint/suspicious/noExplicitAny: test yanitlari serbest JSON
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> => {
      const res = await app.request(path, {
        method,
        headers: { 'x-test-claims': JSON.stringify(manager), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      // biome-ignore lint/suspicious/noExplicitAny: test yanitlari serbest JSON
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };

    const tpl = (await call('POST', '/api/metering/templates', { preset: 'central_heating' })).json;
    const meterIds: string[] = [];
    for (const u of w.ow.units) {
      const r = await call('POST', '/api/metering/meters', { unitId: u.unitId, kind: 'heat_allocator', label: 'Salon', openingIndex: 0, installedAt: '2026-01-01' });
      if (r.status !== 201) throw new Error(JSON.stringify(r.json));
      meterIds.push(r.json.meterId);
    }
    const total = 987_654_321; // 9.876.543,21 TL: kurus bolunmez, en buyuk kalan
    const period = (
      await call('POST', '/api/metering/periods', { templateId: tpl.templateId, name: 'Kasım 2026', startDate: '2026-11-01', endDate: '2026-11-30', dueDate: '2026-12-15', totalAmount: total })
    ).json;
    for (let i = 0; i < meterIds.length; i += 90) {
      const items = meterIds.slice(i, i + 90).map((meterId, j) => ({ meterId, endIndex: ((i + j) % 41) * 10 + 7 }));
      const r = await call('PUT', `/api/meter-readings/periods/${period.periodId}`, { items });
      if (r.status !== 200) throw new Error(JSON.stringify(r.json));
    }
    const calc = await call('POST', `/api/metering/periods/${period.periodId}/calculate`);
    expect(calc.json).toMatchObject({ ok: true, totals: { unitCount: METER_UNITS, chargeCount: METER_UNITS } });
    const balancesBefore = new Map([...w.ow.fake.accounts.values()].map((a) => [a.accountId, a.balance as number]));

    // Cekisme enjeksiyonu: defter yazimlarinin ve sayac kayit yazimlarinin bir kismi gecici hatayla
    // (iptal edilmis islem: hicbir sey yazilmadan) reddedilir.
    const r = rng(303);
    let injected = 0;
    const flaky = <A extends unknown[], R>(fn: (...a: A) => Promise<R>, p: number) => async (...a: A): Promise<R> => {
      if (r() < p) {
        injected++;
        throw new WriteContentionError();
      }
      return fn(...a);
    };
    const fin = w.ow.fake.repo;
    fin.postTransaction = flaky(fin.postTransaction.bind(fin), 0.2);
    fin.postBatch = flaky(fin.postBatch.bind(fin), 0.2);
    const mrepo = w.meterRepo.repository;
    mrepo.write = flaky(mrepo.write.bind(mrepo), 0.1);

    // --- Onay: 202 + arka plan isi ---
    const accepted = await call('POST', `/api/metering/periods/${period.periodId}/approve`, { calcHash: calc.json.calcHash });
    expect(accepted.status).toBe(202);
    expect(accepted.json).toMatchObject({ mode: 'job', job: { kind: 'meter_posting', status: 'pending', total: METER_UNITS } });
    // Sayfa yenilense de: donemin suren isi bulunur.
    const live = await call('GET', `/api/metering/periods/${period.periodId}/job`);
    expect(live.json.job).toMatchObject({ jobId: accepted.json.job.jobId, kind: 'meter_posting' });
    // Yinelenen mesaj (SQS en az bir kez teslim).
    q.messages.push({ ...(q.messages[0] as (typeof q.messages)[number]) });
    await drain(service, q.messages);
    expect(injected).toBeGreaterThan(10);

    const posted = await call('GET', `/api/jobs/${accepted.json.job.jobId}`);
    expect(posted.json).toMatchObject({ status: 'completed', processed: METER_UNITS, result: { posted: METER_UNITS } });
    // Kesintide yazilip sayilamayan kalemler tekrar denemede replay olur: yeni yazim <= bolum sayisi,
    // asil olcut defterde her bolumun TEK kalemi olmasi (asagida).
    expect(posted.json.result.written).toBeLessThanOrEqual(METER_UNITS);
    const charges = w.meterCharges(period.periodId);
    expect(charges).toHaveLength(METER_UNITS);
    expect(new Set(charges.map((t) => t.lines[0]?.unitId)).size).toBe(METER_UNITS);
    expect(charges.reduce((s, t) => s + t.totalAmount, 0)).toBe(total);
    expect(w.ow.fake.trialBalance()).toBe(0);
    expect(w.lines(period.periodId).every((l) => l.status === 'posted' && !!l.transactionId)).toBe(true);
    expect(w.meterRepo.audits.filter((a) => a.action === 'meters.period_posted')).toHaveLength(1);

    // FSUM: is bitince ozetler worker'da tazelendi; her ozet hesap surumunu tutar ve bakiyesi
    // hesap bakiyesine esit (kurus farki yok); aidat durumu tam defter hesabiyla birebir.
    const fsumCheck = async () => {
      const accounts = [...w.ow.fake.accounts.values()].filter((a) => a.type === 'receivable' && a.unitId && a.liableParty);
      for (const a of accounts) {
        const s = w.ow.fake.summaries.get(`${APT}|${a.accountId}`);
        expect(s, a.accountId).toBeDefined();
        expect(s?.sourceVersion).toBe(a.version);
        expect(s?.core.balance).toBe(a.balance);
      }
      const units = w.ow.units;
      const receivables = new Set(accounts.map((a) => a.accountId));
      const legacy = buildDuesStatus(units, [...w.ow.fake.transactions.values()].sort((x, y) => x.transactionId.localeCompare(y.transactionId)), receivables, w.ow.now().toISOString().slice(0, 10), 500).sort((x, y) =>
        x.unitNumber.localeCompare(y.unitNumber, 'tr', { numeric: true }),
      );
      const dues = await w.ow.finance.duesStatus({ apartmentId: APT, userId: manager.userId });
      expect(dues.items).toEqual(legacy);
    };
    await fsumCheck();

    // --- Toplu geri alma: 202 + arka plan isi, yinelenen mesaj ---
    const reverseBody = { idempotencyKey: 'rev-kasim-2026', reason: 'Hatalı okuma: sayaçlar yeniden okunacak', notify: false };
    const rev = await call('POST', `/api/metering/periods/${period.periodId}/reverse`, reverseBody);
    expect(rev.status).toBe(202);
    expect(rev.json).toMatchObject({ mode: 'job', job: { kind: 'meter_reversal', status: 'pending' } });
    // Ayni anahtarla tekrar tiklama ayni isi doner.
    expect((await call('POST', `/api/metering/periods/${period.periodId}/reverse`, reverseBody)).json.job.jobId).toBe(rev.json.job.jobId);
    // P1-c: worker baslamadan (donem hala `posted`) sayfa yenilenirse bekleyen geri alma isi bulunur.
    expect(rev.json.job.jobId.startsWith(`mr-${period.periodId}-`)).toBe(true);
    const pendingRev = await call('GET', `/api/metering/periods/${period.periodId}/job`);
    expect(pendingRev.json.job).toMatchObject({ jobId: rev.json.job.jobId, kind: 'meter_reversal', status: 'pending' });
    q.messages.push({ ...(q.messages[0] as (typeof q.messages)[number]) });
    await drain(service, q.messages);

    const reversedJob = await call('GET', `/api/jobs/${rev.json.job.jobId}`);
    expect(reversedJob.json).toMatchObject({ status: 'completed', processed: METER_UNITS, result: { reversed: METER_UNITS } });
    expect(reversedJob.json.result.written).toBeLessThanOrEqual(METER_UNITS);
    const reversals = w.reversals(period.periodId);
    expect(reversals).toHaveLength(METER_UNITS);
    expect(new Set(reversals.map((t) => t.reversalOf)).size).toBe(METER_UNITS);
    expect(w.ow.fake.trialBalance()).toBe(0);
    // Alt cari bakiyeleri onay oncesine dondu (kurusu kurusuna).
    for (const a of w.ow.fake.accounts.values()) {
      if (a.type === 'receivable') expect(a.balance, a.accountId).toBe(balancesBefore.get(a.accountId) ?? 0);
    }
    const after = (await call('GET', `/api/metering/periods/${period.periodId}/lines`)).json;
    expect(after.period.status).toBe('reversed');
    expect(meterIds.every((id) => w.meter(id).lastReading?.periodId !== period.periodId)).toBe(true);
    expect(w.meterRepo.audits.filter((a) => a.action === 'meters.period_reversed')).toHaveLength(1);
    await fsumCheck();

    // Bitmis geri almanin tekrari: yeni ters kayit yok (senkron yol replay).
    const again = await call('POST', `/api/metering/periods/${period.periodId}/reverse`, reverseBody);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ replayed: true, reversed: METER_UNITS, written: 0 });
    expect(w.reversals(period.periodId)).toHaveLength(METER_UNITS);
  }, 300_000);
});
