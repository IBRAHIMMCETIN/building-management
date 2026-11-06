import {
  ConditionalCheckFailedException,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AuthClaims,
  apiGatewayAuthenticator,
  claimsFromRecord,
} from '../src/auth/claims.js';
import { createApp } from '../src/app.js';
import { DataAccessError, resetDynamoCache } from '../src/config/dynamodb.js';
import {
  type CoreRepository,
  coreKeys,
  createCoreRepository,
} from '../src/modules/core/repository.js';
import {
  CoreError,
  createCoreService,
  isAtMostOne,
  isExactlyOne,
  sumLandShares,
} from '../src/modules/core/service.js';
import type { Block, Site, Unit } from '../src/modules/core/types.js';
import { ValidationError } from '../src/modules/core/validation.js';

// ---------------------------------------------------------------------------
// Ortak yardimcilar
// ---------------------------------------------------------------------------

const NOW = new Date('2026-11-06T10:00:00.000Z');
const meta = { $metadata: {} };

const siteInput = {
  name: 'Gul Apartmani',
  type: 'apartment',
  address: { line1: 'Ataturk Cad. No:1', district: 'Konak', city: 'Izmir', postalCode: '35250' },
};

/** Bellekte calisan, DynamoDB semantigini (kosullu yazim, surum) taklit eden repository. */
function createFakeRepo() {
  const sites = new Map<string, Site>();
  const blocks = new Map<string, Block>();
  const units = new Map<string, Unit>();

  const conflict = () => new DataAccessError('conflict', 'Kosul saglanmadi');

  function put<T extends { PK: string; SK: string; version: number }>(
    store: Map<string, T>,
    item: T,
    expectedVersion?: number,
  ) {
    const key = `${item.PK}|${item.SK}`;
    const existing = store.get(key);
    if (expectedVersion === undefined) {
      if (existing) throw conflict();
    } else if (!existing || existing.version !== expectedVersion) {
      throw conflict();
    }
    store.set(key, structuredClone(item));
  }

  const inSite = <T extends { siteId: string }>(store: Map<string, T>, apartmentId: string) =>
    [...store.values()].filter((i) => i.siteId === apartmentId).map((i) => structuredClone(i));

  const repo: CoreRepository = {
    getSite: async (a) => structuredClone(sites.get(`${coreKeys.site(a).PK}|SITE`)),
    createSite: async (s) => put(sites, s),
    updateSite: async (s, v) => put(sites, s, v),
    getBlock: async (a, id) => {
      const k = coreKeys.block(a, id);
      return structuredClone(blocks.get(`${k.PK}|${k.SK}`));
    },
    listBlocks: async (a) => inSite(blocks, a),
    createBlock: async (b) => put(blocks, b),
    updateBlock: async (b, v) => put(blocks, b, v),
    getUnit: async (a, id) => {
      const k = coreKeys.unit(a, id);
      return structuredClone(units.get(`${k.PK}|${k.SK}`));
    },
    listUnits: async (a) => inSite(units, a),
    createUnit: async (u) => put(units, u),
    updateUnit: async (u, v) => put(units, u, v),
  };

  return { repo, sites, blocks, units };
}

function makeService() {
  const fake = createFakeRepo();
  let n = 0;
  const service = createCoreService({
    repository: fake.repo,
    now: () => NOW,
    newId: () => `id-${++n}`,
  });
  return { service, ...fake };
}

// ---------------------------------------------------------------------------
// Repository (aws-sdk-client-mock)
// ---------------------------------------------------------------------------

describe('core repository', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const repo = createCoreRepository();

  beforeEach(() => {
    ddbMock.reset();
    resetDynamoCache();
    vi.stubEnv('DYNAMODB_TABLE_NAME', 'bm-test-table');
    vi.stubEnv('AWS_REGION', 'eu-central-1');
    vi.stubEnv('DYNAMODB_ENDPOINT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const site = (): Site => ({
    ...coreKeys.site('apt-1'),
    entityType: 'SITE',
    status: 'active',
    createdAt: NOW.toISOString(),
    createdBy: 'u1',
    updatedAt: NOW.toISOString(),
    updatedBy: 'u1',
    version: 1,
    siteId: 'apt-1',
    tenantId: 't1',
    name: 'Gul',
    type: 'apartment',
    address: { line1: 'x', district: 'y', city: 'z' },
    fiscalYearStartMonth: 1,
    settings: {
      landShareEnabled: false,
      expenseGroupRules: [],
      dueDayOfMonth: 10,
      lateFeeMonthlyBasisPoints: 500,
      timezone: 'Europe/Istanbul',
      currency: 'TRY',
    },
  });

  it('anahtarlar APT#<siteId> PK ve varlik SK formatindadir', () => {
    expect(coreKeys.site('a')).toEqual({ PK: 'APT#a', SK: 'SITE' });
    expect(coreKeys.block('a', 'b1')).toEqual({ PK: 'APT#a', SK: 'BLOCK#b1' });
    expect(coreKeys.unit('a', 'u1')).toEqual({ PK: 'APT#a', SK: 'UNIT#u1' });
  });

  it('getSite tutarli okuma ile dogru anahtari ceker', async () => {
    ddbMock.on(GetCommand).resolves({ Item: site() });

    const result = await repo.getSite('apt-1');

    const input = ddbMock.commandCalls(GetCommand)[0]!.args[0].input;
    expect(input.Key).toEqual({ PK: 'APT#apt-1', SK: 'SITE' });
    expect(input.ConsistentRead).toBe(true);
    expect(result?.siteId).toBe('apt-1');
  });

  it('kayit yoksa undefined doner', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await repo.getUnit('apt-1', 'yok')).toBeUndefined();
  });

  it('createSite var olan kaydin uzerine yazmayi engelleyen kosulla yazar', async () => {
    ddbMock.on(PutCommand).resolves({});

    await repo.createSite(site());

    const input = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(input.Item).toMatchObject({ PK: 'APT#apt-1', SK: 'SITE' });
  });

  it('createSite var olan kayitta conflict (409) verir', async () => {
    ddbMock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: 'x', ...meta }));

    await expect(repo.createSite(site())).rejects.toMatchObject({ code: 'conflict', httpStatus: 409 });
  });

  it('anahtari kayitla uyusmayan yazimi DynamoDB cagrisi yapmadan reddeder', async () => {
    const bad: Site = { ...site(), PK: 'APT#baska-apartman' };

    await expect(repo.createSite(bad)).rejects.toThrow(/Anahtar tutarsizligi/);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('updateSite surum kosulunu uygular', async () => {
    ddbMock.on(PutCommand).resolves({});

    await repo.updateSite({ ...site(), version: 3 }, 2);

    const input = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe('attribute_exists(PK) AND #version = :expectedVersion');
    expect(input.ExpressionAttributeNames).toEqual({ '#version': 'version' });
    expect(input.ExpressionAttributeValues).toEqual({ ':expectedVersion': 2 });
  });

  it('surum uyusmazligi conflict olarak yansir', async () => {
    ddbMock.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: 'x', ...meta }));

    await expect(repo.updateSite({ ...site(), version: 3 }, 2)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('listUnits sayfalama anahtarini takip eder ve her sorguda ayni tenant PK kullanir', async () => {
    const u1 = { PK: 'APT#apt-1', SK: 'UNIT#u1' };
    const u2 = { PK: 'APT#apt-1', SK: 'UNIT#u2' };
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [u1], LastEvaluatedKey: u1 })
      .resolvesOnce({ Items: [u2] });

    const units = await repo.listUnits('apt-1');

    expect(units).toEqual([u1, u2]);
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args[0].input.ExpressionAttributeValues).toMatchObject({
        ':pk': 'APT#apt-1',
        ':skp': 'UNIT#',
      });
    }
    expect(calls[1]!.args[0].input.ExclusiveStartKey).toEqual(u1);
  });

  it('listBlocks BLOCK# on ekini kullanir', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await repo.listBlocks('apt-9');

    const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeValues).toMatchObject({ ':pk': 'APT#apt-9', ':skp': 'BLOCK#' });
  });

  it('SDK hatalari DataAccessError olarak yukselir', async () => {
    ddbMock.on(GetCommand).rejects(new ResourceNotFoundException({ message: 'x', ...meta }));

    await expect(repo.getSite('apt-1')).rejects.toMatchObject({
      code: 'not_found',
      httpStatus: 404,
    });
  });
});

// ---------------------------------------------------------------------------
// Arsa payi hesaplari
// ---------------------------------------------------------------------------

describe('arsa payi hesaplari', () => {
  it('bos liste 0/1 verir', () => {
    expect(sumLandShares([])).toEqual({ numerator: 0n, denominator: 1n });
  });

  it('1/3 + 1/3 + 1/3 tam 1 eder (kayan nokta hatasi yok)', () => {
    const total = sumLandShares([
      { numerator: 1, denominator: 3 },
      { numerator: 1, denominator: 3 },
      { numerator: 1, denominator: 3 },
    ]);
    expect(total).toEqual({ numerator: 1n, denominator: 1n });
    expect(isExactlyOne(total)).toBe(true);
  });

  it('40 daire x 25/1000 tam 1 eder, bir fazlasi 1i asar', () => {
    const shares = Array.from({ length: 40 }, () => ({ numerator: 25, denominator: 1000 }));
    expect(isExactlyOne(sumLandShares(shares))).toBe(true);
    expect(isAtMostOne(sumLandShares([...shares, { numerator: 1, denominator: 1000 }]))).toBe(false);
  });

  it('farkli paydalari toplar', () => {
    const total = sumLandShares([
      { numerator: 1, denominator: 2 },
      { numerator: 1, denominator: 3 },
    ]);
    expect(total).toEqual({ numerator: 5n, denominator: 6n });
    expect(isAtMostOne(total)).toBe(true);
    expect(isExactlyOne(total)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

describe('core service - site', () => {
  it('varsayilan ayarlarla site olusturur', async () => {
    const { service, sites } = makeService();

    const site = await service.createSite('user-1', 'tenant-1', siteInput);

    expect(site).toMatchObject({
      PK: 'APT#id-1',
      SK: 'SITE',
      siteId: 'id-1',
      tenantId: 'tenant-1',
      status: 'active',
      version: 1,
      createdBy: 'user-1',
      createdAt: NOW.toISOString(),
      fiscalYearStartMonth: 1,
    });
    expect(site.settings).toMatchObject({
      landShareEnabled: false,
      dueDayOfMonth: 10,
      lateFeeMonthlyBasisPoints: 500,
      timezone: 'Europe/Istanbul',
      currency: 'TRY',
    });
    expect(site.settings.expenseGroupRules.find((r) => r.group === 'capital')).toEqual({
      group: 'capital',
      defaultKey: 'equal',
      liableParty: 'owner',
    });
    expect(sites.size).toBe(1);
  });

  it.each([
    ['ad eksik', { ...siteInput, name: undefined }, 'name'],
    ['gecersiz tur', { ...siteInput, type: 'villa' }, 'type'],
    ['gecersiz ay', { ...siteInput, fiscalYearStartMonth: 13 }, 'fiscalYearStartMonth'],
    ['adres eksik', { ...siteInput, address: { line1: 'x' } }, 'district'],
    [
      'posta kodu hatali',
      { ...siteInput, address: { ...siteInput.address, postalCode: '123' } },
      'postalCode',
    ],
    ['vade gunu 31', { ...siteInput, settings: { dueDayOfMonth: 31 } }, 'dueDayOfMonth'],
    [
      'faiz orani cok yuksek',
      { ...siteInput, settings: { lateFeeMonthlyBasisPoints: 10_001 } },
      'lateFeeMonthlyBasisPoints',
    ],
  ])('gecersiz girdi reddedilir: %s', async (_label, input, field) => {
    const { service } = makeService();

    const err = await service.createSite('u', 't', input).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).field).toBe(field);
  });

  it('arsa payi kapaliyken land_share anahtari secilemez, acikken secilebilir', async () => {
    const { service } = makeService();
    const rules = [{ group: 'capital', defaultKey: 'land_share', liableParty: 'owner' }];

    await expect(
      service.createSite('u', 't', { ...siteInput, settings: { expenseGroupRules: rules } }),
    ).rejects.toBeInstanceOf(ValidationError);

    const ok = await service.createSite('u', 't', {
      ...siteInput,
      settings: { landShareEnabled: true, expenseGroupRules: rules },
    });
    expect(ok.settings.expenseGroupRules[0]?.defaultKey).toBe('land_share');
  });

  it('meterSplit tanimsizken meter anahtari secilemez', async () => {
    const { service } = makeService();
    const rules = [{ group: 'heating', defaultKey: 'meter', liableParty: 'occupant' }];

    await expect(
      service.createSite('u', 't', { ...siteInput, settings: { expenseGroupRules: rules } }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      service.createSite('u', 't', {
        ...siteInput,
        settings: {
          expenseGroupRules: rules,
          meterSplit: { commonSharePercent: 30, commonShareKey: 'area' },
        },
      }),
    ).resolves.toBeDefined();
  });

  it('ayni gider grubunu iki kez tanimlamak reddedilir', async () => {
    const { service } = makeService();
    const rule = { group: 'capital', defaultKey: 'equal', liableParty: 'owner' };

    await expect(
      service.createSite('u', 't', { ...siteInput, settings: { expenseGroupRules: [rule, rule] } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('guncelleme surumu artirir ve ayarlari kismi birlestirir', async () => {
    const { service } = makeService();
    const site = await service.createSite('u', 't', siteInput);

    const updated = await service.updateSite('u2', site.siteId, {
      version: 1,
      name: 'Yeni Ad',
      settings: { dueDayOfMonth: 5 },
    });

    expect(updated).toMatchObject({ name: 'Yeni Ad', version: 2, updatedBy: 'u2' });
    expect(updated.settings.dueDayOfMonth).toBe(5);
    expect(updated.settings.lateFeeMonthlyBasisPoints).toBe(500);
    expect(updated.settings.expenseGroupRules).toEqual(site.settings.expenseGroupRules);
  });

  it('eski surumle guncelleme conflict verir', async () => {
    const { service } = makeService();
    const site = await service.createSite('u', 't', siteInput);
    await service.updateSite('u', site.siteId, { version: 1, name: 'A' });

    await expect(service.updateSite('u', site.siteId, { version: 1, name: 'B' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('olmayan site 404 (not_found) verir', async () => {
    const { service } = makeService();
    await expect(service.getSite('yok')).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
  });
});

describe('core service - blok ve bagimsiz bolum', () => {
  async function setup() {
    const ctx = makeService();
    const site = await ctx.service.createSite('u', 't', siteInput);
    const apt = site.siteId;
    const blockA = await ctx.service.createBlock('u', apt, { name: 'A Blok', floorCount: 5 });
    return { ...ctx, apt, blockA };
  }

  const unitInput = (blockId: string, extra: Record<string, unknown> = {}) => ({
    blockId,
    number: '5',
    type: 'flat',
    grossAreaM2: 85.5,
    ...extra,
  });

  it('blok olusturur; ayni isim (buyuk/kucuk harf fark etmeksizin) conflict verir', async () => {
    const { service, apt, blockA } = await setup();

    expect(blockA).toMatchObject({ siteId: apt, name: 'A Blok', floorCount: 5, status: 'active' });
    await expect(service.createBlock('u', apt, { name: 'a blok' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('olmayan sitede blok olusturulamaz', async () => {
    const { service } = makeService();
    await expect(service.createBlock('u', 'yok', { name: 'A' })).rejects.toBeInstanceOf(CoreError);
  });

  it('blok guncellemede floorCount null ile temizlenir', async () => {
    const { service, apt, blockA } = await setup();

    const updated = await service.updateBlock('u', apt, blockA.blockId, {
      version: 1,
      floorCount: null,
    });

    expect(updated.floorCount).toBeUndefined();
    expect(updated.version).toBe(2);
  });

  it('bagimsiz bolum olusturur ve m2 degerini onda bire cevirir', async () => {
    const { service, apt, blockA } = await setup();

    const unit = await service.createUnit('u', apt, unitInput(blockA.blockId));

    expect(unit).toMatchObject({
      PK: `APT#${apt}`,
      blockId: blockA.blockId,
      siteId: apt,
      number: '5',
      grossAreaTenthsM2: 855,
      grossAreaM2: 85.5,
      exemptions: [],
    });
  });

  it('olmayan veya pasif bloga bagimsiz bolum eklenemez', async () => {
    const { service, apt, blockA } = await setup();

    await expect(service.createUnit('u', apt, unitInput('yok'))).rejects.toMatchObject({
      code: 'not_found',
    });

    await service.deactivateBlock('u', apt, blockA.blockId);
    await expect(service.createUnit('u', apt, unitInput(blockA.blockId))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('ayni blokta ayni numara conflict, farkli blokta serbesttir', async () => {
    const { service, apt, blockA } = await setup();
    const blockB = await service.createBlock('u', apt, { name: 'B Blok' });
    await service.createUnit('u', apt, unitInput(blockA.blockId));

    await expect(service.createUnit('u', apt, unitInput(blockA.blockId))).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(service.createUnit('u', apt, unitInput(blockB.blockId))).resolves.toBeDefined();
  });

  it.each([
    ['m2 sifir', { grossAreaM2: 0 }, 'grossAreaM2'],
    ['m2 negatif', { grossAreaM2: -5 }, 'grossAreaM2'],
    ['m2 cok kucuk', { grossAreaM2: 0.04 }, 'grossAreaM2'],
    ['m2 metin', { grossAreaM2: '85' }, 'grossAreaM2'],
    ['gecersiz tur', { type: 'villa' }, 'type'],
    ['pay paydadan buyuk', { landShare: { numerator: 5, denominator: 4 } }, 'landShare'],
    ['payda sifir', { landShare: { numerator: 1, denominator: 0 } }, 'denominator'],
    [
      'muafiyet tarihi ters',
      { exemptions: [{ expenseCategory: 'elevator', validFrom: '2026-12-01', validTo: '2026-01-01' }] },
      'validTo',
    ],
    [
      'muafiyet tarihi gecersiz',
      { exemptions: [{ expenseCategory: 'elevator', validFrom: '2026-02-30' }] },
      'validFrom',
    ],
  ])('gecersiz bagimsiz bolum girdisi reddedilir: %s', async (_label, extra, field) => {
    const { service, apt, blockA } = await setup();

    const err = await service
      .createUnit('u', apt, unitInput(blockA.blockId, extra))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).field).toBe(field);
  });

  it('toplam arsa payi 1i asamaz; pasif daireler toplama dahil edilmez', async () => {
    const { service, apt, blockA } = await setup();
    const share = (n: number) => ({ landShare: { numerator: n, denominator: 1000 } });

    const first = await service.createUnit('u', apt, unitInput(blockA.blockId, { number: '1', ...share(600) }));
    await expect(
      service.createUnit('u', apt, unitInput(blockA.blockId, { number: '2', ...share(500) })),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      service.createUnit('u', apt, unitInput(blockA.blockId, { number: '2', ...share(400) })),
    ).resolves.toBeDefined();

    await service.deactivateUnit('u', apt, first.unitId);
    await expect(
      service.createUnit('u', apt, unitInput(blockA.blockId, { number: '3', ...share(600) })),
    ).resolves.toBeDefined();
  });

  it('guncellemede arsa payi kontrolu kendi eski degerini dislar', async () => {
    const { service, apt, blockA } = await setup();
    const u1 = await service.createUnit(
      'u',
      apt,
      unitInput(blockA.blockId, { number: '1', landShare: { numerator: 600, denominator: 1000 } }),
    );
    await service.createUnit(
      'u',
      apt,
      unitInput(blockA.blockId, { number: '2', landShare: { numerator: 300, denominator: 1000 } }),
    );

    const ok = await service.updateUnit('u', apt, u1.unitId, {
      version: 1,
      landShare: { numerator: 700, denominator: 1000 },
    });
    expect(ok.landShare).toEqual({ numerator: 700, denominator: 1000 });

    await expect(
      service.updateUnit('u', apt, u1.unitId, {
        version: 2,
        landShare: { numerator: 701, denominator: 1000 },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('guncelleme: m2 ve numara degisir, null ile arsa payi temizlenir, blok degisemez', async () => {
    const { service, apt, blockA } = await setup();
    const unit = await service.createUnit(
      'u',
      apt,
      unitInput(blockA.blockId, { landShare: { numerator: 10, denominator: 1000 } }),
    );

    const updated = await service.updateUnit('u', apt, unit.unitId, {
      version: 1,
      number: '6',
      grossAreaM2: 120.7,
      landShare: null,
    });
    expect(updated).toMatchObject({ number: '6', grossAreaTenthsM2: 1207, grossAreaM2: 120.7, version: 2 });
    expect(updated.landShare).toBeUndefined();

    await expect(
      service.updateUnit('u', apt, unit.unitId, { version: 2, blockId: 'baska' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('guncelleme: stale surum conflict, numara cakismasi conflict', async () => {
    const { service, apt, blockA } = await setup();
    const u1 = await service.createUnit('u', apt, unitInput(blockA.blockId, { number: '1' }));
    await service.createUnit('u', apt, unitInput(blockA.blockId, { number: '2' }));

    await expect(
      service.updateUnit('u', apt, u1.unitId, { version: 9, type: 'shop' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      service.updateUnit('u', apt, u1.unitId, { version: 1, number: '2' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('aktif bagimsiz bolumu olan blok pasife alinamaz; once daire pasife alinir', async () => {
    const { service, apt, blockA } = await setup();
    const unit = await service.createUnit('u', apt, unitInput(blockA.blockId));

    await expect(service.deactivateBlock('u', apt, blockA.blockId)).rejects.toMatchObject({
      code: 'conflict',
    });

    await service.deactivateUnit('u', apt, unit.unitId);
    const block = await service.deactivateBlock('u', apt, blockA.blockId);
    expect(block.status).toBe('inactive');
  });

  it('pasife alma tekrar cagrilirsa idempotenttir (surum artmaz)', async () => {
    const { service, apt, blockA } = await setup();
    const unit = await service.createUnit('u', apt, unitInput(blockA.blockId));

    const first = await service.deactivateUnit('u', apt, unit.unitId);
    const second = await service.deactivateUnit('u', apt, unit.unitId);

    expect(first.status).toBe('inactive');
    expect(second.version).toBe(first.version);
  });

  it('listUnits durum/blok filtresi ve ozet hesaplar', async () => {
    const { service, apt, blockA } = await setup();
    const blockB = await service.createBlock('u', apt, { name: 'B Blok' });
    await service.createUnit(
      'u',
      apt,
      unitInput(blockA.blockId, {
        number: '1',
        grossAreaM2: 80,
        landShare: { numerator: 500, denominator: 1000 },
      }),
    );
    await service.createUnit(
      'u',
      apt,
      unitInput(blockA.blockId, {
        number: '10',
        grossAreaM2: 100.5,
        landShare: { numerator: 500, denominator: 1000 },
      }),
    );
    const gone = await service.createUnit('u', apt, unitInput(blockB.blockId, { number: '1' }));
    await service.deactivateUnit('u', apt, gone.unitId);

    const active = await service.listUnits(apt);
    expect(active.items.map((u) => u.number)).toEqual(['1', '10']);
    expect(active.summary).toEqual({
      activeUnitCount: 2,
      totalGrossAreaTenthsM2: 1805,
      landShare: { numerator: '1', denominator: '1', isComplete: true },
    });

    expect((await service.listUnits(apt, { status: 'all' })).items).toHaveLength(3);
    expect((await service.listUnits(apt, { status: 'inactive' })).items).toHaveLength(1);
    expect((await service.listUnits(apt, { blockId: blockB.blockId })).items).toHaveLength(0);
  });

  it('gecersiz kimlikler dogrulama hatasi verir', async () => {
    const { service, apt } = await setup();
    await expect(service.getUnit(apt, 'a#b')).rejects.toBeInstanceOf(ValidationError);
    await expect(service.getBlock(apt, '')).rejects.toBeInstanceOf(ValidationError);
  });

  it('baska apartmanin kaydi bu apartman uzerinden gorunmez (tenant izolasyonu)', async () => {
    const ctx = await setup();
    const other = await ctx.service.createSite('u', 't', siteInput);
    const otherBlock = await ctx.service.createBlock('u', other.siteId, { name: 'X Blok' });
    const otherUnit = await ctx.service.createUnit(
      'u',
      other.siteId,
      unitInput(otherBlock.blockId, { number: '9' }),
    );

    await expect(ctx.service.getUnit(ctx.apt, otherUnit.unitId)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(ctx.service.getBlock(ctx.apt, otherBlock.blockId)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await ctx.service.listUnits(ctx.apt)).items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Claim cozumleme
// ---------------------------------------------------------------------------

describe('claims', () => {
  it('gecerli claim kaydini cozer', () => {
    expect(
      claimsFromRecord({ sub: 'u1', role: 'apartment_manager', apartmentId: 'apt-1', organizationId: 'o1' }),
    ).toEqual({ userId: 'u1', role: 'apartment_manager', apartmentId: 'apt-1', organizationId: 'o1' });
  });

  it.each([
    ['null', null],
    ['sub yok', { role: 'observer' }],
    ['gecersiz rol', { sub: 'u', role: 'root' }],
    ['rol yok', { sub: 'u' }],
    ['metin', 'x'],
  ])('gecersiz claim reddedilir: %s', (_label, raw) => {
    expect(claimsFromRecord(raw)).toBeNull();
  });

  it('API Gateway HTTP API (jwt.claims) ve REST (claims) bicimlerini okur', async () => {
    const make = (authorizer: unknown) =>
      ({ env: { event: { requestContext: { authorizer } } } }) as unknown as Context;
    const claims = { sub: 'u1', role: 'observer', apartmentId: 'apt-1' };

    expect(await apiGatewayAuthenticator(make({ jwt: { claims } }))).toMatchObject({ userId: 'u1' });
    expect(await apiGatewayAuthenticator(make({ claims }))).toMatchObject({ role: 'observer' });
    expect(await apiGatewayAuthenticator(make(undefined))).toBeNull();
    expect(await apiGatewayAuthenticator({ env: undefined } as unknown as Context)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hono rotalari
// ---------------------------------------------------------------------------

describe('core routes', () => {
  const manager = (apartmentId = 'id-1'): AuthClaims => ({
    userId: 'mgr-1',
    role: 'apartment_manager',
    apartmentId,
  });

  async function setup() {
    const ctx = makeService();
    // id-1: site, apartmentId claim'i ile eslesir.
    await ctx.service.createSite('seed', 'tenant-1', siteInput);

    const app = createApp({
      version: 'test',
      coreService: ctx.service,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
    });

    const call = async (method: string, path: string, claims?: AuthClaims | null, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: {
          ...(claims ? { 'x-test-claims': JSON.stringify(claims) } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined
          ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
          : {}),
      });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };

    return { ...ctx, app, call };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('kimlik yoksa 401 doner', async () => {
    const { call } = await setup();
    expect((await call('GET', '/api/sites')).status).toBe(401);
    expect((await call('GET', '/api/sites/id-1/units')).status).toBe(401);
  });

  it('authenticate verilmezse varsayilan olarak tum istekler 401 alir', async () => {
    const res = await createApp({ version: 'x' }).request('/api/sites');
    expect(res.status).toBe(401);
  });

  it('GET /api/sites yalnizca claim apartmanini doner ve PK/SK gizlenir', async () => {
    const { call, service } = await setup();
    await service.createSite('seed', 'tenant-1', siteInput); // id-2: baska apartman

    const res = await call('GET', '/api/sites', manager('id-1'));

    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(1);
    expect(res.json.items[0]).toMatchObject({ siteId: 'id-1', name: 'Gul Apartmani' });
    expect(res.json.items[0]).not.toHaveProperty('PK');
    expect(res.json.items[0]).not.toHaveProperty('SK');
  });

  it('POST /api/sites: yonetim firmasi olusturur, yonetici olusturamaz', async () => {
    const { call } = await setup();
    const company: AuthClaims = { userId: 'c1', role: 'management_company', organizationId: 'org-1' };

    const created = await call('POST', '/api/sites', company, siteInput);
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ tenantId: 'org-1', siteId: 'id-2' });

    expect((await call('POST', '/api/sites', manager(), siteInput)).status).toBe(403);

    const noOrg = await call('POST', '/api/sites', { userId: 'c1', role: 'management_company' }, siteInput);
    expect(noOrg.status).toBe(400);
    expect(noOrg.json.field).toBe('tenantId');
  });

  it('platform_admin govdedeki tenantId ile site olusturabilir', async () => {
    const { call } = await setup();
    const admin: AuthClaims = { userId: 'a1', role: 'platform_admin' };

    const res = await call('POST', '/api/sites', admin, { ...siteInput, tenantId: 'org-7' });

    expect(res.status).toBe(201);
    expect(res.json.tenantId).toBe('org-7');
  });

  describe('tenant izolasyonu', () => {
    it('URL baska apartmani gosteriyorsa 403 doner ve servis cagrilmaz', async () => {
      const { call, units, service } = await setup();
      const block = await service.createBlock('seed', 'id-1', { name: 'A' });
      const spy = vi.spyOn(service, 'listUnits');

      const claims = manager('id-1');
      for (const [method, path, body] of [
        ['GET', '/api/sites/id-2', undefined],
        ['PATCH', '/api/sites/id-2', { version: 1, name: 'x' }],
        ['GET', '/api/sites/id-2/blocks', undefined],
        ['GET', '/api/sites/id-2/units', undefined],
        ['POST', '/api/sites/id-2/units', { blockId: block.blockId, number: '1', type: 'flat', grossAreaM2: 50 }],
        ['DELETE', '/api/sites/id-2/units/u1', undefined],
      ] as const) {
        const res = await call(method, path, claims, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.json.error).toBe('forbidden');
      }

      expect(spy).not.toHaveBeenCalled();
      expect(units.size).toBe(0);
    });

    it("apartmentId claim'i olmayan kullanici site rotalarina erisemez", async () => {
      const { call } = await setup();
      const res = await call('GET', '/api/sites/id-1/units', { userId: 'u', role: 'apartment_manager' });
      expect(res.status).toBe(403);
    });

    it('baska apartmana ait veriler claim apartmaninda listelenmez', async () => {
      const { call, service } = await setup();
      const other = await service.createSite('seed', 'tenant-1', siteInput); // id-2
      const otherBlock = await service.createBlock('seed', other.siteId, { name: 'X' });
      await service.createUnit('seed', other.siteId, {
        blockId: otherBlock.blockId,
        number: '1',
        type: 'flat',
        grossAreaM2: 70,
      });

      const mine = await call('GET', '/api/sites/id-1/units', manager('id-1'));
      expect(mine.status).toBe(200);
      expect(mine.json.items).toEqual([]);

      const theirs = await call('GET', '/api/sites/id-2/units', manager('id-2'));
      expect(theirs.json.items).toHaveLength(1);
    });
  });

  describe('roller', () => {
    it('resident ve security_guard okuyamaz', async () => {
      const { call } = await setup();
      for (const role of ['resident', 'security_guard'] as const) {
        const res = await call('GET', '/api/sites/id-1/units', { userId: 'u', role, apartmentId: 'id-1' });
        expect(res.status).toBe(403);
      }
    });

    it('observer ve building_staff okur ama yazamaz', async () => {
      const { call } = await setup();
      for (const role of ['observer', 'building_staff'] as const) {
        const claims: AuthClaims = { userId: 'u', role, apartmentId: 'id-1' };
        expect((await call('GET', '/api/sites/id-1/units', claims)).status).toBe(200);
        expect((await call('POST', '/api/sites/id-1/blocks', claims, { name: 'Z' })).status).toBe(403);
        expect((await call('PATCH', '/api/sites/id-1', claims, { version: 1 })).status).toBe(403);
      }
    });

    it('platform_admin apartman verisini okuyamaz', async () => {
      const { call } = await setup();
      const res = await call('GET', '/api/sites/id-1', { userId: 'a', role: 'platform_admin', apartmentId: 'id-1' });
      expect(res.status).toBe(403);
    });
  });

  describe('blok ve bagimsiz bolum akisi', () => {
    it('olusturma, listeleme, guncelleme, surum catismasi ve pasife alma', async () => {
      const { call } = await setup();
      const claims = manager();

      const block = await call('POST', '/api/sites/id-1/blocks', claims, { name: 'A Blok' });
      expect(block.status).toBe(201);
      expect(block.json).not.toHaveProperty('PK');

      const dup = await call('POST', '/api/sites/id-1/blocks', claims, { name: 'a blok' });
      expect(dup.status).toBe(409);

      const unit = await call('POST', '/api/sites/id-1/units', claims, {
        blockId: block.json.blockId,
        number: '5',
        type: 'flat',
        grossAreaM2: 85.5,
        landShare: { numerator: 25, denominator: 1000 },
      });
      expect(unit.status).toBe(201);
      expect(unit.json).toMatchObject({ grossAreaTenthsM2: 855, grossAreaM2: 85.5, version: 1 });
      expect(unit.json).not.toHaveProperty('PK');

      const list = await call('GET', `/api/sites/id-1/units?blockId=${block.json.blockId}`, claims);
      expect(list.status).toBe(200);
      expect(list.json.items).toHaveLength(1);
      expect(list.json.summary).toMatchObject({ activeUnitCount: 1, totalGrossAreaTenthsM2: 855 });

      const unitPath = `/api/sites/id-1/units/${unit.json.unitId}`;
      expect((await call('GET', unitPath, claims)).json.number).toBe('5');

      const patched = await call('PATCH', unitPath, claims, { version: 1, type: 'duplex' });
      expect(patched.status).toBe(200);
      expect(patched.json).toMatchObject({ type: 'duplex', version: 2 });

      const stale = await call('PATCH', unitPath, claims, { version: 1, type: 'shop' });
      expect(stale.status).toBe(409);
      expect(stale.json.error).toBe('conflict');

      const removed = await call('DELETE', unitPath, claims);
      expect(removed.status).toBe(200);
      expect(removed.json.status).toBe('inactive');

      expect((await call('GET', '/api/sites/id-1/units', claims)).json.items).toEqual([]);
      expect((await call('GET', '/api/sites/id-1/units?status=all', claims)).json.items).toHaveLength(1);

      const blockRemoved = await call('DELETE', `/api/sites/id-1/blocks/${block.json.blockId}`, claims);
      expect(blockRemoved.status).toBe(200);
      expect(blockRemoved.json.status).toBe('inactive');
    });

    it('site guncelleme (PATCH) surum ile calisir', async () => {
      const { call } = await setup();

      const res = await call('PATCH', '/api/sites/id-1', manager(), {
        version: 1,
        settings: { dueDayOfMonth: 20 },
      });

      expect(res.status).toBe(200);
      expect(res.json.settings.dueDayOfMonth).toBe(20);
      expect(res.json.version).toBe(2);
    });

    it('olmayan kayit 404 verir', async () => {
      const { call } = await setup();
      const res = await call('GET', '/api/sites/id-1/units/yok', manager());
      expect(res.status).toBe(404);
      expect(res.json.error).toBe('not_found');
    });

    it('dogrulama hatasi 400 ve alan adini dondurur', async () => {
      const { call } = await setup();
      const res = await call('POST', '/api/sites/id-1/blocks', manager(), {});
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ error: 'validation_error', field: 'name' });
    });

    it('bozuk JSON 400 verir', async () => {
      const { call } = await setup();
      const res = await call('POST', '/api/sites/id-1/blocks', manager(), '{bozuk');
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('validation_error');
    });

    it('gecersiz kimlik ve status filtresi 400 verir', async () => {
      const { call } = await setup();
      expect((await call('GET', '/api/sites/id-1/units/a%23b', manager())).status).toBe(400);
      expect((await call('GET', '/api/sites/id-1/units?status=hepsi', manager())).status).toBe(400);
    });

    it('veritabani hatasi DataAccessError durum koduna cevrilir', async () => {
      const { call, service } = await setup();
      vi.spyOn(service, 'getSite').mockRejectedValueOnce(new DataAccessError('throttled', 'yogun'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await call('GET', '/api/sites/id-1', manager());

      expect(res.status).toBe(503);
      expect(res.json.error).toBe('throttled');
    });

    it('beklenmeyen hata 500 doner ve ayrinti sizdirmaz', async () => {
      const { call, service } = await setup();
      vi.spyOn(service, 'getSite').mockRejectedValueOnce(new Error('gizli ayrinti'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await call('GET', '/api/sites/id-1', manager());

      expect(res.status).toBe(500);
      expect(res.json).toEqual({ error: 'internal_error' });
    });
  });
});
