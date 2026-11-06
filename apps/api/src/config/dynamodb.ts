import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  ProvisionedThroughputExceededException,
  RequestLimitExceeded,
  ResourceNotFoundException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';

/**
 * Multi-tenant DynamoDB erisimi (single-table design).
 *
 * Kurallar:
 *  - Kimlik bilgisi koda gomulmez; AWS SDK varsayilan credential zincirini
 *    (Lambda/EC2 rolu, ortam) kullanir.
 *  - Tum kayitlarin partition key'i `APT#<apartmentId>` ile baslar. Tenant
 *    sorgulari yalnizca `queryTenant` uzerinden yapilmalidir; `apartmentId`
 *    istek govdesinden degil, JWT claim'inden gelmelidir.
 *  - Parasal degerler kurus cinsinden tam sayi saklanir (bkz. types.ts).
 */

// ---------------------------------------------------------------------------
// Konfigurasyon
// ---------------------------------------------------------------------------

export type DynamoConfig = {
  tableName: string;
  region: string;
  /** Yalnizca yerel gelistirme (DynamoDB Local / LocalStack) icin. */
  endpoint?: string;
};

export function loadDynamoConfig(env: NodeJS.ProcessEnv = process.env): DynamoConfig {
  const tableName = env.DYNAMODB_TABLE_NAME;
  if (!tableName) {
    throw new Error('DYNAMODB_TABLE_NAME ortam degiskeni tanimli degil');
  }

  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new Error('AWS_REGION ortam degiskeni tanimli degil');
  }

  return {
    tableName,
    region,
    ...(env.DYNAMODB_ENDPOINT ? { endpoint: env.DYNAMODB_ENDPOINT } : {}),
  };
}

// ---------------------------------------------------------------------------
// Istemci (Lambda sicak calisma icin modul seviyesinde tekil)
// ---------------------------------------------------------------------------

export function createDocumentClient(config: DynamoConfig): DynamoDBDocumentClient {
  const base = new DynamoDBClient({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  });

  return DynamoDBDocumentClient.from(base, {
    marshallOptions: {
      removeUndefinedValues: true,
      convertEmptyValues: false,
    },
    unmarshallOptions: {
      wrapNumbers: false,
    },
  });
}

let cached: { config: DynamoConfig; client: DynamoDBDocumentClient } | undefined;

export function getDynamo(): { client: DynamoDBDocumentClient; tableName: string } {
  if (!cached) {
    const config = loadDynamoConfig();
    cached = { config, client: createDocumentClient(config) };
  }
  return { client: cached.client, tableName: cached.config.tableName };
}

/** Testlerde onbellegi temizlemek icin. */
export function resetDynamoCache(): void {
  cached = undefined;
}

// ---------------------------------------------------------------------------
// Anahtar yardimcilari
// ---------------------------------------------------------------------------

export const KEY_SEPARATOR = '#';

/** Bir apartmanin (tenant) partition key'i. */
export function tenantPk(apartmentId: string): string {
  assertId(apartmentId, 'apartmentId');
  return `APT${KEY_SEPARATOR}${apartmentId}`;
}

/** Sort key olusturur: skKey('BLOCK', blockId) -> "BLOCK#<blockId>". */
export function skKey(entity: string, ...parts: string[]): string {
  parts.forEach((p) => assertId(p, 'sk part'));
  return [entity, ...parts].join(KEY_SEPARATOR);
}

function assertId(value: string, label: string): void {
  if (!value || value.includes(KEY_SEPARATOR)) {
    throw new Error(`Gecersiz ${label}: bos olamaz ve '${KEY_SEPARATOR}' iceremez`);
  }
}

// ---------------------------------------------------------------------------
// Tenant'a kilitli sorgu
// ---------------------------------------------------------------------------

export type TenantQueryOptions = Omit<
  QueryCommandInput,
  'TableName' | 'KeyConditionExpression' | 'ExpressionAttributeNames' | 'ExpressionAttributeValues'
> & {
  /** Sort key on eki (ornegin "UNIT#"). Verilmezse tenant'in tum kayitlari. */
  skPrefix?: string;
  filterNames?: Record<string, string>;
  filterValues?: Record<string, unknown>;
};

/**
 * PK her zaman tenant'tan turetilir; cagiranin baska apartmani sorgulamasi
 * yapisal olarak mumkun degildir.
 */
export async function queryTenant<T = Record<string, unknown>>(
  apartmentId: string,
  options: TenantQueryOptions = {},
): Promise<{ items: T[]; lastKey?: QueryCommandOutput['LastEvaluatedKey'] }> {
  // Girdi dogrulamasi en basta ve try/catch disinda: gecersiz apartmentId bir
  // dogrulama hatasi olarak firlatilir, veritabani hatasi (500) olarak sarmalanmaz.
  const pk = tenantPk(apartmentId);

  const { client, tableName } = getDynamo();
  const { skPrefix, filterNames, filterValues, ...rest } = options;

  const hasPrefix = Boolean(skPrefix);

  try {
    const out = await client.send(
      new QueryCommand({
        ...rest,
        TableName: tableName,
        KeyConditionExpression: hasPrefix ? '#pk = :pk AND begins_with(#sk, :skp)' : '#pk = :pk',
        // Rezerve anahtarlar en sonda: filtre alanlari PK kosulunu ezemez.
        ExpressionAttributeNames: { ...filterNames, '#pk': 'PK', '#sk': 'SK' },
        ExpressionAttributeValues: {
          ...filterValues,
          ':pk': pk,
          ...(hasPrefix ? { ':skp': skPrefix } : {}),
        },
      }),
    );
    return { items: (out.Items ?? []) as T[], lastKey: out.LastEvaluatedKey };
  } catch (err) {
    throw toDataAccessError(err);
  }
}

/** Tenant'in bir sort-key on ekli tum kayitlari (sayfalama dongusu ile). */
export async function queryTenantAll<T = Record<string, unknown>>(
  apartmentId: string,
  skPrefix: string,
  options: Omit<TenantQueryOptions, 'skPrefix' | 'ExclusiveStartKey'> = {},
): Promise<T[]> {
  const items: T[] = [];
  let startKey: QueryCommandOutput['LastEvaluatedKey'];

  do {
    const page = await queryTenant<T>(apartmentId, {
      ...options,
      skPrefix,
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    });
    items.push(...page.items);
    startKey = page.lastKey;
  } while (startKey);

  return items;
}

/** Tek kaydi tutarli okuma ile getirir; yoksa undefined. */
export async function getTenantItem<T>(keys: { PK: string; SK: string }): Promise<T | undefined> {
  const { client, tableName } = getDynamo();
  try {
    const out = await client.send(
      new GetCommand({ TableName: tableName, Key: keys, ConsistentRead: true }),
    );
    return out.Item as T | undefined;
  } catch (err) {
    throw toDataAccessError(err);
  }
}

// ---------------------------------------------------------------------------
// Kosullu yazim yardimcilari (yeni kayit / optimistic locking)
// ---------------------------------------------------------------------------

/** Kayit yoksa yazar; varsa `DataAccessError('conflict')`. */
export async function putNewItem(item: { PK: string; SK: string }): Promise<void> {
  const { client, tableName } = getDynamo();
  try {
    await client.send(
      new PutCommand({ TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }),
    );
  } catch (err) {
    throw toDataAccessError(err);
  }
}

/** Kaydin `version` alani `expectedVersion` ise ustune yazar; degilse `conflict`. */
export async function putVersionedItem(
  item: { PK: string; SK: string },
  expectedVersion: number,
): Promise<void> {
  const { client, tableName } = getDynamo();
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': expectedVersion },
      }),
    );
  } catch (err) {
    throw toDataAccessError(err);
  }
}

// ---------------------------------------------------------------------------
// Hata esleme: SDK hatalari -> anlamli HTTP durum kodlari
// ---------------------------------------------------------------------------

export type DataAccessErrorCode =
  | 'conflict'
  | 'not_found'
  | 'transaction_failed'
  | 'throttled'
  | 'internal';

const STATUS_BY_CODE: Record<DataAccessErrorCode, number> = {
  conflict: 409,
  not_found: 404,
  transaction_failed: 409,
  throttled: 503,
  internal: 500,
};

export class DataAccessError extends Error {
  readonly code: DataAccessErrorCode;
  readonly httpStatus: number;

  constructor(code: DataAccessErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DataAccessError';
    this.code = code;
    this.httpStatus = STATUS_BY_CODE[code];
  }
}

export function toDataAccessError(err: unknown): DataAccessError {
  if (err instanceof DataAccessError) return err;

  if (err instanceof ConditionalCheckFailedException) {
    return new DataAccessError('conflict', 'Kosul saglanmadi (kayit mevcut veya surum catismasi)', {
      cause: err,
    });
  }
  if (err instanceof ResourceNotFoundException) {
    return new DataAccessError('not_found', 'Tablo veya kaynak bulunamadi', { cause: err });
  }
  if (err instanceof TransactionCanceledException) {
    const reasons = err.CancellationReasons?.map((r) => r.Code).join(',') ?? 'unknown';
    return new DataAccessError('transaction_failed', `Islem iptal edildi: ${reasons}`, {
      cause: err,
    });
  }
  if (err instanceof ProvisionedThroughputExceededException || err instanceof RequestLimitExceeded) {
    return new DataAccessError('throttled', 'Veritabani gecici olarak yogun', { cause: err });
  }

  return new DataAccessError('internal', 'Beklenmeyen veritabani hatasi', { cause: err });
}
