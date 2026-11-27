import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import { DataAccessError, resetDynamoCache } from '../src/config/dynamodb.js';
import type { DomainEvent } from '../src/events/publisher.js';
import type { AuditDraft } from '../src/modules/audit/log.js';
import type { Block, LandShare, Unit } from '../src/modules/core/types.js';
import { renderEmail } from '../src/modules/notifications/templates.js';
import type { OwnershipRecord } from '../src/modules/ownership/types.js';
import { type PollRepository, PollVoteConflictError, createPollRepository, pollKeys } from '../src/modules/polls/repository.js';
import { commonDenominator, eligibleVoters, istanbulDate, pollPhase, tallyPoll, toBps } from '../src/modules/polls/results.js';
import { buildSnapshot, createMemoryRollStore } from '../src/modules/polls/rollSnapshot.js';
import { MIN_SECRET_CLOSE_VOTES, createPollService } from '../src/modules/polls/service.js';
import type { Poll, PollVote } from '../src/modules/polls/types.js';
import type { PortalRepository } from '../src/modules/portal/repository.js';
import { createPortalService } from '../src/modules/portal/service.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { buildNotifications } from '../src/workers/notification-worker.js';

const APT = 'apt-1';
const OTHER_APT = 'apt-2';
// 10.11.2026 10:00 Istanbul
const T0 = '2026-11-10T07:00:00.000Z';
const seed = { createdAt: T0, createdBy: 'seed', updatedAt: T0, updatedBy: 'seed', version: 1 };

function unit(id: string, number: string, landShare?: LandShare, status: Unit['status'] = 'active'): Unit {
  return {
    PK: `APT#${APT}`,
    SK: `UNIT#${id}`,
    entityType: 'UNIT',
    status,
    ...seed,
    unitId: id,
    siteId: APT,
    blockId: 'b1',
    number,
    type: 'flat',
    grossAreaTenthsM2: 1000,
    ...(landShare ? { landShare } : {}),
    exemptions: [],
  };
}

function member(userId: string, unitId: string, relation: 'owner' | 'tenant', extra: Partial<UnitMembership> = {}): UnitMembership {
  return {
    PK: `APT#${APT}`,
    SK: `MEMBER#${userId}#${unitId}`,
    entityType: 'UNIT_MEMBERSHIP',
    ...seed,
    userId,
    apartmentId: APT,
    unitId,
    relation,
    residesInUnit: relation === 'tenant',
    status: 'active',
    startDate: '2026-01-01',
    ...extra,
  };
}

const half = { numerator: 1, denominator: 2 };

/** u1 %10, u2 %20, u3 %70 arsa payi (1200'de 120 / 240 / 840). */
const defaultUnits = () => [unit('u1', '1', { numerator: 120, denominator: 1200 }), unit('u2', '2', { numerator: 240, denominator: 1200 }), unit('u3', '3', { numerator: 840, denominator: 1200 })];

const defaultMembers = () => [
  member('own-1', 'u1', 'owner'),
  member('ten-1', 'u1', 'tenant'),
  member('own-2a', 'u2', 'owner', { ownershipShare: half }),
  member('own-2b', 'u2', 'owner', { ownershipShare: half }),
  member('own-3', 'u3', 'owner', { residesInUnit: true }),
];

function createFakePollRepo(rolls: ReturnType<typeof createMemoryRollStore>) {
  const polls = new Map<string, Poll>();
  const votes = new Map<string, PollVote>();
  const outbox: DomainEvent[] = [];
  const audits: AuditDraft[] = [];
  const clone = <T>(x: T): T => structuredClone(x);
  const pk = (apt: string, id: string) => `${apt}|${id}`;
  const vk = (apt: string, poll: string, unitId: string) => `${apt}|${poll}|${unitId}`;
  const repo: PollRepository = {
    get: async (apt, id) => clone(polls.get(pk(apt, id))),
    list: async (apt) => [...polls.values()].filter((p) => p.apartmentId === apt).map(clone),
    create: async (p) => {
      if (polls.has(pk(p.apartmentId, p.pollId))) throw new DataAccessError('conflict', 'var');
      polls.set(pk(p.apartmentId, p.pollId), clone(p));
    },
    update: async (p, expected, opts = {}) => {
      if (polls.get(pk(p.apartmentId, p.pollId))?.version !== expected) throw new DataAccessError('conflict', 'surum');
      const events = opts.outbox ?? [];
      if (events.some((e) => outbox.some((o) => o.eventId === e.eventId))) throw new DataAccessError('conflict', 'olay');
      if (opts.roll?.length) rolls.put(opts.roll);
      polls.set(pk(p.apartmentId, p.pollId), clone(p));
      outbox.push(...clone(events));
      if (opts.audit) audits.push(clone(opts.audit));
    },
    getVote: async (apt, poll, unitId) => clone(votes.get(vk(apt, poll, unitId))),
    listVotes: async (apt, poll) => [...votes.values()].filter((v) => v.apartmentId === apt && v.pollId === poll).map(clone),
    putVote: async (v, expected, now) => {
      const p = polls.get(pk(v.apartmentId, v.pollId));
      if (!p || p.status !== 'published' || !(p.opensAt <= now && p.closesAt > now)) throw new PollVoteConflictError('poll');
      const cur = votes.get(vk(v.apartmentId, v.pollId, v.unitId));
      if (expected === 0 ? cur : cur?.version !== expected) throw new PollVoteConflictError('vote');
      votes.set(vk(v.apartmentId, v.pollId, v.unitId), clone(v));
    },
  };
  return { repo, polls, votes, outbox, audits };
}

function setup(opts: { units?: Unit[]; members?: UnitMembership[]; records?: OwnershipRecord[] } = {}) {
  let now = new Date(T0);
  let step = 0;
  const clock = { set: (iso: string) => void (now = new Date(iso)), step: (ms: number) => void (step = ms) };
  const tick = () => {
    const d = now;
    now = new Date(now.getTime() + step);
    return d;
  };
  const rolls = createMemoryRollStore();
  const fake = createFakePollRepo(rolls);
  const units = opts.units ?? defaultUnits();
  const members = opts.members ?? defaultMembers();
  const records = opts.records ?? [];
  const blocks: Block[] = [{ PK: `APT#${APT}`, SK: 'BLOCK#b1', entityType: 'BLOCK', status: 'active', ...seed, blockId: 'b1', siteId: APT, name: 'A Blok' }];
  const core = {
    getUnit: async (apt: string, id: string) => units.find((u) => u.siteId === apt && u.unitId === id),
    listUnits: async (apt: string) => units.filter((u) => u.siteId === apt),
    getBlock: async (apt: string, id: string) => blocks.find((b) => b.siteId === apt && b.blockId === id),
    getSite: async () => undefined,
  };
  const portalRepo: PortalRepository = {
    listMemberships: async (apt, user) => members.filter((m) => m.apartmentId === apt && m.userId === user),
    listLedgerEntries: async () => [],
    getTransactions: async () => [],
    listUnitPayments: async () => [],
    listPublishedAnnouncements: async () => [],
  };
  const portal = createPortalService({ repository: portalRepo, core, now: tick });
  let n = 0;
  const pollService = createPollService({
    repository: fake.repo,
    core,
    ownership: {
      listHeads: async () => [],
      listRecords: async (apt, unitId) => records.filter((r) => r.apartmentId === apt && (!unitId || r.unitId === unitId)),
    },
    memberships: { list: async (apt, f = {}) => members.filter((m) => m.apartmentId === apt && (!f.unitId || m.unitId === f.unitId)) },
    portal,
    rolls,
    now: tick,
    newId: () => `poll${++n}`,
  });
  const app = createApp({ version: 'test', authenticate: createMockAuthenticator(), pollService, portalService: portal });

  const token = (sub: string, role: string, apartmentId = APT) => `Bearer ${encodeMockToken({ sub, role, ...(apartmentId ? { apartmentId } : {}) })}`;
  const manager = token('mgr-1', 'apartment_manager');

  const request = async (path: string, method: string, auth: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any>, headers: res.headers };
  };
  const call = (method: string, path: string, body?: unknown, auth = manager) => request(`/api/polls${path}`, method, auth, body);
  const portalCall = (method: string, path: string, user: string, body?: unknown, unitId?: string) =>
    request(`/api/portal/polls${path}${unitId ? `?unitId=${unitId}` : ''}`, method, token(user, 'resident'), body);
  const vote = (user: string, optionId: string, pollId = 'poll1', unitId?: string) => portalCall('POST', `/${pollId}/vote`, user, { optionId }, unitId);

  /** Taslak olustur + yayinla (varsayilan: kat malikleri, bolum basi, gizli). */
  const published = async (body: Record<string, unknown> = {}) => {
    const created = await call('POST', '', { ...draft, ...body });
    expect(created.status).toBe(201);
    const pub = await call('POST', `/${created.body.pollId}/publish`, { version: 1 });
    expect(pub.status).toBe(200);
    return pub.body;
  };

  return { ...fake, app, call, portalCall, vote, token, clock, published, units, members, records, rolls };
}

const draft = { title: 'Asansör yenilensin mi?', options: ['Evet', 'Hayır'], closesAt: '2026-11-17T18:00:00+03:00' };

// ---------------------------------------------------------------------------

describe('polls - yetki ve tenant izolasyonu', () => {
  it('401 / 403 / denetci salt okunur / yonetim firmasi yazar', async () => {
    const { app, call, token } = setup();
    expect((await app.request('/api/polls')).status).toBe(401);
    expect((await call('GET', '', undefined, token('r', 'resident'))).status).toBe(403);
    expect((await call('POST', '', draft, token('r', 'resident'))).status).toBe(403);
    expect((await call('POST', '', draft, token('s', 'building_staff'))).status).toBe(403);
    expect((await call('POST', '', draft, token('o', 'observer'))).status).toBe(403);
    expect((await call('GET', '', undefined, token('o', 'observer'))).status).toBe(200);
    expect((await call('POST', '', draft, token('m', 'management_company'))).status).toBe(201);
    expect((await call('POST', '/poll1/publish', { version: 1 }, token('o', 'observer'))).status).toBe(403);
    expect((await call('GET', '/poll1/results', undefined, token('s', 'security_guard'))).status).toBe(403);
  });

  it('apartman claim yoksa 403; baska apartmanin oylamasi gorunmez, yayinlanamaz, sonucu okunamaz', async () => {
    const { call, token, published } = setup();
    expect((await call('GET', '', undefined, token('m', 'apartment_manager', ''))).status).toBe(403);
    await published();
    const other = token('mgr-2', 'apartment_manager', OTHER_APT);
    expect((await call('GET', '', undefined, other)).body.items).toEqual([]);
    expect((await call('GET', '/poll1', undefined, other)).status).toBe(404);
    expect((await call('GET', '/poll1/results', undefined, other)).status).toBe(404);
    expect((await call('POST', '/poll1/close', { version: 2, reason: 'deneme' }, other)).status).toBe(404);
  });

  it('govdedeki apartmentId / status yok sayilir; anahtarlar claimden', async () => {
    const { call, polls } = setup();
    const res = await call('POST', '', { ...draft, apartmentId: OTHER_APT, status: 'published' });
    expect(res.body).toMatchObject({ pollId: 'poll1', apartmentId: APT, status: 'draft', phase: 'draft', secret: true, audience: 'owners', weighting: 'per_unit' });
    expect(res.body).not.toHaveProperty('PK');
    expect(polls.get(`${APT}|poll1`)!.SK).toBe('POLL#poll1');
  });

  it('sakin portali yalnizca resident; yonetici portal ucuna giremez', async () => {
    const { app, published, token } = setup();
    await published();
    const res = await app.request('/api/portal/polls', { headers: { authorization: token('mgr-1', 'apartment_manager') } });
    expect(res.status).toBe(403);
  });
});

describe('polls - olusturma ve dogrulama', () => {
  it('secenekler o1..oN kimligi alir; saat dilimli tarih UTC ye normalize edilir; oy listesi tarihi Istanbul gunu', async () => {
    const { call } = setup();
    const res = await call('POST', '', {
      ...draft,
      description: '  Yönetim planı ekte  ',
      options: [' Evet ', 'Hayır', 'Çekimserim'],
      opensAt: '2026-11-12T00:30:00+03:00',
      closesAt: '2026-11-19T00:30:00+03:00',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      description: 'Yönetim planı ekte',
      options: [
        { optionId: 'o1', label: 'Evet' },
        { optionId: 'o2', label: 'Hayır' },
        { optionId: 'o3', label: 'Çekimserim' },
      ],
      opensAt: '2026-11-11T21:30:00.000Z',
      // UTC'de 11'i ama Istanbul'da 12 Kasim.
      rollDate: '2026-11-12',
    });
  });

  it.each([
    ['baslik yok', { options: ['a', 'b'], closesAt: draft.closesAt }],
    ['tek secenek', { ...draft, options: ['Evet'] }],
    ['11 secenek', { ...draft, options: Array.from({ length: 11 }, (_, i) => `S${i}`) }],
    ['ayni secenek iki kez', { ...draft, options: ['Evet', ' evet '] }],
    ['bos secenek', { ...draft, options: ['Evet', '  '] }],
    ['bitis yok', { title: 'x', options: ['a', 'b'] }],
    ['saat dilimsiz tarih', { ...draft, closesAt: '2026-11-17T18:00:00' }],
    ['bitis baslangictan once', { ...draft, opensAt: '2026-11-20T09:00:00Z', closesAt: '2026-11-19T09:00:00Z' }],
    ['gizli oylamada ara sonuc', { ...draft, secret: true, resultsVisibleBeforeClose: true }],
    ['gecersiz hedef kitle', { ...draft, audience: 'everyone' }],
    ['gecersiz agirlik', { ...draft, weighting: 'm2' }],
  ])('400: %s', async (_l, body) => {
    const { call } = setup();
    expect((await call('POST', '', body)).status).toBe(400);
  });
});

describe('polls - yasam dongusu ve denetim', () => {
  it('taslak duzenlenir; yayinda olay outbox a, denetim zincirine poll.publish yazilir; yayindan sonra soru degismez', async () => {
    const { call, outbox, audits, clock } = setup();
    await call('POST', '', draft);
    const edited = await call('PATCH', '/poll1', { version: 1, title: 'Asansör modernizasyonu', options: ['Evet', 'Hayır', 'Ertelensin'], secret: false, resultsVisibleBeforeClose: true });
    expect(edited.body).toMatchObject({ version: 2, title: 'Asansör modernizasyonu', secret: false, resultsVisibleBeforeClose: true });
    expect(edited.body.options).toHaveLength(3);
    expect(audits).toEqual([]); // taslak duzenleme denetlenmez, olay uretmez
    expect(outbox).toEqual([]);

    clock.set('2026-11-10T08:00:00.000Z');
    const pub = await call('POST', '/poll1/publish', { version: 2 });
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ status: 'published', phase: 'open', publishedBy: 'mgr-1', opensAt: '2026-11-10T08:00:00.000Z', rollDate: '2026-11-10', version: 3 });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventId: 'POLL_PUBLISHED:poll1',
      type: 'POLL_PUBLISHED',
      apartmentId: APT,
      payload: { pollId: 'poll1', title: 'Asansör modernizasyonu', audience: 'owners', closesAt: '2026-11-17T15:00:00.000Z' },
    });
    expect(JSON.stringify(outbox[0])).not.toContain('Ertelensin'); // secenekler tasinmaz
    expect(audits).toEqual([expect.objectContaining({ apartmentId: APT, action: 'poll.publish', target: { type: 'poll', id: 'poll1' } })]);

    expect((await call('PATCH', '/poll1', { version: 3, title: 'x' })).status).toBe(409);
    expect((await call('PATCH', '/poll1', { version: 3, options: ['a', 'b'] })).status).toBe(409);
    expect((await call('POST', '/poll1/publish', { version: 3 })).status).toBe(409);
    expect((await call('POST', '/poll1/cancel', { version: 3 })).status).toBe(409);
  });

  it('ileri tarihli oylama planli kalir; oy listesi tarihi acilis gunu', async () => {
    const { call } = setup();
    await call('POST', '', { ...draft, opensAt: '2026-11-12T09:00:00+03:00' });
    const pub = await call('POST', '/poll1/publish', { version: 1 });
    expect(pub.body).toMatchObject({ phase: 'scheduled', opensAt: '2026-11-12T06:00:00.000Z', rollDate: '2026-11-12' });
  });

  it('bitisi gecmis taslak yayinlanamaz (400); eski surum 409; version zorunlu', async () => {
    const { call, clock } = setup();
    await call('POST', '', draft);
    expect((await call('POST', '/poll1/publish', {})).status).toBe(400);
    expect((await call('POST', '/poll1/publish', { version: 7 })).status).toBe(409);
    clock.set('2026-11-18T00:00:00.000Z');
    expect((await call('POST', '/poll1/publish', { version: 1 })).status).toBe(400);
  });

  it('arsa payi agirlikli oylama, arsa payi eksik bolum varsa yayinlanamaz (422)', async () => {
    const { call } = setup({ units: [...defaultUnits(), unit('u4', '4')] });
    await call('POST', '', { ...draft, weighting: 'land_share' });
    const res = await call('POST', '/poll1/publish', { version: 1 });
    expect(res.status).toBe(422);
    expect(res.body.message).toContain('1 bölümde eksik');
  });

  it('erken kapatma gerekce ister, denetime poll.close (early) yazilir; bittikten sonra kapatilamaz', async () => {
    const { call, audits, published, vote, clock } = setup();
    await published({ secret: false });
    await vote('own-1', 'o1');
    expect((await call('POST', '/poll1/close', { version: 2 })).status).toBe(400);
    clock.set('2026-11-12T07:00:00.000Z');
    const closed = await call('POST', '/poll1/close', { version: 2, reason: 'Karar alındı' });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', phase: 'closed', closedEarly: true, closedAt: '2026-11-12T07:00:00.000Z', closeReason: 'Karar alındı' });
    expect(audits.at(-1)).toMatchObject({ action: 'poll.close', reason: 'Karar alındı', details: { early: true, votedUnits: 1 } });
    expect((await call('POST', '/poll1/close', { version: 3, reason: 'tekrar' })).status).toBe(409);
  });

  it('suresi dolan oylama yazim olmadan biter; kapatma reddedilir; filtre evreye gore', async () => {
    const { call, published, clock } = setup();
    await published();
    await call('POST', '', { ...draft, title: 'Taslak' });
    clock.set('2026-11-17T15:00:00.000Z'); // tam bitis ani: bitti
    expect((await call('GET', '/poll1')).body).toMatchObject({ status: 'published', phase: 'closed' });
    expect((await call('POST', '/poll1/close', { version: 2, reason: 'geç' })).status).toBe(409);
    expect((await call('GET', '?status=closed')).body.items.map((p: any) => p.pollId)).toEqual(['poll1']);
    expect((await call('GET', '?status=draft')).body.items.map((p: any) => p.pollId)).toEqual(['poll2']);
    expect((await call('GET', '?status=bogus')).status).toBe(400);
  });

  it('taslak iptal edilir (silme yok); iptal edilen tekrar iptalde ayni doner', async () => {
    const { call, audits } = setup();
    await call('POST', '', draft);
    const res = await call('POST', '/poll1/cancel', { version: 1 });
    expect(res.body).toMatchObject({ status: 'cancelled', phase: 'cancelled', cancelledBy: 'mgr-1' });
    expect(audits.at(-1)).toMatchObject({ action: 'poll.cancel' });
    expect((await call('POST', '/poll1/cancel', { version: 1 })).body.status).toBe('cancelled');
    expect((await call('GET', '/poll1/results')).status).toBe(409);
  });
});

describe('polls - oy kullanma (sakin portali)', () => {
  it('malik acik oylamayi gorur ve oy verir; kendi secimini gorur', async () => {
    const { portalCall, vote, published } = setup();
    await published();
    const list = await portalCall('GET', '', 'own-1');
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('no-store');
    expect(list.body.items).toEqual([expect.objectContaining({ pollId: 'poll1', phase: 'open', eligible: true, canVote: true, unitId: 'u1' })]);
    expect(list.body.items[0].myVote).toBeUndefined();

    const res = await vote('own-1', 'o2');
    expect(res.status).toBe(200);
    expect(res.body.myVote).toEqual({ castByMe: true, optionId: 'o2', castAt: T0 });
    expect((await portalCall('GET', '/poll1', 'own-1')).body.myVote).toMatchObject({ castByMe: true, optionId: 'o2' });
  });

  it('kiraci kat malikleri oylamasini gormez ve oy veremez; sakin oylamasinda oy verir', async () => {
    const { portalCall, vote, published } = setup();
    await published();
    expect((await portalCall('GET', '', 'ten-1')).body.items).toEqual([]);
    expect((await portalCall('GET', '/poll1', 'ten-1')).status).toBe(404);
    const denied = await vote('ten-1', 'o1');
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain('kat malikleri');

    await published({ title: 'Bahçe düzenlemesi', audience: 'residents' });
    expect((await portalCall('GET', '', 'ten-1')).body.items.map((p: any) => p.pollId)).toEqual(['poll2']);
    const ok = await vote('ten-1', 'o1', 'poll2');
    expect(ok.status).toBe(200);
    expect(ok.body.myVote.castByMe).toBe(true);
  });

  it('bolum basina tek oy: kiraci ile malik ayni daireden oy verirse son oy gecerli (sakin oylamasi)', async () => {
    const { vote, published, votes } = setup();
    await published({ audience: 'residents' });
    await vote('ten-1', 'o1');
    await vote('own-1', 'o2');
    const stored = [...votes.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ unitId: 'u1', optionId: 'o2', voterUserId: 'own-1', voterRelation: 'owner', version: 2 });
  });

  it('hisseli mulkiyet: paydaslardan biri oy verir, digerinin sonraki oyu yerine gecer; gizli oylamada diger paydasin secimi gosterilmez', async () => {
    const { vote, portalCall, published, call, votes } = setup();
    await published();
    expect((await vote('own-2a', 'o1')).status).toBe(200);
    const view = await portalCall('GET', '/poll1', 'own-2b');
    expect(view.body.myVote).toEqual({ castByMe: false });
    expect(JSON.stringify(view.body)).not.toContain('own-2a');

    const replaced = await vote('own-2b', 'o2');
    expect(replaced.body.myVote).toMatchObject({ castByMe: true, optionId: 'o2' });
    expect((await portalCall('GET', '/poll1', 'own-2a')).body.myVote).toEqual({ castByMe: false });
    expect([...votes.values()].filter((v) => v.unitId === 'u2')).toHaveLength(1);

    const part = await call('GET', '/poll1/participation');
    expect(part.body).toEqual({ secret: true, hidden: true, hiddenUntil: '2026-11-17T15:00:00.000Z', votedUnits: 1, items: [] });
  });

  it('ayni kisinin ayni secimi yazim yapmaz (surum 1 kalir); gecersiz secenek 400', async () => {
    const { vote, published, votes } = setup();
    await published();
    await vote('own-1', 'o1');
    await vote('own-1', 'o1');
    expect(votes.get(`${APT}|poll1|u1`)!.version).toBe(1);
    expect((await vote('own-1', 'o9')).status).toBe(400);
    expect((await vote('own-1', '')).status).toBe(400);
  });

  it('kapanmis oylama oy kabul etmez: erken kapatma ve bitis zamani', async () => {
    const { vote, published, call, clock } = setup();
    await published({ secret: false });
    await published({ title: 'İkinci' });
    await call('POST', '/poll1/close', { version: 2, reason: 'Toplantıda karar alındı' });
    const early = await vote('own-1', 'o1');
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('poll_closed');
    clock.set('2026-11-17T15:00:00.000Z');
    expect((await vote('own-1', 'o1', 'poll2')).status).toBe(409);
  });

  it('kapatmayla yarisan oy: depo kosulu (oylama acik degil) 409 doner', async () => {
    const { vote, published, polls } = setup();
    await published();
    // Servis oylamayi acik okudu ama yazim aninda kapanmis: ConditionCheck reddeder.
    const original = polls.get(`${APT}|poll1`)!;
    const repoGet = polls.get.bind(polls);
    let reads = 0;
    polls.get = (k: string) => {
      const p = repoGet(k);
      // ilk okuma (servis) acik, sonraki (putVote kosulu) kapali gorur
      return p && k === `${APT}|poll1` && reads++ > 0 ? { ...original, status: 'closed' as const } : p;
    };
    const res = await vote('own-1', 'o1');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('poll_closed');
  });

  it('tarih penceresi: planli oylama listede yok ve oy reddedilir; acilinca oy verilir', async () => {
    const { vote, portalCall, published, clock } = setup();
    await published({ opensAt: '2026-11-11T09:00:00+03:00' });
    expect((await portalCall('GET', '', 'own-1')).body.items).toEqual([]);
    const early = await vote('own-1', 'o1');
    expect(early.status).toBe(409);
    expect(early.body.message).toContain('başlamadı');
    clock.set('2026-11-11T06:00:00.000Z');
    expect((await vote('own-1', 'o1')).status).toBe(200);
  });

  it('oy hakki oy listesi tarihine gore: tarihten sonra malik olan gorur ama oy veremez', async () => {
    const members = [...defaultMembers(), member('new-3', 'u3', 'owner', { startDate: '2026-11-11' })];
    const { vote, portalCall, published, clock } = setup({ members });
    await published();
    clock.set('2026-11-12T07:00:00.000Z');
    const list = await portalCall('GET', '', 'new-3');
    expect(list.body.items[0]).toMatchObject({ eligible: false, canVote: false });
    expect(list.body.items[0].ineligibleReason).toContain('2026-11-10');
    const res = await vote('new-3', 'o1');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_eligible');
    expect((await vote('own-3', 'o1')).status).toBe(200);
  });

  it('mulkiyet sicili varsa oy listesi sicilden: sicilde olmayan malik uyesi oy veremez', async () => {
    const records: OwnershipRecord[] = [
      {
        PK: `APT#${APT}`,
        SK: 'OWNERSHIP#u3#2026-01-01#000001',
        entityType: 'OWNERSHIP_RECORD',
        apartmentId: APT,
        unitId: 'u3',
        seq: 1,
        validFrom: '2026-01-01',
        owners: [{ userId: 'own-3', share: { numerator: 1, denominator: 1 } }],
        source: 'manual',
        reason: 'tapu',
        createdAt: T0,
        createdBy: 'seed',
      },
    ];
    const members = [...defaultMembers(), member('shadow-3', 'u3', 'owner')];
    const { vote, published } = setup({ members, records });
    await published();
    expect((await vote('shadow-3', 'o1')).status).toBe(403);
    expect((await vote('own-3', 'o1')).status).toBe(200);
  });

  it('birden fazla dairesi olan sakin daire secer; baskasinin dairesi 403', async () => {
    const members = [...defaultMembers(), member('own-1', 'u3', 'owner', { ownershipShare: half }), member('own-3', 'u3', 'owner', { ownershipShare: half, residesInUnit: true })].filter(
      (m, i, all) => all.findIndex((x) => x.userId === m.userId && x.unitId === m.unitId) === i,
    );
    const { portalCall, vote, published } = setup({ members });
    await published();
    const choose = await portalCall('GET', '', 'own-1');
    expect(choose.status).toBe(400);
    expect(choose.body).toMatchObject({ error: 'unit_selection_required', unitIds: ['u1', 'u3'] });
    expect((await vote('own-1', 'o1', 'poll1', 'u3')).status).toBe(200);
    expect((await vote('own-1', 'o1', 'poll1', 'u2')).status).toBe(403);
    expect((await portalCall('GET', '', 'own-1', undefined, 'u3')).body.items[0].myVote).toMatchObject({ castByMe: true });
  });
});

describe('polls - sonuc, agirlik ve gizlilik', () => {
  /** u1, u2 Evet; u3 Hayir: bolum basi Evet kazanir, arsa payinda Hayir (%70). */
  async function voted(weighting: 'per_unit' | 'land_share', extra: Record<string, unknown> = {}) {
    const w = setup();
    await w.published({ weighting, secret: false, ...extra });
    await w.vote('own-1', 'o1');
    await w.vote('own-2a', 'o1');
    await w.vote('own-3', 'o2');
    return w;
  }

  it('bolum basina: sayilar, arsa payi toplamlari, katilim ve salt cogunluk', async () => {
    const { call } = await voted('per_unit');
    const res = await call('GET', '/poll1/results');
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject({
      final: false,
      tallyHidden: false,
      weighting: 'per_unit',
      eligible: { units: 3, landShare: { numerator: '1200', denominator: '1200' } },
      participation: { units: 3, unitsBps: 10000, landShare: { numerator: '1200', denominator: '1200' }, landShareBps: 10000 },
      options: [
        { optionId: 'o1', units: 2, unitsBps: 6667, landShare: { numerator: '360', denominator: '1200' }, landShareBps: 3000 },
        { optionId: 'o2', units: 1, unitsBps: 3333, landShare: { numerator: '840', denominator: '1200' }, landShareBps: 7000 },
      ],
      winnerOptionId: 'o1',
    });
  });

  it('arsa payi agirlikli: ayni oylarla kazanan degisir', async () => {
    const { call } = await voted('land_share');
    expect((await call('GET', '/poll1/results')).body.results.winnerOptionId).toBe('o2');
  });

  it('salt cogunluk kesin: tam yari kazanmaz; oy yoksa kazanan yok', async () => {
    const w = setup();
    await w.published({ secret: false });
    expect((await w.call('GET', '/poll1/results')).body.results).toMatchObject({ participation: { units: 0, unitsBps: 0 }, winnerOptionId: null });
    await w.vote('own-1', 'o1');
    await w.vote('own-3', 'o2');
    const r = (await w.call('GET', '/poll1/results')).body.results;
    expect(r.options.map((o: any) => o.units)).toEqual([1, 1]);
    expect(r.winnerOptionId).toBeNull();
    expect(r.participation).toMatchObject({ units: 2, unitsBps: 6667, landShareBps: 8000 });
  });

  it('farkli paydali arsa paylari ortak paydaya cevrilir; eksik arsa payinda toplamlar hesaplanmaz', () => {
    expect(commonDenominator([{ numerator: 1, denominator: 8 }, { numerator: 1, denominator: 12 }, undefined])).toBe(24n);
    expect(commonDenominator([undefined])).toBeNull();
    expect(toBps(1n, 3n)).toBe(3333);
    expect(toBps(2n, 3n)).toBe(6667);
    expect(toBps(5n, 0n)).toBe(0);
    const item = (unitId: string, landShare?: LandShare, owners = [{ userId: `o-${unitId}` }]) => ({ unitId, blockId: 'b', number: unitId, vote: 1 as const, source: 'register' as const, ...(landShare ? { landShare } : {}), owners, warnings: [] });
    const snap = (roll: ReturnType<typeof item>[]) => buildSnapshot({ apartmentId: APT, ownerType: 'poll', ownerId: 'p', rollDate: '2026-11-10', frozenAt: T0, roll, voters: (r) => r.owners.map((o) => ({ userId: o.userId, relation: 'owner' })) });
    const base = { pollId: 'p', options: [{ optionId: 'o1', label: 'A' }, { optionId: 'o2', label: 'B' }], weighting: 'land_share', secret: false, audience: 'owners', status: 'closed', opensAt: T0, closesAt: T0, rollDate: '2026-11-10' };
    const v = (unitId: string, optionId: string) => ({ pollId: 'p', unitId, optionId }) as PollVote;

    const full = snap([item('a', { numerator: 1, denominator: 8 }), item('b', { numerator: 1, denominator: 12 })]);
    const r = tallyPoll({ poll: { ...base, roll: full.meta } as never, entries: full.entries, votes: [v('a', 'o1'), v('b', 'o2')], nowIso: T0 });
    expect(r.eligible.landShare).toEqual({ numerator: '5', denominator: '24' });
    expect(r.options?.map((o) => o.landShare)).toEqual([{ numerator: '3', denominator: '24' }, { numerator: '2', denominator: '24' }]);
    expect(r.winnerOptionId).toBe('o1'); // 3/24 > 5/48

    const partial = snap([item('a', { numerator: 1, denominator: 8 }), item('b', { numerator: 1, denominator: 12 }), item('c', undefined, [])]);
    const rp = tallyPoll({ poll: { ...base, weighting: 'per_unit', roll: partial.meta } as never, entries: partial.entries, votes: [v('a', 'o1')], nowIso: T0 });
    expect(rp.eligible.landShare).toBeNull();
    expect(rp.participation.landShareBps).toBeNull();
    expect(rp.warnings).toEqual(['1 bölümün arsa payı girilmemiş; arsa payı toplamları hesaplanamıyor', '1 bölümde oy kullanabilecek malik kaydı yok']);
  });

  it('BigInt ortak payda: cok buyuk / aralarinda asal paydalar tasmaz, sonuc 500 vermez', async () => {
    const primes = [999_999_937, 999_999_929, 999_999_893];
    const units = primes.map((d, i) => unit(`u${i + 1}`, String(i + 1), { numerator: 1, denominator: d }));
    const { published, vote, call } = setup({ units, members: [member('own-1', 'u1', 'owner'), member('own-2a', 'u2', 'owner'), member('own-3', 'u3', 'owner')] });
    await published({ weighting: 'land_share', secret: false });
    await vote('own-1', 'o1');
    const res = await call('GET', '/poll1/results');
    expect(res.status).toBe(200);
    const den = BigInt(res.body.results.eligible.landShare.denominator);
    expect(den).toBe(primes.reduce((p, d) => p * BigInt(d), 1n));
    expect(den > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(res.body.results.options[0].units).toBe(1);
  });

  it('gizli oylama: surerken kimse dagilimi gormez; bitince sayilar acilir; bolum bazinda secim HICBIR evrede yok', async () => {
    const { call, vote, published, clock, portalCall } = setup();
    await published();
    await vote('own-1', 'o1');
    await vote('own-3', 'o2');
    const live = (await call('GET', '/poll1/results')).body.results;
    expect(live).toMatchObject({ tallyHidden: true, participation: { units: 2 } });
    expect(live.options).toBeUndefined();
    expect(live.winnerOptionId).toBeUndefined();
    expect((await portalCall('GET', '/poll1', 'own-1')).body).toMatchObject({ resultsAvailable: false });

    const liveRows = (await call('GET', '/poll1/participation')).body;
    expect(liveRows).toEqual({ secret: true, hidden: true, hiddenUntil: '2026-11-17T15:00:00.000Z', votedUnits: 2, items: [] });

    clock.set('2026-11-17T15:00:00.000Z');
    const afterRows = (await call('GET', '/poll1/participation')).body;
    expect(afterRows.hidden).toBe(false);
    expect(afterRows.items.map((r: any) => r.voted)).toEqual([true, false, true]);
    for (const row of afterRows.items) {
      expect(row).not.toHaveProperty('optionId');
      expect(row).not.toHaveProperty('castAt');
      expect(row).not.toHaveProperty('voterRelation');
    }
    const serialized = JSON.stringify(afterRows);
    for (const leak of ['own-1', 'own-3', '"o1"', '"o2"']) expect(serialized).not.toContain(leak);
    const final = (await call('GET', '/poll1/results')).body.results;
    expect(final).toMatchObject({ final: true, tallyHidden: false, winnerOptionId: null });
    expect(final.options.map((o: any) => o.units)).toEqual([1, 1]);
    expect(JSON.stringify((await call('GET', '/poll1/participation')).body)).not.toContain('"o1"');
    const portal = (await portalCall('GET', '/poll1', 'own-1')).body;
    expect(portal).toMatchObject({ phase: 'closed', resultsAvailable: true, results: { final: true } });
  });

  it('acik oylama: yonetici bolum bazinda secimi gorur; ara sonuc acikse oy verenler de gorur', async () => {
    const { call, portalCall } = await voted('per_unit', { resultsVisibleBeforeClose: true });
    const rows = (await call('GET', '/poll1/participation')).body.items;
    expect(rows.find((r: any) => r.unitId === 'u3')).toMatchObject({ voted: true, optionId: 'o2', voterRelation: 'owner', castAt: T0 });
    const portal = (await portalCall('GET', '/poll1', 'own-1')).body;
    expect(portal).toMatchObject({ resultsAvailable: true, results: { final: false, winnerOptionId: 'o1' } });
    // Acik oylamada hisseli bolumun diger paydasi bolumun secimini gorur.
    expect((await portalCall('GET', '/poll1', 'own-2b')).body.myVote).toMatchObject({ castByMe: false, optionId: 'o1' });
  });

  it('acik oylamada ara sonuc kapaliysa oy veren bitene kadar gormez', async () => {
    const { portalCall } = await voted('per_unit');
    expect((await portalCall('GET', '/poll1', 'own-1')).body).toMatchObject({ resultsAvailable: false });
    expect((await portalCall('GET', '/poll1', 'own-1')).body.results).toBeUndefined();
  });
});

describe('polls - saf yardimcilar', () => {
  it('evre ve Istanbul gunu', () => {
    const p = { status: 'published', opensAt: '2026-11-10T07:00:00.000Z', closesAt: '2026-11-11T07:00:00.000Z' } as const;
    expect(pollPhase(p, '2026-11-10T06:59:59.999Z')).toBe('scheduled');
    expect(pollPhase(p, '2026-11-10T07:00:00.000Z')).toBe('open');
    expect(pollPhase(p, '2026-11-11T07:00:00.000Z')).toBe('closed');
    expect(pollPhase({ ...p, status: 'closed' }, '2026-11-10T08:00:00.000Z')).toBe('closed');
    expect(istanbulDate('2026-11-10T21:30:00.000Z')).toBe('2026-11-11');
  });

  it('oy hakki: kat malikleri yalnizca listedeki paydaslar; sakinlerde o gun gecerli uyelikler', () => {
    const roll = { unitId: 'u1', owners: [{ userId: 'a' }, { userId: 'b' }] };
    const members = [member('t', 'u1', 'tenant'), member('old', 'u1', 'tenant', { endDate: '2026-11-01', status: 'inactive' }), member('later', 'u1', 'tenant', { startDate: '2026-12-01' })];
    expect(eligibleVoters({ audience: 'owners', rollDate: '2026-11-10' }, roll, members).map((v) => v.userId)).toEqual(['a', 'b']);
    expect(eligibleVoters({ audience: 'residents', rollDate: '2026-11-10' }, roll, members)).toEqual([
      { userId: 'a', relation: 'owner' },
      { userId: 'b', relation: 'owner' },
      { userId: 't', relation: 'tenant' },
    ]);
    expect(eligibleVoters({ audience: 'owners', rollDate: '2026-11-10' }, undefined, members)).toEqual([]);
  });
});

describe('polls - bildirim', () => {
  const event = (audience: 'owners' | 'residents'): DomainEvent =>
    ({
      eventId: 'POLL_PUBLISHED:p1',
      type: 'POLL_PUBLISHED',
      version: 1,
      occurredAt: T0,
      apartmentId: APT,
      actorId: 'mgr-1',
      groupKey: APT,
      payload: { pollId: 'p1', title: 'Asansör', audience, opensAt: T0, closesAt: '2026-11-17T15:00:00.000Z' },
    }) as DomainEvent;

  it('kat malikleri oylamasi yalnizca maliklere; sakin oylamasi tum guncel uyelere', () => {
    const members = defaultMembers();
    const owners = buildNotifications(event('owners'), members, new Map(), '2026-11-10').map((n) => n.userId).sort();
    expect(owners).toEqual(['own-1', 'own-2a', 'own-2b', 'own-3']);
    const all = buildNotifications(event('residents'), members, new Map(), '2026-11-10');
    expect(all.map((n) => n.userId).sort()).toEqual(['own-1', 'own-2a', 'own-2b', 'own-3', 'ten-1']);
    expect(all[0]).toMatchObject({ template: 'poll_published', data: { pollId: 'p1', title: 'Asansör' } });
  });

  it('e-posta sablonu: konu, Istanbul saatiyle tarih ve portal baglantisi', () => {
    const email = renderEmail(
      { eventId: 'E', apartmentId: APT, userId: 'own-1', template: 'poll_published', data: { pollId: 'p1', title: 'Asansör <b>', audience: 'owners', opensAt: T0, closesAt: '2026-11-17T15:00:00.000Z' } },
      { siteName: 'Lale', unitLabel: () => 'Daire', portalUrl: 'https://site.example/app' },
    )!;
    expect(email.subject).toBe('Yeni oylama: Asansör <b> - Lale');
    expect(email.html).toContain('Asansör &lt;b&gt;');
    expect(email.text).toContain('10.11.2026 10:00');
    expect(email.text).toContain('17.11.2026 18:00');
    expect(email.html).toContain('href="https://site.example/app/oylamalar"');
  });
});

describe('polls repository (DynamoDB)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const repo = createPollRepository();

  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  const voteItem = (version = 1): PollVote => ({
    ...pollKeys.vote(APT, 'p1', 'u1'),
    entityType: 'POLL_VOTE',
    apartmentId: APT,
    pollId: 'p1',
    unitId: 'u1',
    optionId: 'o1',
    voterUserId: 'own-1',
    voterRelation: 'owner',
    castAt: T0,
    createdAt: T0,
    version,
  });

  it('oy: oylama ConditionCheck + bolum basina tek kayit (ilk oy attribute_not_exists, degisiklik surum kosullu)', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await repo.putVote(voteItem(), 0, T0);
    await repo.putVote(voteItem(2), 1, T0);
    const [first, second] = ddb.commandCalls(TransactWriteCommand).map((c) => c.args[0].input.TransactItems!);
    expect(first![0]!.ConditionCheck).toMatchObject({
      Key: { PK: 'APT#apt-1', SK: 'POLL#p1' },
      ConditionExpression: '#status = :published AND #opensAt <= :now AND #closesAt > :now',
      ExpressionAttributeValues: { ':published': 'published', ':now': T0 },
    });
    expect(first![1]!.Put).toMatchObject({ Item: { SK: 'POLLVOTE#p1#u1' }, ConditionExpression: 'attribute_not_exists(PK)' });
    expect(second![1]!.Put).toMatchObject({ ConditionExpression: 'attribute_exists(PK) AND #version = :expected', ExpressionAttributeValues: { ':expected': 1 } });
  });

  it('iptal nedenleri: oylama kosulu -> poll, oy surumu -> vote', async () => {
    const cancelled = (codes: string[]) =>
      new TransactionCanceledException({ message: 'x', $metadata: {}, CancellationReasons: codes.map((Code) => ({ Code })) });
    ddb.on(TransactWriteCommand).rejectsOnce(cancelled(['ConditionalCheckFailed', 'None'])).rejectsOnce(cancelled(['None', 'ConditionalCheckFailed']));
    await expect(repo.putVote(voteItem(), 0, T0)).rejects.toMatchObject({ name: 'PollVoteConflictError', reason: 'poll' });
    await expect(repo.putVote(voteItem(), 0, T0)).rejects.toMatchObject({ name: 'PollVoteConflictError', reason: 'vote' });
  });

  it('oylar POLLVOTE#<poll># on ekiyle okunur; anahtar tutarsizligi reddedilir', async () => {
    ddb.on(QueryCommand).resolves({ Items: [voteItem()] });
    expect(await repo.listVotes(APT, 'p1')).toHaveLength(1);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toMatchObject({ ':pk': 'APT#apt-1', ':skp': 'POLLVOTE#p1#' });
    await expect(repo.putVote({ ...voteItem(), PK: 'APT#apt-2' }, 0, T0)).rejects.toThrow(/tutarsiz/);
  });

  it('yayin: oy listesi kovalari oylamayla ayni TransactWriteItems icinde attribute_not_exists ile yazilir', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const snap = buildSnapshot({
      apartmentId: APT,
      ownerType: 'poll',
      ownerId: 'p1',
      rollDate: '2026-11-10',
      frozenAt: T0,
      roll: [{ unitId: 'u1', blockId: 'b1', number: '1', vote: 1, source: 'register', owners: [{ userId: 'a' }], warnings: [] }],
      voters: () => [{ userId: 'a', relation: 'owner' }],
    });
    const poll = { ...pollKeys.poll(APT, 'p1'), entityType: 'POLL', pollId: 'p1', apartmentId: APT, updatedAt: T0, version: 2, roll: snap.meta } as unknown as Poll;
    await repo.update(poll, 1, { roll: snap.chunks });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(2);
    expect(items[1]!.Put).toMatchObject({ ConditionExpression: 'attribute_not_exists(PK)', Item: { SK: 'POLLROLL#p1#000', entityType: 'ROLL_SNAPSHOT' } });
    await expect(repo.update(poll, 1, { roll: [{ ...snap.chunks[0]!, ownerId: 'other' }] })).rejects.toThrow(/ait degil/);
  });
});

describe('polls - dondurulmus oy listesi, gizlilik ve eszamanlilik', () => {
  it('oy listesi yayinda dondurulur: sonradan sicil / uyelik / arsa payi degisse de oy hakki ve paydalar degismez', async () => {
    const { published, vote, call, units, members, rolls, polls } = setup();
    await published({ weighting: 'land_share', secret: false });
    const poll = polls.get(`${APT}|poll1`)!;
    expect(poll.roll).toMatchObject({ rollDate: '2026-11-10', units: 3, denominator: '1200', totalWeight: '1200', missingLandShare: 0, frozenAt: T0 });
    expect((await rolls.entries(APT, 'poll', 'poll1')).map((e) => e.unitId)).toEqual(['u1', 'u2', 'u3']);

    // Yayindan sonra: u3'un arsa payi degisir, geriye donuk yeni malik eklenir, yeni bolum acilir.
    units[2] = { ...units[2]!, landShare: { numerator: 1, denominator: 1200 } };
    units.push(unit('u9', '9', { numerator: 500, denominator: 1200 }));
    members.push(member('late-3', 'u3', 'owner'), member('own-9', 'u9', 'owner'));
    expect((await vote('late-3', 'o1')).body.error).toBe('not_eligible');
    expect((await vote('own-9', 'o1')).body.message).toContain('oy listesinde yok');
    await vote('own-3', 'o2');
    const r = (await call('GET', '/poll1/results')).body.results;
    expect(r.eligible).toEqual({ units: 3, landShare: { numerator: '1200', denominator: '1200' } });
    expect(r.options[1].landShare).toEqual({ numerator: '840', denominator: '1200' });
    expect((await call('GET', '/poll1/participation')).body.items.map((x: any) => x.unitId)).toEqual(['u1', 'u2', 'u3']);
  });

  it(`gizli oylama en az ${MIN_SECRET_CLOSE_VOTES} oy olmadan erken kapatilamaz; planli gizli oylama kapatilabilir; katilim planlanan bitise kadar gizli`, async () => {
    const { published, vote, call } = setup();
    await published();
    await vote('own-1', 'o1');
    await vote('own-2a', 'o2');
    const refused = await call('POST', '/poll1/close', { version: 2, reason: 'Erken bitir' });
    expect(refused.status).toBe(422);
    expect(refused.body.message).toContain('en az 3 bölüm');
    await vote('own-3', 'o1');
    const closed = await call('POST', '/poll1/close', { version: 2, reason: 'Erken bitir' });
    expect(closed.status).toBe(200);
    // Erken kapanista sonuc kesinlesir ama hangi bolumun oy kullandigi planlanan bitise kadar gizli.
    expect((await call('GET', '/poll1/results')).body.results).toMatchObject({ final: true, tallyHidden: false });
    expect((await call('GET', '/poll1/participation')).body).toMatchObject({ hidden: true, votedUnits: 3, items: [] });

    await published({ title: 'Planlı gizli', opensAt: '2026-11-20T09:00:00+03:00', closesAt: '2026-11-25T18:00:00+03:00' });
    expect((await call('POST', '/poll2/close', { version: 2, reason: 'Vazgeçildi' })).status).toBe(200);
  });

  it('ara sonuc yalnizca bolumu oy kullanmis sakine; oy vermeyen "oy verince" bilgisini alir', async () => {
    const { published, vote, portalCall } = setup();
    await published({ secret: false, resultsVisibleBeforeClose: true });
    await vote('own-1', 'o1');
    expect((await portalCall('GET', '/poll1', 'own-1')).body).toMatchObject({ resultsAvailable: true, resultsAfterVote: false, results: { final: false } });
    const notYet = (await portalCall('GET', '/poll1', 'own-3')).body;
    expect(notYet).toMatchObject({ resultsAvailable: false, resultsAfterVote: true });
    expect(notYet.results).toBeUndefined();
  });

  it('kapanis kontrolu icin zaman damgasi yazimdan hemen once alinir', async () => {
    const { published, vote, clock, repo } = setup();
    await published();
    let written: { now: string; castAt: string } | undefined;
    const put = repo.putVote;
    repo.putVote = async (v, expected, now) => {
      written = { now, castAt: v.castAt };
      return put(v, expected, now);
    };
    clock.step(1000);
    expect((await vote('own-1', 'o1')).status).toBe(200);
    // Her saat okumasi 1 sn ilerler: daire cozumu T0, evre kontrolu T0+1 sn; yazim zamani bunlardan
    // SONRA yeniden alinir (evre kontrolundeki zaman yeniden kullanilmaz).
    expect(written!.now > '2026-11-10T07:00:01.000Z').toBe(true);
    expect(written!.castAt).toBe(written!.now);
  });

  it('ayni oyun eszamanli ikinci gonderimi kosul cakismasinda basari doner; farkli oy 409', async () => {
    const { published, vote, repo, votes } = setup();
    await published();
    const put = repo.putVote;
    // Esanli istek ayni oyu az once yazmis gibi: kosul cakisir, kayitli oy gonderilenle ayni.
    repo.putVote = async (v, expected, now) => {
      await put(v, expected, now);
      throw new PollVoteConflictError('vote');
    };
    const same = await vote('own-2a', 'o1');
    expect(same.status).toBe(200);
    expect(same.body.myVote).toMatchObject({ castByMe: true, optionId: 'o1' });
    // Diger paydasin farkli oyu araya girdi: kayitli oy gonderilenden farkli -> 409.
    repo.putVote = async (v) => {
      votes.set(`${APT}|poll1|u2`, { ...v, voterUserId: 'own-2a', optionId: 'o1', version: 2 });
      throw new PollVoteConflictError('vote');
    };
    expect((await vote('own-2b', 'o2')).status).toBe(409);
  });
});
