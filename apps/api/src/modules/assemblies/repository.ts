import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { DataAccessError, getDynamo, getTenantItem, queryTenantAll, skKey, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import { toOutboxItems } from '../../events/outbox.js';
import type { DomainEvent } from '../../events/publisher.js';
import { type AuditDraft, auditedPutNew, sendWithAudit } from '../audit/log.js';
import type { TableKeys } from '../core/types.js';
import type { RollChunk } from '../polls/rollSnapshot.js';
import type {
  Assembly,
  AssemblyAttendance,
  AssemblyCall,
  AssemblyCallRecipients,
  AssemblyDecision,
  AssemblyServiceRecord,
  ConsentEntry,
  ConsentRequest,
  ResolvedCall,
} from './types.js';

const seq3 = (n: number) => String(n).padStart(3, '0');

export const assemblyKeys = {
  assembly: (apartmentId: string, assemblyId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('ASSEMBLY', assemblyId) }),
  attendance: (apartmentId: string, assemblyId: string, unitId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('ASMATT', assemblyId, unitId) }),
  decision: (apartmentId: string, assemblyId: string, itemId: string, seq: number): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('ASMDEC', assemblyId, itemId, seq3(seq)) }),
  call: (apartmentId: string, assemblyId: string, seq: number): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('ASMCALL', assemblyId, seq3(seq)) }),
  callRecipients: (apartmentId: string, assemblyId: string, seq: number, bucket: number): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('ASMCALLR', assemblyId, seq3(seq), seq3(bucket)),
  }),
  service: (apartmentId: string, assemblyId: string, ownerId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('ASMSERVE', assemblyId, ownerId) }),
  consent: (apartmentId: string, consentId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('ASMCONS', consentId) }),
  consentEntry: (apartmentId: string, consentId: string, unitId: string, seq: number): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('ASMCONSV', consentId, unitId, seq3(seq)) }),
};

/** Toplanti yazimiyla ayni atomik islemde yazilan degismez kayitlar ve olaylar. */
export type AssemblyWriteExtras = {
  /** Dondurulan oy listesi kovalari (`attribute_not_exists`). */
  roll?: RollChunk[];
  /** Yeni karar / duzeltme kaydi (`attribute_not_exists`). */
  decision?: AssemblyDecision;
  /** Yeni cagri kaydi (`attribute_not_exists`). */
  call?: AssemblyCall;
  /** Cagri alici kovalari (`attribute_not_exists`; cagri kaydiyla ayni yazim). */
  callRecipients?: AssemblyCallRecipients[];
  /** Outbox olaylari (ASSEMBLY_CALLED / _CANCELLED / _RESCHEDULED; `attribute_not_exists`). */
  outbox?: DomainEvent[];
};

/** Cagri kaydini kovalariyla birlestirir (eski kayit: alicilar kaydin icinde). */
export function resolveCall(call: AssemblyCall, buckets: readonly AssemblyCallRecipients[]): ResolvedCall {
  const own = buckets.filter((b) => b.entityType === 'ASSEMBLY_CALL_RECIPIENTS' && b.apartmentId === call.apartmentId && b.assemblyId === call.assemblyId && b.seq === call.seq);
  const fromBuckets = [...own].sort((x, y) => x.bucket - y.bucket).flatMap((b) => b.userIds);
  const { recipientUserIds: legacy, ...rest } = call;
  return { ...rest, recipientUserIds: [...(legacy ?? []), ...fromBuckets] };
}

export type AssemblyRepository = {
  get(apartmentId: string, assemblyId: string): Promise<Assembly | undefined>;
  list(apartmentId: string): Promise<Assembly[]>;
  /** Yeni toplanti + denetim kaydi (atomik). */
  create(a: Assembly, audit: AuditDraft): Promise<void>;
  /**
   * Surum kosullu; `audit` ve ekler (oy listesi kovalari, karar, cagri, outbox; hepsi
   * `attribute_not_exists`) ayni atomik yazimda. Cakismada `DataAccessError('conflict')`.
   */
  update(a: Assembly, expectedVersion: number, audit?: AuditDraft, extras?: AssemblyWriteExtras): Promise<void>;
  listAttendance(apartmentId: string, assemblyId: string): Promise<AssemblyAttendance[]>;
  getAttendance(apartmentId: string, assemblyId: string, unitId: string): Promise<AssemblyAttendance | undefined>;
  /**
   * Bolumun katilimi: `expectedVersion = 0` ilk kayit. Ayni islemde toplantinin `planned` oldugu
   * dogrulanir. Kosul saglanmazsa `DataAccessError('conflict')`.
   */
  putAttendance(att: AssemblyAttendance, expectedVersion: number, audit: AuditDraft): Promise<void>;
  /** Karar kayitlari: `assemblyId` verilirse o toplantinin, yoksa apartmanin tumu (karar defteri). */
  listDecisions(apartmentId: string, assemblyId?: string): Promise<AssemblyDecision[]>;
  /** Cagri kaydi, alicilar kovalardan birlestirilmis. */
  getCall(apartmentId: string, assemblyId: string, seq: number): Promise<ResolvedCall | undefined>;
  /** Toplantinin tum cagrilari (iptal / erteleme bildiriminin alicilari), sira artan. */
  listCalls(apartmentId: string, assemblyId: string): Promise<ResolvedCall[]>;

  // Yasal cagri teslim takibi
  listServiceRecords(apartmentId: string, assemblyId: string): Promise<AssemblyServiceRecord[]>;
  getServiceRecord(apartmentId: string, assemblyId: string, ownerId: string): Promise<AssemblyServiceRecord | undefined>;
  /** `expectedVersion = 0` ilk kayit; ayni islemde toplantinin iptal edilmedigi dogrulanir. */
  putServiceRecord(rec: AssemblyServiceRecord, expectedVersion: number, audit: AuditDraft): Promise<void>;

  // Yazili riza
  getConsent(apartmentId: string, consentId: string): Promise<ConsentRequest | undefined>;
  listConsents(apartmentId: string): Promise<ConsentRequest[]>;
  /** Yeni talep + dondurulmus oy listesi kovalari + denetim (atomik). */
  createConsent(req: ConsentRequest, roll: RollChunk[], audit: AuditDraft): Promise<void>;
  /** Surum kosullu (kapatma / iptal). */
  updateConsent(req: ConsentRequest, expectedVersion: number, audit: AuditDraft): Promise<void>;
  listConsentEntries(apartmentId: string, consentId: string): Promise<ConsentEntry[]>;
  /** Degismez riza kaydi (`attribute_not_exists`); ayni islemde talebin acik oldugu dogrulanir. */
  putConsentEntry(entry: ConsentEntry, audit: AuditDraft): Promise<void>;
};

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

const conditionFailed = (err: unknown) =>
  err instanceof TransactionCanceledException && (err.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed');

function assertKeys(item: TableKeys, expected: TableKeys): void {
  if (item.PK !== expected.PK || item.SK !== expected.SK) throw new Error(`Genel kurul anahtari tutarsiz: ${item.PK}/${item.SK}`);
}

/** Eklerin toplantiya ait oldugunu dogrular (baska toplanti / apartman kaydi karismaz). */
export function assertExtrasBelong(a: Assembly, extras: AssemblyWriteExtras): void {
  for (const chunk of extras.roll ?? []) {
    if (chunk.apartmentId !== a.apartmentId || chunk.ownerId !== a.assemblyId) throw new Error('Oy listesi kovasi toplantiya ait degil');
  }
  const d = extras.decision;
  if (d) {
    if (d.apartmentId !== a.apartmentId || d.assemblyId !== a.assemblyId) throw new Error('Karar kaydi toplantiya ait degil');
    assertKeys(d, assemblyKeys.decision(a.apartmentId, a.assemblyId, d.itemId, d.seq));
  }
  const c = extras.call;
  if (c) {
    if (c.apartmentId !== a.apartmentId || c.assemblyId !== a.assemblyId) throw new Error('Cagri kaydi toplantiya ait degil');
    assertKeys(c, assemblyKeys.call(a.apartmentId, a.assemblyId, c.seq));
  }
  for (const b of extras.callRecipients ?? []) {
    if (!c || b.apartmentId !== a.apartmentId || b.assemblyId !== a.assemblyId || b.seq !== c.seq) throw new Error('Alici kovasi cagriya ait degil');
    assertKeys(b, assemblyKeys.callRecipients(a.apartmentId, a.assemblyId, b.seq, b.bucket));
  }
  for (const e of extras.outbox ?? []) {
    if (e.apartmentId !== a.apartmentId) throw new Error('Olay toplantinin apartmanina ait degil');
  }
}

export function createAssemblyRepository(): AssemblyRepository {
  return {
    get: (apartmentId, id) => getTenantItem<Assembly>(assemblyKeys.assembly(apartmentId, id)),
    async list(apartmentId) {
      const items = await queryTenantAll<Assembly>(apartmentId, 'ASSEMBLY#', { ConsistentRead: true });
      return items.filter((a) => a.entityType === 'ASSEMBLY' && a.apartmentId === apartmentId);
    },
    async create(a, audit) {
      assertKeys(a, assemblyKeys.assembly(a.apartmentId, a.assemblyId));
      await auditedPutNew(a, audit);
    },
    async update(a, expectedVersion, audit, extras = {}) {
      assertKeys(a, assemblyKeys.assembly(a.apartmentId, a.assemblyId));
      assertExtrasBelong(a, extras);
      const { client, tableName } = getDynamo();
      const putNew = (Item: Record<string, unknown>): TransactItem => ({ Put: { TableName: tableName, Item, ConditionExpression: 'attribute_not_exists(PK)' } });
      const items: TransactItem[] = [
        {
          Put: {
            TableName: tableName,
            Item: a,
            ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':expected': expectedVersion },
          },
        },
        ...(extras.roll ?? []).map(putNew),
        ...(extras.decision ? [putNew(extras.decision)] : []),
        ...(extras.call ? [putNew(extras.call)] : []),
        ...(extras.callRecipients ?? []).map(putNew),
        ...toOutboxItems(extras.outbox ?? [], a.updatedAt, a.apartmentId).map(putNew),
      ];
      try {
        await sendWithAudit(client, items, audit);
      } catch (err) {
        if (conditionFailed(err)) throw new DataAccessError('conflict', 'Kosul saglanmadi (surum catismasi veya kayit zaten var)', { cause: err });
        throw toDataAccessError(err);
      }
    },
    async listAttendance(apartmentId, assemblyId) {
      const items = await queryTenantAll<AssemblyAttendance>(apartmentId, `ASMATT#${assemblyId}#`, { ConsistentRead: true });
      return items.filter((x) => x.entityType === 'ASSEMBLY_ATTENDANCE' && x.apartmentId === apartmentId && x.assemblyId === assemblyId);
    },
    getAttendance: (apartmentId, assemblyId, unitId) => getTenantItem<AssemblyAttendance>(assemblyKeys.attendance(apartmentId, assemblyId, unitId)),
    async putAttendance(att, expectedVersion, audit) {
      assertKeys(att, assemblyKeys.attendance(att.apartmentId, att.assemblyId, att.unitId));
      const { client, tableName } = getDynamo();
      const items: TransactItem[] = [
        {
          ConditionCheck: {
            TableName: tableName,
            Key: assemblyKeys.assembly(att.apartmentId, att.assemblyId),
            // Ilk karardan sonra katilim donar (eszamanli karar yazimiyla yarisa karsi).
            ConditionExpression: '#status = :planned AND attribute_not_exists(#locked)',
            ExpressionAttributeNames: { '#status': 'status', '#locked': 'attendanceLockedAt' },
            ExpressionAttributeValues: { ':planned': 'planned' },
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: att,
            ...(expectedVersion === 0
              ? { ConditionExpression: 'attribute_not_exists(PK)' }
              : {
                  ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
                  ExpressionAttributeNames: { '#version': 'version' },
                  ExpressionAttributeValues: { ':expected': expectedVersion },
                }),
          },
        },
      ];
      try {
        await sendWithAudit(client, items, audit);
      } catch (err) {
        if (conditionFailed(err)) throw new DataAccessError('conflict', 'Kosul saglanmadi (toplanti iptal veya kayit degisti)', { cause: err });
        throw toDataAccessError(err);
      }
    },
    async listDecisions(apartmentId, assemblyId) {
      const items = await queryTenantAll<AssemblyDecision>(apartmentId, assemblyId ? `ASMDEC#${assemblyId}#` : 'ASMDEC#', { ConsistentRead: true });
      return items.filter((d) => d.entityType === 'ASSEMBLY_DECISION' && d.apartmentId === apartmentId && (!assemblyId || d.assemblyId === assemblyId));
    },
    async getCall(apartmentId, assemblyId, seq) {
      const c = await getTenantItem<AssemblyCall>(assemblyKeys.call(apartmentId, assemblyId, seq));
      if (!(c && c.entityType === 'ASSEMBLY_CALL' && c.apartmentId === apartmentId && c.assemblyId === assemblyId)) return undefined;
      const buckets = c.buckets ? await queryTenantAll<AssemblyCallRecipients>(apartmentId, `ASMCALLR#${assemblyId}#${seq3(seq)}#`, { ConsistentRead: true }) : [];
      return resolveCall(c, buckets);
    },
    async listCalls(apartmentId, assemblyId) {
      const [calls, buckets] = await Promise.all([
        queryTenantAll<AssemblyCall>(apartmentId, `ASMCALL#${assemblyId}#`, { ConsistentRead: true }),
        queryTenantAll<AssemblyCallRecipients>(apartmentId, `ASMCALLR#${assemblyId}#`, { ConsistentRead: true }),
      ]);
      return calls
        .filter((c) => c.entityType === 'ASSEMBLY_CALL' && c.apartmentId === apartmentId && c.assemblyId === assemblyId)
        .sort((x, y) => x.seq - y.seq)
        .map((c) => resolveCall(c, buckets));
    },
    async listServiceRecords(apartmentId, assemblyId) {
      const items = await queryTenantAll<AssemblyServiceRecord>(apartmentId, `ASMSERVE#${assemblyId}#`, { ConsistentRead: true });
      return items.filter((x) => x.entityType === 'ASSEMBLY_SERVICE' && x.apartmentId === apartmentId && x.assemblyId === assemblyId);
    },
    async getServiceRecord(apartmentId, assemblyId, ownerId) {
      const r = await getTenantItem<AssemblyServiceRecord>(assemblyKeys.service(apartmentId, assemblyId, ownerId));
      return r?.entityType === 'ASSEMBLY_SERVICE' && r.apartmentId === apartmentId ? r : undefined;
    },
    async putServiceRecord(rec, expectedVersion, audit) {
      assertKeys(rec, assemblyKeys.service(rec.apartmentId, rec.assemblyId, rec.ownerId));
      const { client, tableName } = getDynamo();
      const items: TransactItem[] = [
        {
          ConditionCheck: {
            TableName: tableName,
            Key: assemblyKeys.assembly(rec.apartmentId, rec.assemblyId),
            ConditionExpression: 'attribute_exists(PK) AND #status <> :cancelled',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':cancelled': 'cancelled' },
          },
        },
        versionedPut(tableName, rec, expectedVersion),
      ];
      try {
        await sendWithAudit(client, items, audit);
      } catch (err) {
        if (conditionFailed(err)) throw new DataAccessError('conflict', 'Kosul saglanmadi (toplanti iptal veya kayit degisti)', { cause: err });
        throw toDataAccessError(err);
      }
    },
    async getConsent(apartmentId, consentId) {
      const r = await getTenantItem<ConsentRequest>(assemblyKeys.consent(apartmentId, consentId));
      return r?.entityType === 'ASSEMBLY_CONSENT' && r.apartmentId === apartmentId ? r : undefined;
    },
    async listConsents(apartmentId) {
      const items = await queryTenantAll<ConsentRequest>(apartmentId, 'ASMCONS#', { ConsistentRead: true });
      return items.filter((x) => x.entityType === 'ASSEMBLY_CONSENT' && x.apartmentId === apartmentId);
    },
    async createConsent(req, roll, audit) {
      assertKeys(req, assemblyKeys.consent(req.apartmentId, req.consentId));
      for (const chunk of roll) {
        if (chunk.apartmentId !== req.apartmentId || chunk.ownerId !== req.consentId || chunk.ownerType !== 'consent') throw new Error('Oy listesi kovasi talebe ait degil');
      }
      const { client, tableName } = getDynamo();
      const putNew = (Item: Record<string, unknown>): TransactItem => ({ Put: { TableName: tableName, Item, ConditionExpression: 'attribute_not_exists(PK)' } });
      try {
        await sendWithAudit(client, [putNew(req), ...roll.map(putNew)], audit);
      } catch (err) {
        if (conditionFailed(err)) throw new DataAccessError('conflict', 'Kayit zaten var', { cause: err });
        throw toDataAccessError(err);
      }
    },
    async updateConsent(req, expectedVersion, audit) {
      assertKeys(req, assemblyKeys.consent(req.apartmentId, req.consentId));
      const { client, tableName } = getDynamo();
      try {
        await sendWithAudit(client, [versionedPut(tableName, req, expectedVersion)], audit);
      } catch (err) {
        if (conditionFailed(err)) throw new DataAccessError('conflict', 'Surum catismasi', { cause: err });
        throw toDataAccessError(err);
      }
    },
    async listConsentEntries(apartmentId, consentId) {
      const items = await queryTenantAll<ConsentEntry>(apartmentId, `ASMCONSV#${consentId}#`, { ConsistentRead: true });
      return items.filter((x) => x.entityType === 'ASSEMBLY_CONSENT_ENTRY' && x.apartmentId === apartmentId && x.consentId === consentId);
    },
    async putConsentEntry(entry, audit) {
      assertKeys(entry, assemblyKeys.consentEntry(entry.apartmentId, entry.consentId, entry.unitId, entry.seq));
      const { client, tableName } = getDynamo();
      const items: TransactItem[] = [
        {
          ConditionCheck: {
            TableName: tableName,
            Key: assemblyKeys.consent(entry.apartmentId, entry.consentId),
            ConditionExpression: '#status = :open',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':open': 'open' },
          },
        },
        { Put: { TableName: tableName, Item: entry, ConditionExpression: 'attribute_not_exists(PK)' } },
      ];
      try {
        await sendWithAudit(client, items, audit);
      } catch (err) {
        if (conditionFailed(err)) throw new DataAccessError('conflict', 'Kosul saglanmadi (talep kapali veya kayit var)', { cause: err });
        throw toDataAccessError(err);
      }
    },
  };
}

function versionedPut(tableName: string, item: TableKeys & Record<string, unknown>, expectedVersion: number): TransactItem {
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ...(expectedVersion === 0
        ? { ConditionExpression: 'attribute_not_exists(PK)' }
        : {
            ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':expected': expectedVersion },
          }),
    },
  };
}

export const assemblyRepository: AssemblyRepository = createAssemblyRepository();
