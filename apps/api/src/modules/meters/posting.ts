/**
 * Finans 2.3-3 - Dagitim hesabi onizleme, donem onayi ve toplu tahakkuk.
 *
 * Kurallar:
 *  1. Onizleme-onay kilidi: onizleme `calcHash` uretir (okumalar, sablon, fatura tutari, tarihler,
 *     dagitim sonucu ve borclu ozeti). Onay bu hash'i ZORUNLU tasir; onay aninda yeniden hesaplanan
 *     hash uyusmazsa 409 doner ve yeniden onizleme istenir.
 *  2. Borclu: mevcut cozumleyici (sakin, bos dairede malik, `split` dairede paydas carileri). Donem
 *     sonundaki sorumlu sonradan tasinmis ve ana carisi o tarihe kadar kapatilmissa kalem yeni
 *     sakine degil, o kapamanin AYRILAN carisine yazilir (`finance.chargeMeterLine({ former })`).
 *  3. Idempotent parcali tahakkuk: daire basina `MDP_<periodId>_<unitId>`. Islem yarida kesilirse
 *     ayni onay komutu yalnizca eksik daireleri yazar; tamamlaninca ozet bildirim (outbox), sayac
 *     son onayli endeks / tuketim imleci ve donem `posted`.
 *  4. Kurus mutabakat kilidi: yazimdan once (ve her devamda) satir toplami = fatura tutari.
 */
import type { AuditDraft } from '../audit/log.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { type LiableParty, type Unit, toKurus } from '../core/types.js';
import { asObject, assertId, reqString } from '../core/validation.js';
import { type ClosureRepository, type CariClosure, closureRepository } from '../finance/closures.js';
import { liablePartyFor, occupancyOn } from '../finance/occupancy.js';
import { type FinanceRepository, financeRepository } from '../finance/repository.js';
import type { FinanceService } from '../finance/service.js';
import { mainReceivableId } from '../finance/types.js';
import { type MembershipRepository, membershipRepository } from '../memberships/repository.js';
import type { OwnershipReader } from '../ownership/reader.js';
import { type MeterContext, fingerprint } from './common.js';
import { assertDistributionInvariants, calculateDistribution } from './engine/distribute.js';
import { distributionHash } from './engine/hash.js';
import type { DistributionInput, DistributionResult, Segment } from './engine/types.js';
import { MeterError } from './errors.js';
import { lockProblems } from './expenseLocks.js';
import { buildReadingSheet, unitInScope } from './readings.js';
import { type MeterRepository, type MeterWrite, meterKeys, meterPrefixes, meterRepository } from './repository.js';
import type { LineLiability, LineMeterCursor, Meter, MeterLine, MeterPeriod, PeriodCalc, RecentConsumption, TemplateCategory } from './types.js';

export type MeterPostingServiceDeps = {
  repository: MeterRepository;
  core: Pick<CoreRepository, 'listUnits'>;
  memberships: Pick<MembershipRepository, 'list'>;
  closures: Pick<ClosureRepository, 'list'>;
  financeRepo: Pick<FinanceRepository, 'getAccount'>;
  ownership?: Pick<OwnershipReader, 'ownerSplitOn'>;
  finance: Pick<FinanceService, 'chargeMeterLine' | 'recordDuesBatchSummary'>;
  now: () => Date;
};

/** Atomik yazim basina kayit (denetim payi birakilir). */
const CHUNK = 90;
/** Toplu tahakkuk siniri (karar 8; mevcut `MAX_BULK_UNITS` ile ayni). */
export const MAX_POSTING_UNITS = 500;

const CATEGORY_LABEL: Record<TemplateCategory, string> = { heating: 'Isınma', hot_water: 'Sıcak su', cold_water: 'Su' };

export type Blocker = { code: string; message: string; unitId?: string; meterId?: string };

type PlannedLine = Omit<MeterLine, 'PK' | 'SK' | 'entityType' | 'apartmentId' | 'periodId' | 'status' | 'version' | 'calcHash'>;

export type PostingPlan =
  | { ok: false; blockers: Blocker[]; warnings: string[] }
  | {
      ok: true;
      calcHash: string;
      description: string;
      result: Extract<DistributionResult, { ok: true }>;
      lines: PlannedLine[];
      warnings: string[];
    };

/** Kural 4: satir tutarlari fatura tutarina kurusu kurusuna esit mi? Degilse yazim yapilmaz. */
export function assertReconciled(totalAmount: number, lines: readonly Pick<MeterLine, 'unitId' | 'amount' | 'commonAmount' | 'consumptionAmount' | 'liability'>[]): void {
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  if (!Number.isSafeInteger(totalAmount) || sum !== totalAmount) {
    throw new MeterError('unprocessable', `Kuruş mutabakatı tutmadı: satırlar ${sum}, fatura ${totalAmount}; yazım yapılmadı`);
  }
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amount) || l.amount < 0 || l.commonAmount + l.consumptionAmount !== l.amount) {
      throw new MeterError('unprocessable', `Kuruş mutabakatı tutmadı: ${l.unitId} satırı tutarsız`);
    }
    if (l.amount > 0 && l.liability.kind === 'none') throw new MeterError('unprocessable', `Kuruş mutabakatı tutmadı: ${l.unitId} borçlusuz`);
  }
}

export function createMeterPostingService(overrides: Partial<MeterPostingServiceDeps> & Pick<MeterPostingServiceDeps, 'finance'>) {
  const deps: MeterPostingServiceDeps = {
    repository: meterRepository,
    core: coreRepository,
    memberships: membershipRepository,
    closures: closureRepository,
    financeRepo: financeRepository,
    now: () => new Date(),
    ...overrides,
  };
  const repo = deps.repository;
  const stamp = () => deps.now().toISOString();

  async function loadPeriod(ctx: MeterContext, periodId: string): Promise<MeterPeriod> {
    assertId(periodId, 'periodId');
    const p = await repo.get<MeterPeriod>(meterKeys.period(ctx.apartmentId, periodId));
    if (!p) throw new MeterError('not_found', 'Dağıtım dönemi bulunamadı');
    return p;
  }

  async function chunked(writes: MeterWrite[], audits: AuditDraft[] = []) {
    for (let i = 0; i < writes.length; i += CHUNK) {
      const last = i + CHUNK >= writes.length;
      await repo.write(writes.slice(i, i + CHUNK), last ? audits : []);
    }
  }

  // -------------------------------------------------------------------------
  // Borclu cozumleme (kural 2)
  // -------------------------------------------------------------------------

  async function liabilityResolver(ctx: MeterContext, period: MeterPeriod) {
    const [members, closures] = await Promise.all([deps.memberships.list(ctx.apartmentId), deps.closures.list(ctx.apartmentId)]);
    const mine = members.filter((m) => m.apartmentId === ctx.apartmentId);
    const date = period.accrualDate;
    const requested = period.template.liableParty;

    return async (unitId: string): Promise<LineLiability | Blocker> => {
      const target = requested === 'occupant' ? liablePartyFor('occupant', occupancyOn(mine, unitId, date)) : { party: 'owner' as LiableParty, vacant: false };
      const mainId = mainReceivableId(unitId, target.party);
      const main = await deps.financeRepo.getAccount(ctx.apartmentId, mainId);
      if (main?.closedThrough && main.closedThrough >= date) {
        // Donem sonundaki sorumlunun carisi tasinma kapamasiyla kapatilmis: o kapamanin ayrilan carisi.
        const closure = closures
          .filter((c: CariClosure) => c.status === 'completed' && c.unitId === unitId && c.party === target.party && c.sourceAccountId === mainId && c.moveOutDate >= date)
          .sort((a, b) => a.moveOutDate.localeCompare(b.moveOutDate))[0];
        if (!closure) {
          return { code: 'closed_account', unitId, message: `Daire carisi ${main.closedThrough} tarihine kadar kapatılmış ve ilgili kapama bulunamadı` };
        }
        return {
          party: target.party,
          vacant: target.vacant,
          kind: 'former',
          accountId: `${mainId}-c${closure.closureId}`,
          former: { closureId: closure.closureId, sourceAccountId: mainId, userIds: closure.userIds, periodEnd: closure.moveOutDate },
        };
      }
      if (target.party === 'owner' && deps.ownership) {
        const owners = await deps.ownership.ownerSplitOn(ctx.apartmentId, unitId, date);
        if (owners?.length) return { party: 'owner', vacant: target.vacant, kind: 'split' };
      }
      return { party: target.party, vacant: target.vacant, kind: 'main', accountId: mainId };
    };
  }

  // -------------------------------------------------------------------------
  // Hesap (onizleme ve onay ayni fonksiyonu kullanir)
  // -------------------------------------------------------------------------

  async function computePlan(ctx: MeterContext, period: MeterPeriod): Promise<PostingPlan> {
    const blockers: Blocker[] = [];
    if (period.totalAmount === undefined) blockers.push({ code: 'missing_total', message: 'Fatura tutarı (totalAmount) girilmemiş' });
    // 2.3-5a: bagli faturalarin kilidi bu donemde olmali (cift dagitim yok).
    for (const x of await lockProblems(repo, ctx.apartmentId, period.periodId, period.expenseIds)) {
      blockers.push({ code: 'expense_lock', message: `Fatura ${x.expenseId} bu dönem adına kilitli değil${x.periodId ? ` (${x.periodId} dönemine bağlı)` : ''}` });
    }

    const sheet = await buildReadingSheet(repo, deps.core, ctx.apartmentId, period);
    for (const row of sheet.rows) {
      if (!row.inScope || (row.status !== 'missing' && row.status !== 'error')) continue;
      blockers.push({ code: row.error?.code ?? row.status, message: row.error?.message ?? 'Okuma hatası', unitId: row.unitId, meterId: row.meterId });
    }

    const units: Unit[] = (await deps.core.listUnits(ctx.apartmentId))
      .filter((u) => unitInScope(u, period.template.scope, period.endDate))
      .sort((a, b) => a.unitId.localeCompare(b.unitId));
    if (units.length > MAX_POSTING_UNITS) blockers.push({ code: 'too_many_units', message: `Tek dönemde en fazla ${MAX_POSTING_UNITS} bağımsız bölüm` });
    const inScope = new Set(units.map((u) => u.unitId));
    const segments: Segment[] = [...sheet.segByMeter.values()].filter((s) => inScope.has(s.unitId));
    const warnings = sheet.summary.warnings.map((w) => w.code);
    if (blockers.length) return { ok: false, blockers, warnings };

    const input: DistributionInput = {
      totalAmount: period.totalAmount as number,
      template: { commonShareBps: period.template.commonShareBps, commonKey: period.template.commonKey, meterKind: period.meterKind },
      units: units.map((u) => ({ unitId: u.unitId, grossAreaTenthsM2: u.grossAreaTenthsM2, ...(u.landShare ? { landShare: u.landShare } : {}) })),
      segments,
    };
    const result = calculateDistribution(input);
    if (!result.ok) {
      return { ok: false, blockers: result.errors.map((e) => ({ code: e.code, message: e.message, unitId: e.unitId, meterId: e.meterId })), warnings: [...warnings, ...result.warnings.map((w) => w.code)] };
    }
    assertDistributionInvariants(result);

    const resolve = await liabilityResolver(ctx, period);
    const unitById = new Map(units.map((u) => [u.unitId, u]));
    const lines: PlannedLine[] = [];
    for (const line of result.lines) {
      let liability: LineLiability = { party: period.template.liableParty, vacant: false, kind: 'none' };
      if (line.amount > 0) {
        const r = await resolve(line.unitId);
        if ('code' in r) {
          blockers.push(r);
          continue;
        }
        liability = r;
      }
      const meters: LineMeterCursor[] = line.segments.map((s) => {
        const seg = sheet.segByMeter.get(s.meterId) as Segment;
        const m = sheet.meterById.get(s.meterId) as Meter;
        return {
          meterId: s.meterId,
          endIndex: s.endIndex,
          endDate: seg.endDate,
          delta: s.delta,
          days: seg.days,
          ...(m.lastReading ? { prevLastReading: m.lastReading } : {}),
          ...(m.recentConsumption ? { prevRecentConsumption: m.recentConsumption } : {}),
        };
      });
      lines.push({
        unitId: line.unitId,
        ...(unitById.get(line.unitId)?.number ? { unitNumber: unitById.get(line.unitId)?.number } : {}),
        hasMeter: line.hasMeter,
        estimated: line.estimated,
        consumption: line.consumption,
        consumptionWeight: line.consumptionWeight.toString(),
        commonWeight: line.commonWeight.toString(),
        commonAmount: line.commonAmount,
        consumptionAmount: line.consumptionAmount,
        amount: line.amount,
        liability,
        meters,
      });
    }
    if (blockers.length) return { ok: false, blockers, warnings };

    const description = `${CATEGORY_LABEL[period.template.category]} — ${period.name}`.slice(0, 200);
    const calcHash = fingerprint({
      v: 1,
      distribution: distributionHash(input, result),
      accrualDate: period.accrualDate,
      dueDate: period.dueDate,
      description,
      liabilities: lines.map((l) => [l.unitId, l.liability.party, l.liability.vacant, l.liability.kind, l.liability.accountId ?? null]),
    });
    return { ok: true, calcHash, description, result, lines, warnings: [...warnings, ...result.warnings.map((w) => w.code)] };
  }

  const calcOf = (ctx: MeterContext, plan: Extract<PostingPlan, { ok: true }>): PeriodCalc => ({
    hash: plan.calcHash,
    calculatedAt: stamp(),
    calculatedBy: ctx.userId,
    totalAmount: plan.result.totals.totalAmount,
    commonPool: plan.result.totals.commonPool,
    consumptionPool: plan.result.totals.consumptionPool,
    fallbackToCommon: plan.result.totals.fallbackToCommon,
    totalConsumption: plan.result.totals.totalConsumption,
    unitCount: plan.lines.length,
    chargeCount: plan.lines.filter((l) => l.amount > 0).length,
    warningCodes: [...new Set(plan.warnings)],
  });

  /**
   * Onizleme: dagitim cetveli, borclular ve `calcHash`. Donem taslaksa hesap ozeti donem kaydina
   * yazilir (`calculated`); okuma / tutar degisikligi donemi yeniden `draft` yapar.
   */
  async function calculate(ctx: MeterContext, periodId: string) {
    const period = await loadPeriod(ctx, periodId);
    if (period.status !== 'draft' && period.status !== 'calculated') {
      throw new MeterError('unprocessable', 'Yalnızca taslak dönem hesaplanabilir; onaylı dönemin satırları için /lines kullanın');
    }
    const plan = await computePlan(ctx, period);
    if (!plan.ok) return { ok: false as const, period, blockers: plan.blockers, warnings: plan.warnings };
    const calc = calcOf(ctx, plan);
    const next: MeterPeriod = { ...period, status: 'calculated', calc, updatedAt: stamp(), updatedBy: ctx.userId, version: period.version + 1 };
    await repo.write([{ op: 'replace', item: next, expectedVersion: period.version }], []);
    return {
      ok: true as const,
      period: next,
      calcHash: plan.calcHash,
      description: plan.description,
      totals: { ...calc, totalConsumptionWeight: plan.result.totals.totalConsumptionWeight.toString() },
      lines: plan.lines,
      warnings: plan.warnings,
    };
  }

  // -------------------------------------------------------------------------
  // Onay + toplu tahakkuk (kural 1, 3, 4)
  // -------------------------------------------------------------------------

  async function approve(ctx: MeterContext, periodId: string, body: unknown) {
    const o = asObject(body);
    const calcHash = reqString(o, 'calcHash', 128);
    let period = await loadPeriod(ctx, periodId);

    if (period.status === 'posted') {
      if (period.calc?.hash !== calcHash) throw new MeterError('conflict', 'Dönem farklı bir hesapla onaylanmış');
      return { period, replayed: true, posted: period.chargeCount ?? 0, written: 0 };
    }
    if (period.status === 'posting') {
      if (period.calc?.hash !== calcHash) throw new MeterError('conflict', 'Onay devam ediyor; bu hesap özeti onaylanan hesapla uyuşmuyor');
      return resume(ctx, period);
    }
    if (period.status !== 'draft' && period.status !== 'calculated') throw new MeterError('unprocessable', 'Bu dönem onaylanamaz (iptal edilmiş veya geri alınmış)');

    const plan = await computePlan(ctx, period);
    if (!plan.ok) throw new MeterError('unprocessable', 'Dönem onaylanamaz; engelleyici hatalar var', { blockers: plan.blockers });
    if (plan.calcHash !== calcHash) {
      throw new MeterError('conflict', 'Önizlemeden sonra okumalar, şablon veya tutar değişti; yeniden önizleyin', { calcHash: plan.calcHash });
    }
    // Kural 4: yazim baslamadan once kurus mutabakati.
    assertReconciled(period.totalAmount as number, plan.lines);

    // 1) Dagitim satirlari (taslak; onaydan once yeniden uretilebilir -> kosulsuz yazim).
    await chunked(
      plan.lines.map((l): MeterWrite => {
        const line: MeterLine = {
          ...meterKeys.line(ctx.apartmentId, period.periodId, l.unitId),
          entityType: 'METER_LINE',
          apartmentId: ctx.apartmentId,
          periodId: period.periodId,
          ...l,
          calcHash: plan.calcHash,
          status: l.amount > 0 ? 'pending' : 'skipped',
          version: 1,
        };
        return { op: 'put', item: line };
      }),
    );
    // 2) Donem -> posting (surum kosullu: arada okuma girildiyse 409).
    const calc = calcOf(ctx, plan);
    const posting: MeterPeriod = {
      ...period,
      status: 'posting',
      calc,
      batchId: `mdp-${period.periodId}`,
      approvedAt: stamp(),
      approvedBy: ctx.userId,
      updatedAt: stamp(),
      updatedBy: ctx.userId,
      version: period.version + 1,
    };
    await repo.write(
      [{ op: 'replace', item: posting, expectedVersion: period.version }],
      [
        {
          apartmentId: ctx.apartmentId,
          action: 'meters.period_approve',
          target: { type: 'meter_period', id: period.periodId },
          actorId: ctx.userId,
          details: { calcHash, totalAmount: calc.totalAmount, commonPool: calc.commonPool, consumptionPool: calc.consumptionPool, chargeCount: calc.chargeCount },
        },
      ],
    );
    period = posting;
    return resume(ctx, period);
  }

  /** Onaylanan hesaba ait satirlar (onceki yarim denemelerden kalan eski satirlar haric). */
  async function frozenLines(ctx: MeterContext, period: MeterPeriod): Promise<MeterLine[]> {
    const hash = period.calc?.hash;
    return (await repo.list<MeterLine>(ctx.apartmentId, meterPrefixes.lines(period.periodId)))
      .filter((l) => !!hash && l.calcHash === hash)
      .sort((a, b) => a.unitId.localeCompare(b.unitId));
  }

  /** Onaylanan donemin tahakkukunu yazar / tamamlar. Tekrar cagrilmasi guvenlidir. */
  async function resume(ctx: MeterContext, period: MeterPeriod) {
    const lines = await frozenLines(ctx, period);
    // Kural 4: her devamda da (dondurulmus satirlarla) mutabakat.
    assertReconciled(period.totalAmount as number, lines);
    if (period.calc && lines.length !== period.calc.unitCount) {
      throw new MeterError('unprocessable', 'Dağıtım satırları eksik; dönem kaydıyla uyuşmuyor');
    }
    const batchId = period.batchId ?? `mdp-${period.periodId}`;
    const description = `${CATEGORY_LABEL[period.template.category]} — ${period.name}`.slice(0, 200);
    const reference = `METER_PERIOD:${period.periodId}`;

    // 3) Daire basina tahakkuk (idempotent: MDP_<periodId>_<unitId>). Yazilmis daire tekrar yazilmaz.
    let written = 0;
    let charged = 0;
    const updated: MeterWrite[] = [];
    const summary: { unitId: string; amount: number; transactionId: string; liableParty: LiableParty; coOwnerParts?: { userId: string; amount: number }[] }[] = [];
    for (const line of lines) {
      if (line.amount <= 0) continue;
      charged++;
      // Ayrilan cariye yazilan kalem dairenin bugunku sakinine bildirilmez (ozet disinda).
      const notify = line.liability.kind !== 'former';
      if (line.status === 'posted' && line.transactionId) {
        if (notify) summary.push({ unitId: line.unitId, amount: line.amount, transactionId: line.transactionId, liableParty: line.liability.party, ...(line.coOwnerParts ? { coOwnerParts: line.coOwnerParts } : {}) });
        continue;
      }
      const f = line.liability.former;
      const r = await deps.finance.chargeMeterLine(
        { apartmentId: ctx.apartmentId, userId: ctx.userId },
        {
          idemId: `MDP_${period.periodId}_${line.unitId}`,
          unitId: line.unitId,
          party: line.liability.party,
          vacant: line.liability.vacant,
          amount: line.amount,
          date: period.accrualDate,
          dueDate: period.dueDate,
          description,
          batchId,
          reference,
          ...(period.template.incomeAccountId ? { incomeAccountId: period.template.incomeAccountId } : {}),
          ...(line.liability.kind === 'former' && f
            ? { former: { closureId: f.closureId, sourceAccountId: f.sourceAccountId, userIds: f.userIds, periodEnd: f.periodEnd, unitNumber: line.unitNumber ?? line.unitId } }
            : {}),
        },
      );
      if (!r.replayed) written++;
      if (notify) summary.push({ unitId: line.unitId, amount: line.amount, transactionId: r.transactionId, liableParty: r.liableParty, ...(r.coOwnerParts ? { coOwnerParts: r.coOwnerParts } : {}) });
      const next: MeterLine = {
        ...line,
        status: 'posted',
        transactionId: r.transactionId,
        accountIds: r.accountIds,
        ...(r.coOwnerParts ? { coOwnerParts: r.coOwnerParts } : {}),
        postedAt: stamp(),
        version: line.version + 1,
      };
      updated.push({ op: 'replace', item: next, expectedVersion: line.version });
    }
    await chunked(updated);

    // 4) Ozet bildirim (outbox; deterministik kimlik -> tekrar cagrida ikinci olay yok).
    await deps.finance.recordDuesBatchSummary(
      { apartmentId: ctx.apartmentId, userId: ctx.userId },
      {
        batchId,
        date: period.accrualDate,
        dueDate: period.dueDate,
        description,
        liableParty: period.template.liableParty,
        results: summary.map(({ coOwnerParts, ...x }) => ({
          ...x,
          amount: toKurus(x.amount),
          ...(coOwnerParts ? { coOwnerParts: coOwnerParts.map((c) => ({ userId: c.userId, amount: toKurus(c.amount) })) } : {}),
        })),
      },
    );

    // 5) Sayac imleci: son onayli endeks + son tuketimler (bu donem zaten yazildiysa atlanir).
    const meterWrites: MeterWrite[] = [];
    for (const line of lines) {
      for (const c of line.meters) {
        const m = await repo.get<Meter>(meterKeys.meter(ctx.apartmentId, c.meterId));
        if (!m || m.lastReading?.periodId === period.periodId) continue;
        const recent: RecentConsumption[] = [{ delta: c.delta, days: c.days, periodId: period.periodId }, ...(m.recentConsumption ?? [])].slice(0, 3);
        meterWrites.push({
          op: 'replace',
          item: { ...m, lastReading: { index: c.endIndex, date: c.endDate, periodId: period.periodId }, recentConsumption: recent, updatedAt: stamp(), updatedBy: ctx.userId, version: m.version + 1 },
          expectedVersion: m.version,
        });
      }
    }
    await chunked(meterWrites);

    // 6) Donem -> posted.
    const chargeCount = charged;
    const posted: MeterPeriod = { ...period, status: 'posted', postedAt: stamp(), chargeCount, updatedAt: stamp(), updatedBy: ctx.userId, version: period.version + 1 };
    await repo.write(
      [{ op: 'replace', item: posted, expectedVersion: period.version }],
      [
        {
          apartmentId: ctx.apartmentId,
          action: 'meters.period_posted',
          target: { type: 'meter_period', id: period.periodId },
          actorId: ctx.userId,
          details: { batchId, chargeCount, written, totalAmount: period.totalAmount },
        },
      ],
    );
    return { period: posted, replayed: false, posted: chargeCount, written };
  }

  async function listLines(ctx: MeterContext, periodId: string) {
    const period = await loadPeriod(ctx, periodId);
    const lines = await frozenLines(ctx, period);
    return { period, lines, total: lines.reduce((s, l) => s + l.amount, 0) };
  }

  return { calculate, approve, listLines, computePlan };
}

export type MeterPostingService = ReturnType<typeof createMeterPostingService>;
