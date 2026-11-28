import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamo, toDataAccessError } from '../../config/dynamodb.js';
import { ValidationError } from '../core/validation.js';
import type { CounterStore } from './throttle.js';
import type { UnitRange } from './schema.js';

/**
 * Demo talepleri apartman (tenant) bolumunde DEGILDIR: talep sahibi henuz musteri degildir.
 *   PK = `DEMOREQ#<requestId>`, SK = `DEMOREQ`
 *   GSI1PK = `DEMO_REQUEST`, GSI1SK = `<createdAt>#<requestId>`   (platform listesi, en yeni once)
 *   ttl = olusturma + 730 gun (KVKK saklama suresi; DynamoDB TTL siler, uygulamada silme yazimi yok)
 * Sayaclar (throttle.ts) `DEMOTHR#...` bolumlerindedir.
 */
export const DEMO_REQUEST_INDEX_PK = 'DEMO_REQUEST';
export const DEMO_REQUEST_RETENTION_DAYS = 730;

export type DemoRequestItem = {
  PK: string;
  SK: 'DEMOREQ';
  entityType: 'DEMO_REQUEST';
  requestId: string;
  fullName: string;
  email: string;
  phone?: string;
  organization: string;
  unitRange: UnitRange;
  message?: string;
  kvkkConsent: true;
  kvkkVersion: string;
  status: 'new';
  /** Kisaltilmis IP (IPv4 /24, IPv6 /48) ve User-Agent: kotuye kullanim incelemesi icin. */
  ipMasked?: string;
  userAgent?: string;
  createdAt: string;
  ttl: number;
  GSI1PK: typeof DEMO_REQUEST_INDEX_PK;
  GSI1SK: string;
};

export const demoRequestKeys = (requestId: string) => ({ PK: `DEMOREQ#${requestId}`, SK: 'DEMOREQ' as const });

export type DemoRequestPage = { items: DemoRequestItem[]; nextCursor?: string };

export type DemoRequestRepository = CounterStore & {
  put(item: DemoRequestItem): Promise<void>;
  list(opts: { limit: number; cursor?: string }): Promise<DemoRequestPage>;
};

type Cursor = { PK: string; SK: string; GSI1PK: string; GSI1SK: string };

export function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  if (!key) return undefined;
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Yalnizca bu listenin urettigi bicim kabul edilir (baska bolume ExclusiveStartKey verilemez). */
export function decodeCursor(cursor: string): Cursor {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    const keys = Object.keys(raw).sort().join(',');
    if (
      keys === 'GSI1PK,GSI1SK,PK,SK' &&
      raw.GSI1PK === DEMO_REQUEST_INDEX_PK &&
      typeof raw.PK === 'string' &&
      raw.PK.startsWith('DEMOREQ#') &&
      raw.SK === 'DEMOREQ' &&
      typeof raw.GSI1SK === 'string' &&
      raw.GSI1SK.length <= 120
    ) {
      return raw as Cursor;
    }
  } catch {
    // asagida
  }
  throw new ValidationError('cursor gecersiz', 'cursor');
}

export function createDemoRequestRepository(): DemoRequestRepository {
  return {
    async put(item) {
      const { client, tableName } = getDynamo();
      try {
        await client.send(new PutCommand({ TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    async list({ limit, cursor }) {
      const { client, tableName } = getDynamo();
      try {
        const out = await client.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: 'GSI1',
            KeyConditionExpression: 'GSI1PK = :pk',
            ExpressionAttributeValues: { ':pk': DEMO_REQUEST_INDEX_PK },
            ScanIndexForward: false,
            Limit: limit,
            ...(cursor ? { ExclusiveStartKey: decodeCursor(cursor) } : {}),
          }),
        );
        const items = (out.Items ?? []).filter((i) => i.entityType === 'DEMO_REQUEST') as DemoRequestItem[];
        const nextCursor = encodeCursor(out.LastEvaluatedKey);
        return { items, ...(nextCursor ? { nextCursor } : {}) };
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        throw toDataAccessError(err);
      }
    },
    async hit(pk, sk, opts) {
      const { client, tableName } = getDynamo();
      try {
        const out = await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: pk, SK: sk },
            UpdateExpression: 'ADD #count :one SET #et = :et, #ttl = if_not_exists(#ttl, :ttl)',
            ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
            ExpressionAttributeNames: { '#count': 'count', '#et': 'entityType', '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':one': 1, ':et': 'DEMO_THROTTLE', ':ttl': opts.ttl, ':limit': opts.limit },
            ReturnValues: 'UPDATED_NEW',
          }),
        );
        return { ok: true, count: Number(out.Attributes?.count ?? 1) };
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return { ok: false, count: opts.limit };
        throw toDataAccessError(err);
      }
    },
  };
}
