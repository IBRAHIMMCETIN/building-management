import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import { DataAccessError } from '../src/config/dynamodb.js';
import { assemblyQuorum, decide } from '../src/modules/assemblies/quorum.js';
import type { AssemblyRepository } from '../src/modules/assemblies/repository.js';
import { createAssemblyService } from '../src/modules/assemblies/service.js';
import type { Assembly, AssemblyAttendance } from '../src/modules/assemblies/types.js';
import type { AuditDraft } from '../src/modules/audit/log.js';
import type { Block, LandShare, Unit } from '../src/modules/core/types.js';
import { renderReportPdf } from '../src/modules/documents/reportPdf.js';
import { createMemoryDocumentStore } from '../src/modules/documents/store.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import type { Person } from '../src/modules/residents/repository.js';

const APT = 'apt-1';
const T0 = '2026-11-27T09:00:00.000Z';
const seed = { createdAt: T0, createdBy: 'seed', updatedAt: T0, updatedBy: 'seed', version: 1 };

const unit = (id: string, number: string, landShare?: LandShare, blockId = 'b1'): Unit => ({
  PK: `APT#${APT}`,
  SK: `UNIT#${id}`,
  entityType: 'UNIT',
  status: 'active',
  ...seed,
  unitId: id,
  siteId: APT,
  blockId,
  number,
  type: 'flat',
  grossAreaTenthsM2: 1000,
  ...(landShare ? { landShare } : {}),
  exemptions: [],
});

const owner = (userId: string, unitId: string, extra: Partial<UnitMembership> = {}): UnitMembership => ({
  PK: `APT#${APT}`,
  SK: `MEMBER#${userId}#${unitId}`,
  entityType: 'UNIT_MEMBERSHIP',
  ...seed,
  userId,
  apartmentId: APT,
  unitId,
  relation: 'owner',
  residesInUnit: true,
  status: 'active',
  startDate: '2026-01-01',
  ...extra,
});

/** u1-u3 %10'ar, u4 %70 arsa payi: sayica cogunluk ile arsa payi cogunlugu ayrisir. */
const ls = (n: number): LandShare => ({ numerator: n, denominator: 1000 });

function setup(opts: { store?: boolean } = {}) {
  const now = new Date(T0);
  const docs = new Map<string, Assembly>();
  const atts = new Map<string, AssemblyAttendance>();
  const audits: AuditDraft[] = [];
  const clone = <T>(x: T): T => structuredClone(x);
  const repo: AssemblyRepository = {
    get: async (apt, id) => clone(docs.get(`${apt}|${id}`)),
    list: async (apt) => [...docs.values()].filter((a) => a.apartmentId === apt).map(clone),
    create: async (a) => void docs.set(`${a.apartmentId}|${a.assemblyId}`, clone(a)),
    update: async (a, expected, audit) => {
      if (docs.get(`${a.apartmentId}|${a.assemblyId}`)?.version !== expected) throw new DataAccessError('conflict', 'surum');
      docs.set(`${a.apartmentId}|${a.assemblyId}`, clone(a));
      if (audit) audits.push(clone(audit));
    },
    listAttendance: async (apt, id) => [...atts.values()].filter((x) => x.apartmentId === apt && x.assemblyId === id).map(clone),
    getAttendance: async (apt, id, unitId) => clone(atts.get(`${apt}|${id}|${unitId}`)),
    putAttendance: async (att, expected, audit) => {
      if (docs.get(`${att.apartmentId}|${att.assemblyId}`)?.status !== 'planned') throw new DataAccessError('conflict', 'iptal');
      const k = `${att.apartmentId}|${att.assemblyId}|${att.unitId}`;
      if (expected === 0 ? atts.has(k) : atts.get(k)?.version !== expected) throw new DataAccessError('conflict', 'surum');
      atts.set(k, clone(att));
      audits.push(clone(audit));
    },
  };
  const units = [unit('u1', '1', ls(100)), unit('u2', '2', ls(100)), unit('u3', '3', ls(100)), unit('u4', '4', ls(700), 'b2')];
  const members = [
    owner('own-1', 'u1'),
    owner('own-2a', 'u2', { ownershipShare: { numerator: 1, denominator: 2 } }),
    owner('own-2b', 'u2', { ownershipShare: { numerator: 1, denominator: 2 } }),
    owner('own-3', 'u3'),
    owner('own-4', 'u4'),
  ];
  const people = ['own-1', 'own-2a', 'own-2b', 'own-3', 'own-4'].map((userId) => ({ apartmentId: APT, userId, fullName: `Kişi ${userId}` }) as Person);
  const blocks = [
    { blockId: 'b1', name: 'A Blok', siteId: APT },
    { blockId: 'b2', name: 'B Blok', siteId: APT },
  ] as Block[];
  const { store } = createMemoryDocumentStore();
  let n = 0;
  const service = createAssemblyService({
    repository: repo,
    core: { listUnits: async () => units, listBlocks: async () => blocks, getSite: async () => ({ name: 'Lale Apartmanı' }) as never },
    ownership: { listHeads: async () => [], listRecords: async () => [] },
    memberships: { list: async (apt) => members.filter((m) => m.apartmentId === apt) },
    people: { list: async () => people },
    store: opts.store === false ? undefined : store,
    now: () => now,
    newId: () => `asm${++n}`,
  });
  const app = createApp({ version: 'test', authenticate: createMockAuthenticator(), assemblyService: service });
  const token = (sub: string, role: string, apartmentId = APT) => `Bearer ${encodeMockToken({ sub, role, ...(apartmentId ? { apartmentId } : {}) })}`;
  const manager = token('mgr-1', 'apartment_manager');
  const call = async (method: string, path: string, body?: unknown, auth = manager) => {
    const res = await app.request(`/api/assemblies${path}`, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const attend = (unitId: string, mode: string, extra: Record<string, unknown> = {}) => call('PUT', `/asm1/attendance/${unitId}`, { mode, ...extra });
  return { call, token, attend, audits, store, docs };
}

const meeting = {
  kind: 'ordinary',
  scheduledAt: '2026-12-15T19:00:00+03:00',
  location: 'Site toplantı salonu',
  agenda: ['Yönetim kurulu seçimi', { title: 'İşletme projesi', description: '2027 bütçesi' }],
};

describe('assemblies - yetki ve kayit', () => {
  it('roller: denetci okur, yazamaz; sakin ve gorevli giremez; tenant izolasyonu', async () => {
    const { call, token } = setup();
    expect((await call('POST', '', meeting, token('o', 'observer'))).status).toBe(403);
    expect((await call('GET', '', undefined, token('r', 'resident'))).status).toBe(403);
    expect((await call('GET', '', undefined, token('s', 'building_staff'))).status).toBe(403);
    expect((await call('POST', '', meeting, token('m', 'management_company'))).status).toBe(201);
    expect((await call('GET', '', undefined, token('o', 'observer'))).body.items).toHaveLength(1);
    expect((await call('GET', '/asm1', undefined, token('x', 'apartment_manager', 'apt-2'))).status).toBe(404);
  });

  it('toplanti: gundem a1..aN, oy listesi tarihi toplanti gunu (Istanbul), cevrim ici baglanti https', async () => {
    const { call } = setup();
    const res = await call('POST', '', { ...meeting, scheduledAt: '2026-12-16T00:30:00+03:00', onlineUrl: 'https://meet.example/abc' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'ordinary',
      status: 'planned',
      secondMeeting: false,
      scheduledAt: '2026-12-15T21:30:00.000Z',
      rollDate: '2026-12-16',
      onlineUrl: 'https://meet.example/abc',
      agenda: [
        { itemId: 'a1', title: 'Yönetim kurulu seçimi' },
        { itemId: 'a2', title: 'İşletme projesi', description: '2027 bütçesi' },
      ],
    });
  });

  it.each([
    ['yer ve baglanti yok', { ...meeting, location: undefined }],
    ['http baglanti', { ...meeting, location: undefined, onlineUrl: 'http://meet.example' }],
    ['bos gundem', { ...meeting, agenda: [] }],
    ['31 madde', { ...meeting, agenda: Array.from({ length: 31 }, (_, i) => `M${i}`) }],
    ['gecersiz tur', { ...meeting, kind: 'annual' }],
    ['saat dilimsiz tarih', { ...meeting, scheduledAt: '2026-12-15T19:00:00' }],
  ])('400: %s', async (_l, body) => {
    const { call } = setup();
    expect((await call('POST', '', body)).status).toBe(400);
  });
});

describe('assemblies - katilim ve KMK m.30 yeter sayi', () => {
  it('oy listesi satirlari malik adlari ve paylarla; yeter sayi sayi VE arsa payi cogunlugu ister', async () => {
    const { call, attend } = setup();
    await call('POST', '', meeting);
    const d0 = (await call('GET', '/asm1')).body;
    expect(d0.units.map((u: any) => u.unitId)).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(d0.units[1].owners).toEqual([
      { userId: 'own-2a', name: 'Kişi own-2a', share: { numerator: 1, denominator: 2 } },
      { userId: 'own-2b', name: 'Kişi own-2b', share: { numerator: 1, denominator: 2 } },
    ]);
    expect(d0.units[1].warnings).toEqual(['temsilci yok']);
    expect(d0.quorum).toMatchObject({ totalUnits: 4, presentUnits: 0, met: false, totalLandShare: { numerator: 1000, denominator: 1000 } });

    // Sayica cogunluk (3/4) var, arsa payi (300/1000) yok.
    for (const u of ['u1', 'u2', 'u3']) expect((await attend(u, 'present')).status).toBe(200);
    let q = (await call('GET', '/asm1')).body.quorum;
    expect(q).toMatchObject({ presentUnits: 3, unitsMajority: true, landShareMajority: false, met: false, landShareBps: 3000 });

    // Arsa payi var (700 + 100), sayi yok (2/4: yarisindan fazla degil).
    await attend('u2', 'absent');
    await attend('u3', 'absent');
    await attend('u4', 'proxy', { proxyName: 'Av. Deniz Kaya' });
    q = (await call('GET', '/asm1')).body.quorum;
    expect(q).toMatchObject({ presentUnits: 2, proxyUnits: 1, unitsMajority: false, landShareMajority: true, met: false });

    await attend('u2', 'present', { attendeeName: 'Kişi own-2b' });
    q = (await call('GET', '/asm1')).body.quorum;
    expect(q).toMatchObject({ presentUnits: 3, met: true, decisionThreshold: 2, presentLandShare: { numerator: 900, denominator: 1000 } });
  });

  it('vekaleten katilim vekil adi ister; ayni vekil birden fazla bolumde uyari; oy listesinde olmayan bolum 404', async () => {
    const { call, attend, audits } = setup();
    await call('POST', '', meeting);
    expect((await attend('u1', 'proxy')).status).toBe(400);
    await attend('u1', 'proxy', { proxyName: 'Ali Demir' });
    await attend('u3', 'proxy', { proxyName: ' ali demir ' });
    expect((await call('GET', '/asm1')).body.quorum.warnings.join(' ')).toContain('Aynı vekil birden fazla bölümü temsil ediyor (Ali Demir: 2 bölüm)');
    expect((await attend('u9', 'present')).status).toBe(404);
    expect((await attend('u1', 'maybe')).status).toBe(400);
    // Katilim denetime yazilir; ad / vekil adi denetim ayrintisina girmez.
    expect(audits.filter((a) => a.action === 'assembly.attendance')).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain('Ali Demir');
  });

  it('sayim yalnizca yeter sayi varsa; karar katilanlarin sayi cogunlugu; toplam katilani asamaz', async () => {
    const { call, attend, audits } = setup();
    await call('POST', '', meeting);
    await attend('u1', 'present');
    const blocked = await call('POST', '/asm1/agenda/a1/tally', { version: 1, yes: 1, no: 0, abstain: 0 });
    expect(blocked.status).toBe(422);
    expect(blocked.body.message).toContain('İkinci toplantıda');

    await attend('u2', 'present');
    await attend('u4', 'present');
    expect((await call('POST', '/asm1/agenda/a1/tally', { version: 1, yes: 3, no: 1, abstain: 0 })).status).toBe(400);
    const accepted = await call('POST', '/asm1/agenda/a1/tally', { version: 1, yes: 2, no: 1, abstain: 0 });
    expect(accepted.status).toBe(200);
    expect(accepted.body.assembly.agenda[0].tally).toMatchObject({ yes: 2, no: 1, abstain: 0, presentUnits: 3, decision: 'accepted', recordedBy: 'mgr-1' });
    // Cekimser kabul sayilmaz: 1 kabul / 3 katilan reddedilir.
    const rejected = await call('POST', '/asm1/agenda/a2/tally', { version: 2, yes: 1, no: 1, abstain: 1 });
    expect(rejected.body.assembly.agenda[1].tally.decision).toBe('rejected');
    expect(audits.filter((a) => a.action === 'assembly.tally').map((a) => a.details)).toEqual([
      expect.objectContaining({ itemId: 'a1', decision: 'accepted', corrected: false }),
      expect.objectContaining({ itemId: 'a2', decision: 'rejected' }),
    ]);
    expect((await call('POST', '/asm1/agenda/a9/tally', { version: 3, yes: 1, no: 0, abstain: 0 })).status).toBe(404);
    // Sayim yapildiktan sonra toplanti bilgisi / gundem degismez.
    expect((await call('PATCH', '/asm1', { version: 3, location: 'Bahçe' })).status).toBe(409);
  });

  it('ikinci toplantida yeter sayi aranmaz; karar yine katilanlarin cogunlugu', async () => {
    const { call, attend } = setup();
    await call('POST', '', { ...meeting, secondMeeting: true });
    await attend('u1', 'present');
    const res = await call('POST', '/asm1/agenda/a1/tally', { version: 1, yes: 1, no: 0, abstain: 0 });
    expect(res.status).toBe(200);
    expect(res.body.quorum).toMatchObject({ met: true, unitsMajority: false, secondMeeting: true });
    expect(res.body.assembly.agenda[0].tally.decision).toBe('accepted');
  });

  it('iptal gerekce ister ve denetlenir; iptal edilen toplantida katilim / sayim 409', async () => {
    const { call, attend, audits } = setup();
    await call('POST', '', meeting);
    expect((await call('POST', '/asm1/cancel', { version: 1 })).status).toBe(400);
    const res = await call('POST', '/asm1/cancel', { version: 1, reason: 'Ertelendi' });
    expect(res.body).toMatchObject({ status: 'cancelled', cancelReason: 'Ertelendi' });
    expect(audits.at(-1)).toMatchObject({ action: 'assembly.cancel', reason: 'Ertelendi' });
    expect((await attend('u1', 'present')).status).toBe(409);
    expect((await call('POST', '/asm1/agenda/a1/tally', { version: 2, yes: 1, no: 0, abstain: 0 })).status).toBe(409);
  });
});

describe('assemblies - hazirun cetveli PDF', () => {
  it('oy listesinden PDF uretilir, S3 anahtari apartman altinda, 5 dk imzali link; veri degismedikce yeniden uretilmez', async () => {
    const { call, attend, store } = setup();
    await call('POST', '', meeting);
    await attend('u4', 'proxy', { proxyName: 'Av. Deniz Kaya' });
    const res = await call('GET', '/asm1/attendance-sheet');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ contentType: 'application/pdf', fileName: 'hazirun-cetveli-2026-12-15.pdf' });
    expect(res.body.url).toMatch(/^memory:\/\/get\/apartments\/apt-1\/reports\/2026\/12\/assembly-hazirun-asm1-[0-9a-f]{16}\.pdf\?ttl=300/);
    const key = decodeURIComponent(res.body.url.slice('memory://get/'.length).split('?')[0]);
    const head = await store.head(key);
    expect(head?.contentType).toBe('application/pdf');
    expect((await call('GET', '/asm1/attendance-sheet')).body.url).toBe(res.body.url);
    await attend('u1', 'present');
    expect((await call('GET', '/asm1/attendance-sheet')).body.url).not.toBe(res.body.url);
  });

  it('belge deposu yoksa 503', async () => {
    const { call } = setup({ store: false });
    await call('POST', '', meeting);
    expect((await call('GET', '/asm1/attendance-sheet')).status).toBe(503);
  });

  it('rapor sablonu imza payli yuksek satir ve satir cizgileriyle gecerli PDF uretir', async () => {
    const bytes = await renderReportPdf({
      apartmentName: 'Lale',
      title: 'Hazirun Cetveli',
      sections: [{ columns: [{ header: 'Bölüm', width: 1 }, { header: 'İmza', width: 2 }], rowHeight: 26, ruled: true, rows: Array.from({ length: 40 }, (_, i) => ({ cells: [String(i + 1), ''] })) }],
      generatedAt: T0,
      dataHash: 'a'.repeat(64),
    });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });
});

describe('assemblies - saf yeter sayi', () => {
  const roll = (shares: (number | undefined)[], owners: string[][] = []) =>
    shares.map((s, i) => ({ unitId: `u${i}`, ...(s === undefined ? {} : { landShare: ls(s) }), owners: (owners[i] ?? [`o${i}`]).map((userId) => ({ userId })) }));
  const att = (unitId: string, mode: AssemblyAttendance['mode'] = 'present') => ({ unitId, mode }) as AssemblyAttendance;

  it('tam yari yetmez (yarisindan fazlasi); arsa payi yoksa yeter sayi saglanamaz', () => {
    const q = assemblyQuorum({ roll: roll([250, 250, 250, 250]), attendance: [att('u0'), att('u1')], secondMeeting: false });
    expect(q).toMatchObject({ unitsMajority: false, landShareMajority: false, met: false, decisionThreshold: 2 });
    const none = assemblyQuorum({ roll: roll([undefined, undefined, undefined]), attendance: [att('u0'), att('u1')], secondMeeting: false });
    expect(none).toMatchObject({ unitsMajority: true, landShareMajority: false, met: false, totalLandShare: null });
    expect(none.warnings[0]).toContain('arsa payı çoğunluğu hesaplanamıyor');
    expect(assemblyQuorum({ roll: roll([500, 500]), attendance: [att('u0', 'absent'), att('zz')], secondMeeting: false }).presentUnits).toBe(0);
  });

  it('bir malikin bolumleri oylarin ucte birini asarsa uyari', () => {
    const q = assemblyQuorum({ roll: roll([100, 100, 100, 100, 100], [['a'], ['a'], ['b'], ['c'], ['d']]), attendance: [], secondMeeting: false });
    expect(q.warnings.join(' ')).toContain('üçte birini');
  });

  it('karar: kabul > katilan / 2', () => {
    expect(decide(2, 3)).toBe('accepted');
    expect(decide(2, 4)).toBe('rejected');
    expect(decide(0, 0)).toBe('rejected');
  });
});
