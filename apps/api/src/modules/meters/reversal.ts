/**
 * Finans 2.3-4 - Onayli sayac doneminin toplu geri alinmasi ve duzeltilmis donem.
 *
 * Kurallar:
 *  1. Ters kayit ve zincir korumasi: her kalem mevcut `reverseTransaction` ile ters kaydedilir
 *     (taksit plani / avans mahsubu / tasinma kapamasi engelleri aynen gecerli; onizleme ayni
 *     kurallari `reversalStatus` ile kontrol eder). Ayni sayac turunde daha yeni onayli / onaylanan
 *     bir donem varsa (veya sayac imleci ilerlemisse) once o donem geri alinmalidir.
 *  2. Devam: geri alma `key` (idempotencyKey) ile baslar; neden ve ters kayit tarihi donem kaydinda
 *     sabitlenir. Yarida kesilirse ayni anahtarla kaldigi yerden devam eder (`REV_<islem>`
 *     idempotency). Tamamlaninca sayac imleçleri onceki onayli doneme geri yuklenir.
 *  3. Sessiz varsayilan: bildirim yalnizca `notify: true` ile (outbox, METER_PERIOD_REVERSED).
 *  4. Duzeltilmis donem: geri alinan donemden tek komutla yeni taslak; okumalar kopyalanir.
 */
import { randomUUID } from 'node:crypto';
import type { AuditDraft } from '../audit/log.js';
import { mapLimit } from '../core/concurrency.js';
import { type LiableParty, toKurus } from '../core/types.js';
import { ValidationError, asObject, assertId, optBool, optString, reqString } from '../core/validation.js';
import { type DomainEvent, buildEvent } from '../../events/publisher.js';
import { type FinanceRepository, financeRepository } from '../finance/repository.js';
import type { FinanceService } from '../finance/service.js';
import { type MeterContext, istanbulDate } from './common.js';
import { MeterError } from './errors.js';
import { planExpenseLocks } from './expenseLocks.js';
import { withTransientRetry } from './posting.js';
import { type MeterRepository, type MeterWrite, meterKeys, meterPrefixes, meterRepository } from './repository.js';
import type { Meter, MeterLine, MeterPeriod, MeterReading, PeriodReversal } from './types.js';

export type MeterReversalServiceDeps = {
  repository: MeterRepository;
  finance: Pick<FinanceService, 'reverseTransaction' | 'reversalStatus'>;
  financeRepo: Pick<FinanceRepository, 'recordEvents'>;
  now: () => Date;
  newId: () => string;
};

const CHUNK = 90;
const IDEM_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const REASON_MAX = 300;
/** Sayac okumalari / imlec geri yuklemesi icin eszamanli okuma (sirali okuma 1.200 sayacta ~12 sn). */
const READ_CONCURRENCY = 16;

export type ReversalBlocker = { code: string; message: string; unitId?: string; transactionId?: string; periodId?: string };

export function createMeterReversalService(overrides: Partial<MeterReversalServiceDeps> & Pick<MeterReversalServiceDeps, 'finance'>) {
  const deps: MeterReversalServiceDeps = {
    repository: meterRepository,
    financeRepo: financeRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.repository;
  const stamp = () => deps.now().toISOString();
  const fctx = (ctx: MeterContext) => ({ apartmentId: ctx.apartmentId, userId: ctx.userId });

  async function loadPeriod(ctx: MeterContext, periodId: string): Promise<MeterPeriod> {
    assertId(periodId, 'periodId');
    const p = await repo.get<MeterPeriod>(meterKeys.period(ctx.apartmentId, periodId));
    if (!p) throw new MeterError('not_found', 'Dağıtım dönemi bulunamadı');
    return p;
  }

  async function chunked(writes: MeterWrite[], audits: AuditDraft[] = []) {
    for (let i = 0; i < writes.length; i += CHUNK) {
      await repo.write(writes.slice(i, i + CHUNK), i + CHUNK >= writes.length ? audits : []);
    }
  }

  /** Onaylanan hesaba ait, kalemi yazilmis satirlar. */
  async function chargedLines(ctx: MeterContext, period: MeterPeriod): Promise<MeterLine[]> {
    const hash = period.calc?.hash;
    return (await repo.list<MeterLine>(ctx.apartmentId, meterPrefixes.lines(period.periodId)))
      .filter((l) => !!hash && l.calcHash === hash && !!l.transactionId)
      .sort((a, b) => a.unitId.localeCompare(b.unitId));
  }

  const description = (p: MeterPeriod) => {
    const label = p.template.category === 'heating' ? 'Isınma' : p.template.category === 'hot_water' ? 'Sıcak su' : 'Su';
    return `${label} — ${p.name}`.slice(0, 200);
  };

  // -------------------------------------------------------------------------
  // Onizleme (kural 1)
  // -------------------------------------------------------------------------

  async function blockersOf(ctx: MeterContext, period: MeterPeriod, lines: readonly MeterLine[]) {
    const blockers: ReversalBlocker[] = [];
    // Zincir: ayni sayac turunde daha yeni onayli / suren donem.
    const periods = await repo.list<MeterPeriod>(ctx.apartmentId, meterPrefixes.periods);
    for (const other of periods) {
      if (other.periodId === period.periodId || other.meterKind !== period.meterKind) continue;
      const newerPosted = (other.status === 'posted' || other.status === 'reversing') && other.endDate > period.endDate;
      if (newerPosted || other.status === 'posting') {
        blockers.push({
          code: 'newer_period',
          periodId: other.periodId,
          message: `Aynı sayaçların daha yeni "${other.name}" dönemi ${other.status === 'posting' ? 'onaylanıyor' : 'onaylı'}; önce o dönem geri alınmalı`,
        });
      }
    }
    // Sayac imleci bu donemden ileri gitmisse (yalnizca baslamamis geri almada).
    if (period.status === 'posted') {
      const seen = new Set<string>();
      const refs: { unitId: string; meterId: string }[] = [];
      for (const line of lines) {
        for (const c of line.meters) {
          if (seen.has(c.meterId)) continue;
          seen.add(c.meterId);
          refs.push({ unitId: line.unitId, meterId: c.meterId });
        }
      }
      const meters = await mapLimit(refs, READ_CONCURRENCY, (r) => repo.get<Meter>(meterKeys.meter(ctx.apartmentId, r.meterId)));
      refs.forEach((r, i) => {
        const m = meters[i];
        if (m && m.lastReading?.periodId !== period.periodId) {
          blockers.push({ code: 'meter_advanced', unitId: r.unitId, message: `"${m.label}" sayacının son onaylı okuması başka bir döneme ait; önce o dönem geri alınmalı` });
        }
      });
    }
    // Defter engelleri (plan, mahsup, tasinma kapamasi) - reverseTransaction ile ayni kurallar.
    const txIds = lines.map((l) => l.transactionId as string);
    const status = txIds.length ? await deps.finance.reversalStatus(fctx(ctx), txIds) : [];
    const byTx = new Map(status.map((s) => [s.transactionId, s]));
    for (const line of lines) {
      const s = byTx.get(line.transactionId as string);
      if (s?.state === 'blocked' || s?.state === 'missing') {
        blockers.push({ code: s.code ?? s.state, unitId: line.unitId, transactionId: line.transactionId, message: s.message ?? 'Ters kayıt yapılamaz' });
      }
    }
    return { blockers, status: byTx };
  }

  async function preview(ctx: MeterContext, periodId: string) {
    const period = await loadPeriod(ctx, periodId);
    if (period.status !== 'posted' && period.status !== 'reversing') {
      throw new MeterError('unprocessable', 'Yalnızca onaylı dönem geri alınabilir');
    }
    const lines = await chargedLines(ctx, period);
    const { blockers, status } = await blockersOf(ctx, period, lines);
    const items = lines.map((l) => {
      const s = status.get(l.transactionId as string);
      return {
        unitId: l.unitId,
        unitNumber: l.unitNumber,
        amount: l.amount,
        transactionId: l.transactionId,
        liability: l.liability,
        state: s?.state ?? 'missing',
        ...(s?.lateFeeAfter ? { lateFeeAfter: s.lateFeeAfter } : {}),
      };
    });
    return {
      period,
      canReverse: blockers.length === 0,
      blockers,
      items,
      total: items.reduce((s, i) => s + i.amount, 0),
      // Karar 4: kesinlesmis gecikme tazminati otomatik geri alinmaz; yonetici ayrica duzeltir.
      lateFeeWarnings: items.filter((i) => i.lateFeeAfter).map((i) => ({ unitId: i.unitId, transactionIds: i.lateFeeAfter })),
    };
  }

  // -------------------------------------------------------------------------
  // Geri alma (kural 1-3)
  // -------------------------------------------------------------------------

  /** Geri alma komutunun dogrulanmis govdesi (senkron yol ve arka plan isi ayni kurallar). */
  function parseReverseBody(body: unknown): { key: string; reason?: string; notify: boolean } {
    const o = asObject(body);
    const key = o.idempotencyKey;
    if (typeof key !== 'string' || !IDEM_KEY.test(key)) throw new ValidationError('idempotencyKey 8-64 karakter (harf, rakam, - _) olmalı', 'idempotencyKey');
    const reason = o.reason === undefined ? undefined : reqString(o, 'reason', REASON_MAX);
    return { key, ...(reason !== undefined ? { reason } : {}), notify: optBool(o, 'notify') ?? false };
  }

  /**
   * Geri almanin yazim oncesi asamasi: engeller (zincir, sayac imleci, defter) kontrol edilir ve
   * donem `reversing` olur (neden / tarih / anahtar donem kaydinda sabitlenir). Tekrar cagrilmasi
   * guvenlidir: ayni anahtarla `reversing` donem aynen, `reversed` donem `reversed` doner.
   */
  async function beginReversal(ctx: MeterContext, periodId: string, body: unknown): Promise<{ kind: 'reversing' | 'reversed'; period: MeterPeriod }> {
    const p = parseReverseBody(body);
    const period = await loadPeriod(ctx, periodId);

    if (period.status === 'reversed') {
      if (period.reversal?.key !== p.key) throw new MeterError('conflict', 'Dönem başka bir geri alma işlemiyle geri alınmış');
      return { kind: 'reversed', period };
    }
    if (period.status === 'reversing') {
      if (period.reversal?.key !== p.key) throw new MeterError('conflict', 'Bu dönem için başka bir geri alma sürüyor; aynı anahtarla devam edin');
      return { kind: 'reversing', period };
    }
    if (period.status !== 'posted') throw new MeterError('unprocessable', 'Yalnızca onaylı dönem geri alınabilir');

    if (p.reason === undefined) throw new ValidationError('reason zorunludur', 'reason');
    const lines = await chargedLines(ctx, period);
    const { blockers } = await blockersOf(ctx, period, lines);
    if (blockers.length) throw new MeterError('unprocessable', 'Dönem geri alınamaz; engelleri kaldırın', { blockers });

    const reversal: PeriodReversal = {
      key: p.key,
      reason: p.reason,
      date: istanbulDate(deps.now()),
      notify: p.notify,
      batchId: `mdr-${period.periodId}`,
      startedAt: stamp(),
      startedBy: ctx.userId,
    };
    const next: MeterPeriod = { ...period, status: 'reversing', reversal, updatedAt: stamp(), updatedBy: ctx.userId, version: period.version + 1 };
    await repo.write(
      [{ op: 'replace', item: next, expectedVersion: period.version }],
      [
        {
          apartmentId: ctx.apartmentId,
          action: 'meters.period_reverse',
          target: { type: 'meter_period', id: period.periodId },
          actorId: ctx.userId,
          reason: p.reason,
          details: { key: p.key, notify: p.notify, chargeCount: lines.length, total: lines.reduce((s, l) => s + l.amount, 0) },
        },
      ],
    );
    return { kind: 'reversing', period: next };
  }

  async function reverse(ctx: MeterContext, periodId: string, body: unknown) {
    const begun = await beginReversal(ctx, periodId, body);
    if (begun.kind === 'reversed') {
      const rev = begun.period.reversal as PeriodReversal;
      return { period: begun.period, replayed: true, reversed: rev.reversedCount ?? 0, written: 0, notified: rev.notify };
    }
    return run(ctx, begun.period);
  }

  /**
   * P1-b: parcali ters kayit. Bekleyen (`reversed` olmayan) kalemlerden en fazla `maxUnits` tanesi
   * `REV_<islem>` anahtariyla ters kaydedilir; satir durumu her alt parcadan sonra yazilir (kesintide
   * en fazla bir alt parca yeniden oynatilir; ters kayit idempotent). Ayni adim tekrar cagrilabilir.
   */
  async function reverseStep(
    ctx: MeterContext,
    period: MeterPeriod,
    opts: { maxUnits: number; batchSize?: number; concurrency?: number; shouldStop?: () => boolean },
  ): Promise<{ processed: number; written: number; pending: number; total: number; reversed: number }> {
    if (period.status !== 'reversing' || !period.reversal) throw new MeterError('unprocessable', 'Dönem geri alma aşamasında değil');
    const rev = period.reversal;
    const lines = await chargedLines(ctx, period);
    const pendingLines = lines.filter((l) => l.status !== 'reversed');
    const todo = pendingLines.slice(0, Math.max(0, opts.maxUnits));
    const batchSize = Math.max(1, opts.batchSize ?? 25);
    const reason = `Sayaç dönemi geri alındı (${period.name}): ${rev.reason}`.slice(0, 300);
    let processed = 0;
    let written = 0;
    for (let i = 0; i < todo.length; i += batchSize) {
      if (i > 0 && opts.shouldStop?.()) break;
      const slice = todo.slice(i, i + batchSize);
      const updated = await mapLimit(slice, opts.concurrency ?? 1, async (line): Promise<MeterWrite> => {
        // Neden ve tarih donemde sabit: devam / tekrar aynen replay olur (REV_<islem>).
        const r = await withTransientRetry(() => deps.finance.reverseTransaction(fctx(ctx), line.transactionId as string, { reason, date: rev.date }));
        if (!r.replayed) written++;
        return {
          op: 'replace',
          item: { ...line, status: 'reversed', reversalTransactionId: r.transaction.transactionId, version: line.version + 1 },
          expectedVersion: line.version,
        };
      });
      await chunked(updated);
      processed += slice.length;
    }
    return { processed, written, pending: pendingLines.length - processed, total: lines.length, reversed: lines.length - pendingLines.length + processed };
  }

  /** Imlec geri yukleme yazimi (bu donemi gosteren sayaclar onceki onayli okumaya / tuketime). */
  async function restoreMeters(ctx: MeterContext, period: MeterPeriod, cursors: readonly MeterLine['meters'][number][]): Promise<MeterWrite[]> {
    const seen = new Set<string>();
    const unique = cursors.filter((c) => (seen.has(c.meterId) ? false : (seen.add(c.meterId), true)));
    const meters = await mapLimit(unique, READ_CONCURRENCY, (c) => repo.get<Meter>(meterKeys.meter(ctx.apartmentId, c.meterId)));
    const writes: MeterWrite[] = [];
    unique.forEach((c, i) => {
      const m = meters[i];
      if (!m || m.lastReading?.periodId !== period.periodId) return;
      const restored: Meter = { ...m, updatedAt: stamp(), updatedBy: ctx.userId, version: m.version + 1 };
      if (c.prevLastReading) restored.lastReading = c.prevLastReading;
      else delete restored.lastReading;
      if (c.prevRecentConsumption?.length) restored.recentConsumption = c.prevRecentConsumption;
      else delete restored.recentConsumption;
      writes.push({ op: 'replace', item: restored, expectedVersion: m.version });
    });
    return writes;
  }

  /**
   * Tum kalemler ters kaydedildikten sonra: sayac imlecleri, istege bagli bildirim, faturalarin
   * serbest birakilmasi ve donem `reversed`. Tekrar cagrilmasi guvenlidir.
   */
  async function finalizeReversal(ctx: MeterContext, period: MeterPeriod, info: { written?: number } = {}) {
    const rev = period.reversal as PeriodReversal;
    if (period.status === 'reversed') return { period, reversed: rev.reversedCount ?? 0, written: 0, notified: rev.notify };
    if (period.status !== 'reversing') throw new MeterError('unprocessable', 'Dönem geri alma aşamasında değil');
    const lines = await chargedLines(ctx, period);
    if (lines.some((l) => l.status !== 'reversed')) throw new MeterError('unprocessable', 'Geri alma tamamlanmadı; bekleyen kalemler var');
    const written = info.written ?? 0;

    // 2) Sayac imleci (kalemsiz - tutari 0 - satirlardaki sayaclar dahil).
    const zero = (await repo.list<MeterLine>(ctx.apartmentId, meterPrefixes.lines(period.periodId))).filter((l) => l.calcHash === period.calc?.hash && !l.transactionId);
    await chunked(await restoreMeters(ctx, period, [...lines, ...zero].flatMap((l) => l.meters)));

    // 3) Istege bagli bildirim (karar 6: varsayilan sessiz). Ayrilan cari kalemleri haric.
    if (rev.notify) {
      const items: { unitId: string; amount: ReturnType<typeof toKurus>; transactionId: string; liableParty: LiableParty; userId?: string }[] = [];
      for (const l of lines) {
        if (l.liability.kind === 'former' || !l.reversalTransactionId) continue;
        if (l.coOwnerParts?.length) {
          for (const x of l.coOwnerParts) items.push({ unitId: l.unitId, amount: toKurus(x.amount), transactionId: l.reversalTransactionId, liableParty: l.liability.party, userId: x.userId });
        } else {
          items.push({ unitId: l.unitId, amount: toKurus(l.amount), transactionId: l.reversalTransactionId, liableParty: l.liability.party });
        }
      }
      if (items.length) {
        const event = buildEvent(
          {
            eventId: `METER_PERIOD_REVERSED:${period.periodId}:${rev.key}`,
            type: 'METER_PERIOD_REVERSED',
            apartmentId: ctx.apartmentId,
            actorId: ctx.userId,
            payload: {
              periodId: period.periodId,
              batchId: rev.batchId,
              description: description(period),
              totalAmount: toKurus(items.reduce((s, i) => s + i.amount, 0)),
              items,
            },
          },
          deps.now,
        ) as DomainEvent;
        await deps.financeRepo.recordEvents(ctx.apartmentId, [event]);
      }
    }

    // 4) Donem -> reversed.
    const reversedCount = lines.length;
    const done: MeterPeriod = {
      ...period,
      status: 'reversed',
      reversal: { ...rev, completedAt: stamp(), reversedCount },
      updatedAt: stamp(),
      updatedBy: ctx.userId,
      version: period.version + 1,
    };
    // 2.3-5a: faturalar serbest (duzeltilmis donem yeniden baglar).
    const releases = await planExpenseLocks(repo, { apartmentId: ctx.apartmentId, periodId: period.periodId, acquire: [], release: period.expenseIds, actorId: ctx.userId, at: stamp() });
    await repo.write(
      [{ op: 'replace', item: done, expectedVersion: period.version }, ...releases],
      [
        {
          apartmentId: ctx.apartmentId,
          action: 'meters.period_reversed',
          target: { type: 'meter_period', id: period.periodId },
          actorId: ctx.userId,
          details: { key: rev.key, reversedCount, written, notify: rev.notify },
        },
      ],
    );
    return { period: done, reversed: reversedCount, written, notified: rev.notify };
  }

  /** Geri almayi yurutur / tamamlar (senkron yol). Tekrar cagrilmasi guvenlidir. */
  async function run(ctx: MeterContext, period: MeterPeriod) {
    let written = 0;
    for (;;) {
      const step = await reverseStep(ctx, period, { maxUnits: Number.POSITIVE_INFINITY });
      written += step.written;
      if (step.pending === 0) break;
    }
    const done = await finalizeReversal(ctx, period, { written });
    return { period: done.period, replayed: false, reversed: done.reversed, written, notified: done.notified };
  }

  /** Arka plan isi icin: donemi (guncel surumuyla) okur ve geri alinacak kalem sayisi. */
  const getPeriod = loadPeriod;
  async function chargedCount(ctx: MeterContext, period: MeterPeriod): Promise<number> {
    return (await chargedLines(ctx, period)).length;
  }

  // -------------------------------------------------------------------------
  // Duzeltilmis donem (kural 4)
  // -------------------------------------------------------------------------

  async function copyReadings(ctx: MeterContext, from: MeterPeriod, to: MeterPeriod, first: MeterWrite[], audits: AuditDraft[]) {
    const source = await repo.list<MeterReading>(ctx.apartmentId, meterPrefixes.readings(from.periodId));
    const existing = new Set((await repo.list<MeterReading>(ctx.apartmentId, meterPrefixes.readings(to.periodId))).map((r) => r.meterId));
    const copies: MeterWrite[] = source
      .filter((r) => !existing.has(r.meterId))
      .map((r) => {
        const { PK: _pk, SK: _sk, ...rest } = r;
        const copy: MeterReading = {
          ...rest,
          ...meterKeys.reading(ctx.apartmentId, to.periodId, r.meterId),
          periodId: to.periodId,
          copiedFromPeriodId: from.periodId,
          rev: 1,
          version: 1,
        };
        return { op: 'create', item: copy };
      });
    const room = CHUNK - first.length;
    if (first.length) await repo.write([...first, ...copies.slice(0, Math.max(room, 0))], audits);
    await chunked(copies.slice(first.length ? Math.max(room, 0) : 0));
    return copies.length;
  }

  async function createCorrection(ctx: MeterContext, periodId: string, body: unknown) {
    const o = body === undefined || body === null ? {} : asObject(body);
    const old = await loadPeriod(ctx, periodId);
    if (old.status !== 'reversed') throw new MeterError('unprocessable', 'Düzeltilmiş dönem yalnızca geri alınmış dönemden açılabilir');

    if (old.supersededByPeriodId) {
      // Tekrar: var olan duzeltme donemi; yarida kalan kopyalama tamamlanir (yonetici duzeltmeleri korunur).
      const existing = await loadPeriod(ctx, old.supersededByPeriodId);
      const copied = OPEN.includes(existing.status) ? await copyReadings(ctx, old, existing, [], []) : 0;
      return { period: existing, replayed: true, copied };
    }
    const name = (optString(o, 'name', 100) ?? `${old.name} (düzeltme)`).slice(0, 100);
    const periods = await repo.list<MeterPeriod>(ctx.apartmentId, meterPrefixes.periods);
    const clash = periods.find(
      (p) => p.periodId !== old.periodId && p.meterKind === old.meterKind && !['reversed', 'cancelled'].includes(p.status) && p.startDate <= old.endDate && old.startDate <= p.endDate,
    );
    if (clash) throw new MeterError('conflict', `Bu tarih aralığı "${clash.name}" dönemiyle çakışıyor`);

    const at = stamp();
    const newId = deps.newId();
    const correction: MeterPeriod = {
      ...meterKeys.period(ctx.apartmentId, newId),
      entityType: 'METER_PERIOD',
      periodId: newId,
      apartmentId: ctx.apartmentId,
      name,
      templateId: old.templateId,
      template: old.template,
      meterKind: old.meterKind,
      startDate: old.startDate,
      endDate: old.endDate,
      accrualDate: old.accrualDate,
      dueDate: old.dueDate,
      ...(old.totalAmount !== undefined ? { totalAmount: old.totalAmount } : {}),
      expenseIds: [...old.expenseIds],
      status: 'draft',
      supersedesPeriodId: old.periodId,
      createdAt: at,
      createdBy: ctx.userId,
      updatedAt: at,
      updatedBy: ctx.userId,
      version: 1,
    };
    const oldNext: MeterPeriod = { ...old, supersededByPeriodId: newId, updatedAt: at, updatedBy: ctx.userId, version: old.version + 1 };
    // Faturalar duzeltilmis doneme baglanir (geri almada serbest birakildi; baskasi aldiysa 409).
    const locks = await planExpenseLocks(repo, { apartmentId: ctx.apartmentId, periodId: newId, acquire: old.expenseIds, release: [], actorId: ctx.userId, at });
    const copied = await copyReadings(
      ctx,
      old,
      correction,
      [
        { op: 'create', item: correction },
        { op: 'replace', item: oldNext, expectedVersion: old.version },
        ...locks,
      ],
      [
        {
          apartmentId: ctx.apartmentId,
          action: 'meters.period_correction',
          target: { type: 'meter_period', id: newId },
          actorId: ctx.userId,
          details: { supersedesPeriodId: old.periodId, name },
        },
      ],
    );
    return { period: correction, replayed: false, copied };
  }

  return { preview, reverse, createCorrection, beginReversal, reverseStep, finalizeReversal, getPeriod, chargedCount, parseReverseBody };
}

const OPEN: readonly MeterPeriod['status'][] = ['draft', 'calculated'];

export type MeterReversalService = ReturnType<typeof createMeterReversalService>;
