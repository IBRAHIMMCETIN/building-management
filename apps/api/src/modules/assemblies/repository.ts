import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { DataAccessError, getDynamo, getTenantItem, queryTenantAll, skKey, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import { toOutboxItems } from '../../events/outbox.js';
import type { DomainEvent } from '../../events/publisher.js';
import { type AuditDraft, auditedPutNew, sendWithAudit } from '../audit/log.js';
import type { TableKeys } from '../core/types.js';
import type { RollChunk } from '../polls/rollSnapshot.js';
import type { Assembly, AssemblyAttendance, AssemblyCall, AssemblyDecision } from './types.js';

const seq3 = (n: number) => String(n).padStart(3, '0');

export const assemblyKeys = {
  assembly: (apartmentId: string, assemblyId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('ASSEMBLY', assemblyId) }),
  attendance: (apartmentId: string, assemblyId: string, unitId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('ASMATT', assemblyId, unitId) }),
  decision: (apartmentId: string, assemblyId: string, itemId: string, seq: number): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('ASMDEC', assemblyId, itemId, seq3(seq)) }),
  call: (apartmentId: string, assemblyId: string, seq: number): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('ASMCALL', assemblyId, seq3(seq)) }),
};

/** Toplanti yazimiyla ayni atomik islemde yazilan degismez kayitlar ve olaylar. */
export type AssemblyWriteExtras = {
  /** Dondurulan oy listesi kovalari (`attribute_not_exists`). */
  roll?: RollChunk[];
  /** Yeni karar / duzeltme kaydi (`attribute_not_exists`). */
  decision?: AssemblyDecision;
  /** Yeni cagri kaydi (`attribute_not_exists`). */
  call?: AssemblyCall;
  /** Outbox olaylari (ASSEMBLY_CALLED; `attribute_not_exists`). */
  outbox?: DomainEvent[];
};

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
  getCall(apartmentId: string, assemblyId: string, seq: number): Promise<AssemblyCall | undefined>;
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
      return c && c.entityType === 'ASSEMBLY_CALL' && c.apartmentId === apartmentId && c.assemblyId === assemblyId ? c : undefined;
    },
  };
}

export const assemblyRepository: AssemblyRepository = createAssemblyRepository();
