import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DataAccessError } from '../src/config/dynamodb.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import { createCoreService } from '../src/modules/core/service.js';
import type { Block, Site, Unit } from '../src/modules/core/types.js';
import { createFinanceService } from '../src/modules/finance/service.js';
import {
  DATE_IN_FRACTION,
  parseArea,
  parseExcelDate,
  parseFractionCell,
  recoverDigitDate,
  parseBalanceRow,
  parseBool,
  parseDate,
  parseFraction,
  parsePersonRow,
  parseSignedKurus,
  parseUnitRow,
  parseUnitType,
} from '../src/modules/imports/parse.js';
import type { ImportRepository } from '../src/modules/imports/repository.js';
import { createImportsService } from '../src/modules/imports/service.js';
import type { ImportItem, ImportJob } from '../src/modules/imports/types.js';
import type { MembershipRepository } from '../src/modules/memberships/repository.js';
import { createMembershipService } from '../src/modules/memberships/service.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import type { UserDirectory } from '../src/modules/residents/directory.js';
import type { Person, PersonRepository } from '../src/modules/residents/repository.js';
import { createResidentsService } from '../src/modules/residents/service.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';

const NOW = new Date('2026-11-11T10:00:00.000Z'); // Istanbul 11.11.2026

// ---------------------------------------------------------------------------
// Ayristirici
// ---------------------------------------------------------------------------

describe('aktarim hucre ayristiricilari (Turkce yazimlar)', () => {
  it('tutar: binlik/ondalik, isaret, para birimi; kayan nokta yok', () => {
    expect(parseSignedKurus('1.500,50')).toBe(150050);
    expect(parseSignedKurus('1500.5')).toBe(150050);
    expect(parseSignedKurus('₺1.500')).toBe(150000);
    expect(parseSignedKurus('-250')).toBe(-25000);
    expect(parseSignedKurus('(250,10)')).toBe(-25010);
    expect(parseSignedKurus('0,1')).toBe(10);
    expect(parseSignedKurus('12,345')).toBeNull();
    expect(parseSignedKurus('abc')).toBeNull();
  });

  it('tarih, alan, kesir, evet/hayir, tip', () => {
    expect(parseDate('05.11.2026')).toBe('2026-11-05');
    expect(parseDate('5/1/2026')).toBe('2026-01-05');
    expect(parseDate('2026-11-05T00:00:00.000Z')).toBe('2026-11-05');
    expect(parseDate('31.02.2026')).toBeNull();
    expect(parseDate('')).toBeUndefined();
    expect(parseArea('85,5')).toBe(85.5);
    expect(parseArea('85 m²')).toBe(85);
    expect(parseArea('85,55')).toBeNull();
    expect(parseFraction('12/480')).toEqual({ numerator: 12, denominator: 480 });
    expect(parseFraction('5/4')).toBeNull();
    expect(parseFraction(' ')).toBeUndefined();
    expect(parseBool('Evet')).toBe(true);
    expect(parseBool('H')).toBe(false);
    expect(parseBool('belki')).toBeNull();
    expect(parseUnitType('Dükkan')).toBe('shop');
    expect(parseUnitType('')).toBe('flat');
    expect(parseUnitType('villa')).toBeNull();
  });

  it('Excel tarihleri kurtarilir: seri numara, binlik ayracli ve sifiri dusmus tarih', () => {
    expect(parseExcelDate(46023)).toBe('2026-01-01');
    expect(parseExcelDate(46023.75)).toBe('2026-01-01');
    expect(parseExcelDate(12)).toBeNull();
    expect(parseDate('46023')).toBe('2026-01-01');
    expect(parseDate('1012026')).toBe('2026-01-01');
    expect(parseDate('1.012.026')).toBe('2026-01-01');
    expect(parseDate('15012026')).toBe('2026-01-15');
    expect(parseDate('20260115')).toBe('2026-01-15');
    expect(parseDate('2026-1-5')).toBe('2026-01-05');
    expect(parseDate('5-1-2026')).toBe('2026-01-05');
    // 7 hane: once gunun sifiri dusmus kabul edilir (g|aa), olmazsa gg|a.
    expect(recoverDigitDate('1112026')).toBe('2026-11-01');
    expect(recoverDigitDate('3132026')).toBe('2026-03-31');
    expect(recoverDigitDate('9992026')).toBeNull();
    expect(parseDate('99999999')).toBeNull();
    expect(parseDate('123')).toBeNull();
  });

  it('kesir sutununda tarih/ondalik acik mesajla reddedilir; tek tirnak kabul', () => {
    expect(parseFractionCell("'1/2", 'Hisse')).toEqual({ ok: true, value: { numerator: 1, denominator: 2 } });
    expect(parseFractionCell(undefined, 'Hisse')).toEqual({ ok: true, value: undefined });
    for (const v of [DATE_IN_FRACTION, '1.Oca', '1-Oca', '1 Ocak', 'Jan-1', '2026-01-01', '01.01.2026']) {
      expect(parseFractionCell(v, 'Hisse')).toEqual({ ok: false, message: "Hisse bir tarih olamaz. Lütfen '1/1 biçiminde (başında tek tırnakla) giriniz" });
    }
    expect(parseFractionCell('0,5', 'Arsa payı')).toMatchObject({ ok: false, message: expect.stringContaining('ondalık') });
    expect(parseFractionCell('3/2', 'Hisse')).toMatchObject({ ok: false });
    const p = parsePersonRow({ row: 2, block: 'A', number: '1', fullName: 'Ali Veli', email: 'a@b.co', relation: 'Malik', share: '1.Oca', startDate: '32.01.2026' }, '2026-10-31');
    expect(!p.ok && p.errors).toEqual([
      { field: 'startDate', message: 'Geçersiz başlangıç tarihi: Lütfen YYYY-AA-GG biçiminde giriniz (örn. 2026-01-01)' },
      { field: 'share', message: "Hisse bir tarih olamaz. Lütfen '1/1 biçiminde (başında tek tırnakla) giriniz" },
    ]);
  });

  it('satir hatalari alan bazinda raporlanir', () => {
    const r = parseUnitRow({ row: 3, block: '', number: '5', area: 'x', landShare: '3' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.map((e) => e.field)).toEqual(['block', 'area', 'landShare']);
    const p = parsePersonRow({ row: 4, block: 'A', number: '1', fullName: 'Ay', email: 'x', relation: 'Kiracı', share: '1/2' }, '2026-10-31');
    expect(!p.ok && p.errors.map((e) => e.field)).toEqual(['email', 'share']);
  });

  it('varsayilanlar: kiraci dairede oturur, baslangic/vade devir tarihi', () => {
    const p = parsePersonRow({ row: 2, block: 'A Blok', number: '5', fullName: 'Ayşe Yılmaz', email: ' AYSE@site.com ', relation: 'Kiracı' }, '2026-10-31');
    expect(p.ok && p.value).toMatchObject({ email: 'ayse@site.com', relation: 'tenant', residesInUnit: true, startDate: '2026-10-31', key: 'person:ayse@site.com|a blok|5' });
    const b = parseBalanceRow({ row: 2, block: 'A Blok', number: '5', party: 'Oturan', amount: '1.200' }, '2026-10-31');
    expect(b.ok && b.value).toMatchObject({ party: 'occupant', amount: 120000, dueDate: '2026-10-31', description: 'Devir bakiyesi' });
  });
});

// ---------------------------------------------------------------------------
// Servis (gercek core / memberships / residents / finance servisleri, bellek ici depolar)
// ---------------------------------------------------------------------------

function keyed<T>() {
  const m = new Map<string, T>();
  return m;
}

function setup() {
  let n = 0;
  const newId = () => `id-${++n}`;
  const now = () => NOW;

  // --- core ---
  const sites = keyed<Site>();
  const blocks = keyed<Block>();
  const units = keyed<Unit>();
  const coreRepo: CoreRepository = {
    getSite: async (a) => sites.get(a),
    createSite: async (s) => void sites.set(s.siteId, s),
    updateSite: async (s) => void sites.set(s.siteId, s),
    listSiteIds: async () => [...sites.keys()],
    getBlock: async (a, id) => [...blocks.values()].find((b) => b.siteId === a && b.blockId === id),
    listBlocks: async (a) => [...blocks.values()].filter((b) => b.siteId === a),
    createBlock: async (b) => void blocks.set(b.blockId, b),
    updateBlock: async (b) => void blocks.set(b.blockId, b),
    getUnit: async (a, id) => [...units.values()].find((u) => u.siteId === a && u.unitId === id),
    listUnits: async (a) => [...units.values()].filter((u) => u.siteId === a),
    createUnit: async (u) => void units.set(u.unitId, u),
    updateUnit: async (u, v) => {
      if (units.get(u.unitId)?.version !== v) throw new DataAccessError('conflict', 'surum');
      units.set(u.unitId, u);
    },
  };
  const core = createCoreService({ repository: coreRepo, now, newId });

  // --- uyelik / kisi ---
  const memberships = keyed<UnitMembership>();
  const membershipRepo: MembershipRepository = {
    get: async (a, u, unit) => memberships.get(`${a}|${u}|${unit}`),
    list: async (a, f = {}) => [...memberships.values()].filter((m) => m.apartmentId === a && (!f.unitId || m.unitId === f.unitId)),
    create: async (m) => {
      const k = `${m.apartmentId}|${m.userId}|${m.unitId}`;
      if (memberships.has(k)) throw new DataAccessError('conflict', 'var');
      memberships.set(k, m);
    },
    update: async (m) => void memberships.set(`${m.apartmentId}|${m.userId}|${m.unitId}`, m),
  };
  const people = keyed<Person>();
  const peopleRepo: PersonRepository = {
    get: async (a, u) => people.get(`${a}|${u}`),
    list: async (a) => [...people.values()].filter((p) => p.apartmentId === a),
    create: async (p) => void people.set(`${p.apartmentId}|${p.userId}`, p),
    update: async (p) => void people.set(`${p.apartmentId}|${p.userId}`, p),
  };
  const accounts = new Map<string, string>();
  const created: { email: string; sendInvitation?: boolean }[] = [];
  const resent: string[] = [];
  const directory: UserDirectory = {
    findOrCreate: async ({ email, sendInvitation }) => {
      created.push({ email, sendInvitation });
      const existing = accounts.get(email);
      if (existing) return { userId: existing, created: false };
      const sub = `sub-${accounts.size + 1}`;
      accounts.set(email, sub);
      return { userId: sub, created: true };
    },
    resendInvitation: async (email) => {
      resent.push(email);
      return 'sent';
    },
  };
  const membershipService = createMembershipService({ repository: membershipRepo, core: coreRepo, now });
  const residents = createResidentsService({ people: peopleRepo, core: coreRepo, memberships: membershipService, directory, now });

  // --- finans ---
  const fin = createFakeFinanceRepo();
  const finance = createFinanceService({ repository: fin.repo, core: coreRepo, now, newId });

  // --- aktarim deposu ---
  const jobs = keyed<ImportJob>();
  const items = keyed<ImportItem>();
  const importRepo: ImportRepository = {
    getJob: async (a, id) => jobs.get(`${a}|${id}`),
    listJobs: async (a) => [...jobs.values()].filter((j) => j.apartmentId === a),
    createJob: async (j) => {
      if (jobs.has(`${j.apartmentId}|${j.importId}`)) throw new DataAccessError('conflict', 'var');
      jobs.set(`${j.apartmentId}|${j.importId}`, structuredClone(j));
    },
    updateJob: async (j, v) => {
      if (jobs.get(`${j.apartmentId}|${j.importId}`)?.version !== v) throw new DataAccessError('conflict', 'surum');
      jobs.set(`${j.apartmentId}|${j.importId}`, structuredClone(j));
    },
    getItem: async (a, id, key) => [...items.values()].find((i) => i.apartmentId === a && i.importId === id && i.itemKey === key),
    listItems: async (a, id) => [...items.values()].filter((i) => i.apartmentId === a && i.importId === id),
    createItem: async (i) => {
      if (items.has(i.SK)) throw new DataAccessError('conflict', 'var');
      items.set(i.SK, structuredClone(i));
    },
    updateItem: async (i, v) => {
      if (items.get(i.SK)?.version !== v) throw new DataAccessError('conflict', 'surum');
      items.set(i.SK, structuredClone(i));
    },
  };

  const service = createImportsService({
    repository: importRepo,
    core,
    coreRepo,
    residents,
    memberships: membershipService,
    people: peopleRepo,
    finance,
    financeRepo: fin.repo,
    now,
    newId,
  });

  return { service, core, coreRepo, finance, fin, units, blocks, memberships, created, resent, items, jobs };
}

const unitsSheet = [
  { row: 2, block: 'A Blok', number: '1', floor: '1', type: 'Daire', area: '100', landShare: '1/4' },
  { row: 3, block: 'A Blok', number: '2', floor: '1', type: 'Daire', area: '100,5', landShare: '1/4' },
  { row: 4, block: 'B Blok', number: 'D1', floor: '0', type: 'Dükkan', area: '60' },
];
const peopleSheet = [
  { row: 2, block: 'A Blok', number: '1', fullName: 'Ali Veli', email: 'ali@site.com', relation: 'Malik', residesInUnit: 'E', startDate: '01.01.2020' },
  { row: 3, block: 'a blok', number: '2', fullName: 'Ayşe Yılmaz', email: 'ayse@site.com', relation: 'Kiracı' },
];
const balancesSheet = [
  { row: 2, block: 'A Blok', number: '1', party: 'Malik', amount: '1.000,00', dueDate: '10.10.2026', description: 'Eski aidat borcu' },
  { row: 3, block: 'A Blok', number: '2', party: 'Oturan', amount: '-250' },
];

async function seeded() {
  const t = setup();
  const site = await t.core.createSite('mgr', 'tenant', { name: 'Lale Apt', type: 'apartment', address: { line1: 'x', district: 'y', city: 'z' } });
  const ctx = { apartmentId: site.siteId, userId: 'mgr', role: 'apartment_manager' as const };
  return { ...t, ctx };
}

async function runAll(t: Awaited<ReturnType<typeof seeded>>, importId = 'imp1') {
  await t.service.start(t.ctx, { importId, asOfDate: '2026-10-31', fileName: 'veri.xlsx', totals: { units: 3, people: 2, balances: 2 } });
  await t.service.processRows(t.ctx, importId, { units: unitsSheet });
  await t.service.processRows(t.ctx, importId, { people: peopleSheet });
  await t.service.processRows(t.ctx, importId, { balances: balancesSheet });
  await t.service.setFunds(t.ctx, importId, { cash: '5.000', bank: '12.500,75' });
  return t.service.complete(t.ctx, importId);
}

describe('aktarim - onizleme (yazmaz)', () => {
  it('gecerli dosya: olusturulacaklar, yeni bloklar; hicbir kayit yazilmaz', async () => {
    const t = await seeded();
    const r = await t.service.preview(t.ctx, { asOfDate: '31.10.2026', units: unitsSheet, people: peopleSheet, balances: balancesSheet });
    expect(r).toMatchObject({ ok: true, asOfDate: '2026-10-31', blocksToCreate: ['A Blok', 'B Blok'], globalErrors: [] });
    expect(r.counts).toEqual({ units: { create: 3, exists: 0, error: 0 }, people: { create: 2, exists: 0, error: 0 }, balances: { create: 2, exists: 0, error: 0 } });
    expect(t.units.size).toBe(0);
    expect(t.created).toHaveLength(0);
  });

  it('dosya ici tekrar, bilinmeyen daire, cift kiraci, arsa payi toplami raporlanir', async () => {
    const t = await seeded();
    const r = await t.service.preview(t.ctx, {
      asOfDate: '2026-10-31',
      units: [...unitsSheet, { row: 5, block: 'A BLOK', number: '1', area: '90' }, { row: 6, block: 'C', number: '9', area: '50', landShare: '3/4' }],
      people: [
        ...peopleSheet,
        { row: 4, block: 'A Blok', number: '2', fullName: 'Can Kaya', email: 'can@site.com', relation: 'Kiracı' },
        { row: 5, block: 'Z', number: '9', fullName: 'Yok Kisi', email: 'yok@site.com', relation: 'Malik' },
      ],
      balances: [...balancesSheet, { row: 4, block: 'A Blok', number: '1', party: 'Malik', amount: '5' }],
    });
    expect(r.ok).toBe(false);
    expect(r.globalErrors[0]).toMatch(/Arsa pay/);
    const errors = r.rows.filter((x) => x.status === 'error').map((x) => `${x.sheet}:${x.row}`);
    expect(errors).toEqual(['units:5', 'people:4', 'people:5', 'balances:4']);
    expect(r.rows[0]?.status).toBe('error');
  });

  it('gelecek devir tarihi ve 1000 satir siniri reddedilir', async () => {
    const t = await seeded();
    await expect(t.service.preview(t.ctx, { asOfDate: '2026-12-01' })).rejects.toMatchObject({ field: 'asOfDate' });
    const many = Array.from({ length: 1001 }, (_, i) => ({ block: 'A', number: String(i), area: '50' }));
    await expect(t.service.preview(t.ctx, { asOfDate: '2026-10-31', units: many })).rejects.toMatchObject({ field: 'rows' });
  });
});

describe('aktarim - mevcut kiraci', () => {
  it('sistemde aktif kiracisi olan daireye ikinci kiraci onizlemede hata verir', async () => {
    const t = await seeded();
    await runAll(t);
    const r = await t.service.preview(t.ctx, {
      asOfDate: '2026-10-31',
      people: [{ row: 2, block: 'A Blok', number: '2', fullName: 'Can Kaya', email: 'can@site.com', relation: 'Kiracı' }],
    });
    expect(r.rows[0]).toMatchObject({ status: 'error' });
  });
});

describe('aktarim - yazim', () => {
  it('daireler, bloklar, uyelikler (sessiz), acilis ve kasa/banka bakiyeleri; mizan dengede', async () => {
    const t = await seeded();
    const job = await runAll(t);
    expect(job.status).toBe('completed');
    expect(job.counts).toMatchObject({ unit: { created: 3 }, person: { created: 2 }, balance: { created: 2 }, funds: { created: 2 } });

    expect([...t.blocks.values()].map((b) => b.name).sort()).toEqual(['A Blok', 'B Blok']);
    expect(t.units.size).toBe(3);
    expect(t.created.every((c) => c.sendInvitation === false)).toBe(true);
    expect(t.memberships.size).toBe(2);

    const u1 = [...t.units.values()].find((u) => u.number === '1')!;
    const u2 = [...t.units.values()].find((u) => u.number === '2')!;
    expect(t.fin.balanceOf(`recv-${u1.unitId}-owner`, t.ctx.apartmentId)).toBe(100000);
    expect(t.fin.balanceOf(`recv-${u2.unitId}-occupant`, t.ctx.apartmentId)).toBe(-25000);
    expect(t.fin.balanceOf('cash', t.ctx.apartmentId)).toBe(500000);
    expect(t.fin.balanceOf('bank', t.ctx.apartmentId)).toBe(1250075);
    expect(t.fin.balanceOf('opening-balance', t.ctx.apartmentId)).toBe(-(100000 - 25000 + 500000 + 1250075));
    expect(t.fin.trialBalance()).toBe(0);

    // Karar 2a: devir borcuna vadesinden itibaren kistelyevm isler (10.10 -> 11.11: 32 gun).
    const dues = await t.finance.duesStatus({ apartmentId: t.ctx.apartmentId, userId: 'mgr' });
    expect(dues.items.find((i) => i.unitId === u1.unitId)).toMatchObject({ overdue: 100000, lateFee: 5333 });
  });

  it('ayni parcalar tekrar gonderilirse hicbir sey ikinci kez yazilmaz (idempotent)', async () => {
    const t = await seeded();
    await t.service.start(t.ctx, { importId: 'imp1', asOfDate: '2026-10-31' });
    const first = await t.service.processRows(t.ctx, 'imp1', { units: unitsSheet });
    const again = await t.service.processRows(t.ctx, 'imp1', { units: unitsSheet });
    expect(again.results).toEqual(first.results);
    await t.service.processRows(t.ctx, 'imp1', { balances: balancesSheet });
    const postedBefore = t.fin.posted.length;
    await t.service.processRows(t.ctx, 'imp1', { balances: balancesSheet });
    expect(t.fin.posted).toHaveLength(postedBefore);
    expect(t.units.size).toBe(3);
  });

  it('mevcut daire atlanir (exists); is kurali hatasi satira yazilir, parca devam eder', async () => {
    const t = await seeded();
    await t.service.start(t.ctx, { importId: 'imp1', asOfDate: '2026-10-31' });
    await t.service.processRows(t.ctx, 'imp1', { units: unitsSheet.slice(0, 1) });
    await t.service.start(t.ctx, { importId: 'imp2', asOfDate: '2026-10-31' });
    const r = await t.service.processRows(t.ctx, 'imp2', {
      units: unitsSheet,
      people: [...peopleSheet, { row: 9, block: 'A Blok', number: '2', fullName: 'Can Kaya', email: 'can@site.com', relation: 'Kiracı' }],
    });
    expect(r.results.map((x) => x.outcome)).toEqual(['exists', 'created', 'created', 'created', 'created', 'error']);
    expect(r.results.at(-1)?.message).toBeTruthy();
  });

  it('parca siniri 25 satir; tamamlanmis aktarima satir eklenemez', async () => {
    const t = await seeded();
    await runAll(t);
    await expect(t.service.processRows(t.ctx, 'imp1', { units: unitsSheet })).rejects.toMatchObject({ httpStatus: 409 });
    await t.service.start(t.ctx, { importId: 'imp3', asOfDate: '2026-10-31' });
    const many = Array.from({ length: 26 }, (_, i) => ({ block: 'A', number: String(i), area: '50' }));
    await expect(t.service.processRows(t.ctx, 'imp3', { units: many })).rejects.toMatchObject({ field: 'rows' });
  });
});

describe('aktarim - davetler ve geri alma', () => {
  it('davetler sonradan parca parca gonderilir; ayni kisiye ikinci kez gitmez', async () => {
    const t = await seeded();
    await runAll(t);
    expect((await t.service.get(t.ctx, 'imp1')).pendingInvitations).toBe(2);
    expect(await t.service.sendInvitations(t.ctx, 'imp1')).toEqual({ sent: 2, remaining: 0 });
    expect(t.resent.sort()).toEqual(['ali@site.com', 'ayse@site.com']);
    expect(await t.service.sendInvitations(t.ctx, 'imp1')).toEqual({ sent: 0, remaining: 0 });
  });

  it('geri alma: bakiyeler ters kayitla iptal (defter silinmez), uyelikler biter, hareketsiz daireler pasif', async () => {
    const t = await seeded();
    await runAll(t);
    const txBefore = t.fin.transactions.size;
    const r = await t.service.rollback(t.ctx, 'imp1', {});
    expect(r).toMatchObject({ remaining: 0, status: 'rolled_back', report: { reversed: 4, membershipsEnded: 2, unitsDeactivated: 3, unitsKept: 0 } });
    expect(t.fin.transactions.size).toBe(txBefore + 4);
    expect(t.fin.trialBalance()).toBe(0);
    expect(t.fin.balanceOf('cash', t.ctx.apartmentId)).toBe(0);
    expect([...t.memberships.values()].every((m) => m.status === 'inactive')).toBe(true);
    expect([...t.units.values()].every((u) => u.status === 'inactive')).toBe(true);
    // Tekrar: zaten geri alinmis, hicbir sey yapilmaz.
    expect(await t.service.rollback(t.ctx, 'imp1', {})).toMatchObject({ remaining: 0, report: { reversed: 4 } });
    await expect(t.service.sendInvitations(t.ctx, 'imp1')).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('aktarim sonrasi baska hareketi olan daire geri almada korunur', async () => {
    const t = await seeded();
    await runAll(t);
    const u3 = [...t.units.values()].find((u) => u.number === 'D1')!;
    await t.finance.chargeUnit({ apartmentId: t.ctx.apartmentId, userId: 'mgr' }, { idempotencyKey: 'k1', unitId: u3.unitId, liableParty: 'owner', amount: 100, dueDate: '2026-11-20', description: 'x' });
    const r = await t.service.rollback(t.ctx, 'imp1', {});
    expect(r.report).toMatchObject({ unitsDeactivated: 2, unitsKept: 1 });
    expect(t.units.get(u3.unitId)?.status).toBe('active');
  });
});

describe('aktarim rotalari', () => {
  it('yalnizca yonetici yazabilir; denetci gecmisi okur; sakin erisemez', async () => {
    const t = await seeded();
    const app = (role: 'apartment_manager' | 'observer' | 'resident') =>
      createApp({ version: 't', authenticate: () => ({ userId: 'mgr', role, apartmentId: t.ctx.apartmentId }), importsService: t.service });
    const post = (body: object) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    expect((await app('observer').request('/api/imports/preview', post({ asOfDate: '2026-10-31' }))).status).toBe(403);
    expect((await app('resident').request('/api/imports')).status).toBe(403);
    expect((await app('apartment_manager').request('/api/imports/preview', post({ asOfDate: '2026-10-31', units: unitsSheet }))).status).toBe(200);
    expect((await app('apartment_manager').request('/api/imports', post({ importId: 'r1', asOfDate: '2026-10-31' }))).status).toBe(201);
    const list = await app('observer').request('/api/imports');
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
    expect((await app('observer').request('/api/imports/yok')).status).toBe(404);
  });
});
