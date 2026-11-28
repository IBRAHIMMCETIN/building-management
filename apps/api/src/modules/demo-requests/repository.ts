import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamo, toDataAccessError } from '../../config/dynamodb.js';
import { type AuditDraft, sendWithAudit } from '../audit/log.js';
import { ValidationError } from '../core/validation.js';
import type { CounterStore } from './throttle.js';
import type { UnitRange } from './schema.js';

/**
 * Demo talepleri apartman (tenant) bolumunde DEGILDIR: talep sahibi henuz musteri degildir.
 *   PK = `DEMOREQ#<requestId>`, SK = `DEMOREQ`
 *   GSI1PK = `DEMO_REQUEST`, GSI1SK = `<createdAt>#<requestId>`   (platform listesi, en yeni once)
 *   ttl = olusturma + 730 gun (KVKK saklama suresi; DynamoDB TTL siler, uygulamada silme yazimi yok)
 * Silme / spam (KVKK silme talebi, istenmeyen kayit): `DeleteItem` yetkisi olmadigindan kayit
 * `status: deleted | spam` ile yeniden yazilir; kisisel alanlar (ad, e-posta, telefon, site adi, mesaj,
 * maskeli IP) ve GSI1 anahtarlari KALDIRILIR (listeden duser), TTL kalir. Islem platform denetim
 * zincirine ayni atomik yazimda girer.
 * Sayaclar (throttle.ts) `DEMOTHR#...` bolumlerindedir.
 */
export const DEMO_REQUEST_INDEX_PK = 'DEMO_REQUEST';
export const DEMO_REQUEST_RETENTION_DAYS = 730;

export type DemoRequestStatus = 'new' | 'deleted' | 'spam';

export type DemoRequestItem = {
  PK: string;
  SK: 'DEMOREQ';
  entityType: 'DEMO_REQUEST';
  requestId: string;
  fullName?: string;
  email?: string;
  phone?: string;
  organization?: string;
  unitRange: UnitRange;
  message?: string;
  kvkkConsent: true;
  kvkkVersion: string;
  status: DemoRequestStatus;
  /** Platform geneli gunluk olagan hacim asildiginda kaydedilen talep (throttle.ts `softLimit`). */
  suspect?: true;
  /** Kisaltilmis IP (IPv4 /24, IPv6 /48): kotuye kullanim incelemesi icin. */
  ipMasked?: string;
  createdAt: string;
  erasedAt?: string;
  erasedBy?: string;
  ttl: number;
  GSI1PK?: typeof DEMO_REQUEST_INDEX_PK;
  GSI1SK?: string;
};

/** Silme / spamde kaldirilan kisisel alanlar. */
export const DEMO_REQUEST_PII_FIELDS = ['fullName', 'email', 'phone', 'organization', 'message', 'ipMasked'] as const;

export const demoRequestKeys = (requestId: string) => ({ PK: `DEMOREQ#${requestId}`, SK: 'DEMOREQ' as const });

export type DemoRequestPage = { items: DemoRequestItem[]; nextCursor?: string };

export type EraseCommand = { requestId: string; status: 'deleted' | 'spam'; at: string; by: string };

export type DemoRequestRepository = CounterStore & {
  put(item: DemoRequestItem): Promise<void>;
  get(requestId: string): Promise<DemoRequestItem | undefined>;
  list(opts: { limit: number; cursor?: string }): Promise<DemoRequestPage>;
  /** Yalnizca `status = new` kayitta; degilse `false` (zaten silinmis / spam). Denetim ayni yazimda. */
  erase(cmd: EraseCommand, audit: AuditDraft): Promise<boolean>;
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

/** Silme / spam guncellemesi: durum + iz, kisisel alanlar ve liste anahtarlari kaldirilir. */
export function eraseUpdate(cmd: EraseCommand) {
  const names: Record<string, string> = { '#status': 'status', '#erasedAt': 'erasedAt', '#erasedBy': 'erasedBy', '#g1pk': 'GSI1PK', '#g1sk': 'GSI1SK' };
  DEMO_REQUEST_PII_FIELDS.forEach((f, i) => {
    names[`#p${i}`] = f;
  });
  return {
    Key: demoRequestKeys(cmd.requestId),
    UpdateExpression: `SET #status = :status, #erasedAt = :at, #erasedBy = :by REMOVE ${DEMO_REQUEST_PII_FIELDS.map((_, i) => `#p${i}`).join(', ')}, #g1pk, #g1sk`,
    ConditionExpression: 'attribute_exists(PK) AND #status = :new',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: { ':status': cmd.status, ':at': cmd.at, ':by': cmd.by, ':new': 'new' },
  };
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
    async get(requestId) {
      const { client, tableName } = getDynamo();
      try {
        const out = await client.send(new GetCommand({ TableName: tableName, Key: demoRequestKeys(requestId), ConsistentRead: true }));
        return out.Item?.entityType === 'DEMO_REQUEST' ? (out.Item as DemoRequestItem) : undefined;
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
        const items = (out.Items ?? []).filter((i) => i.entityType === 'DEMO_REQUEST' && i.status === 'new') as DemoRequestItem[];
        const nextCursor = encodeCursor(out.LastEvaluatedKey);
        return { items, ...(nextCursor ? { nextCursor } : {}) };
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        throw toDataAccessError(err);
      }
    },
    async erase(cmd, audit) {
      const { client, tableName } = getDynamo();
      const update = { TableName: tableName, ...eraseUpdate(cmd) };
      try {
        // Denetim kapaliysa (yerel) sendWithAudit yalnizca guncellemeyi yazar.
        await sendWithAudit(client, [{ Update: update }], audit);
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        if (err instanceof TransactionCanceledException && err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') return false;
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
