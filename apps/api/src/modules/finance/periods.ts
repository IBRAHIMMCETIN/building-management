/**
 * Finans 2.4-2 - Mali donem kapanisi: kontrol listesi, iki fazli kapanis (kilit -> anlik goruntu)
 * ve yalnizca son kapanan ayin gerekceli yeniden acilmasi.
 *
 * Kurallar (plan: claude/finans-2-4-donem-kapanisi-butce-plani.md, kararlar 25.11.2026):
 *  - Kapanis aylik ve sirali: son kapanandan sonraki ay. Ilk kapanis tamamlanmis herhangi bir ay
 *    olabilir (acilis bakiyeleri onceki tum hareketlerden). Bulunulan ay kapatilamaz.
 *  - Engel: yarim sayac onayi / geri almasi, inceleme bekleyen online odeme, mizan dengesizligi
 *    veya defter-bakiye uyusmazligi. Uyari (kod listesiyle onaylanir): eslesmemis banka satiri,
 *    kesinlesmemis gecikme tazminati, bekleyen mahsup talebi, taslak sayac donemi.
 *  - Yil sonu devri ayrica yevmiye yazmaz (karar A): Aralik goruntusu devir goruntusudur.
 *  - Yeniden acma: yonetici + yonetim firmasi, yalnizca son kapanan ay, gerekce zorunlu.
 */
import type { IsoDate } from '../core/types.js';
import { coreRepository } from '../core/repository.js';
import { ValidationError, asObject, reqInt, reqString } from '../core/validation.js';
import { queryTenantAll } from '../../config/dynamodb.js';
import { offsetRepository } from './offsets.js';
import { bankRepository } from './bank/repository.js';
import { paymentsRepository } from '../payments/repository.js';
import { nextPeriod, periodBounds, previousPeriod } from './lateFee.js';
import { unpostedFeeOf, summarizeLines } from './accountSummary.js';
import { type SummaryRepo, loadAccountCores, summarizable } from './accountSummaryStore.js';
import { type FinanceRepository, financeRepository } from './repository.js';
import { FiscalConflictError, type FiscalRepository, fiscalRepository } from './periodRepository.js';
import {
  type ChecklistItem,
  ClosingBlockedError,
  type FinanceLock,
  PeriodError,
  type FiscalPeriod,
  type PeriodSnapshot,
  buildSnapshot,
  formatPeriodTr,
  netByAccount,
  periodKeys,
  verifySnapshot,
} from './periodLock.js';
import type { Account, Transaction } from './types.js';

export type PeriodContext = { apartmentId: string; userId: string };
export { ClosingBlockedError, PeriodError };

/** Kontrol listesinin diger modullerden okudugu durumlar (testte sahtesi verilir). */
export type PeriodCheckSources = {
  meterPeriods(apartmentId: string): Promise<{ periodId: string; name: string; status: string; endDate: IsoDate }[]>;
  reviewPayments(apartmentId: string): Promise<number>;
  unmatchedBankLines(apartmentId: string, bankAccountIds: string[], from: IsoDate, to: IsoDate): Promise<number>;
  pendingOffsetRequests(apartmentId: string): Promise<number>;
  lateFeeSettings(apartmentId: string): Promise<{ monthlyBasisPoints: number }>;
};

export type PeriodServiceDeps = {
  finance: Pick<FinanceRepository, 'listAccounts' | 'listTransactions'> & SummaryRepo;
  fiscal: FiscalRepository;
  sources: PeriodCheckSources;
  now: () => Date;
};

export const defaultPeriodSources: PeriodCheckSources = {
  async meterPeriods(apartmentId) {
    const items = await queryTenantAll<{ periodId: string; name: string; status: string; endDate: IsoDate; apartmentId?: string }>(apartmentId, 'MPERIOD#', { ConsistentRead: true });
    return items.map(({ periodId, name, status, endDate }) => ({ periodId, name, status, endDate }));
  },
  async reviewPayments(apartmentId) {
    return (await paymentsRepository.listIntents(apartmentId, { status: 'NEEDS_REVIEW', limit: 50 })).items.length;
  },
  async unmatchedBankLines(apartmentId, bankAccountIds, from, to) {
    let n = 0;
    for (const bankAccountId of bankAccountIds) {
      n += (await bankRepository.queryLines(apartmentId, { bankAccountId, from, to, status: 'unmatched', limit: 100 })).items.length;
    }
    return n;
  },
  async pendingOffsetRequests(apartmentId) {
    return (await offsetRepository.listRequests(apartmentId)).filter((r) => r.status === 'pending').length;
  },
  async lateFeeSettings(apartmentId) {
    const site = await coreRepository.getSite(apartmentId);
    return { monthlyBasisPoints: site?.settings.lateFeeMonthlyBasisPoints ?? 500 };
  },
};

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const REASON_MIN = 10;
const REASON_MAX = 300;
const WARNING_CODES = ['bank_unmatched', 'late_fee_pending', 'offset_requests_pending', 'meter_draft'] as const;

const addDays = (d: IsoDate, n: number): IsoDate => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function createPeriodService(overrides: Partial<PeriodServiceDeps> = {}) {
  const deps: PeriodServiceDeps = {
    finance: financeRepository,
    fiscal: fiscalRepository,
    sources: defaultPeriodSources,
    now: () => new Date(),
    ...overrides,
  };
  const stamp = () => deps.now().toISOString();
  const today = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());

  function assertPeriod(period: string): void {
    if (!PERIOD_RE.test(period)) throw new ValidationError('period YYYY-MM olmali', 'period');
  }

  function emptyLock(apartmentId: string, userId: string): FinanceLock {
    return { ...periodKeys.lock(apartmentId), entityType: 'FINANCE_LOCK', apartmentId, updatedAt: stamp(), updatedBy: userId, version: 0 };
  }

  /** Bu ay su an kapatilabilir mi? (sira + takvim). Kapanabilir degilse nedeniyle firlatir. */
  function assertClosable(lock: FinanceLock | undefined, period: string): void {
    const { last } = periodBounds(period);
    if (last >= today()) throw new PeriodError('unprocessable', `${formatPeriodTr(period)} henüz bitmedi; yalnızca tamamlanmış aylar kapatılabilir`);
    if (lock?.closing && lock.closing.period !== period) {
      throw new PeriodError('conflict', `${formatPeriodTr(lock.closing.period)} kapanışı yarıda kaldı; önce onu tamamlayın`);
    }
    if (lock?.closing?.period === period) return; // yarida kalan kapanisin devami
    if (lock?.lastClosedPeriod) {
      const expected = nextPeriod(lock.lastClosedPeriod);
      if (period !== expected) throw new PeriodError('unprocessable', `Kapanış sırayla yapılır: sıradaki dönem ${formatPeriodTr(expected)}`);
    } else if (lock?.lockedThrough && periodBounds(period).last <= lock.lockedThrough) {
      throw new PeriodError('unprocessable', 'Bu dönem zaten kilitli');
    }
  }

  type Loaded = {
    accounts: Account[];
    periodTxs: Transaction[];
    after: Transaction[];
    opening: Map<string, number>;
    previous?: FiscalPeriod;
  };

  /**
   * Kapanis/kontrol listesi icin defter: yalnizca donemin islemleri + sonrasi (net icin).
   *
   * P1-a: acilis bakiyeleri onceki ayin KAPALI anlik goruntusunden alinir (kilit o aya kayit
   * yazilmasini engeller); gecmis yillarin satirlari yeniden toplanmaz. Butunluk korunur:
   * `verifySnapshot` her hesapta `kapanis + donem sonrasi net = canli bakiye` esitligini denetler,
   * kapali bir aya sizan kayit bu esitligi bozar. Onceki kapali goruntu yoksa (sitenin ILK
   * kapanisi) acilis tek seferlik olarak donem oncesi tum islemlerden hesaplanir.
   */
  async function load(apartmentId: string, period: string, lock: FinanceLock | undefined): Promise<Loaded> {
    const { first, last } = periodBounds(period);
    const prevPeriod = previousPeriod(period);
    const [accounts, periodPage, afterPage, previous] = await Promise.all([
      deps.finance.listAccounts(apartmentId),
      deps.finance.listTransactions(apartmentId, { from: first, to: last }),
      deps.finance.listTransactions(apartmentId, { from: addDays(last, 1) }),
      (lock?.lastClosedPeriod ?? lock?.closing?.previousLastClosed) === prevPeriod ? deps.fiscal.getPeriod(apartmentId, prevPeriod) : Promise.resolve(undefined),
    ]);
    const closedPrevious = previous?.status === 'closed' ? previous : undefined;
    const opening = closedPrevious
      ? new Map(closedPrevious.snapshot.rows.map((r) => [r.accountId, r.closing]))
      : netByAccount((await deps.finance.listTransactions(apartmentId, { to: addDays(first, -1) })).items);
    return { accounts, periodTxs: periodPage.items, after: afterPage.items, opening, ...(closedPrevious ? { previous: closedPrevious } : {}) };
  }

  function snapshotOf(l: Loaded): { snapshot: PeriodSnapshot; problems: ChecklistItem[] } {
    const snapshot = buildSnapshot({ accounts: l.accounts, opening: l.opening, periodTransactions: l.periodTxs });
    const problems = verifySnapshot(snapshot, l.accounts, netByAccount(l.after));
    // Onceki goruntu ile sureklilik: kilit varken onceki aya kayit giremez; fark varsa butunluk sorunu.
    if (l.previous) {
      const prevClosing = new Map(l.previous.snapshot.rows.map((r) => [r.accountId, r.closing]));
      const drift = snapshot.rows.filter((r) => (prevClosing.get(r.accountId) ?? 0) !== r.opening);
      if (drift.length) {
        problems.push({ code: 'opening_drift', message: `Önceki dönem kapanışı ile açılış uyuşmuyor (${drift.length} hesap)`, count: drift.length });
      }
    }
    return { snapshot, problems };
  }

  async function evaluate(ctx: PeriodContext, period: string, lock: FinanceLock | undefined, l: Loaded) {
    const { first, last } = periodBounds(period);
    const blockers: ChecklistItem[] = [];
    const warnings: ChecklistItem[] = [];
    const [meterPeriods, review, offsetsPending, fee] = await Promise.all([
      deps.sources.meterPeriods(ctx.apartmentId),
      deps.sources.reviewPayments(ctx.apartmentId),
      deps.sources.pendingOffsetRequests(ctx.apartmentId),
      deps.sources.lateFeeSettings(ctx.apartmentId),
    ]);
    const stuck = meterPeriods.filter((p) => p.status === 'posting' || p.status === 'reversing');
    if (stuck.length) {
      blockers.push({ code: 'meter_posting', message: `Yarıda kalmış sayaç onayı / geri alması: ${stuck.map((p) => p.name).join(', ')}`, count: stuck.length });
    }
    if (review > 0) blockers.push({ code: 'payment_review', message: 'İnceleme bekleyen online ödeme var', count: review });
    const { problems } = snapshotOf(l);
    blockers.push(...problems);

    const bankIds = l.accounts.filter((a) => a.type === 'bank').map((a) => a.accountId);
    const unmatched = bankIds.length ? await deps.sources.unmatchedBankLines(ctx.apartmentId, bankIds, first, last) : 0;
    if (unmatched > 0) warnings.push({ code: 'bank_unmatched', message: `Bu ayda eşleşmemiş ${unmatched >= 100 ? '100+' : unmatched} banka satırı var`, count: unmatched });

    // Onceki ayin tazminati bu ayin 1'i tarihli kesinlesir: ay sonunda hala yazilmamis tutar var mi?
    const asOf = periodBounds(previousPeriod(period)).last;
    if (fee.monthlyBasisPoints > 0) {
      // P1-a: alt cari ozetlerinden (tam hesap gecmisi, asOf = onceki ay sonu); donem sonuna kadar
      // deftere yazilmis tazminat dusulur. Tum defter taranmaz.
      const receivables = l.accounts.filter((a) => summarizable(a) && !(a.closedThrough && a.closedThrough >= asOf));
      const { cores } = await loadAccountCores(deps.finance, ctx.apartmentId, receivables, { asOf, today: today(), computedAt: stamp() });
      const pending = receivables.reduce(
        (s, a) => s + unpostedFeeOf(cores.get(a.accountId) ?? summarizeLines([]), fee.monthlyBasisPoints, asOf, last),
        0,
      );
      if (pending > 0) warnings.push({ code: 'late_fee_pending', message: `${formatPeriodTr(previousPeriod(period))} gecikme tazminatı deftere yazılmamış`, amount: pending });
    }
    if (offsetsPending > 0) warnings.push({ code: 'offset_requests_pending', message: 'Bekleyen sakin mahsup talebi var', count: offsetsPending });
    const drafts = meterPeriods.filter((p) => (p.status === 'draft' || p.status === 'calculated') && p.endDate <= last);
    if (drafts.length) warnings.push({ code: 'meter_draft', message: `Onaylanmamış sayaç dönemi: ${drafts.map((p) => p.name).join(', ')}`, count: drafts.length });

    let sequence: string | undefined;
    try {
      assertClosable(lock, period);
    } catch (err) {
      sequence = err instanceof Error ? err.message : String(err);
    }
    return { blockers, warnings, sequence };
  }

  // ---------------------------------------------------------------------------

  async function status(ctx: PeriodContext) {
    const [lock, periods] = await Promise.all([deps.fiscal.getLock(ctx.apartmentId), deps.fiscal.listPeriods(ctx.apartmentId)]);
    const previousMonth = previousPeriod(today().slice(0, 7));
    let next: string | undefined;
    if (lock?.closing) next = lock.closing.period;
    else if (lock?.lastClosedPeriod) next = nextPeriod(lock.lastClosedPeriod);
    // Ilk kapanis: istemci tamamlanmis herhangi bir ayi secebilir (varsayilan: onceki ay).
    const nextClosable = next && next <= previousMonth ? next : next ? undefined : previousMonth;
    return {
      lockedThrough: lock?.lockedThrough,
      lastClosedPeriod: lock?.lastClosedPeriod,
      closing: lock?.closing?.period,
      lockVersion: lock?.version ?? 0,
      nextClosable,
      firstClose: !lock?.lastClosedPeriod && !lock?.closing,
      periods: periods.map(({ snapshot, PK: _pk, SK: _sk, ...p }) => ({ ...p, totals: snapshot.totals, hash: snapshot.hash })),
    };
  }

  async function checklist(ctx: PeriodContext, period: string) {
    assertPeriod(period);
    const lock = await deps.fiscal.getLock(ctx.apartmentId);
    const l = await load(ctx.apartmentId, period, lock);
    const { blockers, warnings, sequence } = await evaluate(ctx, period, lock, l);
    const { snapshot } = snapshotOf(l);
    return {
      period,
      canClose: !sequence && blockers.length === 0,
      ...(sequence ? { sequenceError: sequence } : {}),
      blockers,
      warnings,
      lockVersion: lock?.version ?? 0,
      preview: { totals: snapshot.totals },
    };
  }

  async function close(ctx: PeriodContext, period: string, body: unknown) {
    assertPeriod(period);
    const o = asObject(body);
    const expectedLockVersion = reqInt(o, 'expectedLockVersion', 0, Number.MAX_SAFE_INTEGER);
    const ack = Array.isArray(o.acknowledgeWarnings) ? o.acknowledgeWarnings.filter((x): x is string => typeof x === 'string') : [];
    if (ack.some((c) => !(WARNING_CODES as readonly string[]).includes(c))) throw new ValidationError('acknowledgeWarnings bilinmeyen uyarı kodu içeriyor', 'acknowledgeWarnings');

    let lock = await deps.fiscal.getLock(ctx.apartmentId);
    if ((lock?.version ?? 0) !== expectedLockVersion) throw new PeriodError('conflict', 'Dönem durumu değişti; sayfayı yenileyin');
    assertClosable(lock, period);
    const { first, last } = periodBounds(period);
    const resuming = lock?.closing?.period === period;

    // Faz 0: engeller ve onaylanmamis uyarilar (kilit konmadan once).
    const pre = await evaluate(ctx, period, lock, await load(ctx.apartmentId, period, lock));
    if (pre.blockers.length) throw new ClosingBlockedError('Dönem kapatılamaz: engelleri giderin', pre.blockers, pre.warnings);
    const missing = pre.warnings.filter((w) => !ack.includes(w.code));
    if (missing.length) throw new ClosingBlockedError('Uyarıları onaylayarak tekrar deneyin', [], missing);

    // Faz 1: kilit (yeni kayit artik bu aya giremez).
    const base = lock ?? emptyLock(ctx.apartmentId, ctx.userId);
    if (!resuming) {
      const next: FinanceLock = {
        ...base,
        lockedThrough: last,
        closing: {
          period,
          ...(base.lockedThrough ? { previousLockedThrough: base.lockedThrough } : {}),
          ...(base.lastClosedPeriod ? { previousLastClosed: base.lastClosedPeriod } : {}),
          startedAt: stamp(),
          startedBy: ctx.userId,
        },
        updatedAt: stamp(),
        updatedBy: ctx.userId,
        version: base.version + 1,
      };
      await writeOrConflict(() => deps.fiscal.write(ctx.apartmentId, { lock: next, expectedLockVersion: base.version }));
      lock = next;
    }
    const locked = lock as FinanceLock & { closing: NonNullable<FinanceLock['closing']> };

    // Faz 2: kilit altinda anlik goruntu (kesin) ve dogrulama.
    const l = await load(ctx.apartmentId, period, locked);
    const { snapshot, problems } = snapshotOf(l);
    if (problems.length) {
      // Kilidi geri al: kapanis yapilmadi.
      const { closing: c, lockedThrough: _lt, lastClosedPeriod: _lc, ...rest } = locked;
      const reverted: FinanceLock = {
        ...rest,
        ...(c.previousLockedThrough ? { lockedThrough: c.previousLockedThrough } : {}),
        ...(c.previousLastClosed ? { lastClosedPeriod: c.previousLastClosed } : {}),
        updatedAt: stamp(),
        updatedBy: ctx.userId,
        version: locked.version + 1,
      };
      await writeOrConflict(() => deps.fiscal.write(ctx.apartmentId, { lock: reverted, expectedLockVersion: locked.version }));
      throw new ClosingBlockedError('Dönem kapatılamaz: defter doğrulaması başarısız', problems);
    }

    // Faz 3: goruntu + kilidin kesinlesmesi + denetim (tek atomik yazim).
    const existing = await deps.fiscal.getPeriod(ctx.apartmentId, period);
    const ts = stamp();
    const doc: FiscalPeriod = {
      ...periodKeys.period(ctx.apartmentId, period),
      entityType: 'FISCAL_PERIOD',
      apartmentId: ctx.apartmentId,
      period,
      periodStart: first,
      periodEnd: last,
      status: 'closed',
      closedAt: ts,
      closedBy: ctx.userId,
      acknowledgedWarnings: pre.warnings,
      ...(locked.closing.previousLockedThrough ? { previousLockedThrough: locked.closing.previousLockedThrough } : {}),
      ...(locked.closing.previousLastClosed ? { previousLastClosed: locked.closing.previousLastClosed } : {}),
      snapshot,
      revision: (existing?.revision ?? 0) + 1,
      reopenHistory: existing?.reopenHistory ?? [],
      version: (existing?.version ?? 0) + 1,
    };
    const { closing: _c, ...lockRest } = locked;
    const finalLock: FinanceLock = { ...lockRest, lockedThrough: last, lastClosedPeriod: period, updatedAt: ts, updatedBy: ctx.userId, version: locked.version + 1 };
    await writeOrConflict(() =>
      deps.fiscal.write(ctx.apartmentId, {
        lock: finalLock,
        expectedLockVersion: locked.version,
        period: doc,
        expectedPeriodVersion: existing?.version ?? 0,
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.period_close',
          target: { type: 'fiscal_period', id: period },
          actorId: ctx.userId,
          details: { period, revision: doc.revision, hash: snapshot.hash, totals: snapshot.totals, acknowledged: pre.warnings.map((w) => w.code) },
        },
      }),
    );
    const { PK: _pk, SK: _sk, ...view } = doc;
    return { period: view, lock: { lockedThrough: finalLock.lockedThrough, lastClosedPeriod: period, lockVersion: finalLock.version } };
  }

  async function reopen(ctx: PeriodContext, period: string, body: unknown) {
    assertPeriod(period);
    const o = asObject(body);
    const reason = reqString(o, 'reason', REASON_MAX, REASON_MIN).trim();
    const lock = await deps.fiscal.getLock(ctx.apartmentId);
    if (lock?.closing) throw new PeriodError('conflict', `${formatPeriodTr(lock.closing.period)} kapanışı sürüyor`);
    if (!lock?.lastClosedPeriod || lock.lastClosedPeriod !== period) {
      throw new PeriodError('unprocessable', lock?.lastClosedPeriod ? `Yalnızca son kapanan dönem (${formatPeriodTr(lock.lastClosedPeriod)}) yeniden açılabilir` : 'Kapalı dönem yok');
    }
    const doc = await deps.fiscal.getPeriod(ctx.apartmentId, period);
    if (!doc || doc.status !== 'closed') throw new PeriodError('not_found', 'Dönem kaydı bulunamadı');
    const ts = stamp();
    const { lockedThrough: _lt, lastClosedPeriod: _lc, ...rest } = lock;
    const nextLock: FinanceLock = {
      ...rest,
      ...(doc.previousLockedThrough ? { lockedThrough: doc.previousLockedThrough } : {}),
      ...(doc.previousLastClosed ? { lastClosedPeriod: doc.previousLastClosed } : {}),
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: lock.version + 1,
    };
    const nextDoc: FiscalPeriod = {
      ...doc,
      status: 'reopened',
      reopenHistory: [...doc.reopenHistory, { at: ts, by: ctx.userId, reason, revision: doc.revision }],
      version: doc.version + 1,
    };
    await writeOrConflict(() =>
      deps.fiscal.write(ctx.apartmentId, {
        lock: nextLock,
        expectedLockVersion: lock.version,
        period: nextDoc,
        expectedPeriodVersion: doc.version,
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.period_reopen',
          target: { type: 'fiscal_period', id: period },
          actorId: ctx.userId,
          reason,
          details: { period, revision: doc.revision, lockedThrough: nextLock.lockedThrough ?? null },
        },
      }),
    );
    const { PK: _pk, SK: _sk, ...view } = nextDoc;
    return { period: view, lock: { lockedThrough: nextLock.lockedThrough, lastClosedPeriod: nextLock.lastClosedPeriod, lockVersion: nextLock.version } };
  }

  async function get(ctx: PeriodContext, period: string) {
    assertPeriod(period);
    const doc = await deps.fiscal.getPeriod(ctx.apartmentId, period);
    if (!doc) throw new PeriodError('not_found', 'Dönem kaydı bulunamadı');
    const { PK: _pk, SK: _sk, ...view } = doc;
    return view;
  }

  async function writeOrConflict(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof FiscalConflictError) throw new PeriodError('conflict', 'Dönem durumu başka bir işlemle değişti; sayfayı yenileyin');
      throw err;
    }
  }

  return { status, checklist, close, reopen, get };
}

export type PeriodService = ReturnType<typeof createPeriodService>;
