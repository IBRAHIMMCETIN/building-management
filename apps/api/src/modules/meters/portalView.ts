/**
 * Finans 2.3-5a - Sakin portali: kendi dairesinin sayac tuketim gecmisi (bina / blok ortalamasiyla
 * karsilastirma) ve Sayac Dagitim Dokumu PDF'i.
 *
 * Yetki: sakin yalnizca uyesi oldugu dairenin, uyelik penceresine dusen (tahakkuk tarihi
 * `startDate..endDate`) ve gorebildigi tarafa (kiraci -> sakin; oturmayan malik -> malik) yazilmis
 * onayli donemlerini gorur. Geri alinmis donemler listelenmez (duzeltilmis donem listelenir).
 * Diger dairelerin verisi yalnizca ortalama olarak (daire kimligi olmadan) doner.
 */
import { createHash } from 'node:crypto';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import type { Unit } from '../core/types.js';
import { assertId } from '../core/validation.js';
import { contentDisposition, meterStatementKey } from '../documents/keys.js';
import { METER_STATEMENT_TEMPLATE_VERSION, type MeterStatementPdfData, renderMeterStatementPdf } from '../documents/meterStatementPdf.js';
import { type DocumentStore, URL_TTL_SECONDS, createDocumentStoreFromEnv } from '../documents/store.js';
import { type MembershipRepository, membershipRepository } from '../memberships/repository.js';
import { visibleParties } from '../portal/types.js';
import type { UnitMembership } from '../portal/types.js';
import { type MeterContext, formatIndex } from './common.js';
import { MeterError } from './errors.js';
import { type MeterRepository, meterKeys, meterPrefixes, meterRepository } from './repository.js';
import type { Meter, MeterLine, MeterPeriod, TemplateCategory } from './types.js';

export type MeterPortalServiceDeps = {
  repository: MeterRepository;
  memberships: Pick<MembershipRepository, 'list'>;
  core: Pick<CoreRepository, 'listUnits' | 'getSite' | 'listBlocks'>;
  store: DocumentStore | undefined;
  now: () => Date;
};

const CATEGORY_LABEL: Record<TemplateCategory, string> = { heating: 'Isınma', hot_water: 'Sıcak su', cold_water: 'Su' };
const KEY_LABEL = { area: 'Kullanım alanı (m²)', equal: 'Eşit', land_share: 'Arsa payı' } as const;
/** Gecmis listesinde en fazla donem. */
const MAX_HISTORY = 36;

const num = (s: string) => Number(s);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (x: number, digits = 3) => x.toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: digits });

export function createMeterPortalService(overrides: Partial<MeterPortalServiceDeps> = {}) {
  const deps: MeterPortalServiceDeps = {
    repository: meterRepository,
    memberships: membershipRepository,
    core: coreRepository,
    now: () => new Date(),
    ...overrides,
    store: 'store' in overrides ? overrides.store : createDocumentStoreFromEnv(),
  };
  const repo = deps.repository;

  /** Kullanicinin bu daireye ait uyelikleri (aktif veya tasinma kapamasiyla sona ermis). */
  async function membershipsOf(ctx: Pick<MeterContext, 'apartmentId' | 'userId'>, unitId: string): Promise<UnitMembership[]> {
    assertId(unitId, 'unitId');
    const list = (await deps.memberships.list(ctx.apartmentId, { unitId })).filter(
      (m) => m.apartmentId === ctx.apartmentId && m.userId === ctx.userId && m.unitId === unitId && (m.status === 'active' || !!m.endedByClosureId),
    );
    if (list.length === 0) throw new MeterError('forbidden', 'Bu bağımsız bölümün kaydını görüntüleme yetkiniz yok');
    return list;
  }

  /** Satir bu uyelerden birine gorunur mu? (tahakkuk tarihi uyelik penceresinde + taraf) */
  const visibleTo = (ms: readonly UnitMembership[], period: MeterPeriod, line: MeterLine) =>
    ms.some(
      (m) =>
        m.startDate <= period.accrualDate &&
        (!m.endDate || m.endDate >= period.accrualDate) &&
        visibleParties(m).includes(line.liability.party) &&
        (line.liability.kind !== 'former' || (line.liability.former?.userIds ?? []).includes(m.userId)),
    );

  const linesOf = async (apartmentId: string, p: MeterPeriod) =>
    (await repo.list<MeterLine>(apartmentId, meterPrefixes.lines(p.periodId))).filter((l) => l.calcHash === p.calc?.hash);

  function averages(lines: readonly MeterLine[], unit: Unit | undefined, units: ReadonlyMap<string, Unit>) {
    const metered = lines.filter((l) => l.hasMeter);
    const building = avg(metered.map((l) => num(l.consumption)));
    const sameBlock = unit ? metered.filter((l) => units.get(l.unitId)?.blockId === unit.blockId) : [];
    return { building, block: sameBlock.length ? avg(sameBlock.map((l) => num(l.consumption))) : undefined, meteredUnits: metered.length, blockUnits: sameBlock.length };
  }

  /** Sakinin tuketim gecmisi (yeniden eskiye), tur bazinda onceki donemle karsilastirma. */
  async function myConsumption(ctx: Pick<MeterContext, 'apartmentId' | 'userId'>, unitId: string) {
    const ms = await membershipsOf(ctx, unitId);
    const [periods, units, meters] = await Promise.all([
      repo.list<MeterPeriod>(ctx.apartmentId, meterPrefixes.periods),
      deps.core.listUnits(ctx.apartmentId),
      repo.list<Meter>(ctx.apartmentId, meterPrefixes.meters),
    ]);
    const unitById = new Map(units.map((u) => [u.unitId, u]));
    const meterById = new Map(meters.map((m) => [m.meterId, m]));
    const posted = periods.filter((p) => p.status === 'posted').sort((a, b) => b.endDate.localeCompare(a.endDate)).slice(0, MAX_HISTORY);

    const items = [];
    for (const p of posted) {
      const lines = await linesOf(ctx.apartmentId, p);
      const line = lines.find((l) => l.unitId === unitId);
      if (!line || !visibleTo(ms, p, line)) continue;
      const a = averages(lines, unitById.get(unitId), unitById);
      items.push({
        periodId: p.periodId,
        name: p.name,
        meterKind: p.meterKind,
        category: p.template.category,
        startDate: p.startDate,
        endDate: p.endDate,
        dueDate: p.dueDate,
        hasMeter: line.hasMeter,
        estimated: line.estimated,
        consumption: num(line.consumption),
        consumptionText: line.consumption,
        commonAmount: line.commonAmount,
        consumptionAmount: line.consumptionAmount,
        amount: line.amount,
        meters: line.meters.map((c) => {
          const m = meterById.get(c.meterId);
          const scale = m?.scale ?? 0;
          return { meterId: c.meterId, label: m?.label ?? c.meterId, endIndex: formatIndex(c.endIndex, scale), delta: formatIndex(c.delta, scale), endDate: c.endDate };
        }),
        buildingAverage: Math.round(a.building * 1000) / 1000,
        ...(a.block !== undefined ? { blockAverage: Math.round(a.block * 1000) / 1000 } : {}),
        meteredUnits: a.meteredUnits,
        supersedesPeriodId: p.supersedesPeriodId,
      });
    }
    // Ayni sayac turunde bir onceki doneme gore degisim.
    for (const [i, it] of items.entries()) {
      const prev = items.slice(i + 1).find((x) => x.meterKind === it.meterKind);
      if (!prev) continue;
      const diff = it.consumption - prev.consumption;
      Object.assign(it, {
        previous: {
          periodId: prev.periodId,
          consumption: prev.consumption,
          diff: Math.round(diff * 1000) / 1000,
          ...(prev.consumption > 0 ? { percent: Math.round((diff / prev.consumption) * 1000) / 10 } : {}),
        },
      });
    }
    return { unitId, unitNumber: unitById.get(unitId)?.number, periods: items };
  }

  /** PDF verisi + onbellek anahtari (yetki kontrolu cagirana aittir). */
  async function statementFor(apartmentId: string, period: MeterPeriod, line: MeterLine, lines: readonly MeterLine[]) {
    const [site, units, blocks, meters] = await Promise.all([
      deps.core.getSite(apartmentId),
      deps.core.listUnits(apartmentId),
      deps.core.listBlocks(apartmentId),
      repo.list<Meter>(apartmentId, meterPrefixes.meters),
    ]);
    const unitById = new Map(units.map((u) => [u.unitId, u]));
    const unit = unitById.get(line.unitId);
    const block = blocks.find((b) => b.blockId === unit?.blockId);
    const meterById = new Map(meters.map((m) => [m.meterId, m]));
    const a = averages(lines, unit, unitById);
    const totalCons = lines.reduce((s, l) => s + num(l.consumption), 0);
    const share = totalCons > 0 ? (num(line.consumption) / totalCons) * 100 : 0;
    const calc = period.calc;
    const base = {
      apartmentName: site?.name ?? 'Apartman',
      unitLabel: `${block ? `${block.name} / ` : ''}Daire ${unit?.number ?? line.unitId}`,
      periodName: period.name,
      startDate: period.startDate,
      endDate: period.endDate,
      dueDate: period.dueDate,
      categoryLabel: CATEGORY_LABEL[period.template.category],
      commonShareBps: period.template.commonShareBps,
      commonKeyLabel: KEY_LABEL[period.template.commonKey],
      totalAmount: calc?.totalAmount ?? period.totalAmount ?? 0,
      commonPool: calc?.commonPool ?? 0,
      consumptionPool: calc?.consumptionPool ?? 0,
      fallbackToCommon: calc?.fallbackToCommon ?? false,
      buildingConsumption: calc?.totalConsumption ?? fmt(totalCons),
      meters: line.meters.map((c) => {
        const m = meterById.get(c.meterId);
        const scale = m?.scale ?? 0;
        const start = c.endIndex - c.delta;
        return {
          label: m?.label ?? 'Sayaç',
          ...(m?.serialNo ? { serialNo: m.serialNo } : {}),
          ...(start >= 0 ? { startIndex: formatIndex(start, scale) } : {}),
          endIndex: formatIndex(c.endIndex, scale),
          delta: formatIndex(c.delta, scale),
        };
      }),
      unitConsumption: line.consumption,
      consumptionSharePct: share.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      commonAmount: line.commonAmount,
      consumptionAmount: line.consumptionAmount,
      amount: line.amount,
      buildingAverage: fmt(a.building),
      ...(a.block !== undefined && a.blockUnits < a.meteredUnits ? { blockAverage: fmt(a.block) } : {}),
      estimated: line.estimated,
    };
    const dataHash = createHash('sha256')
      .update(JSON.stringify({ v: METER_STATEMENT_TEMPLATE_VERSION, base, calcHash: period.calc?.hash }))
      .digest('hex');
    const data: MeterStatementPdfData = { ...base, generatedAt: period.postedAt ?? period.updatedAt, dataHash };
    return { data, key: meterStatementKey(apartmentId, period.endDate, period.periodId, line.unitId, dataHash) };
  }

  /** Onbellekte yoksa uretir, S3'e yazar ve kisa omurlu imzali link doner. */
  async function signedStatement(apartmentId: string, period: MeterPeriod, line: MeterLine, lines: readonly MeterLine[]) {
    if (!deps.store) throw new MeterError('unavailable', 'Belge deposu yapılandırılmamış (DOCUMENTS_BUCKET)');
    const { data, key } = await statementFor(apartmentId, period, line, lines);
    if (!(await deps.store.head(key))) {
      await deps.store.put(key, await renderMeterStatementPdf(data), 'application/pdf');
    }
    const fileName = `sayac-dokumu-${period.endDate}-${line.unitId}.pdf`;
    const url = await deps.store.presignGet(key, { contentDisposition: contentDisposition(fileName, 'inline'), contentType: 'application/pdf', expiresIn: URL_TTL_SECONDS });
    return { url, fileName, contentType: 'application/pdf', expiresAt: new Date(deps.now().getTime() + URL_TTL_SECONDS * 1000).toISOString() };
  }

  async function postedLine(apartmentId: string, periodId: string, unitId: string) {
    assertId(periodId, 'periodId');
    assertId(unitId, 'unitId');
    const period = await repo.get<MeterPeriod>(meterKeys.period(apartmentId, periodId));
    if (!period || period.status !== 'posted') throw new MeterError('not_found', 'Onaylı dağıtım dönemi bulunamadı');
    const lines = await linesOf(apartmentId, period);
    const line = lines.find((l) => l.unitId === unitId);
    if (!line) throw new MeterError('not_found', 'Bu bölüm dönemin dağıtımında yok');
    return { period, line, lines };
  }

  /** Sakin: kendi dairesinin dokumu. */
  async function myStatement(ctx: Pick<MeterContext, 'apartmentId' | 'userId'>, unitId: string, periodId: string) {
    const ms = await membershipsOf(ctx, unitId);
    const { period, line, lines } = await postedLine(ctx.apartmentId, periodId, unitId);
    if (!visibleTo(ms, period, line)) throw new MeterError('forbidden', 'Bu döneme ait dökümü görüntüleme yetkiniz yok');
    return signedStatement(ctx.apartmentId, period, line, lines);
  }

  /** Yonetici / denetci: herhangi bir dairenin dokumu. */
  async function unitStatement(ctx: Pick<MeterContext, 'apartmentId'>, periodId: string, unitId: string) {
    const { period, line, lines } = await postedLine(ctx.apartmentId, periodId, unitId);
    return signedStatement(ctx.apartmentId, period, line, lines);
  }

  return { myConsumption, myStatement, unitStatement };
}

export type MeterPortalService = ReturnType<typeof createMeterPortalService>;

