/**
 * Faz 3 (O1-4): ariza talebi ve bakim gorevinin Finans baglantisi - yeni masraf (atomik: gider +
 * ozet + EXPLINK kilidi + olay), var olan masrafi baglama / bagi kaldirma, ters kayit, yonetici
 * onayli daireye yansitma, gece denetimi kontrolleri ve uclar.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import type { Unit } from '../src/modules/core/types.js';
import { ValidationError } from '../src/modules/core/validation.js';
import { type WorkTargetSnapshot, checkWorkCosts } from '../src/modules/finance/audit.js';
import { PeriodClosedError } from '../src/modules/finance/periodLock.js';
import { FinanceError, type FinanceContext, createFinanceService } from '../src/modules/finance/service.js';
import type { Transaction } from '../src/modules/finance/types.js';
import type { MaintenanceTask, MaintenanceTemplate } from '../src/modules/maintenance/types.js';
import type { Ticket, TicketEvent } from '../src/modules/tickets/types.js';
import { type WorkCostContext, type WorkCostSource, createWorkCostService } from '../src/modules/workcosts/service.js';
import type { CostSummary, ExpenseLinkRecord } from '../src/modules/workcosts/types.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';

const APT = 'apt-1';
const NOW = new Date('2026-11-25T09:00:00.000Z');
const TS = NOW.toISOString();
const mgr: WorkCostContext = { apartmentId: APT, userId: 'mgr', role: 'apartment_manager' };
const fctx: FinanceContext = { apartmentId: APT, userId: 'mgr' };

const audit = { createdAt: TS, createdBy: 'seed', updatedAt: TS, updatedBy: 'seed' };
const unit = (id: string) => ({ PK: `APT#${APT}`, SK: `UNIT#${id}`, entityType: 'UNIT', unitId: id, siteId: APT, blockId: 'b1', number: id.toUpperCase(), type: 'flat', grossAreaTenthsM2: 1000, exemptions: [], status: 'active', ...audit, version: 1 }) as unknown as Unit;
const ticket = (id: string, extra: Partial<Ticket> = {}) =>
  ({
    PK: `APT#${APT}`,
    SK: `TICKET#${id}`,
    entityType: 'TICKET',
    apartmentId: APT,
    ticketId: id,
    number: 'T-000007',
    title: 'Banyo tavanı akıyor',
    description: 'x',
    category: 'plumbing',
    priority: 'normal',
    location: { kind: 'unit', unitId: 'u1', blockId: 'b1' },
    status: 'resolved',
    source: 'manager',
    createdByRole: 'apartment_manager',
    dueAt: TS,
    reopenCount: 0,
    photoCount: 0,
    ...audit,
    version: 3,
    ...extra,
  }) as Ticket;
const task = (): MaintenanceTask =>
  ({
    PK: `APT#${APT}`,
    SK: 'MTASK#2026-11-20#tpl1',
    entityType: 'MAINT_TASK',
    apartmentId: APT,
    taskId: '2026-11-20_tpl1',
    templateId: 'tpl1',
    templateVersion: 1,
    dueDate: '2026-11-20',
    name: 'Asansör aylık bakımı',
    kind: 'elevator_monthly',
    category: 'elevator',
    checklist: [],
    status: 'done',
    ticketIds: [],
    ...audit,
    version: 4,
  }) as unknown as MaintenanceTask;

async function world() {
  const fake = createFakeFinanceRepo(APT);
  const units = [unit('u1')];
  const core: Pick<CoreRepository, 'getUnit' | 'listUnits'> = { getUnit: async (_a, id) => units.find((u) => u.unitId === id), listUnits: async () => units };
  let n = 0;
  const finance = createFinanceService({ repository: fake.repo, core, now: () => NOW, newId: () => `id-${String(++n).padStart(4, '0')}` });
  const supplier = await finance.createAccount(fctx, { type: 'payable', name: 'Asansör Firması' });
  const template = { templateId: 'tpl1', expenseAccountId: 'exp-elevator', supplierAccountId: supplier.accountId } as MaintenanceTemplate;
  const seed = (doc: { PK: string; SK: string }) => fake.docs.set(`${doc.PK}|${doc.SK}`, structuredClone(doc) as never);
  seed(ticket('tk1'));
  seed(ticket('tk2', { number: 'T-000008', title: 'Lobi lambası', category: 'electrical', location: { kind: 'common', area: 'Lobi' } }));
  seed(ticket('tk3', { number: 'T-000009', status: 'cancelled' }));
  seed(task());
  const doc = <T>(sk: string) => structuredClone(fake.docs.get(`APT#${APT}|${sk}`)) as T | undefined;
  /** Es zamanli degisiklik benzetimi: bir sonraki okuma bir surum eski doner. */
  let staleOnce = false;
  const source: WorkCostSource = {
    async getTicket(_a, id) {
      const t = doc<Ticket>(`TICKET#${id}`);
      if (t && staleOnce) {
        staleOnce = false;
        return { ...t, version: t.version - 1 };
      }
      return t;
    },
    getTask: async (_a, id) => doc<MaintenanceTask>(`MTASK#${id.slice(0, 10)}#${id.slice(11)}`),
    getTemplate: async () => template,
    getLink: async (_a, id) => doc<ExpenseLinkRecord>(`EXPLINK#${id}`),
    listLinks: async () => [...fake.docs.values()].filter((d) => d.entityType === 'EXPENSE_LINK') as unknown as ExpenseLinkRecord[],
  };
  const costs = createWorkCostService({ finance, source, expenses: fake.repo, now: () => NOW, newId: () => `ev-${String(++n).padStart(4, '0')}` });
  const events = (ticketId: string) => [...fake.docs.values()].filter((d) => String(d.SK).startsWith(`TKEV#${ticketId}#`)) as unknown as TicketEvent[];
  const summaryOf = (sk: string) => (doc<{ costSummary?: CostSummary }>(sk)?.costSummary ?? { total: 0, expenseIds: [] }) as CostSummary;
  const snapshot = () => ({
    transactions: [...fake.transactions.values()] as Transaction[],
    workTargets: [...fake.docs.values()]
      .filter((d) => (d.entityType === 'TICKET' || d.entityType === 'MAINT_TASK') && d.costSummary)
      .map((d) => ({ ref: d.entityType === 'TICKET' ? `ticket:${d.ticketId}` : `maintenance:${d.taskId}`, SK: d.SK, version: d.version, costSummary: d.costSummary }) as WorkTargetSnapshot),
    expenseLinks: [...fake.docs.values()].filter((d) => d.entityType === 'EXPENSE_LINK') as unknown as ExpenseLinkRecord[],
  });
  const plainExpense = (key: string, amount = 50000) =>
    finance.recordExpense(fctx, { idempotencyKey: key, expenseAccountId: 'exp-repair', creditAccountId: 'payable', amount, date: '2026-11-24', description: 'Tesisatçı faturası', supplier: 'Usta Ali' });
  return { fake, finance, costs, supplier, events, summaryOf, snapshot, plainExpense, doc, stale: () => (staleOnce = true) };
}

describe('yeni masraf (expense modu)', () => {
  it('talepten gider: kategori onerisi (Bakım / Onarım), atomik ozet + kilit + ic olay, denetim; tekrar replay', async () => {
    const w = await world();
    const before = await w.costs.costs(mgr, 'ticket', 'tk1');
    expect(before).toMatchObject({ total: 0, items: [], rechargeable: 0, suggestion: { expenseAccountId: 'exp-repair' } });
    const body = { mode: 'expense', idempotencyKey: 'tk1-cost-0001', amount: 125050, creditAccountId: 'payable', supplier: 'Usta Ali', invoiceNumber: 'F-12' };
    const r = await w.costs.add(mgr, 'ticket', 'tk1', body);
    expect(r).toMatchObject({ replayed: false, total: 125050, rechargeable: 125050, items: [{ mode: 'expense', amount: 125050, description: 'T-000007 Banyo tavanı akıyor', reversed: false, supplier: 'Usta Ali', expenseAccountId: 'exp-repair' }] });
    expect(w.fake.accounts.get(`${APT}|exp-repair`)?.name).toBe('Bakım / Onarım');
    expect(w.fake.expenses.get(`${APT}|${r.expenseId}`)?.link).toEqual({ type: 'ticket', id: 'tk1', label: 'T-000007 Banyo tavanı akıyor' });
    expect(w.doc<Ticket>('TICKET#tk1')).toMatchObject({ version: 4, updatedBy: 'mgr', costSummary: { total: 125050, expenseIds: [r.expenseId] } });
    expect(w.doc<ExpenseLinkRecord>(`EXPLINK#${r.expenseId}`)).toMatchObject({ status: 'active', mode: 'expense', amount: 125050, version: 1, target: { type: 'ticket', id: 'tk1' } });
    expect(w.events('tk1')).toMatchObject([{ kind: 'cost_linked', visibility: 'internal', amount: 125050, expenseId: r.expenseId, by: 'mgr', byRole: 'apartment_manager' }]);
    const batch = w.fake.batches.at(-1);
    expect(batch?.transactions).toHaveLength(1);
    expect(batch?.audit).toMatchObject({ action: 'ledger.expense', details: { work: { type: 'ticket', id: 'tk1' } } });

    const again = await w.costs.add(mgr, 'ticket', 'tk1', body);
    expect(again).toMatchObject({ replayed: true, expenseId: r.expenseId, total: 125050 });
    expect(w.fake.expenses.size).toBe(1);
    // Ayni anahtar baska isle kullanilamaz.
    await expect(w.costs.add(mgr, 'maintenance', '2026-11-20_tpl1', body)).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('bakim gorevi: sablondaki gider hesabi ve tedarikci varsayilan; olay yok', async () => {
    const w = await world();
    const r = await w.costs.add(mgr, 'maintenance', '2026-11-20_tpl1', { mode: 'expense', idempotencyKey: 'mt-cost-0001', amount: 300000, date: '2026-11-20' });
    expect(r.items[0]).toMatchObject({ expenseAccountId: 'exp-elevator', creditAccountId: w.supplier.accountId, description: 'Asansör aylık bakımı (20.11.2026)' });
    expect(w.doc<MaintenanceTask>('MTASK#2026-11-20#tpl1')).toMatchObject({ version: 5, costSummary: { total: 300000 } });
    expect(w.fake.balanceOf(w.supplier.accountId)).toBe(-300000);
    expect([...w.fake.docs.values()].some((d) => String(d.SK).startsWith('TKEV#'))).toBe(false);
  });

  it('kapali doneme masraf 409 ve hicbir sey yazilmaz; iptal edilmis talep 422; es zamanli degisiklikte yeniden denenir', async () => {
    const w = await world();
    w.fake.docs.set(`APT#${APT}|FINLOCK`, { PK: `APT#${APT}`, SK: 'FINLOCK', lockedThrough: '2026-10-31', version: 1 } as never);
    await expect(w.costs.add(mgr, 'ticket', 'tk1', { mode: 'expense', idempotencyKey: 'tk1-cost-0002', amount: 1000, creditAccountId: 'payable', date: '2026-10-15' })).rejects.toBeInstanceOf(PeriodClosedError);
    expect(w.doc<Ticket>('TICKET#tk1')?.version).toBe(3);
    expect(w.fake.expenses.size).toBe(0);
    await expect(w.costs.add(mgr, 'ticket', 'tk3', { mode: 'expense', idempotencyKey: 'tk3-cost-0001', amount: 1000, creditAccountId: 'payable' })).rejects.toMatchObject({ code: 'unprocessable' });

    w.stale();
    const r = await w.costs.add(mgr, 'ticket', 'tk1', { mode: 'expense', idempotencyKey: 'tk1-cost-0003', amount: 1000, creditAccountId: 'payable' });
    expect(r.total).toBe(1000);
    expect(w.doc<Ticket>('TICKET#tk1')?.version).toBe(4);
  });
});

describe('var olan masrafi baglama', () => {
  it('bir masraf tek ise baglanir; bag gerekceyle kaldirilir ve baska ise baglanabilir; isten kaydedilen gider bagdan cikarilamaz', async () => {
    const w = await world();
    const e = (await w.plainExpense('plain-exp-0001')).expense;
    const linked = await w.costs.add(mgr, 'ticket', 'tk1', { mode: 'link', idempotencyKey: 'link-0001', expenseId: e.expenseId });
    expect(linked).toMatchObject({ replayed: false, total: 50000, items: [{ mode: 'link', expenseId: e.expenseId, supplier: 'Usta Ali' }] });
    expect(w.fake.batches.at(-1)).toMatchObject({ transactions: [], audit: { action: 'ticket.cost_link', target: { type: 'ticket', id: 'tk1' } } });
    expect((await w.costs.add(mgr, 'ticket', 'tk1', { mode: 'link', idempotencyKey: 'link-0001', expenseId: e.expenseId })).replayed).toBe(true);
    await expect(w.costs.add(mgr, 'ticket', 'tk1', { mode: 'link', idempotencyKey: 'link-0002', expenseId: e.expenseId })).rejects.toThrow(/zaten bu ise/);
    await expect(w.costs.add(mgr, 'maintenance', '2026-11-20_tpl1', { mode: 'link', idempotencyKey: 'link-0003', expenseId: e.expenseId })).rejects.toThrow(/baska bir ise bagli: T-000007/);

    await expect(w.costs.unlink(mgr, 'ticket', 'tk1', e.expenseId, {})).rejects.toBeInstanceOf(ValidationError);
    const un = await w.costs.unlink(mgr, 'ticket', 'tk1', e.expenseId, { reason: 'Yanlış işe bağlanmıştı' });
    expect(un).toMatchObject({ total: 0, items: [] });
    expect(w.summaryOf('TICKET#tk1')).toMatchObject({ total: 0, expenseIds: [] });
    expect(w.doc<ExpenseLinkRecord>(`EXPLINK#${e.expenseId}`)).toMatchObject({ status: 'unlinked', unlinkReason: 'Yanlış işe bağlanmıştı', version: 2 });
    expect(w.events('tk1').map((x) => x.kind)).toEqual(['cost_linked', 'cost_unlinked']);

    const moved = await w.costs.add(mgr, 'maintenance', '2026-11-20_tpl1', { mode: 'link', idempotencyKey: 'link-0004', expenseId: e.expenseId });
    expect(moved.total).toBe(50000);
    const options = await w.costs.expenseOptions(mgr);
    expect(options.items.find((x) => x.expenseId === e.expenseId)).toMatchObject({ amount: 50000, supplier: 'Usta Ali', linkedTo: { type: 'maintenance', id: '2026-11-20_tpl1' } });
    expect((await w.costs.expenseOptions(mgr, { from: '2026-12-01' })).items).toEqual([]);
    expect(w.doc<ExpenseLinkRecord>(`EXPLINK#${e.expenseId}`)).toMatchObject({ status: 'active', version: 3, target: { type: 'maintenance', id: '2026-11-20_tpl1' } });

    const own = await w.costs.add(mgr, 'ticket', 'tk1', { mode: 'expense', idempotencyKey: 'tk1-cost-0004', amount: 2000, creditAccountId: 'payable' });
    await expect(w.costs.unlink(mgr, 'ticket', 'tk1', own.expenseId, { reason: 'x' })).rejects.toThrow(/ters kayitla/);
    await expect(w.costs.unlink(mgr, 'ticket', 'tk1', 'yok', { reason: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    expect(checkWorkCosts(w.snapshot())).toEqual([]);
  });

  it("Finans'ta ters kaydedilen masraf okuma aninda duser; iptal edilmis gider baglanamaz", async () => {
    const w = await world();
    const r = await w.costs.add(mgr, 'ticket', 'tk1', { mode: 'expense', idempotencyKey: 'tk1-cost-0005', amount: 40000, creditAccountId: 'payable' });
    await w.finance.reverseTransaction(fctx, r.transactionId, { reason: 'Mükerrer fatura' });
    const view = await w.costs.costs(mgr, 'ticket', 'tk1');
    expect(view).toMatchObject({ total: 0, rechargeable: 0, items: [{ expenseId: r.expenseId, reversed: true }] });
    // Ozet yazim anindaki haliyle kalir (defter append-only); denetim bulgusu yok.
    expect(w.summaryOf('TICKET#tk1').total).toBe(40000);
    expect(checkWorkCosts(w.snapshot())).toEqual([]);

    const e = (await w.plainExpense('plain-exp-0002')).expense;
    await w.finance.reverseTransaction(fctx, e.transactionId, { reason: 'Hatalı' });
    await expect(w.costs.add(mgr, 'ticket', 'tk1', { mode: 'link', idempotencyKey: 'link-0005', expenseId: e.expenseId })).rejects.toThrow(/iptal edilmis gider/);
  });
});

describe('daireye yansitma (karar 4)', () => {
  it('acik onay, daire ici talep ve ust sinir; yansitma tahakkuku + ozet + olay atomik; tekrar replay', async () => {
    const w = await world();
    await w.costs.add(mgr, 'ticket', 'tk1', { mode: 'expense', idempotencyKey: 'tk1-cost-0006', amount: 80000, creditAccountId: 'payable' });
    const base = { idempotencyKey: 'tk1-charge-0001', liableParty: 'occupant', amount: 30000, dueDate: '2026-12-15' };
    await expect(w.costs.charge(mgr, 'tk1', base)).rejects.toBeInstanceOf(ValidationError);
    await expect(w.costs.charge(mgr, 'tk2', { ...base, confirm: true })).rejects.toThrow(/daire ici/);
    await expect(w.costs.charge(mgr, 'tk1', { ...base, confirm: true, amount: 80001 })).rejects.toThrow(/en fazla 80000/);

    const r = await w.costs.charge(mgr, 'tk1', { ...base, confirm: true });
    expect(r).toMatchObject({ replayed: false, liableParty: 'occupant', rechargedTotal: 30000, rechargeable: 50000, recharges: [{ amount: 30000, unitId: 'u1', liableParty: 'occupant', requestedParty: 'occupant', reversed: false }] });
    const tx = w.fake.transactions.get(`${APT}|${r.transactionId}`) as Transaction;
    expect(tx).toMatchObject({ kind: 'dues_charge', reference: 'TICKET:T-000007', description: 'Onarım yansıtma: T-000007 Banyo tavanı akıyor', dueDate: '2026-12-15' });
    expect(tx.lines).toEqual([
      expect.objectContaining({ side: 'debit', unitId: 'u1', liableParty: 'occupant', amount: 30000 }),
      expect.objectContaining({ side: 'credit', accountId: 'income-repair-recharge', amount: 30000 }),
    ]);
    expect(w.fake.accounts.get(`${APT}|income-repair-recharge`)?.name).toBe('Onarım Yansıtma Gelirleri');
    expect(w.fake.events('DUE_GENERATED')).toHaveLength(1);
    expect(w.events('tk1').at(-1)).toMatchObject({ kind: 'cost_charged', visibility: 'internal', amount: 30000, transactionId: r.transactionId });
    expect(w.fake.batches.at(-1)?.audit).toMatchObject({ details: { recharge: { unitId: 'u1', liableParty: 'occupant' } } });

    expect((await w.costs.charge(mgr, 'tk1', { ...base, confirm: true })).replayed).toBe(true);
    expect(w.summaryOf('TICKET#tk1').recharges).toHaveLength(1);
    expect(checkWorkCosts(w.snapshot())).toEqual([]);

    // Yansitma ters kaydedilirse yansitilabilir tutar geri gelir.
    await w.finance.reverseTransaction(fctx, r.transactionId, { reason: 'Kusur sakinde degil' });
    expect(await w.costs.costs(mgr, 'ticket', 'tk1')).toMatchObject({ rechargedTotal: 0, rechargeable: 80000 });
  });
});

describe('gece denetimi', () => {
  it('ozet / kilit / defter tutarsizliklari', async () => {
    const w = await world();
    const r = await w.costs.add(mgr, 'ticket', 'tk1', { mode: 'expense', idempotencyKey: 'tk1-cost-0007', amount: 10000, creditAccountId: 'payable' });
    const ok = w.snapshot();
    expect(checkWorkCosts(ok)).toEqual([]);
    const tk = ok.workTargets[0] as WorkTargetSnapshot;
    const sum = tk.costSummary as CostSummary;

    const missing = { ...ok, workTargets: [{ ...tk, costSummary: { ...sum, expenseIds: [], total: 0, items: [] } }] };
    expect(checkWorkCosts(missing).map((f) => f.code).sort()).toEqual(['explink_orphan', 'ticket_cost_mismatch', 'ticket_cost_mismatch']);

    const badTotal = { ...ok, workTargets: [{ ...tk, costSummary: { ...sum, total: 9999 } }] };
    expect(checkWorkCosts(badTotal)).toMatchObject([{ code: 'ticket_cost_mismatch', workRef: 'ticket:tk1', expected: 10000, actual: 9999 }]);

    const noTarget = { ...ok, workTargets: [] };
    expect(checkWorkCosts(noTarget)).toMatchObject([{ code: 'explink_orphan', expenseId: r.expenseId, detail: 'is bulunamadi' }]);

    const noTx = { ...ok, transactions: [] };
    expect(checkWorkCosts(noTx)).toMatchObject([{ code: 'explink_orphan', transactionId: r.transactionId }]);

    const ghostRecharge = { ...ok, workTargets: [{ ...tk, costSummary: { ...sum, recharges: [{ transactionId: 'yok', amount: 1 } as never] } }] };
    expect(checkWorkCosts(ghostRecharge)).toMatchObject([{ code: 'ticket_cost_mismatch', transactionId: 'yok' }]);
  });
});

describe('uclar', () => {
  it('masraflari yonetim ve denetci gorur; gorevli goremez; yazim yalnizca yonetim', async () => {
    const w = await world();
    const app = createApp({
      version: 'test',
      workCostService: w.costs,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
    });
    const call = async (method: string, path: string, role: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { 'x-test-claims': JSON.stringify({ userId: 'u', role, apartmentId: APT }), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    const body = { mode: 'expense', idempotencyKey: 'api-cost-0001', amount: 5000, creditAccountId: 'payable' };
    expect((await call('POST', '/api/tickets/tk1/costs', 'observer', body)).status).toBe(403);
    expect((await call('POST', '/api/tickets/tk1/costs', 'apartment_manager', body))).toMatchObject({ status: 201, json: { total: 5000 } });
    expect((await call('POST', '/api/tickets/tk1/costs', 'apartment_manager', body)).status).toBe(200);
    expect((await call('GET', '/api/tickets/tk1/costs', 'observer')).json.total).toBe(5000);
    expect((await call('GET', '/api/tickets/tk1/costs', 'building_staff')).status).toBe(403);
    expect((await call('GET', '/api/maintenance/tasks/2026-11-20_tpl1/costs', 'management_company')).json).toMatchObject({ total: 0, suggestion: { expenseAccountId: 'exp-elevator' } });
    expect((await call('POST', '/api/tickets/tk1/charges', 'observer', {})).status).toBe(403);
    expect((await call('POST', '/api/tickets/tk1/charges', 'apartment_manager', { idempotencyKey: 'api-charge-0001', liableParty: 'owner', amount: 100, dueDate: '2026-12-31' })).status).toBe(400);
    expect((await call('GET', '/api/tickets/nope/costs', 'apartment_manager')).status).toBe(404);
  });
});

it('FinanceError hata kodlari HTTP durumlarina esler (referans)', () => {
  expect(new FinanceError('conflict', 'x').httpStatus).toBe(409);
});
