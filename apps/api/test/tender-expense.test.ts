/**
 * Ihale devami: karardan Finans'a aktarim. Gider MEVCUT Finans gider servisiyle (recordExpense)
 * kaydedilir; on dolum (KDV dahil toplam, firma, ihale referansi, kategoriye gore gider kalemi),
 * gider + defter + ihale bagi + denetim tek atomik yazim, ihale basina tek gider (ayni anahtar
 * tekrar ayni sonuc, farkli anahtar 409, es zamanli iki istekte biri), roller ve API ucu.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import { createFinanceService } from '../src/modules/finance/service.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { type TenderContext, createTenderService } from '../src/modules/tenders/service.js';
import type { Tender } from '../src/modules/tenders/types.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';
import { createFakeTenderRepo } from './fakes/tenderRepo.js';

const APT = 'apt-1';
const NOW = new Date('2026-11-27T07:00:00.000Z');
const mgr: TenderContext = { apartmentId: APT, userId: 'mgr', role: 'apartment_manager' };
const firm: TenderContext = { apartmentId: APT, userId: 'firm', role: 'management_company' };
const observer: TenderContext = { apartmentId: APT, userId: 'obs', role: 'observer' };
const resident: TenderContext = { apartmentId: APT, userId: 'res-a', role: 'resident' };

const decided = (id: string, extra: Partial<Tender> = {}): Tender => ({
  PK: `APT#${APT}`,
  SK: `TENDER#${id}`,
  entityType: 'TENDER',
  apartmentId: APT,
  tenderId: id,
  title: 'Dış cephe mantolama',
  description: 'A ve B blok dış cephe mantolama',
  category: 'mantolama',
  minQuotes: 3,
  deadline: '2026-11-20',
  status: 'decided',
  quotes: [
    { quoteId: 'q1', supplierName: 'Cephe Ltd.', amountKurus: 90_000_00, vatIncluded: false, vatRate: 20, status: 'active', createdAt: NOW.toISOString(), createdBy: 'mgr', updatedAt: NOW.toISOString(), updatedBy: 'mgr' },
  ],
  publishedAt: '2026-11-21T07:00:00.000Z',
  decision: { quoteId: 'q1', reason: 'En düşük teklif', reference: 'KD-2026/14', supplierName: 'Cephe Ltd.', netKurus: 90_000_00, vatKurus: 18_000_00, totalKurus: 108_000_00, decidedAt: '2026-11-25T07:00:00.000Z', decidedBy: 'mgr' },
  createdAt: '2026-11-01T07:00:00.000Z',
  createdBy: 'mgr',
  updatedAt: '2026-11-25T07:00:00.000Z',
  updatedBy: 'mgr',
  version: 5,
  ...extra,
});

function world(opts: { finance?: boolean } = {}) {
  const fin = createFakeFinanceRepo(APT);
  const core = { getUnit: async () => undefined, listUnits: async () => [] } as unknown as Pick<CoreRepository, 'getUnit' | 'listUnits'>;
  let n = 0;
  const finance = createFinanceService({ repository: fin.repo, core, now: () => NOW, newId: () => `id-${String(++n).padStart(4, '0')}` });
  // Ihale ve Finans ayni tabloda: sahte depolar ayni belge haritasini paylasir (atomik yazim benzetimi).
  const tenders = createFakeTenderRepo(fin.docs as never);
  const seed = (t: Tender) => fin.docs.set(`${t.PK}|${t.SK}`, structuredClone(t) as never);
  seed(decided('tnd-1'));
  seed(decided('tnd-2', { category: 'asansor', title: 'Asansör revizyonu', decision: { ...decided('x').decision!, reference: undefined } }));
  seed(decided('tnd-3', { status: 'published', decision: undefined }));
  const memberships = [{ userId: 'res-a', unitId: 'u1', apartmentId: APT, relation: 'owner', residesInUnit: true, status: 'active', startDate: '2026-01-01' }] as unknown as UnitMembership[];
  const service = createTenderService({
    repo: tenders.repo,
    documents: undefined,
    tickets: { get: async () => undefined },
    memberships: { listMemberships: async (apt, u) => memberships.filter((m) => m.apartmentId === apt && m.userId === u) },
    ...(opts.finance === false ? {} : { finance }),
    now: () => NOW,
    newId: () => `id-${String(++n).padStart(10, '0')}`,
  });
  const tender = (id: string) => structuredClone(fin.docs.get(`APT#${APT}|TENDER#${id}`)) as unknown as Tender;
  const expenses = () => [...fin.expenses.values()];
  return { fin, service, tender, expenses };
}

describe('karardan gider kaydi: on dolum', () => {
  it('yonetim gorunumunde on dolum (KDV dahil toplam, firma, referansli aciklama, kategoriye gore kalem); denetci / sakin gormez', async () => {
    const w = world();
    const t = (await w.service.get(mgr, 'tnd-1')).tender;
    expect(t.expenseDraft).toEqual({ amountKurus: 108_000_00, supplier: 'Cephe Ltd.', description: 'İhale tnd-1: Dış cephe mantolama · Karar KD-2026/14', expenseAccountId: 'exp-repair', date: '2026-11-27' });
    expect((await w.service.get(mgr, 'tnd-2')).tender.expenseDraft).toMatchObject({ expenseAccountId: 'exp-elevator', description: 'İhale tnd-2: Asansör revizyonu' });
    expect((await w.service.get(mgr, 'tnd-3')).tender).not.toHaveProperty('expenseDraft');
    expect((await w.service.get(observer, 'tnd-1')).tender).not.toHaveProperty('expenseDraft');
    expect((await w.service.portalGet(resident, 'tnd-1')).tender).not.toHaveProperty('expenseDraft');
  });
});

describe('karardan gider kaydi: yazim', () => {
  it('Finans gider servisiyle: gider + defter + ihale bagi + denetim tek atomik yazim; varsayilanlar karardan', async () => {
    const w = world();
    const r = await w.service.createExpense(mgr, 'tnd-1', { idempotencyKey: 'tx-exp-1', creditAccountId: 'payable' });
    expect(r).toMatchObject({ replayed: false, expenseId: expect.any(String), transactionId: expect.any(String) });
    const [expense] = w.expenses();
    expect(w.expenses()).toHaveLength(1);
    expect(expense).toMatchObject({
      expenseId: r.expenseId,
      amount: 108_000_00,
      expenseAccountId: 'exp-repair',
      creditAccountId: 'payable',
      supplier: 'Cephe Ltd.',
      description: 'İhale tnd-1: Dış cephe mantolama · Karar KD-2026/14',
      link: { type: 'tender', id: 'tnd-1', label: 'İhale: Dış cephe mantolama' },
    });
    expect(w.tender('tnd-1')).toMatchObject({ version: 6, updatedBy: 'mgr', expense: { expenseId: r.expenseId, transactionId: r.transactionId, amountKurus: 108_000_00, idempotencyKey: 'tx-exp-1', linkedBy: 'mgr' } });
    // Tek atomik yazim: islem, gider ve ihale ayni postBatch icinde; denetim ihale ayrintisiyla.
    const batch = w.fin.batches.at(-1);
    expect(batch?.transactions).toHaveLength(1);
    expect(batch?.replaceRecords?.map((x) => x.item.SK)).toEqual(['TENDER#tnd-1']);
    expect(batch?.audit).toMatchObject({ action: 'ledger.expense', details: { tender: { tenderId: 'tnd-1', quoteId: 'q1', decisionTotalKurus: 108_000_00, amountDiffers: false } } });
    // Yanit: ihale gorunumu bag ile, on dolum artik yok.
    expect(r.tender).toMatchObject({ expense: { expenseId: r.expenseId, amountKurus: 108_000_00 } });
    expect(r.tender).not.toHaveProperty('expenseDraft');
    expect((await w.service.get(observer, 'tnd-1')).tender).toMatchObject({ expense: { expenseId: r.expenseId } });
  });

  it('idempotent: ayni anahtar ayni sonuc; farkli anahtar 409 (ihale basina tek gider)', async () => {
    const w = world();
    const first = await w.service.createExpense(mgr, 'tnd-1', { idempotencyKey: 'tx-exp-1', creditAccountId: 'payable' });
    const again = await w.service.createExpense(mgr, 'tnd-1', { idempotencyKey: 'tx-exp-1', creditAccountId: 'payable' });
    expect(again).toMatchObject({ replayed: true, expenseId: first.expenseId, transactionId: first.transactionId });
    await expect(w.service.createExpense(firm, 'tnd-1', { idempotencyKey: 'tx-exp-2', creditAccountId: 'payable' })).rejects.toMatchObject({ code: 'conflict', details: { expenseId: first.expenseId } });
    expect(w.expenses()).toHaveLength(1);
    expect(w.fin.transactions.size).toBe(1);
  });

  it('es zamanli iki istek (farkli anahtar): surum kosulu yalnizca birini yazar', async () => {
    const w = world();
    const results = await Promise.allSettled([
      w.service.createExpense(mgr, 'tnd-1', { idempotencyKey: 'race-a', creditAccountId: 'payable' }),
      w.service.createExpense(firm, 'tnd-1', { idempotencyKey: 'race-b', creditAccountId: 'payable' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict' });
    expect(w.expenses()).toHaveLength(1);
    expect(w.tender('tnd-1').version).toBe(6);
  });

  it('yonetici on doluma mudahale edebilir (kalem, tutar); Finans kurallari aynen gecerli', async () => {
    const w = world();
    await expect(w.service.createExpense(mgr, 'tnd-1', { idempotencyKey: 'k-cash' })).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(w.tender('tnd-1')).not.toHaveProperty('expense');
    await expect(w.service.createExpense(mgr, 'tnd-1', { idempotencyKey: 'k-bad', creditAccountId: 'payable', expenseAccountId: 'yok' })).rejects.toMatchObject({ code: 'not_found' });
    const r = await w.service.createExpense(mgr, 'tnd-1', { idempotencyKey: 'k-part', creditAccountId: 'payable', expenseAccountId: 'exp-management', amount: 54_000_00, description: 'Mantolama 1. hakediş', invoiceNumber: 'F-77' });
    expect(w.expenses()[0]).toMatchObject({ amount: 54_000_00, expenseAccountId: 'exp-management', description: 'Mantolama 1. hakediş', invoiceNumber: 'F-77', supplier: 'Cephe Ltd.' });
    expect(w.fin.batches.at(-1)?.audit).toMatchObject({ details: { tender: { amountDiffers: true } } });
    expect(r.tender).toMatchObject({ expense: { amountKurus: 54_000_00 } });
  });

  it('kurallar: yalnizca karara baglanmis ihale; yalnizca yonetim; Finans yoksa 503; baska apartman 404', async () => {
    const w = world();
    await expect(w.service.createExpense(mgr, 'tnd-3', { idempotencyKey: 'k1', creditAccountId: 'payable' })).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(w.service.createExpense(observer, 'tnd-1', { idempotencyKey: 'k1', creditAccountId: 'payable' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.createExpense(resident, 'tnd-1', { idempotencyKey: 'k1', creditAccountId: 'payable' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.createExpense({ ...mgr, apartmentId: 'apt-2' }, 'tnd-1', { idempotencyKey: 'k1', creditAccountId: 'payable' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.createExpense(mgr, 'tnd-1', {})).rejects.toMatchObject({ field: 'idempotencyKey' });
    await expect(world({ finance: false }).service.createExpense(mgr, 'tnd-1', { idempotencyKey: 'k1', creditAccountId: 'payable' })).rejects.toMatchObject({ code: 'unavailable', httpStatus: 503 });
    expect(w.expenses()).toHaveLength(0);
  });

  it('API: POST /api/tenders/:id/expense 201, tekrar 200; denetci 403; Finans hatasi Finans koduyla', async () => {
    const w = world();
    const app = createApp({
      version: 'test',
      tenderService: w.service,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
    });
    const call = async (ctx: TenderContext, body: unknown) => {
      const res = await app.request('/api/tenders/tnd-1/expense', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-claims': JSON.stringify({ userId: ctx.userId, role: ctx.role, apartmentId: ctx.apartmentId }) },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    expect((await call(observer, { idempotencyKey: 'h1', creditAccountId: 'payable' })).status).toBe(403);
    expect(await call(mgr, { idempotencyKey: 'h0' })).toMatchObject({ status: 422, json: { error: 'insufficient_funds' } });
    const created = await call(mgr, { idempotencyKey: 'h1', creditAccountId: 'payable' });
    expect(created).toMatchObject({ status: 201, json: { replayed: false, tender: { expense: { amountKurus: 108_000_00 } } } });
    expect(await call(mgr, { idempotencyKey: 'h1', creditAccountId: 'payable' })).toMatchObject({ status: 200, json: { replayed: true, expenseId: created.json.expenseId } });
    expect(await call(mgr, { idempotencyKey: 'h2', creditAccountId: 'payable' })).toMatchObject({ status: 409, json: { error: 'conflict', expenseId: created.json.expenseId } });
  });
});
