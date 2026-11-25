/**
 * Finans 2.4-6: gece denetiminde mali donem butunlugu (checkFiscalPeriods) - snapshot bozulmasi,
 * kapali doneme kilit disi yazim, kilit/donem tutarsizligi ve takili kapanis.
 */
import { describe, expect, it } from 'vitest';
import type { CoreRepository } from '../src/modules/core/repository.js';
import type { Unit } from '../src/modules/core/types.js';
import { checkFiscalPeriods } from '../src/modules/finance/audit.js';
import type { FinanceLock, FiscalPeriod } from '../src/modules/finance/periodLock.js';
import { type PeriodCheckSources, createPeriodService } from '../src/modules/finance/periods.js';
import { type FinanceContext, createFinanceService } from '../src/modules/finance/service.js';
import type { Account, Transaction } from '../src/modules/finance/types.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';
import { createFakeFiscalRepo } from './fakes/fiscalRepo.js';

const APT = 'apt-1';
const ctx: FinanceContext = { apartmentId: APT, userId: 'mgr-1' };
const NOW = new Date('2026-11-25T09:00:00.000Z');

const unit = (id: string) =>
  ({ PK: `APT#${APT}`, SK: `UNIT#${id}`, entityType: 'UNIT', unitId: id, siteId: APT, blockId: 'b1', number: id, type: 'flat', grossAreaTenthsM2: 1000, exemptions: [], status: 'active', version: 1 }) as unknown as Unit;

async function world() {
  const fake = createFakeFinanceRepo(APT);
  const fiscal = createFakeFiscalRepo(fake.docs);
  const units = [unit('u1')];
  const core = { getUnit: async (_a: string, id: string) => units.find((u) => u.unitId === id), listUnits: async () => units } as unknown as Pick<CoreRepository, 'getUnit' | 'listUnits'>;
  let n = 0;
  const finance = createFinanceService({ repository: fake.repo, core, now: () => NOW, newId: () => `id${String(++n).padStart(4, '0')}` });
  const sources: PeriodCheckSources = {
    meterPeriods: async () => [],
    reviewPayments: async () => 0,
    unmatchedBankLines: async () => 0,
    pendingOffsetRequests: async () => 0,
    lateFeeSettings: async () => ({ monthlyBasisPoints: 0 }),
  };
  const periods = createPeriodService({ finance: fake.repo, fiscal: fiscal.repo, sources, now: () => NOW });
  let k = 0;
  for (const date of ['2026-09-01', '2026-10-01']) {
    await finance.chargeUnit(ctx, { idempotencyKey: `dues-key-${++k}`, unitId: 'u1', liableParty: 'owner', amount: 100000, date, dueDate: date, description: 'Aidat' });
  }
  await finance.recordPayment(ctx, { idempotencyKey: `pay-key-${++k}`, unitId: 'u1', liableParty: 'owner', amount: 60000, method: 'cash', paidAt: '2026-09-15' });
  await periods.close(ctx, '2026-09', { expectedLockVersion: 0, acknowledgeWarnings: [] });
  const snapshot = async () => ({
    accounts: (await fake.repo.listAccounts(APT)) as Account[],
    transactions: [...fake.transactions.values()] as Transaction[],
    financeLock: (await fiscal.repo.getLock(APT)) as FinanceLock,
    fiscalPeriods: (await fiscal.repo.listPeriods(APT)) as FiscalPeriod[],
  });
  return { fake, snapshot };
}

describe('mali donem butunlugu (gece denetimi)', () => {
  it('temiz kapanis bulgu uretmez; sonradan eklenen hareketsiz hesap ve ad degisikligi de', async () => {
    const w = await world();
    const s = await w.snapshot();
    expect(checkFiscalPeriods(s, NOW)).toEqual([]);
    const extra = { ...s.accounts[0], accountId: 'exp-new', type: 'expense', name: 'Yeni gider', balance: 0, status: 'active' } as Account;
    const renamed = s.accounts.map((a) => (a.accountId === 'cash' ? { ...a, name: 'Ana kasa', code: '100' } : a));
    expect(checkFiscalPeriods({ ...s, accounts: [...renamed, extra] }, NOW)).toEqual([]);
  });

  it('kapanistan sonra kapali aya tarihli islem: drift + kilit disi yazim', async () => {
    const w = await world();
    const s = await w.snapshot();
    const sneaky = {
      transactionId: '20260920-zz',
      siteId: APT,
      date: '2026-09-20',
      kind: 'payment',
      createdAt: '2026-11-25T10:00:00.000Z',
      createdBy: 'x',
      lines: [
        { accountId: 'cash', side: 'debit', amount: 5000 },
        { accountId: s.accounts.find((a) => a.type === 'receivable')?.accountId as string, side: 'credit', amount: 5000 },
      ],
    } as unknown as Transaction;
    const f = checkFiscalPeriods({ ...s, transactions: [...s.transactions, sneaky] }, NOW);
    expect(f).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'fiscal_period_drift', periodId: '2026-09', detail: 'ledger_changed' }),
        expect.objectContaining({ code: 'fiscal_closed_write', periodId: '2026-09', transactionId: '20260920-zz' }),
      ]),
    );
  });

  it('bozulmus snapshot satiri ve kilit tutarsizligi; takili kapanis', async () => {
    const w = await world();
    const s = await w.snapshot();
    const [p] = s.fiscalPeriods;
    const corrupt = { ...p, snapshot: { ...p.snapshot, rows: p.snapshot.rows.map((r, i) => (i === 0 ? { ...r, closing: r.closing + 1 } : r)) } } as FiscalPeriod;
    expect(checkFiscalPeriods({ ...s, fiscalPeriods: [corrupt] }, NOW)).toEqual([expect.objectContaining({ code: 'fiscal_period_drift', detail: 'snapshot_corrupt' })]);

    expect(checkFiscalPeriods({ ...s, financeLock: { ...s.financeLock, lockedThrough: '2026-08-31' } }, NOW)).toEqual([
      expect.objectContaining({ code: 'fiscal_lock_mismatch', detail: 'locked_through', expected: '2026-09-30' }),
    ]);
    const stuck = { ...s.financeLock, closing: { period: '2026-10', previousLockedThrough: '2026-09-30', previousLastClosed: '2026-09', startedAt: '2026-11-25T08:00:00.000Z', startedBy: 'mgr-1' } } as FinanceLock;
    expect(checkFiscalPeriods({ ...s, financeLock: stuck }, NOW)).toEqual([expect.objectContaining({ code: 'fiscal_lock_mismatch', detail: 'close_stuck', periodId: '2026-10' })]);
    expect(checkFiscalPeriods({ ...s, financeLock: stuck }, new Date('2026-11-25T08:10:00.000Z'))).toEqual([]);
  });
});
