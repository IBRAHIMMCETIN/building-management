import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import { DataAccessError, resetDynamoCache } from '../src/config/dynamodb.js';
import { getRequestContext, maskIp, runWithRequestContext, truncateUserAgent } from '../src/modules/audit/context.js';
import {
  AuditChainBusyError,
  type AuditEntry,
  GENESIS_HASH,
  appendAudit,
  auditedPutNew,
  auditedPutVersioned,
  buildEntry,
  canonicalJson,
  computeHash,
  sanitizeDetails,
  sendWithAudit,
  verifyChain,
} from '../src/modules/audit/log.js';
import { type AuditReader, type CheckpointStore, createAuditReader, verifyAuditScope } from '../src/modules/audit/repository.js';
import type { Site } from '../src/modules/core/types.js';
import { toKurus } from '../src/modules/core/types.js';
import { createFinanceRepository, financeKeys } from '../src/modules/finance/repository.js';
import type { Transaction } from '../src/modules/finance/types.js';
import { createMembershipRepository } from '../src/modules/memberships/repository.js';
import { createDynamoPreferencesRepository } from '../src/modules/notifications/preferences.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { type SupportRepository, type SupportSession, createSupportService } from '../src/modules/support/service.js';

const APT = 'apt-1';
const NOW = new Date('2026-11-21T09:00:00.000Z');
const ddb = mockClient(DynamoDBDocumentClient);

function useTables(audit = true) {
  ddb.reset();
  resetDynamoCache();
  process.env.DYNAMODB_TABLE_NAME = 'bm-main';
  process.env.AWS_REGION = 'eu-north-1';
  process.env.DYNAMODB_ENDPOINT = '';
  if (audit) process.env.AUDIT_TABLE_NAME = 'bm-audit';
  else delete process.env.AUDIT_TABLE_NAME;
}

afterEach(() => {
  delete process.env.AUDIT_TABLE_NAME;
  delete process.env.NODE_ENV_AUDIT_TEST;
});

/** Zincirde art arda kayitlar (gercek hash'lerle). */
function chain(n: number, scope = `APT#${APT}`): AuditEntry[] {
  const out: AuditEntry[] = [];
  let tail = { seq: 0, hash: GENESIS_HASH };
  for (let i = 0; i < n; i++) {
    const e = buildEntry({ apartmentId: scope === 'PLATFORM' ? undefined : APT, action: `test.a${i}`, target: { type: 't', id: String(i) } }, tail, new Date(NOW.getTime() + i * 1000));
    out.push(e);
    tail = { seq: e.seq, hash: e.hash };
  }
  return out;
}

// ---------------------------------------------------------------------------
// KVKK maskeleme
// ---------------------------------------------------------------------------

describe('istek baglami - IP ve User-Agent maskeleme', () => {
  it('IPv4 /24, IPv6 /48, IPv4-mapped; X-Forwarded-For ilk adres; gecersiz -> yok', () => {
    expect(maskIp('203.0.113.77')).toBe('203.0.113.0/24');
    expect(maskIp('203.0.113.77, 10.0.0.1')).toBe('203.0.113.0/24');
    expect(maskIp('::ffff:198.51.100.9')).toBe('198.51.100.0/24');
    expect(maskIp('2001:db8:abcd:12:1:2:3:4')).toBe('2001:db8:abcd::/48');
    expect(maskIp('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(maskIp('yok')).toBeUndefined();
    expect(maskIp(undefined)).toBeUndefined();
  });

  it('User-Agent en fazla 200 karakter, kontrol karakteri yok', () => {
    expect(truncateUserAgent('x'.repeat(500))).toHaveLength(200);
    expect(truncateUserAgent('Mozilla\r\n5.0')).toBe('Mozilla 5.0');
    expect(truncateUserAgent('')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Kayit bicimi, hash, maskeleme
// ---------------------------------------------------------------------------

describe('denetim kaydi', () => {
  it('kanonik JSON anahtar sirasindan bagimsiz; undefined atilir', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, 'x'] } })).toBe('{"a":{"c":[2,"x"]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('istek baglamindaki aktor, kisaltilmis IP/UA ve 10 yillik TTL; zincire baglanir', () => {
    const e = runWithRequestContext(
      { requestId: 'req-1', ip: '203.0.113.0/24', userAgent: 'UA', actor: { userId: 'mgr-1', role: 'apartment_manager' } },
      () => buildEntry({ apartmentId: APT, action: 'membership.create', target: { type: 'membership', id: 'u:1' }, reason: 'davet' }, { seq: 41, hash: 'a'.repeat(64) }, NOW),
    );
    expect(e).toMatchObject({
      PK: 'APT#apt-1',
      SK: 'SEQ#000000000042',
      seq: 42,
      action: 'membership.create',
      actor: { userId: 'mgr-1', role: 'apartment_manager' },
      request: { requestId: 'req-1', ip: '203.0.113.0/24', userAgent: 'UA' },
      prevHash: 'a'.repeat(64),
      GSI1PK: 'ACTOR#mgr-1',
    });
    const years = (e.ttl - NOW.getTime() / 1000) / (365.25 * 86_400);
    expect(years).toBeGreaterThan(9.99);
    expect(years).toBeLessThan(10.01);
    expect(e.hash).toBe(computeHash(e.prevHash, e));
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('baglam yoksa (zamanlayici) aktor system; kapsam verilmezse PLATFORM', () => {
    const e = buildEntry({ action: 'notification_preferences.update', target: { type: 'user', id: 'u1' }, actorId: 'u1' }, { seq: 0, hash: GENESIS_HASH }, NOW);
    expect(e).toMatchObject({ PK: 'PLATFORM', actor: { userId: 'u1', role: 'system' }, prevHash: GENESIS_HASH });
    expect(e).not.toHaveProperty('request');
  });

  it('ayrintilarda kisisel/gizli alanlar maskelenir, metin ve diziler kisaltilir, boyut sinirlanir', () => {
    const d = sanitizeDetails({ emailEnabled: true, email: 'a@b.com', phone: '555', iban: 'TR..', nested: { cardNumber: '4111' }, note: 'x'.repeat(400), list: Array.from({ length: 60 }, (_, i) => i) })!;
    expect(d).toMatchObject({ emailEnabled: true, email: '[maskeli]', phone: '[maskeli]', iban: '[maskeli]', nested: { cardNumber: '[maskeli]' } });
    expect((d.note as string).length).toBe(301);
    expect((d.list as unknown[]).length).toBe(51);
    expect(sanitizeDetails({ big: Array.from({ length: 50 }, () => 'y'.repeat(200)) })).toEqual({ truncated: true, keys: ['big'] });
  });
});

// ---------------------------------------------------------------------------
// Atomik yazim ve zincir yarisi
// ---------------------------------------------------------------------------

const cancelled = (codes: string[]) =>
  new TransactionCanceledException({ message: 'cancelled', $metadata: {}, CancellationReasons: codes.map((Code) => ({ Code })) });

const mainPut = { Put: { TableName: 'bm-main', Item: { PK: `APT#${APT}`, SK: 'X#1' }, ConditionExpression: 'attribute_not_exists(PK)' } };
const draft = { apartmentId: APT, action: 'test.write', target: { type: 't', id: '1' } };

describe('atomik denetim yazimi', () => {
  beforeEach(() => useTables());

  it('denetim kaydi ayni TransactWriteItems icinde SON oge, kosullu, kuyruktan bir sonraki sira', async () => {
    const [last] = chain(1);
    ddb.on(QueryCommand).resolves({ Items: [last] });
    ddb.on(TransactWriteCommand).resolves({});
    const entry = await sendWithAudit(ddb as unknown as DynamoDBDocumentClient, [mainPut], draft, () => NOW);

    const q = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(q).toMatchObject({ TableName: 'bm-audit', ScanIndexForward: false, Limit: 1, ConsistentRead: true, ExpressionAttributeValues: { ':pk': 'APT#apt-1' } });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(mainPut);
    expect(items[1]!.Put).toMatchObject({ TableName: 'bm-audit', ConditionExpression: 'attribute_not_exists(PK)', Item: { SK: 'SEQ#000000000002', seq: 2, prevHash: last!.hash } });
    expect(entry!.seq).toBe(2);
  });

  it('zincir yarisi: yalnizca denetim kosulu tutmazsa kuyruk yeniden okunur ve tekrar denenir', async () => {
    const [a, b] = chain(2);
    ddb.on(QueryCommand).resolvesOnce({ Items: [a] }).resolvesOnce({ Items: [b] });
    ddb.on(TransactWriteCommand).rejectsOnce(cancelled(['None', 'ConditionalCheckFailed'])).resolves({});
    const entry = await sendWithAudit(ddb as unknown as DynamoDBDocumentClient, [mainPut], draft, () => NOW);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(2);
    expect(entry).toMatchObject({ seq: 3, prevHash: b!.hash });
  });

  it('asil yazimin kosulu tutmazsa hata oldugu gibi doner (tekrar yok, ogeler indeksli)', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(TransactWriteCommand).rejects(cancelled(['ConditionalCheckFailed', 'None']));
    await expect(sendWithAudit(ddb as unknown as DynamoDBDocumentClient, [mainPut], draft)).rejects.toBeInstanceOf(TransactionCanceledException);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('surekli yarista AuditChainBusyError (503, istek tekrar denenmeli)', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(TransactWriteCommand).rejects(cancelled(['None', 'ConditionalCheckFailed']));
    const err = await sendWithAudit(ddb as unknown as DynamoDBDocumentClient, [mainPut], draft).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditChainBusyError);
    expect((err as DataAccessError).httpStatus).toBe(503);
  });

  it('auditedPutNew / auditedPutVersioned: ana kayit kosulu -> conflict; denetim acik degilse eski yol (PutCommand)', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(TransactWriteCommand).rejects(cancelled(['ConditionalCheckFailed', 'None']));
    await expect(auditedPutNew({ PK: 'a', SK: 'b' }, draft)).rejects.toMatchObject({ code: 'conflict' });
    await expect(auditedPutVersioned({ PK: 'a', SK: 'b', version: 2 }, 1, draft)).rejects.toMatchObject({ code: 'conflict' });

    useTables(false);
    ddb.on(PutCommand).resolves({});
    await auditedPutNew({ PK: 'a', SK: 'b' }, draft);
    expect(ddb.commandCalls(PutCommand)).toHaveLength(1);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('production/Lambda ortaminda denetim tablosu yoksa hassas yazim reddedilir (fail closed)', async () => {
    useTables(false);
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'bm-api';
    try {
      await expect(auditedPutNew({ PK: 'a', SK: 'b' }, draft)).rejects.toThrow(/AUDIT_TABLE_NAME/);
      expect(ddb.calls()).toHaveLength(0);
    } finally {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    }
  });

  it('defter yazimi (postBatch) denetim kaydini otomatik tasir: islem turu, tutar, referans', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(TransactWriteCommand).resolves({});
    const tx: Transaction = {
      ...financeKeys.transaction(APT, '20261121-t1'),
      entityType: 'TRANSACTION',
      transactionId: '20261121-t1',
      siteId: APT,
      kind: 'payment',
      date: '2026-11-21',
      description: 'Tahsilat - Daire 5',
      reference: 'IYZICO:p1',
      lines: [
        { accountId: 'cash', side: 'debit', amount: toKurus(1000) },
        { accountId: 'recv-u1-occupant', side: 'credit', amount: toKurus(1000), unitId: 'u1', liableParty: 'occupant' },
      ],
      totalAmount: toKurus(1000),
      createdAt: NOW.toISOString(),
      createdBy: 'mgr-1',
    };
    await runWithRequestContext({ requestId: 'r', actor: { userId: 'mgr-1', role: 'apartment_manager' } }, () =>
      createFinanceRepository().postTransaction({ transaction: tx, idempotency: { id: 'k1', fingerprint: 'fp' } }),
    );
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    const audit = items.at(-1)!.Put!;
    expect(audit.TableName).toBe('bm-audit');
    expect(audit.Item).toMatchObject({
      action: 'ledger.payment',
      target: { type: 'transaction', id: '20261121-t1' },
      actor: { userId: 'mgr-1', role: 'apartment_manager' },
      details: { transactions: [{ id: '20261121-t1', kind: 'payment', total: 1000, reference: 'IYZICO:p1', accounts: ['cash', 'recv-u1-occupant'] }] },
    });
    // Defter ogeleri denetimden once, sirasi degismeden.
    expect(items.slice(0, -1).every((i) => i.Put?.TableName === 'bm-main' || i.Update?.TableName === 'bm-main' || i.ConditionCheck?.TableName === 'bm-main')).toBe(true);
  });

  it('uyelik ve tercih yazimlari da atomik denetlenir (apartman / PLATFORM zinciri)', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(TransactWriteCommand).resolves({});
    const m = {
      PK: `APT#${APT}`, SK: 'MEMBER#u9#u1', entityType: 'UNIT_MEMBERSHIP', userId: 'u9', apartmentId: APT, unitId: 'u1', relation: 'tenant',
      residesInUnit: true, status: 'active', startDate: '2026-11-01', createdAt: NOW.toISOString(), createdBy: 'mgr-1', updatedAt: NOW.toISOString(), updatedBy: 'mgr-1', version: 1,
    } as unknown as UnitMembership;
    await createMembershipRepository().create(m);
    await createDynamoPreferencesRepository().put('u9', { email: { enabled: false }, updatedAt: NOW.toISOString() });
    const [membership, prefs] = ddb.commandCalls(TransactWriteCommand).map((c) => c.args[0].input.TransactItems!);
    expect(membership![1]!.Put!.Item).toMatchObject({ PK: 'APT#apt-1', action: 'membership.create', target: { type: 'membership', id: 'u9:u1' }, details: { relation: 'tenant', status: 'active' } });
    expect(prefs![0]!.Put!.Item).toMatchObject({ PK: 'USER#u9', SK: 'NOTIFPREF' });
    expect(prefs![1]!.Put!.Item).toMatchObject({ PK: 'PLATFORM', action: 'notification_preferences.update', details: { emailEnabled: false } });
  });

  it('yalnizca denetim olayi (destek istegi) tek ogeli transaction ile yazilir', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(TransactWriteCommand).resolves({});
    await appendAudit({ apartmentId: APT, action: 'support.request', target: { type: 'support_session', id: 's1' }, details: { method: 'GET', path: '/api/finance/summary' } });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(1);
    expect(items[0]!.Put!.Item).toMatchObject({ action: 'support.request', seq: 1, prevHash: GENESIS_HASH });
  });
});

// ---------------------------------------------------------------------------
// Zincir dogrulamasi
// ---------------------------------------------------------------------------

describe('API ve tarayici ayni hash\'i uretir', () => {
  // apps/web/src/lib/audit/fixture.ts ile AYNI sabit (GET /api/audit yanit bicimi).
  const FIXTURE = [
    {
      "PK": "APT#apt-1",
      "SK": "SEQ#000000000002",
      "entityType": "AUDIT_ENTRY",
      "scope": "APT#apt-1",
      "seq": 2,
      "auditId": "05e142eb-5e2b-43ae-bc2e-d9a7cdb12bfa",
      "at": "2026-11-21T10:05:00.000Z",
      "action": "membership.create",
      "actor": {
        "userId": "sys",
        "role": "system"
      },
      "apartmentId": "apt-1",
      "target": {
        "type": "membership",
        "id": "u9:u1"
      },
      "prevHash": "e5e6cfc7b7ed4d739b514900600a02c218a710ec75572c852fe70be5cba371fc",
      "ttl": 2110788300,
      "hash": "4b933a1b66ac0c4722749470551c4b7fb30ae9ebc125649fe5ae0077c751102e"
    },
    {
      "PK": "APT#apt-1",
      "SK": "SEQ#000000000001",
      "entityType": "AUDIT_ENTRY",
      "scope": "APT#apt-1",
      "seq": 1,
      "auditId": "497dd13d-a5eb-48ea-bd87-220d4df26919",
      "at": "2026-11-21T10:00:00.000Z",
      "action": "ledger.payment",
      "actor": {
        "userId": "mgr-1",
        "role": "apartment_manager"
      },
      "apartmentId": "apt-1",
      "target": {
        "type": "transaction",
        "id": "t-1"
      },
      "reason": "Tahsilat — Daire 5",
      "details": {
        "total": 150050,
        "accounts": [
          "cash",
          "recv-u1"
        ],
        "nested": {
          "ok": true
        }
      },
      "request": {
        "requestId": "req-1",
        "ip": "203.0.113.0/24",
        "userAgent": "Mozilla/5.0 (Türkçe ğüşıöç)"
      },
      "prevHash": "0000000000000000000000000000000000000000000000000000000000000000",
      "ttl": 2110788000,
      "hash": "e5e6cfc7b7ed4d739b514900600a02c218a710ec75572c852fe70be5cba371fc"
    }
  ] as unknown as AuditEntry[];

  it('yanit bicimindeki kayitlardan hash yeniden hesaplanir ve zincir saglamdir', () => {
    for (const e of FIXTURE) expect(computeHash(e.prevHash, e)).toBe(e.hash);
    expect(verifyChain('APT#apt-1', [...FIXTURE].reverse()).findings).toEqual([]);
  });
});

describe('zincir dogrulamasi', () => {
  it('saglam zincir bulgusuz; ustune yazma, silme ve bag kopmasi yakalanir', () => {
    const c = chain(4);
    expect(verifyChain('APT#apt-1', c)).toMatchObject({ findings: [], last: { seq: 4, hash: c[3]!.hash } });

    const tampered = structuredClone(c);
    tampered[1]!.details = { amount: 999 }; // icerik degisti, hash ayni kaldi
    expect(verifyChain('APT#apt-1', tampered).findings).toEqual([{ code: 'audit_chain_hash_mismatch', scope: 'APT#apt-1', seq: 2 }]);

    const deleted = [c[0]!, c[2]!, c[3]!];
    expect(verifyChain('APT#apt-1', deleted).findings).toEqual([expect.objectContaining({ code: 'audit_chain_gap', seq: 3 })]);

    const relinked = structuredClone(c);
    relinked[2]!.prevHash = 'f'.repeat(64);
    relinked[2]!.hash = computeHash(relinked[2]!.prevHash, relinked[2]!); // kendi icinde tutarli ama zincirden kopuk
    expect(verifyChain('APT#apt-1', relinked).findings.map((f) => f.code)).toContain('audit_chain_link_broken');
  });

  it('TTL ile silinmis eski kayitlar (ilk kayit seq>1) bulgu degildir', () => {
    expect(verifyChain('APT#apt-1', chain(5).slice(2)).findings).toEqual([]);
  });

  it('artimli dogrulama: kontrol noktasi ilerler; bulguda ilerlemez; kontrol noktasi kaydi degismisse yakalanir', async () => {
    const c = chain(5);
    const stored = new Map<string, { seq: number; hash: string; verifiedAt: string }>();
    const checkpoints: CheckpointStore = { get: async (s) => stored.get(s), put: async (s, cp) => void stored.set(s, cp) };
    const reader: Pick<AuditReader, 'listAfter' | 'get'> = {
      listAfter: async (_s, after) => c.filter((e) => e.seq > after),
      get: async (_s, seq) => c.find((e) => e.seq === seq),
    };
    const first = await verifyAuditScope('APT#apt-1', { reader, checkpoints, now: () => NOW });
    expect(first).toMatchObject({ checked: 5, findings: [] });
    expect(stored.get('APT#apt-1')).toMatchObject({ seq: 5, hash: c[4]!.hash });

    const second = await verifyAuditScope('APT#apt-1', { reader, checkpoints, now: () => NOW });
    expect(second.checked).toBe(0);

    c[4]!.reason = 'sonradan degistirildi';
    c[4]!.hash = computeHash(c[4]!.prevHash, c[4]!);
    const third = await verifyAuditScope('APT#apt-1', { reader, checkpoints, now: () => NOW });
    expect(third.findings).toEqual([{ code: 'audit_checkpoint_mismatch', scope: 'APT#apt-1', seq: 5 }]);
  });
});

// ---------------------------------------------------------------------------
// Okuma: sayfalama ve tenant izolasyonu
// ---------------------------------------------------------------------------

describe('denetim okuyucu', () => {
  beforeEach(() => useTables());

  it('en yeni once, filtreler, imlec yalnizca ayni kapsam icin gecerli', async () => {
    const c = chain(3);
    ddb.on(QueryCommand).resolves({ Items: [c[2], c[1]], LastEvaluatedKey: { PK: 'APT#apt-1', SK: c[1]!.SK } });
    const reader = createAuditReader();
    const page = await reader.list('APT#apt-1', { limit: 2, action: 'test.', actorId: 'system', from: '2026-11-01T00:00:00.000Z' });
    const input = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ TableName: 'bm-audit', ScanIndexForward: false, ExpressionAttributeValues: { ':pk': 'APT#apt-1', ':action': 'test.', ':uid': 'system', ':from': '2026-11-01T00:00:00.000Z' } });
    expect(input.FilterExpression).toContain('begins_with(#action, :action)');
    expect(page.items.map((e) => e.seq)).toEqual([3, 2]);
    expect(page.cursor).toBeDefined();

    await reader.list('APT#apt-1', { limit: 2, cursor: page.cursor });
    expect(ddb.commandCalls(QueryCommand)[1]!.args[0].input.ExclusiveStartKey).toEqual({ PK: 'APT#apt-1', SK: c[1]!.SK });
    await expect(reader.list('APT#apt-2', { limit: 2, cursor: page.cursor })).rejects.toThrow(/imleci/);
  });
});

// ---------------------------------------------------------------------------
// API: listeleme ve destek erisimi
// ---------------------------------------------------------------------------

function supportWorld() {
  const sessions = new Map<string, SupportSession>();
  const requests: { sessionId: string; method: string; path: string; ctx: ReturnType<typeof getRequestContext> }[] = [];
  let now = NOW;
  let failAudit = false;
  const repository: SupportRepository = {
    get: async (apt, id) => [...sessions.values()].find((s) => s.apartmentId === apt && s.sessionId === id),
    list: async (apt) => [...sessions.values()].filter((s) => s.apartmentId === apt),
    create: async (s) => void sessions.set(s.sessionId, s),
    update: async (s, v) => {
      if (sessions.get(s.sessionId)?.version !== v) throw new DataAccessError('conflict', 'surum');
      sessions.set(s.sessionId, s);
    },
  };
  let n = 0;
  const support = createSupportService({
    repository,
    core: { getSite: async (id) => (id === APT || id === 'apt-2' ? ({ siteId: id } as Site) : undefined) },
    now: () => now,
    newId: () => `session${++n}abcdef`,
    recordRequest: async (s, r) => {
      if (failAudit) throw new DataAccessError('internal', 'denetim yazilamadi');
      requests.push({ sessionId: s.sessionId, ...r, ctx: structuredClone(getRequestContext()) });
    },
  });
  const auditItems = chain(2);
  const listCalls: { scope: string; q: unknown }[] = [];
  const app = createApp({
    version: 'test',
    authenticate: createMockAuthenticator(),
    supportService: support,
    auditReader: {
      list: async (scope, q) => (listCalls.push({ scope, q }), { items: auditItems.slice().reverse() }),
      listAfter: async () => [],
      get: async () => undefined,
    },
  });
  const token = (sub: string, role: string, apartmentId?: string) => `Bearer ${encodeMockToken({ sub, role, ...(apartmentId ? { apartmentId } : {}) })}`;
  const call = async (method: string, path: string, auth: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77', 'user-agent': 'Test/1.0', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
  };
  return {
    call, token, sessions, requests, listCalls,
    setNow: (d: Date) => void (now = d),
    failAudit: (v: boolean) => void (failAudit = v),
  };
}

const REASON = 'Destek talebi #1234: makbuz goruntuleme sorunu inceleniyor';

describe('GET /api/audit', () => {
  it('yonetici ve denetci kendi apartmaninin kayitlarini gorur; indeks alanlari gizli', async () => {
    const w = supportWorld();
    const res = await w.call('GET', '/api/audit?limit=10&action=membership.', w.token('mgr-1', 'apartment_manager', APT));
    expect(res.status).toBe(200);
    expect(w.listCalls[0]).toMatchObject({ scope: 'APT#apt-1', q: { limit: 10, action: 'membership.' } });
    expect(res.body.items).toHaveLength(2);
    // Hash'e giren alanlar istemcide yeniden hesaplanabilsin diye kalir; indeks alanlari gizli.
    expect(res.body.items[0]).not.toHaveProperty('GSI1PK');
    expect(res.body.items[0]).not.toHaveProperty('GSI1SK');
    expect(res.body.items[0]).toMatchObject({ PK: 'APT#apt-1', hash: expect.any(String), ttl: expect.any(Number) });
    expect((await w.call('GET', '/api/audit', w.token('obs-1', 'observer', APT))).status).toBe(200);
  });

  it('sakin, gorevli ve dogrudan platform_admin goremez; gecersiz parametre 400', async () => {
    const w = supportWorld();
    expect((await w.call('GET', '/api/audit', w.token('r1', 'resident', APT))).status).toBe(403);
    expect((await w.call('GET', '/api/audit', w.token('s1', 'building_staff', APT))).status).toBe(403);
    expect((await w.call('GET', '/api/audit', w.token('admin-1', 'platform_admin'))).status).toBe(403);
    expect((await w.call('GET', '/api/audit?limit=500', w.token('mgr-1', 'apartment_manager', APT))).status).toBe(400);
    expect((await w.call('GET', '/api/audit?from=dun', w.token('mgr-1', 'apartment_manager', APT))).status).toBe(400);
    expect((await w.call('GET', '/api/audit?action=DROP%20TABLE', w.token('mgr-1', 'apartment_manager', APT))).status).toBe(400);
  });
});

describe('platform_admin destek erisimi', () => {
  it('gerekce ve sure dogrulanir; yalnizca platform_admin acabilir; olmayan apartman 404', async () => {
    const w = supportWorld();
    const admin = w.token('admin-1', 'platform_admin');
    expect((await w.call('POST', '/api/support/sessions', admin, { apartmentId: APT, reason: 'kisa' })).status).toBe(400);
    expect((await w.call('POST', '/api/support/sessions', admin, { apartmentId: APT, reason: REASON, durationMinutes: 90 })).status).toBe(400);
    expect((await w.call('POST', '/api/support/sessions', admin, { apartmentId: 'yok', reason: REASON })).status).toBe(404);
    expect((await w.call('POST', '/api/support/sessions', w.token('mgr-1', 'apartment_manager', APT), { apartmentId: APT, reason: REASON })).status).toBe(403);

    const ok = await w.call('POST', '/api/support/sessions', admin, { apartmentId: APT, reason: REASON, durationMinutes: 30 });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ apartmentId: APT, adminUserId: 'admin-1', active: true, expiresAt: '2026-11-21T09:30:00.000Z' });
    expect(ok.body.header).toBe(`${APT}.${ok.body.sessionId}`);
  });

  it('oturumla salt okunur (observer) erisim; her istek once denetime yazilir (kisaltilmis IP/UA, gercek aktor)', async () => {
    const w = supportWorld();
    const admin = w.token('admin-1', 'platform_admin');
    const { body: s } = await w.call('POST', '/api/support/sessions', admin, { apartmentId: APT, reason: REASON });
    const res = await w.call('GET', '/api/audit', admin, undefined, { 'x-support-session': s.header });
    expect(res.status).toBe(200);
    expect(w.listCalls.at(-1)!.scope).toBe('APT#apt-1');
    expect(w.requests).toEqual([
      {
        sessionId: s.sessionId,
        method: 'GET',
        path: '/api/audit',
        ctx: expect.objectContaining({
          ip: '203.0.113.0/24',
          userAgent: 'Test/1.0',
          actor: { userId: 'admin-1', role: 'platform_admin', supportSessionId: s.sessionId },
        }),
      },
    ]);
    // Yazma yetkisi yok (observer).
    const write = await w.call('POST', '/api/support/sessions', admin, { apartmentId: APT, reason: REASON }, { 'x-support-session': s.header });
    expect(write.status).toBe(403);
  });

  it('suresi dolmus, bitirilmis, baskasinin veya platform_admin olmayanin oturumu 401', async () => {
    const w = supportWorld();
    const admin = w.token('admin-1', 'platform_admin');
    const { body: s } = await w.call('POST', '/api/support/sessions', admin, { apartmentId: APT, reason: REASON, durationMinutes: 5 });
    const h = { 'x-support-session': s.header };
    expect((await w.call('GET', '/api/audit', w.token('admin-2', 'platform_admin'), undefined, h)).status).toBe(401);
    expect((await w.call('GET', '/api/audit', w.token('mgr-1', 'apartment_manager', APT), undefined, h)).status).toBe(401);
    expect((await w.call('GET', '/api/audit', admin, undefined, { 'x-support-session': 'bozuk' })).status).toBe(401);

    w.setNow(new Date(NOW.getTime() + 6 * 60_000));
    expect((await w.call('GET', '/api/audit', admin, undefined, h)).status).toBe(401);

    w.setNow(NOW);
    const ended = await w.call('POST', `/api/support/sessions/${APT}/${s.sessionId}/end`, admin);
    expect(ended.body).toMatchObject({ active: false, endedAt: NOW.toISOString() });
    expect((await w.call('GET', '/api/audit', admin, undefined, h)).status).toBe(401);
    expect(w.requests).toHaveLength(0);
  });

  it('denetim yazilamazsa istek islenmez (fail closed)', async () => {
    const w = supportWorld();
    const admin = w.token('admin-1', 'platform_admin');
    const { body: s } = await w.call('POST', '/api/support/sessions', admin, { apartmentId: APT, reason: REASON });
    w.failAudit(true);
    const res = await w.call('GET', '/api/audit', admin, undefined, { 'x-support-session': s.header });
    expect(res.status).toBe(500);
    expect(w.listCalls).toHaveLength(0);
  });

  it('oturum baska apartmana erisim vermez (kapsam oturumun apartmani)', async () => {
    const w = supportWorld();
    const admin = w.token('admin-1', 'platform_admin');
    const { body: s } = await w.call('POST', '/api/support/sessions', admin, { apartmentId: 'apt-2', reason: REASON });
    await w.call('GET', '/api/audit', admin, undefined, { 'x-support-session': s.header });
    expect(w.listCalls.at(-1)!.scope).toBe('APT#apt-2');
  });
});
