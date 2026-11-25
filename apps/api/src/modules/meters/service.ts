/**
 * Finans 2.3-2 - Sayac sicili, sayac degisimi / emekliligi, dagitim sablonlari ve donem taslaklari.
 * Yazma: yalnizca yonetici (`apartment_manager`, `management_company`). Okuma girisi `readings.ts`.
 *
 * Kurallar:
 *  - Her yazim tek atomik islem: kayitlar + sayac olaylari + denetim kaydi.
 *  - Sayac degisimi (kural 3): eski sayac `replaced` (kapanis endeksi), yeni sayac ayni dairede
 *    acilis endeksiyle acilir. Sifirlama da yeni sayac parcasidir (seri no ayni kalabilir).
 *  - Geri giden endeks engelleyici hatadir; kapanis endeksi son onayli / acilis endeksinden kucuk olamaz.
 *  - Onayli okumasi olan sayacin olcek ve katsayisi degismez (gecmis donemlerin hesabi bozulmasin).
 *  - Sablon (kural 1): merkezi isitmada yonetmelik varsayilani %30 ortak (m2) + %70 tuketim;
 *    farkli oran/anahtar engellenmez, uyari verilir ve karar referansi + gerekce zorunludur.
 */
import { randomUUID } from 'node:crypto';
import type { AuditDraft } from '../audit/log.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import type { IsoDate, LiableParty, Site, Unit } from '../core/types.js';
import { type Obj, ValidationError, asObject, assertId, optBool, optString, reqEnum, reqInt, reqString } from '../core/validation.js';
import { type DocumentStore, createDocumentStoreFromEnv } from '../documents/store.js';
import { type FinanceRepository, financeRepository } from '../finance/repository.js';
import { DEFAULT_INCOME_ACCOUNTS, SYSTEM_ACCOUNTS } from '../finance/service.js';
import { MAX_EXPENSES_PER_PERIOD, planExpenseLocks } from './expenseLocks.js';
import {
  type MeterContext,
  fingerprint,
  isPhotoContentType,
  istanbulDate,
  meterPhotoKey,
  optDate,
  optIndex,
  parseFactor,
  parseScale,
  reqDate,
  reqIndex,
} from './common.js';
import { BPS_TOTAL, CENTRAL_HEATING_COMMON_BPS, COMMON_KEYS, type CommonKey, METER_KINDS, type MeterKind } from './engine/types.js';
import { MeterError } from './errors.js';
import { meterPhotos } from './photos.js';
import { type MeterRepository, type MeterWrite, meterKeys, meterPrefixes, meterRepository } from './repository.js';
import {
  LEGAL_PROFILES,
  type LegalProfile,
  type Meter,
  type MeterEvent,
  type MeterEventType,
  type MeterExpenseLock,
  type MeterIdempotency,
  type MeterPeriod,
  type MeterReading,
  type MeterSwap,
  type MeterTemplate,
  OPEN_PERIOD_STATUSES,
  SWAP_KINDS,
  TEMPLATE_CATEGORIES,
  type TemplateCategory,
  type TemplateScope,
  type TemplateSnapshot,
} from './types.js';

export type MeterServiceDeps = {
  repository: MeterRepository;
  core: Pick<CoreRepository, 'getUnit' | 'listUnits' | 'getSite' | 'listBlocks'>;
  /** Yoksa (DOCUMENTS_BUCKET tanimsiz) fotograf uclari 503 doner. */
  store: DocumentStore | undefined;
  /** 2.3-5a: donemlere baglanan tedarikci faturalari (gider kayitlari). */
  expenses: Pick<FinanceRepository, 'getExpense' | 'listExpenses'> & Partial<Pick<FinanceRepository, 'getAccount'>>;
  now: () => Date;
  newId: () => string;
};

const LIABLE_PARTIES: readonly LiableParty[] = ['occupant', 'owner'];
const LABEL_MAX = 60;
const SERIAL_MAX = 40;
const REASON_MAX = 300;
const MAX_PERIOD_DAYS = 366;
const MAX_AMOUNT = 99_999_999_999;
const EXEMPTION_CATEGORY = /^[a-z0-9_-]{2,50}$/;
const IDEM_KEY = /^[A-Za-z0-9_-]{8,64}$/;

type TemplateInput = {
  name: string;
  meterKind: MeterKind;
  category: TemplateCategory;
  commonShareBps: number;
  commonKey: CommonKey;
  liableParty: LiableParty;
  scope: TemplateScope;
  legalProfile: LegalProfile;
  decisionRef?: string;
  reason?: string;
  /** Finans 2.4: gelir hesabi (varsayilan `income-dues`). */
  incomeAccountId?: string;
};

/** Hazir gelir hesaplari: tahakkuk aninda finans servisi tarafindan acilir (var olmasi beklenmez). */
const BUILT_IN_INCOME_IDS: readonly string[] = [SYSTEM_ACCOUNTS.incomeDues, ...DEFAULT_INCOME_ACCOUNTS.map((a) => a.accountId)];

/** Yonetmelik uyarilari: merkezi isitmada %30 / m2 disi -> uyari + karar referansi zorunlu. */
export function legalWarnings(t: Pick<TemplateInput, 'legalProfile' | 'commonShareBps' | 'commonKey'>) {
  const warnings: { code: string; message: string }[] = [];
  if (t.legalProfile === 'central_heating' && (t.commonShareBps !== CENTRAL_HEATING_COMMON_BPS || t.commonKey !== 'area')) {
    warnings.push({
      code: 'legal_deviation',
      message: 'Merkezi ısıtmada yönetmelik esası %30 ortak (kullanım alanı) + %70 tüketimdir; farklı oran/anahtar için kat malikleri kurulu kararı gerekir',
    });
  }
  return warnings;
}

/** Hazir sablonlar: merkezi isitma site ayarindaki `meterSplit`'ten, yoksa %30 m2; su %0 + %100. */
export function templatePresetsFor(site: Pick<Site, 'settings'> | undefined): (TemplateInput & { preset: string })[] {
  const split = site?.settings.meterSplit;
  const bps = split ? split.commonSharePercent * 100 : CENTRAL_HEATING_COMMON_BPS;
  const key: CommonKey = split?.commonShareKey ?? 'area';
  const pct = Math.round(bps / 100);
  return [
    {
      preset: 'central_heating',
      name: `Merkezi ısıtma — %${pct} ortak + %${100 - pct} tüketim`,
      meterKind: 'heat_allocator',
      category: 'heating',
      commonShareBps: bps,
      commonKey: key,
      liableParty: 'occupant',
      scope: {},
      legalProfile: 'central_heating',
      incomeAccountId: 'income-heating',
    },
    {
      preset: 'hot_water',
      name: 'Sıcak su — %100 tüketim',
      meterKind: 'hot_water',
      category: 'hot_water',
      commonShareBps: 0,
      commonKey: 'area',
      liableParty: 'occupant',
      scope: {},
      legalProfile: 'none',
      incomeAccountId: 'income-heating',
    },
    { preset: 'cold_water', name: 'Soğuk su — %100 tüketim', meterKind: 'cold_water', category: 'cold_water', commonShareBps: 0, commonKey: 'area', liableParty: 'occupant', scope: {}, legalProfile: 'none' },
  ];
}

export function createMeterService(overrides: Partial<MeterServiceDeps> = {}) {
  const deps: MeterServiceDeps = {
    repository: meterRepository,
    core: coreRepository,
    expenses: financeRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
    store: 'store' in overrides ? overrides.store : createDocumentStoreFromEnv(),
  };
  const repo = deps.repository;
  const stamp = () => deps.now().toISOString();
  const today = () => istanbulDate(deps.now());

  // -------------------------------------------------------------------------
  // Ortak yardimcilar
  // -------------------------------------------------------------------------

  function created(ctx: MeterContext) {
    const at = stamp();
    return { createdAt: at, createdBy: ctx.userId, updatedAt: at, updatedBy: ctx.userId, version: 1 };
  }

  function bumped<T extends { version: number }>(ctx: MeterContext, rec: T, patch: Partial<T>): T {
    return { ...rec, ...patch, updatedAt: stamp(), updatedBy: ctx.userId, version: rec.version + 1 };
  }

  function event(ctx: MeterContext, meterId: string, type: MeterEventType, extra: { date?: IsoDate; details?: Record<string, unknown> } = {}): MeterEvent {
    const at = stamp();
    const eventId = deps.newId();
    return {
      ...meterKeys.event(ctx.apartmentId, meterId, at, eventId),
      entityType: 'METER_EVENT',
      eventId,
      apartmentId: ctx.apartmentId,
      meterId,
      type,
      at,
      by: ctx.userId,
      ...(extra.date ? { date: extra.date } : {}),
      ...(extra.details ? { details: extra.details } : {}),
    };
  }

  const audit = (ctx: MeterContext, action: string, target: { type: string; id: string }, details?: Record<string, unknown>, reason?: string): AuditDraft => ({
    apartmentId: ctx.apartmentId,
    action,
    target,
    actorId: ctx.userId,
    ...(reason ? { reason } : {}),
    ...(details ? { details } : {}),
  });

  const create = (item: object): MeterWrite => ({ op: 'create', item: item as MeterWrite['item'] });
  const replace = (item: object, expectedVersion: number): MeterWrite => ({ op: 'replace', item: item as MeterWrite['item'], expectedVersion });

  async function loadMeter(ctx: MeterContext, meterId: string): Promise<Meter> {
    assertId(meterId, 'meterId');
    const m = await repo.get<Meter>(meterKeys.meter(ctx.apartmentId, meterId));
    if (!m) throw new MeterError('not_found', 'Sayaç bulunamadı');
    return m;
  }

  async function loadUnit(ctx: MeterContext, unitId: string): Promise<Unit> {
    assertId(unitId, 'unitId');
    const u = await deps.core.getUnit(ctx.apartmentId, unitId);
    if (!u || u.status !== 'active') throw new MeterError('not_found', 'Aktif bağımsız bölüm bulunamadı');
    return u;
  }

  const listMetersRaw = (apartmentId: string) => repo.list<Meter>(apartmentId, meterPrefixes.meters);

  /** Sayacin bir sonraki parcasinin baslangici: son onayli okuma, yoksa acilis. */
  const startOf = (m: Meter) => (m.lastReading ? { index: m.lastReading.index, date: m.lastReading.date } : { index: m.openingIndex, date: m.installedAt });

  const requireVersion = (o: Obj) => reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);

  function parseSerial(o: Obj, key = 'serialNo'): string | undefined {
    if (o[key] === undefined || o[key] === null) return undefined;
    return reqString(o, key, SERIAL_MAX);
  }

  const sameSerial = (a?: string, b?: string) => !!a && !!b && a.toLocaleUpperCase('tr-TR') === b.toLocaleUpperCase('tr-TR');

  async function assertSerialFree(ctx: MeterContext, serialNo: string | undefined, exceptMeterIds: string[] = []) {
    if (!serialNo) return;
    const clash = (await listMetersRaw(ctx.apartmentId)).find((m) => m.status === 'active' && !exceptMeterIds.includes(m.meterId) && sameSerial(m.serialNo, serialNo));
    if (clash) throw new MeterError('conflict', `Bu seri numarası başka bir etkin sayaçta kayıtlı (${clash.label})`);
  }

  const photos = meterPhotos(deps.store, deps.now);
  const assertPhoto = (ctx: MeterContext, key: string, date: IsoDate, unitId: string, namePrefix: string) =>
    photos.assertPhoto(ctx.apartmentId, key, date, unitId, namePrefix);

  /** Acik (draft/calculated) donemlerde bu sayacin okumalari (degisim / emeklilik tutarliligi). */
  async function openReadingsOf(ctx: MeterContext, meterId: string): Promise<{ period: MeterPeriod; reading: MeterReading }[]> {
    const periods = (await repo.list<MeterPeriod>(ctx.apartmentId, meterPrefixes.periods)).filter((p) => OPEN_PERIOD_STATUSES.includes(p.status));
    const out: { period: MeterPeriod; reading: MeterReading }[] = [];
    for (const period of periods) {
      const reading = await repo.get<MeterReading>(meterKeys.reading(ctx.apartmentId, period.periodId, meterId));
      if (reading) out.push({ period, reading });
    }
    return out;
  }

  /**
   * Kapanis (degisim / emeklilik) kurallari: tarih son onayli okumadan SONRA, kapanis endeksi
   * baslangictan kucuk olamaz (geri giden endeks engelleyici), en buyuk endeksi asamaz; kapanistan
   * once biten acik donem okumalari kapanisi asamaz.
   */
  async function assertClosing(ctx: MeterContext, m: Meter, date: IsoDate, closingIndex: number): Promise<{ delta: number }> {
    if (m.status !== 'active') throw new MeterError('unprocessable', 'Yalnızca etkin sayaç değiştirilebilir veya emekliye ayrılabilir');
    if (date > today()) throw new ValidationError('Tarih ileri bir gün olamaz', 'date');
    if (date < m.installedAt) throw new ValidationError('Tarih sayacın takılma tarihinden önce olamaz', 'date');
    const start = startOf(m);
    if (m.lastReading && date <= m.lastReading.date) {
      throw new MeterError('unprocessable', `Sayacın ${m.lastReading.date} tarihli onaylı okuması var; tarih bundan sonra olmalı (önce ilgili dönem geri alınmalı)`);
    }
    if (closingIndex < start.index) {
      throw new MeterError('unprocessable', `Kapanış endeksi (${closingIndex}) başlangıç endeksinden (${start.index}) küçük olamaz`);
    }
    if (m.maxIndex !== undefined && closingIndex > m.maxIndex) throw new MeterError('unprocessable', 'Kapanış endeksi sayacın en büyük endeksini aşamaz');
    const busy = (await repo.list<MeterPeriod>(ctx.apartmentId, meterPrefixes.periods)).find((p) => p.status === 'posting' && p.meterKind === m.kind);
    if (busy) throw new MeterError('unprocessable', `"${busy.name}" dönemi onaylanıyor; onay tamamlanınca yeniden deneyin`);
    for (const { period, reading } of await openReadingsOf(ctx, m.meterId)) {
      if (period.endDate <= date && reading.endIndex > closingIndex && !reading.rolloverConfirmed) {
        throw new MeterError('unprocessable', `"${period.name}" dönemindeki okuma (${reading.endIndex}) kapanış endeksinden büyük`);
      }
    }
    return { delta: closingIndex - start.index };
  }

  // -------------------------------------------------------------------------
  // Sayac sicili
  // -------------------------------------------------------------------------

  async function listMeters(ctx: MeterContext, q: { unitId?: string; status?: string; kind?: string }) {
    const status = q.status ?? 'active';
    let items = await listMetersRaw(ctx.apartmentId);
    if (q.unitId) items = items.filter((m) => m.unitId === q.unitId);
    if (q.kind) items = items.filter((m) => m.kind === q.kind);
    if (status !== 'all') items = items.filter((m) => m.status === status);
    return items.sort((a, b) => a.unitId.localeCompare(b.unitId) || a.label.localeCompare(b.label, 'tr') || a.meterId.localeCompare(b.meterId));
  }

  async function getMeter(ctx: MeterContext, meterId: string) {
    const meter = await loadMeter(ctx, meterId);
    const events = await repo.list<MeterEvent>(ctx.apartmentId, meterPrefixes.events(meterId));
    return { meter, events: events.sort((a, b) => a.at.localeCompare(b.at)) };
  }

  async function createMeter(ctx: MeterContext, body: unknown) {
    const o = asObject(body);
    const unit = await loadUnit(ctx, reqString(o, 'unitId', 64));
    const kind = reqEnum(o, 'kind', METER_KINDS);
    const label = reqString(o, 'label', LABEL_MAX);
    const serialNo = parseSerial(o);
    const scale = o.scale === undefined ? 0 : parseScale(o.scale);
    const factor = o.factor === undefined ? { num: 1, den: 1 } : parseFactor(o.factor);
    const maxIndex = optIndex(o, 'maxIndex');
    const openingIndex = reqIndex(o, 'openingIndex');
    const installedAt = reqDate(o, 'installedAt');
    if (installedAt > today()) throw new ValidationError('installedAt ileri bir gün olamaz', 'installedAt');
    if (maxIndex !== undefined && openingIndex > maxIndex) throw new ValidationError('Açılış endeksi en büyük endeksi aşamaz', 'openingIndex');
    await assertSerialFree(ctx, serialNo);

    const meterId = deps.newId();
    const meter: Meter = {
      ...meterKeys.meter(ctx.apartmentId, meterId),
      entityType: 'METER',
      meterId,
      apartmentId: ctx.apartmentId,
      unitId: unit.unitId,
      kind,
      label,
      ...(serialNo ? { serialNo } : {}),
      scale,
      factor,
      ...(maxIndex !== undefined ? { maxIndex } : {}),
      openingIndex,
      installedAt,
      status: 'active',
      ...created(ctx),
    };
    await repo.write(
      [create(meter), create(event(ctx, meterId, 'install', { date: installedAt, details: { openingIndex } }))],
      [audit(ctx, 'meters.meter_create', { type: 'meter', id: meterId }, { unitId: unit.unitId, kind, label, serialNo, openingIndex, installedAt })],
    );
    return meter;
  }

  async function updateMeter(ctx: MeterContext, meterId: string, body: unknown) {
    const o = asObject(body);
    const version = requireVersion(o);
    const m = await loadMeter(ctx, meterId);
    if (m.version !== version) throw new MeterError('conflict', 'Sayaç başka bir işlemle değişti; yeniden deneyin');
    if (m.status === 'cancelled') throw new MeterError('unprocessable', 'İptal edilmiş sayaç düzenlenemez');
    const patch: Partial<Meter> = {};
    const changed: Record<string, unknown> = {};
    if (o.label !== undefined) {
      patch.label = reqString(o, 'label', LABEL_MAX);
      changed.label = patch.label;
    }
    if (o.serialNo !== undefined) {
      const serial = parseSerial(o);
      if (m.status === 'active') await assertSerialFree(ctx, serial, [m.meterId]);
      patch.serialNo = serial;
      changed.serialNo = serial ?? null;
    }
    const hasHistory = !!m.lastReading;
    if (o.scale !== undefined) {
      const scale = parseScale(o.scale);
      if (scale !== m.scale && hasHistory) throw new MeterError('unprocessable', 'Onaylı okuması olan sayacın ölçeği değiştirilemez');
      patch.scale = scale;
      changed.scale = scale;
    }
    if (o.factor !== undefined) {
      const factor = parseFactor(o.factor);
      if ((factor.num !== m.factor.num || factor.den !== m.factor.den) && hasHistory) {
        throw new MeterError('unprocessable', 'Onaylı okuması olan sayacın katsayısı değiştirilemez; yeni sayaç parçası açın (sayaç değişimi)');
      }
      patch.factor = factor;
      changed.factor = factor;
    }
    if (o.maxIndex !== undefined) {
      const maxIndex = optIndex(o, 'maxIndex');
      if (maxIndex !== undefined && maxIndex < startOf(m).index) throw new ValidationError('En büyük endeks mevcut endeksten küçük olamaz', 'maxIndex');
      patch.maxIndex = maxIndex;
      changed.maxIndex = maxIndex ?? null;
    }
    if (Object.keys(changed).length === 0) return m;
    const next = bumped(ctx, m, patch);
    if (next.serialNo === undefined) delete next.serialNo;
    if (next.maxIndex === undefined) delete next.maxIndex;
    await repo.write(
      [replace(next, m.version), create(event(ctx, meterId, 'update', { details: changed }))],
      [audit(ctx, 'meters.meter_update', { type: 'meter', id: meterId }, changed)],
    );
    return next;
  }

  async function retireMeter(ctx: MeterContext, meterId: string, body: unknown) {
    const o = asObject(body);
    const m = await loadMeter(ctx, meterId);
    const retiredAt = reqDate(o, 'retiredAt');
    const closingIndex = reqIndex(o, 'closingIndex');
    const reason = reqString(o, 'reason', REASON_MAX);
    const photoKey = optString(o, 'photoKey', 512);
    const { delta } = await assertClosing(ctx, m, retiredAt, closingIndex);
    if (photoKey) await assertPhoto(ctx, photoKey, retiredAt, m.unitId, `swap-${m.meterId}-`);
    const next = bumped(ctx, m, { status: 'retired', retiredAt, closingIndex, retireReason: reason });
    await repo.write(
      [replace(next, m.version), create(event(ctx, meterId, 'retire', { date: retiredAt, details: { closingIndex, ...(photoKey ? { photoKey } : {}) } }))],
      [audit(ctx, 'meters.meter_retire', { type: 'meter', id: meterId }, { retiredAt, closingIndex, delta }, reason)],
    );
    return next;
  }

  /** Degisim / emeklilik kaniti fotograf yukleme baglantisi. */
  async function createMeterPhotoUpload(ctx: MeterContext, meterId: string, body: unknown) {
    const o = asObject(body);
    const m = await loadMeter(ctx, meterId);
    const date = reqDate(o, 'date');
    if (!isPhotoContentType(o.contentType)) throw new MeterError('unprocessable', 'Desteklenmeyen dosya türü. İzin verilenler: JPEG, PNG, WEBP, HEIC');
    const key = meterPhotoKey(ctx.apartmentId, date, m.unitId, `swap-${m.meterId}-${deps.newId()}`, o.contentType);
    return photos.presignUpload(key, o);
  }

  // -------------------------------------------------------------------------
  // Sayac degisimi / sifirlama (kural 3)
  // -------------------------------------------------------------------------

  async function planSwap(ctx: MeterContext, o: Obj) {
    const old = await loadMeter(ctx, reqString(o, 'meterId', 64));
    const kind = reqEnum(o, 'kind', SWAP_KINDS);
    const swapDate = reqDate(o, 'swapDate');
    const oldClosingIndex = reqIndex(o, 'oldClosingIndex');
    const newOpeningIndex = reqIndex(o, 'newOpeningIndex');
    const reason = reqString(o, 'reason', REASON_MAX);
    const photoKey = optString(o, 'photoKey', 512);
    const { delta } = await assertClosing(ctx, old, swapDate, oldClosingIndex);

    const serialNo = o.newSerialNo === undefined ? (kind === 'reset' ? old.serialNo : undefined) : parseSerial(o, 'newSerialNo');
    const scale = o.newScale === undefined ? old.scale : parseScale(o.newScale, 'newScale');
    const factor = o.newFactor === undefined ? old.factor : parseFactor(o.newFactor, 'newFactor');
    const maxIndex = o.newMaxIndex === undefined ? old.maxIndex : optIndex(o, 'newMaxIndex');
    const label = o.newLabel === undefined ? old.label : reqString(o, 'newLabel', LABEL_MAX);
    if (maxIndex !== undefined && newOpeningIndex > maxIndex) throw new ValidationError('Yeni açılış endeksi en büyük endeksi aşamaz', 'newOpeningIndex');
    if (kind === 'replacement' && sameSerial(serialNo, old.serialNo)) {
      throw new ValidationError('Yeni sayacın seri numarası eskisiyle aynı; sıfırlama ise tür "reset" seçilmeli', 'newSerialNo');
    }
    return { old, kind, swapDate, oldClosingIndex, newOpeningIndex, reason, photoKey, delta, serialNo, scale, factor, maxIndex, label };
  }

  async function previewSwap(ctx: MeterContext, body: unknown) {
    const p = await planSwap(ctx, asObject(body));
    const start = startOf(p.old);
    return {
      oldMeter: p.old,
      startIndex: start.index,
      startDate: start.date,
      oldClosingIndex: p.oldClosingIndex,
      /** Eski sayacin kapanisa kadarki tuketimi (ilgili donemde sayilir). */
      closingDelta: p.delta,
      newMeter: { kind: p.old.kind, label: p.label, serialNo: p.serialNo, scale: p.scale, factor: p.factor, maxIndex: p.maxIndex, openingIndex: p.newOpeningIndex, installedAt: p.swapDate },
    };
  }

  async function createSwap(ctx: MeterContext, body: unknown) {
    const o = asObject(body);
    const key = o.idempotencyKey;
    if (typeof key !== 'string' || !IDEM_KEY.test(key)) throw new ValidationError('idempotencyKey 8-64 karakter (harf, rakam, - _) olmalı', 'idempotencyKey');
    const { idempotencyKey: _k, ...rest } = o;
    const fp = fingerprint({ op: 'meter_swap', ...rest });
    const prior = await repo.get<MeterIdempotency>(meterKeys.idempotency(ctx.apartmentId, `MSW_${key}`));
    if (prior) {
      if (prior.fingerprint !== fp) throw new MeterError('conflict', 'Bu idempotencyKey farklı bir istekle kullanılmış');
      const swap = await loadSwap(ctx, prior.swapId);
      return { swap, replayed: true };
    }
    const p = await planSwap(ctx, o);
    if (p.photoKey) await assertPhoto(ctx, p.photoKey, p.swapDate, p.old.unitId, `swap-${p.old.meterId}-`);
    if (p.kind === 'replacement') await assertSerialFree(ctx, p.serialNo, [p.old.meterId]);

    const swapId = deps.newId();
    const newMeterId = deps.newId();
    const newMeter: Meter = {
      ...meterKeys.meter(ctx.apartmentId, newMeterId),
      entityType: 'METER',
      meterId: newMeterId,
      apartmentId: ctx.apartmentId,
      unitId: p.old.unitId,
      kind: p.old.kind,
      label: p.label,
      ...(p.serialNo ? { serialNo: p.serialNo } : {}),
      scale: p.scale,
      factor: p.factor,
      ...(p.maxIndex !== undefined ? { maxIndex: p.maxIndex } : {}),
      openingIndex: p.newOpeningIndex,
      installedAt: p.swapDate,
      status: 'active',
      predecessorMeterId: p.old.meterId,
      swapInId: swapId,
      ...created(ctx),
    };
    const oldNext = bumped(ctx, p.old, { status: 'replaced', successorMeterId: newMeterId, swapOutId: swapId, retiredAt: p.swapDate, closingIndex: p.oldClosingIndex });
    const swap: MeterSwap = {
      ...meterKeys.swap(ctx.apartmentId, swapId),
      entityType: 'METER_SWAP',
      swapId,
      apartmentId: ctx.apartmentId,
      unitId: p.old.unitId,
      kind: p.kind,
      oldMeterId: p.old.meterId,
      newMeterId,
      swapDate: p.swapDate,
      oldClosingIndex: p.oldClosingIndex,
      newOpeningIndex: p.newOpeningIndex,
      ...(p.photoKey ? { photoKey: p.photoKey } : {}),
      reason: p.reason,
      status: 'active',
      ...created(ctx),
    };
    const idem: MeterIdempotency = {
      ...meterKeys.idempotency(ctx.apartmentId, `MSW_${key}`),
      entityType: 'METER_IDEMPOTENCY',
      key,
      fingerprint: fp,
      swapId,
      createdAt: stamp(),
    };
    await repo.write(
      [
        create(swap),
        replace(oldNext, p.old.version),
        create(newMeter),
        create(event(ctx, p.old.meterId, 'swap_out', { date: p.swapDate, details: { swapId, closingIndex: p.oldClosingIndex, newMeterId } })),
        create(event(ctx, newMeterId, 'swap_in', { date: p.swapDate, details: { swapId, openingIndex: p.newOpeningIndex, oldMeterId: p.old.meterId } })),
        create(idem),
      ],
      [
        audit(
          ctx,
          'meters.swap_create',
          { type: 'meter_swap', id: swapId },
          { kind: p.kind, unitId: p.old.unitId, oldMeterId: p.old.meterId, newMeterId, swapDate: p.swapDate, oldClosingIndex: p.oldClosingIndex, newOpeningIndex: p.newOpeningIndex, closingDelta: p.delta },
          p.reason,
        ),
      ],
    );
    return { swap, oldMeter: oldNext, newMeter, replayed: false };
  }

  async function loadSwap(ctx: MeterContext, swapId: string): Promise<MeterSwap> {
    assertId(swapId, 'swapId');
    const s = await repo.get<MeterSwap>(meterKeys.swap(ctx.apartmentId, swapId));
    if (!s) throw new MeterError('not_found', 'Değişim kaydı bulunamadı');
    return s;
  }

  async function listSwaps(ctx: MeterContext, q: { unitId?: string; meterId?: string }) {
    let items = await repo.list<MeterSwap>(ctx.apartmentId, meterPrefixes.swaps);
    if (q.unitId) items = items.filter((s) => s.unitId === q.unitId);
    if (q.meterId) items = items.filter((s) => s.oldMeterId === q.meterId || s.newMeterId === q.meterId);
    return items.sort((a, b) => b.swapDate.localeCompare(a.swapDate) || b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Degisimin geri alinmasi: yalnizca yeni sayacin onayli okumasi ve ardili yoksa. Eski sayac
   * yeniden etkin olur, yeni sayac `cancelled` (okumalari donem hesabina girmez).
   */
  async function reverseSwap(ctx: MeterContext, swapId: string, body: unknown) {
    const o = asObject(body);
    const reason = reqString(o, 'reason', REASON_MAX);
    const swap = await loadSwap(ctx, swapId);
    if (swap.status !== 'active') throw new MeterError('unprocessable', 'Değişim zaten geri alınmış');
    const [oldM, newM] = await Promise.all([loadMeter(ctx, swap.oldMeterId), loadMeter(ctx, swap.newMeterId)]);
    if (newM.lastReading) throw new MeterError('unprocessable', 'Yeni sayacın onaylı okuması var; önce ilgili dönem geri alınmalı');
    if (newM.status !== 'active' || newM.successorMeterId) throw new MeterError('unprocessable', 'Yeni sayaç tekrar değiştirilmiş veya emekliye ayrılmış; önce o işlem geri alınmalı');
    if (oldM.status !== 'replaced' || oldM.swapOutId !== swap.swapId) throw new MeterError('conflict', 'Eski sayacın durumu değişim kaydıyla uyuşmuyor');
    if (swap.kind === 'replacement') await assertSerialFree(ctx, oldM.serialNo, [oldM.meterId, newM.meterId]);

    const oldNext = bumped(ctx, oldM, { status: 'active' });
    delete oldNext.successorMeterId;
    delete oldNext.swapOutId;
    delete oldNext.retiredAt;
    delete oldNext.closingIndex;
    const newNext = bumped(ctx, newM, { status: 'cancelled' });
    const swapNext = bumped(ctx, swap, { status: 'reversed', reversedAt: stamp(), reversedBy: ctx.userId, reverseReason: reason });
    await repo.write(
      [
        replace(swapNext, swap.version),
        replace(oldNext, oldM.version),
        replace(newNext, newM.version),
        create(event(ctx, oldM.meterId, 'swap_reverse', { details: { swapId } })),
        create(event(ctx, newM.meterId, 'cancel', { details: { swapId } })),
      ],
      [audit(ctx, 'meters.swap_reverse', { type: 'meter_swap', id: swapId }, { oldMeterId: oldM.meterId, newMeterId: newM.meterId }, reason)],
    );
    return { swap: swapNext, oldMeter: oldNext, newMeter: newNext };
  }

  async function swapPhoto(ctx: MeterContext, swapId: string) {
    const swap = await loadSwap(ctx, swapId);
    if (!swap.photoKey) throw new MeterError('not_found', 'Bu değişimde fotoğraf yok');
    return photos.presignDownload(swap.photoKey, `sayac-degisimi-${swap.swapDate}`);
  }

  // -------------------------------------------------------------------------
  // Dagitim sablonlari (kural 1)
  // -------------------------------------------------------------------------

  async function parseScope(ctx: MeterContext, value: unknown): Promise<TemplateScope> {
    const s = asObject(value, 'scope');
    const scope: TemplateScope = {};
    if (s.blockIds !== undefined && s.blockIds !== null) {
      if (!Array.isArray(s.blockIds) || s.blockIds.length === 0 || s.blockIds.length > 100) {
        throw new ValidationError('scope.blockIds 1-100 öğeli dizi olmalı', 'scope.blockIds');
      }
      const ids = s.blockIds.map((b) => assertId(b, 'scope.blockIds'));
      const blocks = new Set((await deps.core.listBlocks(ctx.apartmentId)).map((b) => b.blockId));
      const missing = ids.filter((b) => !blocks.has(b));
      if (missing.length) throw new MeterError('not_found', `Blok bulunamadı: ${missing.join(', ')}`);
      scope.blockIds = [...new Set(ids)].sort();
    }
    if (s.exemptionCategory !== undefined && s.exemptionCategory !== null) {
      const v = typeof s.exemptionCategory === 'string' ? s.exemptionCategory.trim().toLowerCase() : '';
      if (!EXEMPTION_CATEGORY.test(v)) throw new ValidationError('scope.exemptionCategory 2-50 karakter, küçük harf/rakam/-/_ olmalı', 'scope.exemptionCategory');
      scope.exemptionCategory = v;
    }
    return scope;
  }

  /** Finans 2.4: sablonun gelir hesabi; hazir hesaplar dogrudan, digerleri aktif `income` olmali. */
  async function parseIncomeAccount(ctx: MeterContext, value: unknown): Promise<string> {
    const id = assertId(value, 'incomeAccountId');
    if (id === SYSTEM_ACCOUNTS.incomeLateFee) throw new ValidationError('Gecikme tazminati gelir hesabi seçilemez', 'incomeAccountId');
    if (BUILT_IN_INCOME_IDS.includes(id)) return id;
    const acc = deps.expenses.getAccount ? await deps.expenses.getAccount(ctx.apartmentId, id) : undefined;
    if (!acc || acc.type !== 'income' || acc.status !== 'active') throw new ValidationError('incomeAccountId aktif bir gelir hesabı olmalı', 'incomeAccountId');
    return id;
  }

  async function parseTemplate(ctx: MeterContext, o: Obj, base?: TemplateInput): Promise<TemplateInput> {
    function pick<T>(key: string, parse: () => T, fallback: T | undefined): T {
      if (o[key] !== undefined) return parse();
      if (fallback === undefined) throw new ValidationError(`${key} zorunlu`, key);
      return fallback;
    }
    const name = pick('name', () => reqString(o, 'name', 100), base?.name);
    const meterKind = pick('meterKind', () => reqEnum(o, 'meterKind', METER_KINDS), base?.meterKind);
    const category = pick('category', () => reqEnum(o, 'category', TEMPLATE_CATEGORIES), base?.category);
    const commonShareBps = pick('commonShareBps', () => reqInt(o, 'commonShareBps', 0, BPS_TOTAL), base?.commonShareBps);
    const commonKey = pick('commonKey', () => reqEnum(o, 'commonKey', COMMON_KEYS), base?.commonKey);
    const liableParty = pick('liableParty', () => reqEnum(o, 'liableParty', LIABLE_PARTIES), base?.liableParty ?? 'occupant');
    const legalProfile = pick('legalProfile', () => reqEnum(o, 'legalProfile', LEGAL_PROFILES), base?.legalProfile ?? 'none');
    const decisionRef = o.decisionRef === undefined ? base?.decisionRef : o.decisionRef === null ? undefined : reqString(o, 'decisionRef', 120);
    const reason = o.reason === undefined ? base?.reason : o.reason === null ? undefined : reqString(o, 'reason', REASON_MAX);
    const scope = o.scope === undefined ? (base?.scope ?? {}) : await parseScope(ctx, o.scope);
    const incomeAccountId =
      o.incomeAccountId === undefined ? base?.incomeAccountId : o.incomeAccountId === null || o.incomeAccountId === '' ? undefined : await parseIncomeAccount(ctx, o.incomeAccountId);
    if (commonKey === 'land_share') {
      const site = await deps.core.getSite(ctx.apartmentId);
      if (!site?.settings.landShareEnabled) throw new MeterError('unprocessable', 'Bu apartmanda arsa payı anahtarı kapalı (site ayarları)');
    }
    const input: TemplateInput = {
      name,
      meterKind,
      category,
      commonShareBps,
      commonKey,
      liableParty,
      scope,
      legalProfile,
      ...(decisionRef ? { decisionRef } : {}),
      ...(reason ? { reason } : {}),
      ...(incomeAccountId && incomeAccountId !== SYSTEM_ACCOUNTS.incomeDues ? { incomeAccountId } : {}),
    };
    const warnings = legalWarnings(input);
    if (warnings.length && (!input.decisionRef || !input.reason)) {
      throw new MeterError('unprocessable', 'Yönetmelik dışı oran/anahtar için karar referansı (decisionRef) ve gerekçe (reason) zorunlu', { warnings });
    }
    return input;
  }

  const listTemplatesRaw = (apartmentId: string) => repo.list<MeterTemplate>(apartmentId, meterPrefixes.templates);
  const withWarnings = <T extends MeterTemplate>(t: T) => ({ ...t, warnings: legalWarnings(t) });

  async function listTemplates(ctx: MeterContext, q: { includeArchived?: boolean }) {
    const items = (await listTemplatesRaw(ctx.apartmentId)).filter((t) => q.includeArchived || t.status === 'active');
    return items
      .sort((a, b) => a.meterKind.localeCompare(b.meterKind) || Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name, 'tr'))
      .map(withWarnings);
  }

  async function templatePresets(ctx: MeterContext) {
    return templatePresetsFor(await deps.core.getSite(ctx.apartmentId)).map((p) => ({ ...p, warnings: legalWarnings(p) }));
  }

  async function loadTemplate(ctx: MeterContext, templateId: string): Promise<MeterTemplate> {
    assertId(templateId, 'templateId');
    const t = await repo.get<MeterTemplate>(meterKeys.template(ctx.apartmentId, templateId));
    if (!t) throw new MeterError('not_found', 'Dağıtım şablonu bulunamadı');
    return t;
  }

  /** Ayni sayac turundeki diger varsayilan sablonun isaretini kaldiran yazimlar. */
  async function clearDefaults(ctx: MeterContext, meterKind: MeterKind, exceptId: string): Promise<MeterWrite[]> {
    return (await listTemplatesRaw(ctx.apartmentId))
      .filter((t) => t.meterKind === meterKind && t.isDefault && t.templateId !== exceptId)
      .map((t) => replace(bumped(ctx, t, { isDefault: false }), t.version));
  }

  async function createTemplate(ctx: MeterContext, body: unknown) {
    const o = asObject(body);
    const presetName = optString(o, 'preset', 40);
    let base: TemplateInput | undefined;
    if (presetName) {
      const preset = templatePresetsFor(await deps.core.getSite(ctx.apartmentId)).find((p) => p.preset === presetName);
      if (!preset) throw new ValidationError('preset geçersiz (central_heating, hot_water, cold_water)', 'preset');
      const { preset: _p, ...rest } = preset;
      base = rest;
    }
    const input = await parseTemplate(ctx, o, base);
    const isDefault =
      optBool(o, 'isDefault') ?? !(await listTemplatesRaw(ctx.apartmentId)).some((t) => t.status === 'active' && t.meterKind === input.meterKind && t.isDefault);
    const templateId = deps.newId();
    const template: MeterTemplate = {
      ...meterKeys.template(ctx.apartmentId, templateId),
      entityType: 'METER_TEMPLATE',
      templateId,
      apartmentId: ctx.apartmentId,
      ...input,
      isDefault,
      status: 'active',
      ...created(ctx),
    };
    const extra = isDefault ? await clearDefaults(ctx, input.meterKind, templateId) : [];
    await repo.write(
      [create(template), ...extra],
      [audit(ctx, 'meters.template_create', { type: 'meter_template', id: templateId }, { ...input, isDefault, warnings: legalWarnings(input).map((w) => w.code) }, input.reason)],
    );
    return withWarnings(template);
  }

  async function updateTemplate(ctx: MeterContext, templateId: string, body: unknown) {
    const o = asObject(body);
    const version = requireVersion(o);
    const t = await loadTemplate(ctx, templateId);
    if (t.version !== version) throw new MeterError('conflict', 'Şablon başka bir işlemle değişti; yeniden deneyin');
    if (t.status !== 'active') throw new MeterError('unprocessable', 'Arşivlenmiş şablon düzenlenemez');
    if (o.meterKind !== undefined && o.meterKind !== t.meterKind) throw new ValidationError('Şablonun sayaç türü değiştirilemez', 'meterKind');
    const input = await parseTemplate(ctx, o, t);
    const next = bumped(ctx, t, input);
    if (!input.decisionRef) delete next.decisionRef;
    if (!input.reason) delete next.reason;
    if (!input.incomeAccountId) delete next.incomeAccountId;
    await repo.write(
      [replace(next, t.version)],
      [audit(ctx, 'meters.template_update', { type: 'meter_template', id: templateId }, { ...input, warnings: legalWarnings(input).map((w) => w.code) }, input.reason)],
    );
    return withWarnings(next);
  }

  async function setDefaultTemplate(ctx: MeterContext, templateId: string) {
    const t = await loadTemplate(ctx, templateId);
    if (t.status !== 'active') throw new MeterError('unprocessable', 'Arşivlenmiş şablon varsayılan yapılamaz');
    if (t.isDefault) return withWarnings(t);
    const next = bumped(ctx, t, { isDefault: true });
    await repo.write(
      [replace(next, t.version), ...(await clearDefaults(ctx, t.meterKind, templateId))],
      [audit(ctx, 'meters.template_default', { type: 'meter_template', id: templateId }, { meterKind: t.meterKind })],
    );
    return withWarnings(next);
  }

  async function archiveTemplate(ctx: MeterContext, templateId: string, body: unknown) {
    const o = asObject(body);
    const version = requireVersion(o);
    const t = await loadTemplate(ctx, templateId);
    if (t.version !== version) throw new MeterError('conflict', 'Şablon başka bir işlemle değişti; yeniden deneyin');
    if (t.status === 'archived') return withWarnings(t);
    const next = bumped(ctx, t, { status: 'archived', isDefault: false });
    await repo.write([replace(next, t.version)], [audit(ctx, 'meters.template_archive', { type: 'meter_template', id: templateId })]);
    return withWarnings(next);
  }

  // -------------------------------------------------------------------------
  // Dagitim donemleri (taslak; hesap / onay 2.3-3)
  // -------------------------------------------------------------------------

  const snapshotOf = (t: MeterTemplate): TemplateSnapshot => ({
    templateId: t.templateId,
    name: t.name,
    meterKind: t.meterKind,
    category: t.category,
    commonShareBps: t.commonShareBps,
    commonKey: t.commonKey,
    liableParty: t.liableParty,
    scope: t.scope,
    legalProfile: t.legalProfile,
    ...(t.decisionRef ? { decisionRef: t.decisionRef } : {}),
    ...(t.reason ? { reason: t.reason } : {}),
    ...(t.incomeAccountId ? { incomeAccountId: t.incomeAccountId } : {}),
    version: t.version,
  });

  const daySpan = (a: IsoDate, b: IsoDate) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

  function validateDates(startDate: IsoDate, endDate: IsoDate, dueDate: IsoDate) {
    if (endDate < startDate) throw new ValidationError('endDate startDate tarihinden önce olamaz', 'endDate');
    if (daySpan(startDate, endDate) > MAX_PERIOD_DAYS) throw new ValidationError(`Dönem en fazla ${MAX_PERIOD_DAYS} gün olabilir`, 'endDate');
    if (dueDate < endDate) throw new ValidationError('dueDate dönem bitişinden önce olamaz', 'dueDate');
  }

  /** Ayni sayac turunde gecerli (iptal / geri alinmis olmayan) donemler cakisamaz. */
  async function assertNoOverlap(ctx: MeterContext, meterKind: MeterKind, startDate: IsoDate, endDate: IsoDate, exceptId?: string) {
    const clash = (await repo.list<MeterPeriod>(ctx.apartmentId, meterPrefixes.periods)).find(
      (p) =>
        p.periodId !== exceptId &&
        p.meterKind === meterKind &&
        p.status !== 'reversed' &&
        p.status !== 'cancelled' &&
        p.startDate <= endDate &&
        startDate <= p.endDate,
    );
    if (clash) throw new MeterError('conflict', `Bu tarih aralığı "${clash.name}" dönemiyle çakışıyor`);
  }

  function parseAmount(o: Obj): number | undefined {
    if (o.totalAmount === undefined || o.totalAmount === null) return undefined;
    return reqInt(o, 'totalAmount', 1, MAX_AMOUNT);
  }

  /** Donem faturalari (gider kayitlari): en fazla 20, tekrarsiz. */
  function parseExpenseIds(o: Obj): string[] | undefined {
    if (o.expenseIds === undefined) return undefined;
    if (!Array.isArray(o.expenseIds) || o.expenseIds.length > MAX_EXPENSES_PER_PERIOD) {
      throw new ValidationError(`expenseIds en fazla ${MAX_EXPENSES_PER_PERIOD} öğeli dizi olmalı`, 'expenseIds');
    }
    const ids = o.expenseIds.map((x) => assertId(x, 'expenseIds'));
    if (new Set(ids).size !== ids.length) throw new ValidationError('expenseIds tekrarlı', 'expenseIds');
    return ids;
  }

  /** Faturalarin toplami (kurus); bulunamayan fatura 404. */
  async function expenseTotal(ctx: MeterContext, ids: readonly string[]): Promise<number> {
    let sum = 0;
    for (const id of ids) {
      const e = await deps.expenses.getExpense(ctx.apartmentId, id);
      if (!e) throw new MeterError('not_found', `Gider (fatura) bulunamadı: ${id}`);
      sum += e.amount;
    }
    return sum;
  }

  /** Fatura bagliysa tutar faturalarin toplamidir; elle girilen farkli tutar reddedilir. */
  async function amountFor(ctx: MeterContext, ids: readonly string[], manual: number | undefined): Promise<number | undefined> {
    if (ids.length === 0) return manual;
    const sum = await expenseTotal(ctx, ids);
    if (manual !== undefined && manual !== sum) {
      throw new MeterError('unprocessable', `Tutar (${manual}) bağlı faturaların toplamıyla (${sum}) uyuşmuyor`);
    }
    return sum;
  }

  /**
   * 2.3-5b: donem formundaki fatura secicisi. Son giderler (yeniden eskiye) ve her birinin
   * aktif EXPDIST kilidi (hangi donemde dagitildigi). Kilitli olan secilemez; asil koruma
   * yine donem olusturmadaki kosullu yazimdir.
   */
  async function listExpenseOptions(ctx: MeterContext, q: { from?: string } = {}) {
    if (!deps.expenses.listExpenses) return [];
    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : undefined;
    const [expenses, locks] = await Promise.all([
      deps.expenses.listExpenses(ctx.apartmentId),
      repo.list<MeterExpenseLock>(ctx.apartmentId, 'EXPDIST#'),
    ]);
    const lockedBy = new Map(locks.filter((l) => l.status === 'active').map((l) => [l.expenseId, l.periodId]));
    return expenses
      .filter((e) => !from || e.date >= from)
      .sort((a, b) => b.date.localeCompare(a.date) || b.expenseId.localeCompare(a.expenseId))
      .slice(0, 200)
      .map((e) => ({
        expenseId: e.expenseId,
        date: e.date,
        description: e.description,
        amount: e.amount,
        ...(e.supplier ? { supplier: e.supplier } : {}),
        ...(e.invoiceNumber ? { invoiceNumber: e.invoiceNumber } : {}),
        hasInvoice: !!e.invoice,
        ...(lockedBy.has(e.expenseId) ? { lockedBy: lockedBy.get(e.expenseId) } : {}),
      }));
  }

  async function listPeriods(ctx: MeterContext, q: { status?: string; meterKind?: string }) {
    let items = await repo.list<MeterPeriod>(ctx.apartmentId, meterPrefixes.periods);
    if (q.status === 'open') items = items.filter((p) => OPEN_PERIOD_STATUSES.includes(p.status));
    else if (q.status && q.status !== 'all') items = items.filter((p) => p.status === q.status);
    if (q.meterKind) items = items.filter((p) => p.meterKind === q.meterKind);
    return items.sort((a, b) => b.endDate.localeCompare(a.endDate) || b.createdAt.localeCompare(a.createdAt));
  }

  async function loadPeriod(ctx: MeterContext, periodId: string): Promise<MeterPeriod> {
    assertId(periodId, 'periodId');
    const p = await repo.get<MeterPeriod>(meterKeys.period(ctx.apartmentId, periodId));
    if (!p) throw new MeterError('not_found', 'Dağıtım dönemi bulunamadı');
    return p;
  }

  async function createPeriod(ctx: MeterContext, body: unknown) {
    const o = asObject(body);
    const t = await loadTemplate(ctx, reqString(o, 'templateId', 64));
    if (t.status !== 'active') throw new MeterError('unprocessable', 'Arşivlenmiş şablonla dönem açılamaz');
    const name = reqString(o, 'name', 100);
    const startDate = reqDate(o, 'startDate');
    const endDate = reqDate(o, 'endDate');
    const dueDate = reqDate(o, 'dueDate');
    validateDates(startDate, endDate, dueDate);
    const expenseIds = parseExpenseIds(o) ?? [];
    const totalAmount = await amountFor(ctx, expenseIds, parseAmount(o));
    await assertNoOverlap(ctx, t.meterKind, startDate, endDate);
    const periodId = deps.newId();
    const period: MeterPeriod = {
      ...meterKeys.period(ctx.apartmentId, periodId),
      entityType: 'METER_PERIOD',
      periodId,
      apartmentId: ctx.apartmentId,
      name,
      templateId: t.templateId,
      template: snapshotOf(t),
      meterKind: t.meterKind,
      startDate,
      endDate,
      accrualDate: endDate,
      dueDate,
      ...(totalAmount !== undefined ? { totalAmount } : {}),
      expenseIds,
      status: 'draft',
      ...created(ctx),
    };
    const locks = await planExpenseLocks(repo, { apartmentId: ctx.apartmentId, periodId, acquire: expenseIds, release: [], actorId: ctx.userId, at: stamp() });
    await repo.write(
      [create(period), ...locks],
      [
        audit(ctx, 'meters.period_create', { type: 'meter_period', id: periodId }, {
          name,
          templateId: t.templateId,
          meterKind: t.meterKind,
          startDate,
          endDate,
          dueDate,
          totalAmount,
          ...(expenseIds.length ? { expenseIds } : {}),
        }),
      ],
    );
    return period;
  }

  async function updatePeriod(ctx: MeterContext, periodId: string, body: unknown) {
    const o = asObject(body);
    const version = requireVersion(o);
    const p = await loadPeriod(ctx, periodId);
    if (p.version !== version) throw new MeterError('conflict', 'Dönem başka bir işlemle değişti; yeniden deneyin');
    if (!OPEN_PERIOD_STATUSES.includes(p.status)) throw new MeterError('unprocessable', 'Yalnızca taslak dönem düzenlenebilir');
    const patch: Partial<MeterPeriod> = { status: 'draft' };
    const changed: Record<string, unknown> = {};
    if (o.name !== undefined) {
      patch.name = reqString(o, 'name', 100);
      changed.name = patch.name;
    }
    const startDate = optDate(o, 'startDate') ?? p.startDate;
    const endDate = optDate(o, 'endDate') ?? p.endDate;
    const dueDate = optDate(o, 'dueDate') ?? p.dueDate;
    if (startDate !== p.startDate || endDate !== p.endDate || dueDate !== p.dueDate) {
      validateDates(startDate, endDate, dueDate);
      if (startDate !== p.startDate || endDate !== p.endDate) await assertNoOverlap(ctx, p.meterKind, startDate, endDate, p.periodId);
      Object.assign(patch, { startDate, endDate, dueDate, accrualDate: endDate });
      Object.assign(changed, { startDate, endDate, dueDate });
    }
    const newExpenses = parseExpenseIds(o);
    let locks: MeterWrite[] = [];
    if (newExpenses !== undefined || o.totalAmount !== undefined) {
      const ids = newExpenses ?? p.expenseIds;
      const manual = o.totalAmount !== undefined ? parseAmount(o) : ids.length ? undefined : p.totalAmount;
      patch.totalAmount = await amountFor(ctx, ids, manual);
      changed.totalAmount = patch.totalAmount ?? null;
      if (newExpenses !== undefined) {
        patch.expenseIds = newExpenses;
        changed.expenseIds = newExpenses;
        locks = await planExpenseLocks(repo, {
          apartmentId: ctx.apartmentId,
          periodId: p.periodId,
          acquire: newExpenses.filter((e) => !p.expenseIds.includes(e)),
          release: p.expenseIds.filter((e) => !newExpenses.includes(e)),
          actorId: ctx.userId,
          at: stamp(),
        });
      }
    }
    if (optBool(o, 'refreshTemplate')) {
      const t = await loadTemplate(ctx, p.templateId);
      if (t.status !== 'active') throw new MeterError('unprocessable', 'Şablon arşivlenmiş');
      patch.template = snapshotOf(t);
      changed.templateVersion = t.version;
    }
    const next = bumped(ctx, p, patch);
    if (next.totalAmount === undefined) delete next.totalAmount;
    await repo.write([replace(next, p.version), ...locks], [audit(ctx, 'meters.period_update', { type: 'meter_period', id: periodId }, changed)]);
    return next;
  }

  async function cancelPeriod(ctx: MeterContext, periodId: string, body: unknown) {
    const o = asObject(body);
    const version = requireVersion(o);
    const reason = reqString(o, 'reason', REASON_MAX);
    const p = await loadPeriod(ctx, periodId);
    if (p.version !== version) throw new MeterError('conflict', 'Dönem başka bir işlemle değişti; yeniden deneyin');
    if (!OPEN_PERIOD_STATUSES.includes(p.status)) throw new MeterError('unprocessable', 'Yalnızca taslak dönem iptal edilebilir; onaylı dönem geri alınır');
    const next = bumped(ctx, p, { status: 'cancelled' });
    const locks = await planExpenseLocks(repo, { apartmentId: ctx.apartmentId, periodId, acquire: [], release: p.expenseIds, actorId: ctx.userId, at: stamp() });
    await repo.write([replace(next, p.version), ...locks], [audit(ctx, 'meters.period_cancel', { type: 'meter_period', id: periodId }, undefined, reason)]);
    return next;
  }

  return {
    // Sicil
    listMeters,
    getMeter,
    createMeter,
    updateMeter,
    retireMeter,
    createMeterPhotoUpload,
    // Degisim / sifirlama
    previewSwap,
    createSwap,
    listSwaps,
    getSwap: loadSwap,
    reverseSwap,
    swapPhoto,
    // Sablon
    listTemplates,
    templatePresets,
    getTemplate: async (ctx: MeterContext, id: string) => withWarnings(await loadTemplate(ctx, id)),
    createTemplate,
    updateTemplate,
    setDefaultTemplate,
    archiveTemplate,
    // Donem
    listExpenseOptions,
    listPeriods,
    getPeriod: loadPeriod,
    createPeriod,
    updatePeriod,
    cancelPeriod,
  };
}

export type MeterService = ReturnType<typeof createMeterService>;
