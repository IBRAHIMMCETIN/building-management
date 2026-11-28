import { randomUUID } from 'node:crypto';
import { DEFAULT_TICKET_SETTINGS, TICKET_PRIORITIES, type TicketSettings } from '../tickets/types.js';
import { simpleModeFeatures } from '../features/catalog.js';
import { type CoreRepository, coreKeys, coreRepository } from './repository.js';
import {
  type Address,
  type Block,
  DISTRIBUTION_KEYS,
  type ExpenseGroup,
  type ExpenseGroupRule,
  type LandShare,
  type LiableParty,
  type MeterSplitRule,
  type MonthlyDuesPlan,
  type Site,
  type SiteSettings,
  type SiteType,
  type Unit,
  type UnitExemption,
  type UnitType,
  tenthsM2ToM2,
  toKurus,
  toTenthsM2,
} from './types.js';
import {
  type Obj,
  ValidationError,
  asObject,
  assertId,
  isIsoDate,
  optBool,
  optEnum,
  optInt,
  optString,
  optStringArray,
  reqEnum,
  reqInt,
  reqString,
} from './validation.js';

// ---------------------------------------------------------------------------
// Hatalar
// ---------------------------------------------------------------------------

export type CoreErrorCode = 'not_found' | 'conflict';

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly httpStatus: 404 | 409;

  constructor(code: CoreErrorCode, message: string) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.httpStatus = code === 'not_found' ? 404 : 409;
  }
}

// ---------------------------------------------------------------------------
// Sabitler ve varsayilanlar
// ---------------------------------------------------------------------------

const SITE_TYPES = ['apartment', 'site', 'residence'] as const satisfies readonly SiteType[];
const UNIT_TYPES = [
  'flat',
  'duplex',
  'shop',
  'office',
  'parking',
  'storage',
  'other',
] as const satisfies readonly UnitType[];
const EXPENSE_GROUPS = [
  'operating',
  'heating',
  'capital',
  'other',
] as const satisfies readonly ExpenseGroup[];
const LIABLE_PARTIES = ['occupant', 'owner'] as const satisfies readonly LiableParty[];
const METER_COMMON_KEYS = ['equal', 'land_share', 'area'] as const;

const MAX_UNIT_AREA_M2 = 100_000;

export const DEFAULT_EXPENSE_GROUP_RULES: readonly ExpenseGroupRule[] = [
  { group: 'operating', defaultKey: 'equal', liableParty: 'occupant' },
  { group: 'heating', defaultKey: 'area', liableParty: 'occupant' },
  { group: 'capital', defaultKey: 'equal', liableParty: 'owner' },
  { group: 'other', defaultKey: 'equal', liableParty: 'occupant' },
];

/** KMK m.20: gecikme tazminati aylik %5 (500 baz puan) olarak varsayilir. */
export function defaultSiteSettings(): SiteSettings {
  return {
    landShareEnabled: false,
    expenseGroupRules: DEFAULT_EXPENSE_GROUP_RULES.map((rule) => ({ ...rule })),
    dueDayOfMonth: 10,
    lateFeeMonthlyBasisPoints: 500,
    timezone: 'Europe/Istanbul',
    currency: 'TRY',
  };
}

// ---------------------------------------------------------------------------
// Arsa payi hesaplari (kesirli sayi hatasi olmamasi icin BigInt rasyonel)
// ---------------------------------------------------------------------------

export type Fraction = { numerator: bigint; denominator: bigint };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

/** Arsa paylarinin toplami (indirgenmis kesir). Bos liste 0/1 verir. */
export function sumLandShares(shares: readonly LandShare[]): Fraction {
  let numerator = 0n;
  let denominator = 1n;

  for (const share of shares) {
    const n = BigInt(share.numerator);
    const d = BigInt(share.denominator);
    numerator = numerator * d + n * denominator;
    denominator = denominator * d;
    const divisor = gcd(numerator, denominator);
    if (divisor > 1n) {
      numerator /= divisor;
      denominator /= divisor;
    }
  }

  return { numerator, denominator };
}

export function isAtMostOne(total: Fraction): boolean {
  return total.numerator <= total.denominator;
}

export function isExactlyOne(total: Fraction): boolean {
  return total.numerator === total.denominator;
}

// ---------------------------------------------------------------------------
// Girdi cozumleme
// ---------------------------------------------------------------------------

function parseAddress(value: unknown): Address {
  const o = asObject(value, 'address');
  const postalCode = optString(o, 'postalCode', 5);
  if (postalCode !== undefined && !/^\d{5}$/.test(postalCode)) {
    throw new ValidationError('postalCode 5 haneli olmalidir', 'postalCode');
  }
  return {
    line1: reqString(o, 'line1', 200),
    line2: optString(o, 'line2', 200),
    district: reqString(o, 'district', 80),
    city: reqString(o, 'city', 80),
    postalCode,
  };
}

function parseExpenseGroupRules(value: unknown): ExpenseGroupRule[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > EXPENSE_GROUPS.length) {
    throw new ValidationError('expenseGroupRules dolu bir dizi olmalidir', 'expenseGroupRules');
  }
  const seen = new Set<string>();
  return value.map((raw, i) => {
    const o = asObject(raw, `expenseGroupRules[${i}]`);
    const group = reqEnum(o, 'group', EXPENSE_GROUPS);
    if (seen.has(group)) {
      throw new ValidationError(`expenseGroupRules icinde ${group} tekrar ediyor`, 'expenseGroupRules');
    }
    seen.add(group);
    return {
      group,
      defaultKey: reqEnum(o, 'defaultKey', DISTRIBUTION_KEYS),
      liableParty: reqEnum(o, 'liableParty', LIABLE_PARTIES),
    };
  });
}

function parseMeterSplit(value: unknown): MeterSplitRule {
  const o = asObject(value, 'meterSplit');
  return {
    commonSharePercent: reqInt(o, 'commonSharePercent', 0, 100),
    commonShareKey: reqEnum(o, 'commonShareKey', METER_COMMON_KEYS),
  };
}

/** Aylik aidat plani tutar ust siniri: 999.999.999,99 TL (finans MAX_AMOUNT ile ayni). */
const MAX_PLAN_AMOUNT = 99_999_999_999;

function parseMonthlyDuesPlan(value: unknown): MonthlyDuesPlan {
  const o = asObject(value, 'monthlyDuesPlan');
  return {
    enabled: optBool(o, 'enabled') ?? true,
    totalAmount: toKurus(reqInt(o, 'totalAmount', 1, MAX_PLAN_AMOUNT)),
    distributionKey: reqEnum(o, 'distributionKey', METER_COMMON_KEYS),
    liableParty: reqEnum(o, 'liableParty', LIABLE_PARTIES),
    // Finans 2.4: hesap varligi/turu tahakkuk aninda finans servisinde dogrulanir.
    ...(o.incomeAccountId != null && o.incomeAccountId !== '' ? { incomeAccountId: assertId(o.incomeAccountId, 'monthlyDuesPlan.incomeAccountId') } : {}),
    ...(o.budgetId != null && o.budgetId !== '' ? { budgetId: assertId(o.budgetId, 'monthlyDuesPlan.budgetId') } : {}),
  };
}

/**
 * Faz 3 (O1): ariza / talep ayarlari. Kismi girdi mevcut (yoksa varsayilan) ayarin uzerine yazilir.
 * SLA 1-720 saat, otomatik kapanis 1-60 gun.
 */
function parseTicketSettings(value: unknown, base: TicketSettings | undefined): TicketSettings {
  const o = asObject(value, 'tickets');
  const current = base ?? DEFAULT_TICKET_SETTINGS;
  const slaHours = { ...DEFAULT_TICKET_SETTINGS.slaHours, ...current.slaHours };
  if (o.slaHours !== undefined) {
    const h = asObject(o.slaHours, 'tickets.slaHours');
    for (const p of TICKET_PRIORITIES) {
      const v = optInt(h, p, 1, 720);
      if (v !== undefined) slaHours[p] = v;
    }
  }
  return {
    slaHours,
    staffSelfAssign: optBool(o, 'staffSelfAssign') ?? current.staffSelfAssign,
    autoCloseDays: optInt(o, 'autoCloseDays', 1, 60) ?? current.autoCloseDays,
  };
}

/** `base` uzerine kismi `settings` girdisini uygular ve capraz kurallari dogrular. */
function parseSettings(value: unknown, base: SiteSettings): SiteSettings {
  const o = asObject(value, 'settings');

  let meterSplit = base.meterSplit;
  if (o.meterSplit === null) meterSplit = undefined;
  else if (o.meterSplit !== undefined) meterSplit = parseMeterSplit(o.meterSplit);

  let monthlyDuesPlan = base.monthlyDuesPlan;
  if (o.monthlyDuesPlan === null) monthlyDuesPlan = undefined;
  else if (o.monthlyDuesPlan !== undefined) monthlyDuesPlan = parseMonthlyDuesPlan(o.monthlyDuesPlan);

  let tickets = base.tickets;
  if (o.tickets === null) tickets = undefined;
  else if (o.tickets !== undefined) tickets = parseTicketSettings(o.tickets, base.tickets);

  const settings: SiteSettings = {
    landShareEnabled: optBool(o, 'landShareEnabled') ?? base.landShareEnabled,
    expenseGroupRules:
      o.expenseGroupRules === undefined
        ? base.expenseGroupRules
        : parseExpenseGroupRules(o.expenseGroupRules),
    meterSplit,
    dueDayOfMonth: optInt(o, 'dueDayOfMonth', 1, 28) ?? base.dueDayOfMonth,
    lateFeeMonthlyBasisPoints:
      optInt(o, 'lateFeeMonthlyBasisPoints', 0, 10_000) ?? base.lateFeeMonthlyBasisPoints,
    monthlyDuesPlan,
    ...(tickets ? { tickets } : {}),
    // Adim 1: ozellik anahtarlari yalnizca platform uclarindan yazilir; girdideki `features` yok sayilir.
    ...(base.features ? { features: base.features } : {}),
    timezone: 'Europe/Istanbul',
    currency: 'TRY',
  };

  for (const rule of settings.expenseGroupRules) {
    if (rule.defaultKey === 'land_share' && !settings.landShareEnabled) {
      throw new ValidationError(
        `${rule.group} icin arsa payi anahtari secilemez: landShareEnabled kapali`,
        'expenseGroupRules',
      );
    }
    if (rule.defaultKey === 'meter' && !settings.meterSplit) {
      throw new ValidationError(
        `${rule.group} icin sayac anahtari secilemez: meterSplit tanimli degil`,
        'expenseGroupRules',
      );
    }
  }
  if (settings.monthlyDuesPlan?.distributionKey === 'land_share' && !settings.landShareEnabled) {
    throw new ValidationError(
      'monthlyDuesPlan.distributionKey land_share olamaz: landShareEnabled kapali',
      'monthlyDuesPlan',
    );
  }
  if (settings.meterSplit?.commonShareKey === 'land_share' && !settings.landShareEnabled) {
    throw new ValidationError(
      'meterSplit.commonShareKey land_share olamaz: landShareEnabled kapali',
      'meterSplit',
    );
  }

  return settings;
}

function parseLandShare(value: unknown): LandShare {
  const o = asObject(value, 'landShare');
  const numerator = reqInt(o, 'numerator', 1, 1_000_000_000);
  const denominator = reqInt(o, 'denominator', 1, 1_000_000_000);
  if (numerator > denominator) {
    throw new ValidationError('landShare payi paydadan buyuk olamaz', 'landShare');
  }
  return { numerator, denominator };
}

function areaToTenths(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_UNIT_AREA_M2) {
    throw new ValidationError(
      `grossAreaM2 0 ile ${MAX_UNIT_AREA_M2} arasinda pozitif bir sayi olmalidir`,
      'grossAreaM2',
    );
  }
  try {
    return toTenthsM2(value);
  } catch {
    throw new ValidationError('grossAreaM2 en az 0,1 olmalidir', 'grossAreaM2');
  }
}

function optDate(o: Obj, key: string): string | undefined {
  const text = optString(o, key, 10);
  if (text !== undefined && !isIsoDate(text)) {
    throw new ValidationError(`${key} YYYY-MM-DD biciminde gecerli bir tarih olmalidir`, key);
  }
  return text;
}

function parseExemptions(value: unknown): UnitExemption[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ValidationError('exemptions en fazla 20 ogeli bir dizi olmalidir', 'exemptions');
  }
  return value.map((raw, i) => {
    const o = asObject(raw, `exemptions[${i}]`);
    const validFrom = optDate(o, 'validFrom');
    const validTo = optDate(o, 'validTo');
    if (validFrom && validTo && validFrom > validTo) {
      throw new ValidationError('validTo, validFrom tarihinden once olamaz', 'validTo');
    }
    return {
      expenseCategory: reqString(o, 'expenseCategory', 50),
      reason: optString(o, 'reason', 200),
      validFrom,
      validTo,
    };
  });
}

/** PATCH: alan yoksa mevcut deger, `null` ise temizle, aksi halde ayristir. */
function patchOptional<T>(
  o: Obj,
  key: string,
  parse: () => T,
  current: T | undefined,
): T | undefined {
  if (o[key] === undefined) return current;
  if (o[key] === null) return undefined;
  return parse();
}

function sameText(a: string, b: string): boolean {
  return a.toLocaleLowerCase('tr-TR') === b.toLocaleLowerCase('tr-TR');
}

function assertVersion(current: number, requested: number): void {
  if (current !== requested) {
    throw new CoreError('conflict', 'Kayit baska bir islemle degistirildi (surum uyusmazligi)');
  }
}

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

export type UnitView = Unit & { grossAreaM2: number };

export type LandShareSummary = {
  numerator: string;
  denominator: string;
  /** Arsa paylarinin toplami tam 1 ise true. */
  isComplete: boolean;
};

export type UnitListSummary = {
  activeUnitCount: number;
  totalGrossAreaTenthsM2: number;
  landShare: LandShareSummary;
};

export type EntityStatusFilter = 'active' | 'inactive' | 'all';

export type CoreServiceDeps = {
  repository: CoreRepository;
  now: () => Date;
  newId: () => string;
  /**
   * Finans 2.4: aylik aidat planinda secilen gelir hesabinin aktif bir gelir hesabi oldugunu
   * ayarlar kaydedilirken dogrular (yoksa yalnizca tahakkuk aninda dogrulanir).
   */
  validateIncomeAccount?: (apartmentId: string, actor: string, accountId: string) => Promise<void>;
  /**
   * Abonelik: yeni bolumle olusacak aktif bolum sayisi plan limitini asiyorsa hata firlatir
   * (`403 plan_limit_exceeded`; bolum ekleme ve toplu aktarim ayni yoldan gecer).
   */
  assertUnitCapacity?: (apartmentId: string, nextActiveUnits: number) => Promise<void>;
};

export function toUnitView(unit: Unit): UnitView {
  return { ...unit, grossAreaM2: tenthsM2ToM2(unit.grossAreaTenthsM2) };
}

export function createCoreService(overrides: Partial<CoreServiceDeps> = {}) {
  const deps: CoreServiceDeps = {
    repository: coreRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.repository;

  const stamp = () => deps.now().toISOString();

  function newAudit(actor: string) {
    const ts = stamp();
    return { createdAt: ts, createdBy: actor, updatedAt: ts, updatedBy: actor, version: 1 };
  }

  function touch(actor: string, previousVersion: number) {
    return { updatedAt: stamp(), updatedBy: actor, version: previousVersion + 1 };
  }

  function matchesStatus(status: Site['status'], filter: EntityStatusFilter): boolean {
    return filter === 'all' || status === filter;
  }

  async function requireSite(apartmentId: string): Promise<Site> {
    const site = await repo.getSite(apartmentId);
    if (!site) throw new CoreError('not_found', 'Site bulunamadi');
    return site;
  }

  async function requireBlock(apartmentId: string, blockId: string): Promise<Block> {
    assertId(blockId, 'blockId');
    const block = await repo.getBlock(apartmentId, blockId);
    if (!block) throw new CoreError('not_found', 'Blok bulunamadi');
    return block;
  }

  async function requireUnit(apartmentId: string, unitId: string): Promise<Unit> {
    assertId(unitId, 'unitId');
    const unit = await repo.getUnit(apartmentId, unitId);
    if (!unit) throw new CoreError('not_found', 'Bagimsiz bolum bulunamadi');
    return unit;
  }

  function assertLandShareTotal(units: Unit[], selfId: string | undefined, candidate: LandShare) {
    const shares = units
      .filter((u) => u.status === 'active' && u.unitId !== selfId && u.landShare)
      .map((u) => u.landShare as LandShare);
    shares.push(candidate);
    if (!isAtMostOne(sumLandShares(shares))) {
      throw new CoreError('conflict', "Toplam arsa payi 1'i asamaz");
    }
  }

  // ----- Site -----

  async function createSite(actor: string, tenantId: string, input: unknown): Promise<Site> {
    assertId(tenantId, 'tenantId');
    const o = asObject(input);

    const siteId = deps.newId();
    const site: Site = {
      ...coreKeys.site(siteId),
      entityType: 'SITE',
      status: 'active',
      ...newAudit(actor),
      siteId,
      tenantId,
      name: reqString(o, 'name', 120),
      type: reqEnum(o, 'type', SITE_TYPES),
      address: parseAddress(o.address),
      fiscalYearStartMonth: optInt(o, 'fiscalYearStartMonth', 1, 12) ?? 1,
      settings: {
        ...(o.settings === undefined ? defaultSiteSettings() : parseSettings(o.settings, defaultSiteSettings())),
        // Adim 1: yeni siteler sade modla baslar (gizlemeler kapali); platform istedigini acar.
        features: simpleModeFeatures(),
      },
    };

    await repo.createSite(site);
    return site;
  }

  function getSite(apartmentId: string): Promise<Site> {
    return requireSite(apartmentId);
  }

  /**
   * Platform dizini: tum apartmanlarin yalnizca kimlik/adres/durum bilgisi (finans, daire ve
   * kisi verisi yok; platform_admin apartman verisini okuyamaz). Ada gore sirali.
   */
  async function listSiteDirectory() {
    const ids = await repo.listSiteIds();
    const sites = await Promise.all(ids.map((id) => repo.getSite(id)));
    return sites
      .filter((s): s is Site => Boolean(s))
      .map((s) => ({
        siteId: s.siteId,
        tenantId: s.tenantId,
        name: s.name,
        type: s.type,
        city: s.address.city,
        district: s.address.district,
        status: s.status,
        createdAt: s.createdAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  }

  async function updateSite(actor: string, apartmentId: string, input: unknown): Promise<Site> {
    const o = asObject(input);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await requireSite(apartmentId);
    assertVersion(current.version, version);

    const updated: Site = {
      ...current,
      name: optString(o, 'name', 120) ?? current.name,
      type: optEnum(o, 'type', SITE_TYPES) ?? current.type,
      address: o.address === undefined ? current.address : parseAddress(o.address),
      fiscalYearStartMonth: optInt(o, 'fiscalYearStartMonth', 1, 12) ?? current.fiscalYearStartMonth,
      settings:
        o.settings === undefined ? current.settings : parseSettings(o.settings, current.settings),
      ...touch(actor, version),
    };
    const planAccount = updated.settings.monthlyDuesPlan?.incomeAccountId;
    if (o.settings !== undefined && planAccount && planAccount !== current.settings.monthlyDuesPlan?.incomeAccountId && deps.validateIncomeAccount) {
      await deps.validateIncomeAccount(apartmentId, actor, planAccount);
    }

    await repo.updateSite(updated, version);
    return updated;
  }

  // ----- Blok -----

  async function listBlocks(
    apartmentId: string,
    status: EntityStatusFilter = 'active',
  ): Promise<Block[]> {
    const blocks = await repo.listBlocks(apartmentId);
    return blocks
      .filter((b) => matchesStatus(b.status, status))
      .sort((a, b) => a.name.localeCompare(b.name, 'tr', { numeric: true }));
  }

  async function getBlock(apartmentId: string, blockId: string): Promise<Block> {
    return requireBlock(apartmentId, blockId);
  }

  async function createBlock(actor: string, apartmentId: string, input: unknown): Promise<Block> {
    await requireSite(apartmentId);
    const o = asObject(input);
    const name = reqString(o, 'name', 60);

    const existing = await repo.listBlocks(apartmentId);
    if (existing.some((b) => sameText(b.name, name))) {
      throw new CoreError('conflict', 'Bu isimde bir blok zaten var');
    }

    const blockId = deps.newId();
    const block: Block = {
      ...coreKeys.block(apartmentId, blockId),
      entityType: 'BLOCK',
      status: 'active',
      ...newAudit(actor),
      blockId,
      siteId: apartmentId,
      name,
      floorCount: optInt(o, 'floorCount', 1, 200),
      tags: optStringArray(o, 'tags', 20, 30),
    };

    await repo.createBlock(block);
    return block;
  }

  async function updateBlock(
    actor: string,
    apartmentId: string,
    blockId: string,
    input: unknown,
  ): Promise<Block> {
    const o = asObject(input);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await requireBlock(apartmentId, blockId);
    assertVersion(current.version, version);

    const name = optString(o, 'name', 60) ?? current.name;
    if (!sameText(name, current.name)) {
      const blocks = await repo.listBlocks(apartmentId);
      if (blocks.some((b) => b.blockId !== current.blockId && sameText(b.name, name))) {
        throw new CoreError('conflict', 'Bu isimde bir blok zaten var');
      }
    }

    const updated: Block = {
      ...current,
      name,
      floorCount: patchOptional(o, 'floorCount', () => reqInt(o, 'floorCount', 1, 200), current.floorCount),
      tags: patchOptional(
        o,
        'tags',
        () => optStringArray(o, 'tags', 20, 30) as string[],
        current.tags,
      ),
      ...touch(actor, version),
    };

    await repo.updateBlock(updated, version);
    return updated;
  }

  async function deactivateBlock(actor: string, apartmentId: string, blockId: string): Promise<Block> {
    const current = await requireBlock(apartmentId, blockId);
    if (current.status === 'inactive') return current;

    const units = await repo.listUnits(apartmentId);
    if (units.some((u) => u.blockId === current.blockId && u.status === 'active')) {
      throw new CoreError('conflict', 'Blokta aktif bagimsiz bolumler var; once pasife alin');
    }

    const updated: Block = { ...current, status: 'inactive', ...touch(actor, current.version) };
    await repo.updateBlock(updated, current.version);
    return updated;
  }

  // ----- Bagimsiz bolum -----

  async function listUnits(
    apartmentId: string,
    filter: { blockId?: string; status?: EntityStatusFilter } = {},
  ): Promise<{ items: UnitView[]; summary: UnitListSummary }> {
    const blockId = filter.blockId === undefined ? undefined : assertId(filter.blockId, 'blockId');
    const status = filter.status ?? 'active';

    const all = await repo.listUnits(apartmentId);
    const items = all
      .filter((u) => (blockId === undefined || u.blockId === blockId) && matchesStatus(u.status, status))
      .sort(
        (a, b) =>
          a.blockId.localeCompare(b.blockId) ||
          a.number.localeCompare(b.number, 'tr', { numeric: true }),
      );

    const active = items.filter((u) => u.status === 'active');
    const total = sumLandShares(active.flatMap((u) => (u.landShare ? [u.landShare] : [])));

    return {
      items: items.map(toUnitView),
      summary: {
        activeUnitCount: active.length,
        totalGrossAreaTenthsM2: active.reduce((sum, u) => sum + u.grossAreaTenthsM2, 0),
        landShare: {
          numerator: total.numerator.toString(),
          denominator: total.denominator.toString(),
          isComplete: isExactlyOne(total),
        },
      },
    };
  }

  async function getUnit(apartmentId: string, unitId: string): Promise<UnitView> {
    return toUnitView(await requireUnit(apartmentId, unitId));
  }

  async function createUnit(actor: string, apartmentId: string, input: unknown): Promise<UnitView> {
    await requireSite(apartmentId);
    const o = asObject(input);

    const blockId = assertId(o.blockId, 'blockId');
    const block = await repo.getBlock(apartmentId, blockId);
    if (!block || block.status !== 'active') {
      throw new CoreError('not_found', 'Blok bulunamadi veya pasif');
    }

    const number = reqString(o, 'number', 20);
    const type = reqEnum(o, 'type', UNIT_TYPES);
    const grossAreaTenthsM2 = areaToTenths(o.grossAreaM2);
    const floor = optInt(o, 'floor', -5, 200);
    const landShare = o.landShare == null ? undefined : parseLandShare(o.landShare);
    const exemptions = o.exemptions === undefined ? [] : parseExemptions(o.exemptions);

    const units = await repo.listUnits(apartmentId);
    if (units.some((u) => u.blockId === blockId && sameText(u.number, number))) {
      throw new CoreError('conflict', 'Bu blokta ayni numarali bagimsiz bolum zaten var');
    }
    if (landShare) assertLandShareTotal(units, undefined, landShare);
    await deps.assertUnitCapacity?.(apartmentId, units.filter((u) => u.status === 'active').length + 1);

    const unitId = deps.newId();
    const unit: Unit = {
      ...coreKeys.unit(apartmentId, unitId),
      entityType: 'UNIT',
      status: 'active',
      ...newAudit(actor),
      unitId,
      siteId: apartmentId,
      blockId,
      number,
      floor,
      type,
      grossAreaTenthsM2,
      landShare,
      exemptions,
    };

    await repo.createUnit(unit);
    return toUnitView(unit);
  }

  async function updateUnit(
    actor: string,
    apartmentId: string,
    unitId: string,
    input: unknown,
  ): Promise<UnitView> {
    const o = asObject(input);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await requireUnit(apartmentId, unitId);
    assertVersion(current.version, version);

    if (o.blockId !== undefined && o.blockId !== current.blockId) {
      throw new ValidationError('blockId degistirilemez', 'blockId');
    }

    const number = optString(o, 'number', 20) ?? current.number;
    const landShare = patchOptional(o, 'landShare', () => parseLandShare(o.landShare), current.landShare);

    const needsUnits = !sameText(number, current.number) || landShare !== current.landShare;
    if (needsUnits) {
      const units = await repo.listUnits(apartmentId);
      if (
        !sameText(number, current.number) &&
        units.some(
          (u) => u.unitId !== current.unitId && u.blockId === current.blockId && sameText(u.number, number),
        )
      ) {
        throw new CoreError('conflict', 'Bu blokta ayni numarali bagimsiz bolum zaten var');
      }
      if (landShare && landShare !== current.landShare) {
        assertLandShareTotal(units, current.unitId, landShare);
      }
    }

    const updated: Unit = {
      ...current,
      number,
      floor: patchOptional(o, 'floor', () => reqInt(o, 'floor', -5, 200), current.floor),
      type: optEnum(o, 'type', UNIT_TYPES) ?? current.type,
      grossAreaTenthsM2:
        o.grossAreaM2 === undefined ? current.grossAreaTenthsM2 : areaToTenths(o.grossAreaM2),
      landShare,
      exemptions: o.exemptions === undefined ? current.exemptions : parseExemptions(o.exemptions),
      ...touch(actor, version),
    };

    await repo.updateUnit(updated, version);
    return toUnitView(updated);
  }

  async function deactivateUnit(actor: string, apartmentId: string, unitId: string): Promise<UnitView> {
    const current = await requireUnit(apartmentId, unitId);
    if (current.status === 'inactive') return toUnitView(current);

    const updated: Unit = { ...current, status: 'inactive', ...touch(actor, current.version) };
    await repo.updateUnit(updated, current.version);
    return toUnitView(updated);
  }

  return {
    createSite,
    getSite,
    updateSite,
    listSiteDirectory,
    listBlocks,
    getBlock,
    createBlock,
    updateBlock,
    deactivateBlock,
    listUnits,
    getUnit,
    createUnit,
    updateUnit,
    deactivateUnit,
  };
}

export type CoreService = ReturnType<typeof createCoreService>;
