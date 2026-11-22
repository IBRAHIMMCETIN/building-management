import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, QueryCommand, type QueryCommandOutput, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DataAccessError, getDynamo, getTenantItem, queryTenantAll, tenantPk, toDataAccessError } from '../../../config/dynamodb.js';
import { type AuditDraft, auditedPutNew, auditedPutVersioned, sendWithAudit } from '../../audit/log.js';
import type { IsoDate } from '../../core/types.js';
import { BankError } from './errors.js';
import { PROFILE_PREFIX, REF_PREFIX, STATEMENT_PREFIX, bankKeys, decisionPrefix, linePrefix, parseLineId } from './keys.js';
import type {
  BankAccountProfile,
  BankDecision,
  BankFileLock,
  BankFormat,
  BankLine,
  BankPayer,
  BankRef,
  BankRefOf,
  BankStatement,
  LineStatus,
} from './types.js';

export type LineQuery = {
  bankAccountId: string;
  from?: IsoDate;
  to?: IsoDate;
  status?: LineStatus;
  statementId?: string;
  order?: 'asc' | 'desc';
  limit: number;
  cursor?: string;
};

export type BankRepository = {
  getStatement(apartmentId: string, statementId: string): Promise<BankStatement | undefined>;
  /** En yeni once. */
  listStatements(apartmentId: string): Promise<BankStatement[]>;
  getFileLock(apartmentId: string, sha256: string): Promise<BankFileLock | undefined>;
  /** Ekstre + dosya kilidi + denetim kaydi (atomik). Ikisinden biri varsa `DataAccessError('conflict')`. */
  createStatement(statement: BankStatement, lock: BankFileLock, audit: AuditDraft): Promise<void>;
  /** Surum kosullu ustune yazim + denetim kaydi. Surum uyusmazsa `DataAccessError('conflict')`. */
  replaceStatement(statement: BankStatement, expectedVersion: number, audit: AuditDraft): Promise<void>;
  /** Verilen satir SK'larindan veritabaninda olanlar. */
  existingLineKeys(apartmentId: string, sks: string[]): Promise<Set<string>>;
  /** Veritabaninda olan satirlar: SK -> satiri ilk aktaran ekstre. */
  existingLineStatements(apartmentId: string, sks: string[]): Promise<Map<string, string>>;
  /** Yalnizca olmayan satirlari yazar (`attribute_not_exists`); tekrar cagrilabilir. */
  putLinesIfAbsent(apartmentId: string, lines: BankLine[]): Promise<{ written: number; existing: number }>;
  queryLines(apartmentId: string, query: LineQuery): Promise<{ items: BankLine[]; cursor?: string }>;
  getFormat(apartmentId: string, bankAccountId: string): Promise<BankFormat | undefined>;
  /** `expectedVersion` yoksa yeni kayit (varsa conflict), varsa surum kosullu. Denetlenir. */
  saveFormat(format: BankFormat, expectedVersion: number | undefined, audit: AuditDraft): Promise<void>;

  // ----- Faz B2 -----
  getLine(apartmentId: string, bankAccountId: string, lineId: string): Promise<BankLine | undefined>;
  /** Satirin karar gecmisi (eskiden yeniye). */
  listDecisions(apartmentId: string, lineId: string): Promise<BankDecision[]>;
  /**
   * Defter kaydi olmayan karar (yoksayma / yeniden acma): karar kaydi (yalnizca yoksa) + satirin
   * surum kosullu durum gecisi + denetim kaydi TEK atomik yazim. Surum degismisse `conflict`.
   */
  writeDecision(line: BankLine, expectedVersion: number, decision: BankDecision, audit: AuditDraft): Promise<void>;
  getPayer(apartmentId: string, ibanMac: string): Promise<BankPayer | undefined>;
  listRefs(apartmentId: string): Promise<BankRef[]>;
  getRefOf(apartmentId: string, accountId: string): Promise<BankRefOf | undefined>;
  /** Kod + ters esleme, yalnizca ikisi de yoksa (atomik). Kod baskasina aitse 'code_taken'. */
  createRef(ref: BankRef, refOf: BankRefOf): Promise<'created' | 'code_taken' | 'account_has_code'>;
  getProfile(apartmentId: string, bankAccountId: string): Promise<BankAccountProfile | undefined>;
  listProfiles(apartmentId: string): Promise<BankAccountProfile[]>;
  /**
   * Profil kaydi (yeni: yalnizca yoksa; guncelleme: surum kosullu). `others`: sakine gosterilen
   * hesap tek olsun diye ayni yazimda `residentVisible = false` yapilan diger profiller.
   */
  saveProfile(
    profile: BankAccountProfile,
    expectedVersion: number | undefined,
    others: { item: BankAccountProfile; expectedVersion: number }[],
    audit: AuditDraft,
  ): Promise<void>;
};

const LINE_CHUNK = 25;
const BATCH_GET = 100;

const chunks = <T>(arr: T[], n: number): T[][] => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Sayfalama imleci: tenant'a kilitli (baska apartmanin anahtari verilemez)
// ---------------------------------------------------------------------------

export function encodeCursor(key: { PK: string; SK: string }): string {
  return Buffer.from(JSON.stringify({ PK: key.PK, SK: key.SK }), 'utf8').toString('base64url');
}

export function decodeCursor(apartmentId: string, bankAccountId: string, cursor: string): { PK: string; SK: string } {
  try {
    const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { PK?: unknown; SK?: unknown };
    if (o.PK === tenantPk(apartmentId) && typeof o.SK === 'string' && o.SK.startsWith(linePrefix(bankAccountId))) {
      return { PK: o.PK, SK: o.SK };
    }
  } catch {
    // asagida
  }
  throw new BankError('unprocessable', 'Gecersiz sayfalama imleci', { field: 'cursor' });
}

const conditionFailed = (err: unknown) =>
  err instanceof TransactionCanceledException && (err.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed');

export const bankRepository: BankRepository = {
  getStatement: (apt, id) => getTenantItem<BankStatement>(bankKeys.statement(apt, id)),

  async listStatements(apt) {
    const items = await queryTenantAll<BankStatement>(apt, STATEMENT_PREFIX);
    return items.reverse();
  },

  getFileLock: (apt, sha) => getTenantItem<BankFileLock>(bankKeys.fileLock(apt, sha)),

  async createStatement(statement, lock, audit) {
    const { client, tableName } = getDynamo();
    try {
      await sendWithAudit(
        client,
        [
          { Put: { TableName: tableName, Item: statement, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Put: { TableName: tableName, Item: lock, ConditionExpression: 'attribute_not_exists(PK)' } },
        ],
        audit,
      );
    } catch (err) {
      if (conditionFailed(err)) throw new DataAccessError('conflict', 'Ekstre veya dosya kilidi zaten var', { cause: err });
      throw toDataAccessError(err);
    }
  },

  replaceStatement: (statement, expectedVersion, audit) => auditedPutVersioned(statement, expectedVersion, audit),

  async existingLineKeys(apt, sks) {
    return new Set((await bankRepository.existingLineStatements(apt, sks)).keys());
  },

  async existingLineStatements(apt, sks) {
    const { client, tableName } = getDynamo();
    const pk = tenantPk(apt);
    const found = new Map<string, string>();
    for (const part of chunks([...new Set(sks)], BATCH_GET)) {
      let keys: Record<string, unknown>[] = part.map((SK) => ({ PK: pk, SK }));
      for (let attempt = 0; keys.length && attempt < 6; attempt++) {
        try {
          const out = await client.send(
            new BatchGetCommand({
              RequestItems: {
                [tableName]: {
                  Keys: keys,
                  ProjectionExpression: '#pk, #sk, #stmt',
                  ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK', '#stmt': 'statementId' },
                  ConsistentRead: true,
                },
              },
            }),
          );
          for (const item of out.Responses?.[tableName] ?? []) found.set(item.SK as string, String(item.statementId ?? ''));
          keys = (out.UnprocessedKeys?.[tableName]?.Keys ?? []) as Record<string, unknown>[];
        } catch (err) {
          throw toDataAccessError(err);
        }
        if (keys.length) await sleep(25 * 2 ** attempt);
      }
      if (keys.length) throw new DataAccessError('throttled', 'Veritabani gecici olarak yogun');
    }
    return found;
  },

  async putLinesIfAbsent(apt, lines) {
    const { client, tableName } = getDynamo();
    const pk = tenantPk(apt);
    if (lines.some((l) => l.PK !== pk)) throw new Error('Satirlar baska bir apartmana ait');
    const existing = await bankRepository.existingLineKeys(apt, lines.map((l) => l.SK));
    let existingCount = lines.filter((l) => existing.has(l.SK)).length;
    let written = 0;
    for (const part of chunks(lines.filter((l) => !existing.has(l.SK)), LINE_CHUNK)) {
      let pending = part;
      for (let attempt = 0; pending.length; attempt++) {
        try {
          await client.send(
            new TransactWriteCommand({
              TransactItems: pending.map((Item) => ({ Put: { TableName: tableName, Item, ConditionExpression: 'attribute_not_exists(PK)' } })),
            }),
          );
          written += pending.length;
          pending = [];
        } catch (err) {
          if (!(err instanceof TransactionCanceledException) || attempt >= 4) throw toDataAccessError(err);
          // Es zamanli aktarim ayni satiri yazmis olabilir: o satirlar "mevcut" sayilir, kalanlar tekrar denenir.
          const reasons = err.CancellationReasons ?? [];
          const exists = new Set(pending.filter((_, i) => reasons[i]?.Code === 'ConditionalCheckFailed').map((l) => l.SK));
          existingCount += exists.size;
          pending = pending.filter((l) => !exists.has(l.SK));
          await sleep(20 * (attempt + 1));
        }
      }
    }
    return { written, existing: existingCount };
  },

  async queryLines(apt, q) {
    const { client, tableName } = getDynamo();
    const pk = tenantPk(apt);
    const prefix = linePrefix(q.bankAccountId);
    const filters: string[] = [];
    const names: Record<string, string> = { '#pk': 'PK', '#sk': 'SK' };
    const values: Record<string, unknown> = {
      ':pk': pk,
      ':lo': `${prefix}${q.from ?? '0000-01-01'}`,
      ':hi': `${prefix}${q.to ?? '9999-12-31'}#￿`,
    };
    if (q.status) {
      filters.push('#status = :status');
      names['#status'] = 'status';
      values[':status'] = q.status;
    }
    if (q.statementId) {
      filters.push('#stmt = :stmt');
      names['#stmt'] = 'statementId';
      values[':stmt'] = q.statementId;
    }
    let startKey: Record<string, unknown> | undefined = q.cursor ? decodeCursor(apt, q.bankAccountId, q.cursor) : undefined;
    const items: BankLine[] = [];
    let cursorKey: { PK: string; SK: string } | undefined;
    // Filtre (durum/ekstre) sayfa okunduktan SONRA uygulanir: hedef sayiya ulasana kadar en fazla 10 sayfa.
    for (let page = 0; ; page++) {
      let out: QueryCommandOutput;
      try {
        out = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :lo AND :hi',
            ...(filters.length ? { FilterExpression: filters.join(' AND ') } : {}),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ScanIndexForward: q.order === 'asc',
            Limit: q.limit,
            ...(startKey ? { ExclusiveStartKey: startKey } : {}),
          }),
        );
      } catch (err) {
        throw toDataAccessError(err);
      }
      const pageItems = (out.Items ?? []) as BankLine[];
      const room = q.limit - items.length;
      items.push(...pageItems.slice(0, room));
      startKey = out.LastEvaluatedKey;
      if (pageItems.length > room) {
        // Sayfanin ortasinda durduk: bir sonraki istek son dondurulen satirdan devam eder.
        cursorKey = items[items.length - 1];
        break;
      }
      if (!startKey) break;
      if (items.length >= q.limit || page >= 9) {
        cursorKey = items.length >= q.limit ? items[items.length - 1] : (startKey as { PK: string; SK: string });
        break;
      }
    }
    return { items, ...(cursorKey ? { cursor: encodeCursor(cursorKey) } : {}) };
  },

  getFormat: (apt, acct) => getTenantItem<BankFormat>(bankKeys.format(apt, acct)),

  saveFormat: (format, expectedVersion, audit) =>
    expectedVersion === undefined ? auditedPutNew(format, audit) : auditedPutVersioned(format, expectedVersion, audit),
  // ----- Faz B2 -----

  async getLine(apt, bankAccountId, lineId) {
    const parsed = parseLineId(lineId);
    if (!parsed) return undefined;
    return getTenantItem<BankLine>(bankKeys.line(apt, bankAccountId, parsed.date, parsed.fp));
  },

  listDecisions: (apt, lineId) => queryTenantAll<BankDecision>(apt, decisionPrefix(lineId), { ConsistentRead: true }),

  async writeDecision(line, expectedVersion, decision, audit) {
    const { client, tableName } = getDynamo();
    try {
      await sendWithAudit(
        client,
        [
          { Put: { TableName: tableName, Item: decision, ConditionExpression: 'attribute_not_exists(PK)' } },
          {
            Put: {
              TableName: tableName,
              Item: line,
              ConditionExpression: 'attribute_exists(PK) AND #version = :v',
              ExpressionAttributeNames: { '#version': 'version' },
              ExpressionAttributeValues: { ':v': expectedVersion },
            },
          },
        ],
        audit,
      );
    } catch (err) {
      if (conditionFailed(err)) throw new DataAccessError('conflict', 'Banka satiri baska bir istekle degismis', { cause: err });
      throw toDataAccessError(err);
    }
  },

  getPayer: (apt, mac) => getTenantItem<BankPayer>(bankKeys.payer(apt, mac)),

  listRefs: (apt) => queryTenantAll<BankRef>(apt, REF_PREFIX, { ConsistentRead: true }).then((items) => items.filter((i) => i.entityType === 'BANK_REF')),

  getRefOf: (apt, accountId) => getTenantItem<BankRefOf>(bankKeys.refOf(apt, accountId)),

  async createRef(ref, refOf) {
    const { client, tableName } = getDynamo();
    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: tableName, Item: ref, ConditionExpression: 'attribute_not_exists(PK)' } },
            { Put: { TableName: tableName, Item: refOf, ConditionExpression: 'attribute_not_exists(PK)' } },
          ],
        }),
      );
      return 'created';
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        const reasons = err.CancellationReasons ?? [];
        if (reasons[1]?.Code === 'ConditionalCheckFailed') return 'account_has_code';
        if (reasons[0]?.Code === 'ConditionalCheckFailed') return 'code_taken';
      }
      throw toDataAccessError(err);
    }
  },

  getProfile: (apt, acct) => getTenantItem<BankAccountProfile>(bankKeys.profile(apt, acct)),

  listProfiles: (apt) => queryTenantAll<BankAccountProfile>(apt, PROFILE_PREFIX, { ConsistentRead: true }),

  async saveProfile(profile, expectedVersion, others, audit) {
    const { client, tableName } = getDynamo();
    const versioned = (Item: BankAccountProfile, v: number) => ({
      Put: {
        TableName: tableName,
        Item,
        ConditionExpression: 'attribute_exists(PK) AND #version = :v',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':v': v },
      },
    });
    try {
      await sendWithAudit(
        client,
        [
          expectedVersion === undefined
            ? { Put: { TableName: tableName, Item: profile, ConditionExpression: 'attribute_not_exists(PK)' } }
            : versioned(profile, expectedVersion),
          ...others.map((o) => versioned(o.item, o.expectedVersion)),
        ],
        audit,
      );
    } catch (err) {
      if (conditionFailed(err)) throw new DataAccessError('conflict', 'Hesap profili baska bir istekle degismis', { cause: err });
      throw toDataAccessError(err);
    }
  },
};
