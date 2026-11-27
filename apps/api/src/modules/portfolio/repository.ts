import { BatchGetCommand, type BatchGetCommandOutput } from '@aws-sdk/lib-dynamodb';
import { type GrantItem, queryGrantItems } from '../../auth/preTokenGeneration.js';
import { DataAccessError, getDynamo, toDataAccessError } from '../../config/dynamodb.js';
import { apartmentRoleKeys } from '../apartment-roles/repository.js';
import { coreKeys } from '../core/repository.js';

/**
 * Portfoy yetki okumalari. Yeni anahtar yoktur:
 *  - GSI1 `USER#<sub>` (Pre Token Lambda ve `/api/me/contexts` ile ayni kaynak) -> aday apartmanlar
 *  - taban tablo `APT#<apt>` / `ROLE#<user>#<role>` (BatchGet, ConsistentRead) -> GSI gecikmesine
 *    karsi yeniden dogrulama: bugun biten / pasife alinan rol ayni istekte duser
 *  - `APT#<apt>` / `SITE` (BatchGet) -> apartman adi
 *
 * BatchGet'in islenemeyen anahtarlari ustel bekleme + jitter ile yeniden istenir; yine kalirsa istek
 * 503 ile biter (sessizce dusurulmez: apartman kaybolur, sayfalar kayardi).
 */
export type RoleRecord = GrantItem & { userId?: string };

export type PortfolioRepository = {
  grantItems(userId: string): Promise<GrantItem[]>;
  roleRecords(userId: string, keys: ReadonlyArray<{ apartmentId: string; role: string }>): Promise<RoleRecord[]>;
  siteNames(apartmentIds: readonly string[]): Promise<Map<string, string>>;
};

type BatchClient = { send(command: BatchGetCommand): Promise<BatchGetCommandOutput> };

export type BatchGetDeps = {
  dynamo: () => { client: BatchClient; tableName: string };
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  log: (entry: Record<string, unknown>) => void;
};

const BATCH = 100;
/** Ilk deneme + 4 yeniden deneme; bekleme 50, 100, 200, 400 ms (+ ayni kadar jitter), toplam <= ~1,5 sn. */
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 50;

export async function batchGetAll(
  keys: Record<string, unknown>[],
  request: { projection: string; names: Record<string, string>; consistent: boolean; purpose: string },
  deps: BatchGetDeps,
): Promise<Record<string, unknown>[]> {
  const { client, tableName } = deps.dynamo();
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < keys.length; i += BATCH) {
    let pending: Record<string, unknown>[] = keys.slice(i, i + BATCH);
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt >= MAX_ATTEMPTS) {
        deps.log({ msg: 'portfolio_batch_get_unprocessed', purpose: request.purpose, unprocessed: pending.length, attempts: attempt });
        throw new DataAccessError('throttled', 'Veritabani gecici olarak yogun; lutfen tekrar deneyin');
      }
      if (attempt > 0) {
        const backoff = BASE_DELAY_MS * 2 ** (attempt - 1);
        await deps.sleep(backoff + Math.floor(deps.random() * backoff));
      }
      let res: BatchGetCommandOutput;
      try {
        res = await client.send(
          new BatchGetCommand({
            RequestItems: {
              [tableName]: { Keys: pending, ConsistentRead: request.consistent, ProjectionExpression: request.projection, ExpressionAttributeNames: request.names },
            },
          }),
        );
      } catch (err) {
        throw toDataAccessError(err);
      }
      out.push(...((res.Responses?.[tableName] ?? []) as Record<string, unknown>[]));
      pending = (res.UnprocessedKeys?.[tableName]?.Keys ?? []) as Record<string, unknown>[];
    }
  }
  return out;
}

export function createPortfolioRepository(overrides: Partial<BatchGetDeps> & { grantItems?: PortfolioRepository['grantItems'] } = {}): PortfolioRepository {
  const deps: BatchGetDeps = {
    dynamo: getDynamo,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    random: Math.random,
    log: (entry) => console.error(JSON.stringify(entry)),
    ...overrides,
  };
  return {
    grantItems: overrides.grantItems ?? ((userId) => queryGrantItems(userId)),
    async roleRecords(userId, keys) {
      if (keys.length === 0) return [];
      return (await batchGetAll(
        keys.map((k) => apartmentRoleKeys.role(k.apartmentId, userId, k.role)),
        { projection: 'entityType, apartmentId, userId, #r, #s, startDate, endDate', names: { '#r': 'role', '#s': 'status' }, consistent: true, purpose: 'roles' },
        deps,
      )) as RoleRecord[];
    },
    async siteNames(apartmentIds) {
      const ids = [...new Set(apartmentIds)];
      const names = new Map<string, string>();
      if (ids.length === 0) return names;
      const items = await batchGetAll(ids.map((id) => coreKeys.site(id)), { projection: 'siteId, #n', names: { '#n': 'name' }, consistent: false, purpose: 'sites' }, deps);
      for (const item of items) if (typeof item.siteId === 'string' && typeof item.name === 'string') names.set(item.siteId, item.name);
      return names;
    },
  };
}

export const portfolioRepository: PortfolioRepository = createPortfolioRepository();
