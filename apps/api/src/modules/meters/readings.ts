/**
 * Finans 2.3-2 - Donem okumalari: okuma cetveli, tekil / toplu endeks girisi, Excel/CSV aktarimi
 * ve fotograf kaniti. Yazma: yonetici + bina gorevlisi (`READING_WRITE_ROLES`); tahmini okuma
 * onayi ve tur atma isareti yalnizca yonetici.
 *
 * Dogrulama (motorla ayni kurallar):
 *  - Geri giden endeks (tur atma / sayac degisimi kaydi yoksa) ENGELLEYICI hatadir.
 *  - Sicrama (gecmis gunluk ortalamanin 3 kati) uyaridir: okuma kaydedilir, `spike` bayragi doner.
 *  - Eksik okuma icin sistem gecmisten tahmin onerir; yonetici `acceptEstimate` ile acikca onaylar.
 *  - Toplu giris hep-ya-hic: bir satir hataliysa hicbiri yazilmaz, satir bazli hatalar doner.
 */
import { randomUUID } from 'node:crypto';
import type { AuditDraft } from '../audit/log.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import type { IsoDate, Unit } from '../core/types.js';
import { type Obj, ValidationError, asObject, assertId, optBool, reqString } from '../core/validation.js';
import { type DocumentStore, createDocumentStoreFromEnv } from '../documents/store.js';
import { type MeterContext, isManager, isPhotoContentType, meterPhotoKey, parseIndexText } from './common.js';
import { isSpike, resolveSegments, segmentDelta, suggestEstimate } from './engine/consumption.js';
import type { EngineIssue, MeterRecord, Segment } from './engine/types.js';
import { MeterError } from './errors.js';
import { meterPhotos } from './photos.js';
import { type MeterRepository, type MeterWrite, meterKeys, meterPrefixes, meterRepository } from './repository.js';
import { type Meter, type MeterPeriod, type MeterReading, type MeterSwap, OPEN_PERIOD_STATUSES, type ReadingFlag, type ReadingSource } from './types.js';

export type MeterReadingServiceDeps = {
  repository: MeterRepository;
  core: Pick<CoreRepository, 'listUnits'>;
  store: DocumentStore | undefined;
  now: () => Date;
  newId: () => string;
};

/** Tek istekte en fazla okuma (atomik yazim: okumalar + donem + denetim). */
export const MAX_READINGS_PER_WRITE = 90;
/** Toplu aktarimda en fazla satir (parcalar halinde yazilir). */
export const MAX_IMPORT_ROWS = 1000;
const NOTE_MAX = 200;

export type RowStatus = 'ok' | 'missing' | 'error' | 'auto';

export type ReadingRow = {
  meterId: string;
  unitId: string;
  unitNumber?: string;
  blockId?: string;
  label: string;
  serialNo?: string;
  kind: Meter['kind'];
  scale: number;
  inScope: boolean;
  status: RowStatus;
  startIndex?: number;
  startDate?: IsoDate;
  startSource?: Segment['startSource'];
  endIndex?: number;
  endSource?: Segment['endSource'];
  delta?: number;
  flags: ReadingFlag[];
  error?: { code: string; message: string };
  suggestion?: EngineIssue['suggestion'];
  reading?: Pick<MeterReading, 'estimated' | 'rolloverConfirmed' | 'source' | 'note' | 'enteredBy' | 'enteredAt' | 'version' | 'rev'> & { hasPhoto: boolean };
};

export type ReadingItemInput = {
  /** Hata raporunda satir / dizin. */
  ref: number;
  meterId: string;
  endIndex?: number;
  acceptEstimate?: boolean;
  rolloverConfirmed?: boolean;
  /** null: mevcut notu / fotografi kaldirir; undefined: korur. */
  note?: string | null;
  photoKey?: string | null;
};

export type ItemError = { ref: number; meterId?: string; code: string; message: string };

/** Sayac kaydindan motor girdisi. */
export function toMeterRecord(m: Meter): MeterRecord {
  return {
    meterId: m.meterId,
    unitId: m.unitId,
    kind: m.kind,
    scale: m.scale,
    factor: m.factor,
    ...(m.maxIndex !== undefined ? { maxIndex: m.maxIndex } : {}),
    openingIndex: m.openingIndex,
    installedAt: m.installedAt,
    ...(m.status === 'retired' && m.retiredAt ? { retiredAt: m.retiredAt } : {}),
    ...(m.status === 'retired' && m.closingIndex !== undefined ? { closingIndex: m.closingIndex } : {}),
  };
}

/** Sablon kapsami: blok filtresi ve muafiyet kategorisi (toplu tahakkukla ayni kural). */
export function unitInScope(unit: Unit | undefined, scope: MeterPeriod['template']['scope'], date: IsoDate): boolean {
  if (!unit || unit.status !== 'active') return false;
  if (scope.blockIds && !scope.blockIds.includes(unit.blockId)) return false;
  if (scope.exemptionCategory) {
    const exempt = (unit.exemptions ?? []).some(
      (e) => e.expenseCategory === scope.exemptionCategory && (!e.validFrom || e.validFrom <= date) && (!e.validTo || e.validTo >= date),
    );
    if (exempt) return false;
  }
  return true;
}

/** Donemin okuma cetveli: sayac parcalari (motor), okumalar, uyarilar ve tahmin onerileri. */
export async function buildReadingSheet(repo: MeterRepository, core: Pick<CoreRepository, 'listUnits'>, apartmentId: string, period: MeterPeriod) {
  const [meters, swaps, readings, units] = await Promise.all([
    repo.list<Meter>(apartmentId, meterPrefixes.meters),
    repo.list<MeterSwap>(apartmentId, meterPrefixes.swaps),
    repo.list<MeterReading>(apartmentId, meterPrefixes.readings(period.periodId)),
    core.listUnits(apartmentId),
  ]);
  const usable = meters.filter((m) => m.status !== 'cancelled' && m.kind === period.meterKind);
  const meterById = new Map(usable.map((m) => [m.meterId, m]));
  const unitById = new Map(units.map((u) => [u.unitId, u]));
  const readingByMeter = new Map(readings.filter((r) => meterById.has(r.meterId)).map((r) => [r.meterId, r]));

  const resolved = resolveSegments({
    kind: period.meterKind,
    period: { startDate: period.startDate, endDate: period.endDate },
    meters: usable.map(toMeterRecord),
    swaps: swaps.map((s) => ({
      swapId: s.swapId,
      oldMeterId: s.oldMeterId,
      newMeterId: s.newMeterId,
      swapDate: s.swapDate,
      oldClosingIndex: s.oldClosingIndex,
      newOpeningIndex: s.newOpeningIndex,
      status: s.status,
    })),
    lastApproved: new Map(usable.flatMap((m) => (m.lastReading ? [[m.meterId, { index: m.lastReading.index, date: m.lastReading.date }] as const] : []))),
    readings: new Map(
      [...readingByMeter.values()].map((r) => [r.meterId, { endIndex: r.endIndex, estimated: r.estimated, rolloverConfirmed: r.rolloverConfirmed }] as const),
    ),
    history: new Map(usable.flatMap((m) => (m.recentConsumption?.length ? [[m.meterId, m.recentConsumption.map(({ delta, days }) => ({ delta, days }))] as const] : []))),
  });

  const base = (m: Meter): Omit<ReadingRow, 'status' | 'flags'> => {
    const unit = unitById.get(m.unitId);
    const r = readingByMeter.get(m.meterId);
    return {
      meterId: m.meterId,
      unitId: m.unitId,
      ...(unit ? { unitNumber: unit.number, blockId: unit.blockId } : {}),
      label: m.label,
      ...(m.serialNo ? { serialNo: m.serialNo } : {}),
      kind: m.kind,
      scale: m.scale,
      inScope: unitInScope(unit, period.template.scope, period.endDate),
      ...(r
        ? {
            reading: {
              estimated: r.estimated,
              rolloverConfirmed: r.rolloverConfirmed,
              source: r.source,
              ...(r.note ? { note: r.note } : {}),
              enteredBy: r.enteredBy,
              enteredAt: r.enteredAt,
              version: r.version,
              rev: r.rev,
              hasPhoto: !!r.photoKey,
            },
          }
        : {}),
    };
  };

  const rows: ReadingRow[] = [];
  const segByMeter = new Map<string, Segment>();
  for (const seg of resolved.segments) {
    const m = meterById.get(seg.meterId);
    if (!m) continue;
    segByMeter.set(seg.meterId, seg);
    const row: ReadingRow = {
      ...base(m),
      status: 'ok',
      flags: [],
      startIndex: seg.startIndex,
      startDate: seg.startDate,
      startSource: seg.startSource,
      ...(seg.endIndex !== undefined ? { endIndex: seg.endIndex } : {}),
      ...(seg.endSource ? { endSource: seg.endSource } : {}),
    };
    const d = segmentDelta(seg);
    if ('error' in d) {
      row.status = d.error.code === 'missing_reading' ? 'missing' : 'error';
      row.error = { code: d.error.code, message: d.error.message };
      if (d.error.suggestion) row.suggestion = d.error.suggestion;
    } else {
      row.status = seg.endSource === 'reading' ? 'ok' : 'auto';
      row.delta = d.delta;
      if (d.rollover) row.flags.push('rollover');
      if (seg.estimated) row.flags.push('estimated');
      if (isSpike(d.delta, seg.history, seg.days)) row.flags.push('spike');
    }
    rows.push(row);
  }
  for (const issue of resolved.errors) {
    const m = issue.meterId ? meterById.get(issue.meterId) : undefined;
    if (!m || segByMeter.has(m.meterId)) continue;
    rows.push({ ...base(m), status: 'error', flags: [], error: { code: issue.code, message: issue.message } });
  }
  rows.sort((a, b) => (a.blockId ?? '').localeCompare(b.blockId ?? '') || (a.unitNumber ?? '').localeCompare(b.unitNumber ?? '', 'tr', { numeric: true }) || a.label.localeCompare(b.label, 'tr'));

  const inScope = rows.filter((r) => r.inScope);
  const summary = {
    meters: inScope.length,
    ok: inScope.filter((r) => r.status === 'ok').length,
    auto: inScope.filter((r) => r.status === 'auto').length,
    missing: inScope.filter((r) => r.status === 'missing').length,
    errors: inScope.filter((r) => r.status === 'error').length,
    spikes: inScope.filter((r) => r.flags.includes('spike')).length,
    estimated: inScope.filter((r) => r.flags.includes('estimated')).length,
    outOfScope: rows.length - inScope.length,
    warnings: resolved.warnings,
  };
  return { rows, summary, segByMeter, meterById, readingByMeter, unitById };
}


export type ReadingSheet = Awaited<ReturnType<typeof buildReadingSheet>>;

export function createMeterReadingService(overrides: Partial<MeterReadingServiceDeps> = {}) {
  const deps: MeterReadingServiceDeps = {
    repository: meterRepository,
    core: coreRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
    store: 'store' in overrides ? overrides.store : createDocumentStoreFromEnv(),
  };
  const repo = deps.repository;
  const photos = meterPhotos(deps.store, deps.now);
  const stamp = () => deps.now().toISOString();

  async function loadPeriod(ctx: MeterContext, periodId: string): Promise<MeterPeriod> {
    assertId(periodId, 'periodId');
    const p = await repo.get<MeterPeriod>(meterKeys.period(ctx.apartmentId, periodId));
    if (!p) throw new MeterError('not_found', 'Dağıtım dönemi bulunamadı');
    return p;
  }

  function assertOpen(p: MeterPeriod) {
    if (!OPEN_PERIOD_STATUSES.includes(p.status)) throw new MeterError('unprocessable', 'Bu dönem okumaya kapalı (onaylanmış, geri alınmış veya iptal edilmiş)');
  }

  const buildSheet = (ctx: MeterContext, period: MeterPeriod) => buildReadingSheet(repo, deps.core, ctx.apartmentId, period);

  type Sheet = Awaited<ReturnType<typeof buildSheet>>;

  /**
   * Okuma ogelerini dogrular ve yazilacak kayitlari uretir. Hatalari toplar (ilk hatada durmaz).
   */
  async function prepareItems(ctx: MeterContext, period: MeterPeriod, sheet: Sheet, items: readonly ReadingItemInput[], source: ReadingSource) {
    const errors: ItemError[] = [];
    const docs: { doc: MeterReading; prev?: MeterReading }[] = [];
    const results: { ref: number; meterId: string; unitId: string; endIndex: number; delta: number; flags: ReadingFlag[] }[] = [];
    const seen = new Set<string>();
    const manager = isManager(ctx.role);
    const at = stamp();

    for (const item of items) {
      const fail = (code: string, message: string) => errors.push({ ref: item.ref, meterId: item.meterId, code, message });
      if (seen.has(item.meterId)) {
        fail('duplicate', 'Aynı sayaç birden fazla kez girilmiş');
        continue;
      }
      seen.add(item.meterId);
      const seg = sheet.segByMeter.get(item.meterId);
      const meter = sheet.meterById.get(item.meterId);
      if (!seg || !meter) {
        fail('meter_not_in_period', 'Sayaç bu dönemde okunacak sayaçlar arasında değil (tür, takılma tarihi veya onaylı okuma)');
        continue;
      }
      if (seg.endSource === 'swap_closing' || seg.endSource === 'retire_closing') {
        fail('reading_not_needed', 'Değiştirilen / emekliye ayrılan sayacın kapanış endeksi kayıttan alınır; okuma girilmez');
        continue;
      }
      if (!unitInScope(sheet.unitById.get(seg.unitId), period.template.scope, period.endDate)) {
        fail('unit_out_of_scope', 'Bağımsız bölüm bu dönemin dağıtım kapsamında değil (blok / muafiyet)');
        continue;
      }
      if ((item.acceptEstimate || item.rolloverConfirmed) && !manager) {
        fail('manager_only', 'Tahmini okuma onayı ve tur atma işareti yalnızca yönetici tarafından verilebilir');
        continue;
      }
      let endIndex: number;
      let estimated = false;
      if (item.acceptEstimate) {
        if (item.endIndex !== undefined) {
          fail('invalid_item', 'acceptEstimate ile endIndex birlikte gönderilemez');
          continue;
        }
        const suggested = suggestEstimate(seg.history, seg.days);
        if (suggested === undefined) {
          fail('no_estimate', 'Bu sayaç için tahmin önerisi yok (geçmiş dönem tüketimi bulunmuyor)');
          continue;
        }
        endIndex = seg.startIndex + suggested;
        estimated = true;
      } else {
        if (item.endIndex === undefined) {
          fail('invalid_item', 'endIndex zorunlu');
          continue;
        }
        endIndex = item.endIndex;
      }
      if (meter.maxIndex !== undefined && endIndex > meter.maxIndex) {
        fail('invalid_index', `Endeks sayacın en büyük endeksini (${meter.maxIndex}) aşamaz`);
        continue;
      }
      const rolloverConfirmed = item.rolloverConfirmed === true;
      const d = segmentDelta({ ...seg, endIndex, endSource: 'reading', estimated, rolloverConfirmed });
      if ('error' in d) {
        fail(d.error.code, d.error.message);
        continue;
      }
      const flags: ReadingFlag[] = [];
      if (d.rollover) flags.push('rollover');
      if (estimated) flags.push('estimated');
      if (isSpike(d.delta, seg.history, seg.days)) flags.push('spike');

      const prev = sheet.readingByMeter.get(item.meterId);
      let photoKey = prev?.photoKey;
      if (item.photoKey === null) photoKey = undefined;
      else if (typeof item.photoKey === 'string') {
        try {
          await photos.assertPhoto(ctx.apartmentId, item.photoKey, period.endDate, seg.unitId, `${period.periodId}-${item.meterId}-`);
          photoKey = item.photoKey;
        } catch (err) {
          if (err instanceof MeterError || err instanceof ValidationError) {
            fail('invalid_photo', err.message);
            continue;
          }
          throw err;
        }
      }
      const note = item.note === null ? undefined : (item.note ?? prev?.note);
      const doc: MeterReading = {
        ...meterKeys.reading(ctx.apartmentId, period.periodId, item.meterId),
        entityType: 'METER_READING',
        apartmentId: ctx.apartmentId,
        periodId: period.periodId,
        meterId: item.meterId,
        unitId: seg.unitId,
        endIndex,
        estimated,
        rolloverConfirmed,
        source: estimated ? 'estimate' : source,
        ...(photoKey ? { photoKey } : {}),
        ...(note ? { note } : {}),
        flags,
        enteredBy: ctx.userId,
        enteredAt: at,
        rev: (prev?.rev ?? 0) + 1,
        version: (prev?.version ?? 0) + 1,
      };
      docs.push(prev ? { doc, prev } : { doc });
      results.push({ ref: item.ref, meterId: item.meterId, unitId: seg.unitId, endIndex, delta: d.delta, flags });
    }
    return { errors, docs, results };
  }

  /** Okumalari parcalar halinde yazar; her parca: okumalar + donem (taslaga doner) + denetim. */
  async function persist(ctx: MeterContext, period: MeterPeriod, docs: { doc: MeterReading; prev?: MeterReading }[], action: string, extra: Record<string, unknown>) {
    let current = period;
    for (let i = 0; i < docs.length; i += MAX_READINGS_PER_WRITE) {
      const chunk = docs.slice(i, i + MAX_READINGS_PER_WRITE);
      const next: MeterPeriod = { ...current, status: 'draft', updatedAt: stamp(), updatedBy: ctx.userId, version: current.version + 1 };
      const writes: MeterWrite[] = [
        ...chunk.map(({ doc, prev }): MeterWrite => (prev ? { op: 'replace', item: doc, expectedVersion: prev.version } : { op: 'create', item: doc })),
        { op: 'replace', item: next, expectedVersion: current.version },
      ];
      const draft: AuditDraft = {
        apartmentId: ctx.apartmentId,
        action,
        target: { type: 'meter_period', id: period.periodId },
        actorId: ctx.userId,
        details: {
          ...extra,
          count: chunk.length,
          ...(docs.length > MAX_READINGS_PER_WRITE ? { part: Math.floor(i / MAX_READINGS_PER_WRITE) + 1 } : {}),
          meterIds: chunk.map((c) => c.doc.meterId),
          estimated: chunk.filter((c) => c.doc.estimated).length,
          spikes: chunk.filter((c) => c.doc.flags.includes('spike')).length,
        },
      };
      await repo.write(writes, [draft]);
      current = next;
    }
    return current;
  }

  function parseItem(value: unknown, ref: number): ReadingItemInput {
    const o = asObject(value, `items[${ref}]`);
    const meterId = assertId(o.meterId, `items[${ref}].meterId`);
    const endIndex = o.endIndex;
    if (endIndex !== undefined && (typeof endIndex !== 'number' || !Number.isSafeInteger(endIndex) || endIndex < 0)) {
      throw new ValidationError(`items[${ref}].endIndex negatif olmayan tam sayı (ölçekli endeks) olmalı`, 'endIndex');
    }
    const note = o.note === null ? null : o.note === undefined ? undefined : reqString(o, 'note', NOTE_MAX);
    const photoKey = o.photoKey === null ? null : o.photoKey === undefined ? undefined : reqString(o, 'photoKey', 512);
    const acceptEstimate = optBool(o, 'acceptEstimate');
    const rolloverConfirmed = optBool(o, 'rolloverConfirmed');
    return {
      ref,
      meterId,
      ...(endIndex !== undefined ? { endIndex: endIndex as number } : {}),
      ...(acceptEstimate !== undefined ? { acceptEstimate } : {}),
      ...(rolloverConfirmed !== undefined ? { rolloverConfirmed } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(photoKey !== undefined ? { photoKey } : {}),
    };
  }

  const sourceOf = (ctx: MeterContext): ReadingSource => (ctx.role === 'building_staff' ? 'staff' : 'manual');

  // -------------------------------------------------------------------------
  // Uclar
  // -------------------------------------------------------------------------

  /** Okumaya acik donemler (gorevli ekrani). */
  async function listOpenPeriods(ctx: MeterContext) {
    const items = await repo.list<MeterPeriod>(ctx.apartmentId, meterPrefixes.periods);
    return items
      .filter((p) => OPEN_PERIOD_STATUSES.includes(p.status))
      .sort((a, b) => b.endDate.localeCompare(a.endDate))
      .map((p) => ({ periodId: p.periodId, name: p.name, meterKind: p.meterKind, startDate: p.startDate, endDate: p.endDate, status: p.status, version: p.version }));
  }

  async function getSheet(ctx: MeterContext, periodId: string) {
    const period = await loadPeriod(ctx, periodId);
    const { rows, summary } = await buildSheet(ctx, period);
    return { period, rows, summary };
  }

  /** Tekil / toplu okuma girisi (en fazla 90 sayac, hep-ya-hic). */
  async function saveReadings(ctx: MeterContext, periodId: string, body: unknown) {
    const o = asObject(body);
    if (!Array.isArray(o.items) || o.items.length === 0 || o.items.length > MAX_READINGS_PER_WRITE) {
      throw new ValidationError(`items 1-${MAX_READINGS_PER_WRITE} öğeli dizi olmalı`, 'items');
    }
    const items = o.items.map((v, i) => parseItem(v, i));
    const period = await loadPeriod(ctx, periodId);
    assertOpen(period);
    const sheet = await buildSheet(ctx, period);
    const { errors, docs, results } = await prepareItems(ctx, period, sheet, items, sourceOf(ctx));
    if (errors.length) throw new MeterError('unprocessable', 'Okumalar kaydedilmedi; satır hatalarını düzeltin', { items: errors });
    const next = await persist(ctx, period, docs, 'meters.readings_save', { source: sourceOf(ctx) });
    return { period: next, items: results, warnings: results.filter((r) => r.flags.includes('spike')).map((r) => ({ meterId: r.meterId, code: 'spike' })) };
  }

  /**
   * Excel/CSV toplu endeks aktarimi. Web dosyayi okur ve hucreleri METIN olarak gonderir:
   * `rows: [{ row, meter (seri no veya meterId), index ("1.234,567"), note? }]`. `dryRun` ile
   * yalnizca onizleme. Hatali satir varsa hicbiri yazilmaz.
   */
  async function importReadings(ctx: MeterContext, periodId: string, body: unknown) {
    const o = asObject(body);
    if (!Array.isArray(o.rows) || o.rows.length === 0 || o.rows.length > MAX_IMPORT_ROWS) {
      throw new ValidationError(`rows 1-${MAX_IMPORT_ROWS} öğeli dizi olmalı`, 'rows');
    }
    const dryRun = optBool(o, 'dryRun') ?? false;
    const period = await loadPeriod(ctx, periodId);
    assertOpen(period);
    const sheet = await buildSheet(ctx, period);

    const bySerial = new Map<string, Meter[]>();
    for (const m of sheet.meterById.values()) {
      if (!m.serialNo || m.status !== 'active') continue;
      const k = m.serialNo.toLocaleUpperCase('tr-TR');
      bySerial.set(k, [...(bySerial.get(k) ?? []), m]);
    }

    const errors: ItemError[] = [];
    const items: ReadingItemInput[] = [];
    for (const [i, raw] of o.rows.entries()) {
      const r = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Obj;
      const ref = typeof r.row === 'number' && Number.isSafeInteger(r.row) ? r.row : i + 1;
      const meterRef = typeof r.meter === 'string' ? r.meter.trim() : '';
      if (!meterRef) {
        errors.push({ ref, code: 'invalid_item', message: 'Sayaç (seri no veya kimlik) boş' });
        continue;
      }
      let meter = sheet.meterById.get(meterRef);
      if (!meter) {
        const hits = bySerial.get(meterRef.toLocaleUpperCase('tr-TR')) ?? [];
        if (hits.length > 1) {
          errors.push({ ref, code: 'ambiguous_meter', message: `"${meterRef}" seri numarası birden fazla etkin sayaçta var; sayaç kimliğiyle girin` });
          continue;
        }
        meter = hits[0];
      }
      if (!meter) {
        errors.push({ ref, code: 'meter_not_found', message: `"${meterRef}" sayacı bu dönemin sayaçları arasında bulunamadı` });
        continue;
      }
      const parsed = parseIndexText(typeof r.index === 'string' ? r.index : typeof r.index === 'number' ? String(r.index) : undefined, meter.scale);
      if (!parsed.ok) {
        errors.push({ ref, meterId: meter.meterId, code: 'invalid_index', message: parsed.message });
        continue;
      }
      const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim().slice(0, NOTE_MAX) : undefined;
      items.push({ ref, meterId: meter.meterId, endIndex: parsed.value, ...(note ? { note } : {}) });
    }
    const prepared = await prepareItems(ctx, period, sheet, items, 'import');
    errors.push(...prepared.errors);
    errors.sort((a, b) => a.ref - b.ref);

    if (dryRun) {
      return {
        dryRun: true,
        valid: prepared.results.length,
        invalid: errors.length,
        rows: prepared.results.map((r) => ({ ...r, unitNumber: sheet.unitById.get(r.unitId)?.number })),
        errors,
      };
    }
    if (errors.length) throw new MeterError('unprocessable', 'Aktarım yapılmadı; satır hatalarını düzeltin', { items: errors });
    const next = await persist(ctx, period, prepared.docs, 'meters.readings_import', { source: 'import', rows: o.rows.length });
    return { dryRun: false, imported: prepared.docs.length, period: next, warnings: prepared.results.filter((r) => r.flags.includes('spike')).map((r) => ({ ref: r.ref, meterId: r.meterId, code: 'spike' })) };
  }

  /** Okuma fotografi yukleme baglantisi (donem acik, sayac bu donemde okunuyor). */
  async function createPhotoUpload(ctx: MeterContext, periodId: string, meterId: string, body: unknown) {
    const o = asObject(body);
    assertId(meterId, 'meterId');
    const period = await loadPeriod(ctx, periodId);
    assertOpen(period);
    const sheet = await buildSheet(ctx, period);
    const seg = sheet.segByMeter.get(meterId);
    if (!seg || seg.endSource === 'swap_closing' || seg.endSource === 'retire_closing') {
      throw new MeterError('unprocessable', 'Sayaç bu dönemde okunacak sayaçlar arasında değil');
    }
    if (!isPhotoContentType(o.contentType)) throw new MeterError('unprocessable', 'Desteklenmeyen dosya türü. İzin verilenler: JPEG, PNG, WEBP, HEIC');
    const key = meterPhotoKey(ctx.apartmentId, period.endDate, seg.unitId, `${period.periodId}-${meterId}-${deps.newId()}`, o.contentType);
    return photos.presignUpload(key, o);
  }

  /** Okuma fotografi (kisa omurlu imzali goruntuleme linki). */
  async function getPhoto(ctx: MeterContext, periodId: string, meterId: string) {
    assertId(meterId, 'meterId');
    const period = await loadPeriod(ctx, periodId);
    const reading = await repo.get<MeterReading>(meterKeys.reading(ctx.apartmentId, period.periodId, meterId));
    if (!reading?.photoKey) throw new MeterError('not_found', 'Bu okumada fotoğraf yok');
    return photos.presignDownload(reading.photoKey, `sayac-okuma-${period.endDate}`);
  }

  return { listOpenPeriods, getSheet, saveReadings, importReadings, createPhotoUpload, getPhoto };
}

export type MeterReadingService = ReturnType<typeof createMeterReadingService>;
