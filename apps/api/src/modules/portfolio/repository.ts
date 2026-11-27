import { BatchGetCommand, type BatchGetCommandOutput } from '@aws-sdk/lib-dynamodb';
import { type GrantItem, queryGrantItems } from '../../auth/preTokenGeneration.js';
import { getDynamo, toDataAccessError } from '../../config/dynamodb.js';
import { apartmentRoleKeys } from '../apartment-roles/repository.js';
import { loadNamesFromDynamo } from '../me/service.js';

/**
 * Portfoy yetki okumalari. Yeni anahtar yoktur:
 *  - GSI1 `USER#<sub>` (Pre Token Lambda ve `/api/me/contexts` ile ayni kaynak) -> aday apartmanlar
 *  - taban tablo `APT#<apt>` / `ROLE#<user>#<role>` (BatchGet, ConsistentRead) -> GSI gecikmesine
 *    karsi yeniden dogrulama: bugun biten / pasife alinan rol ayni istekte duser
 *  - `APT#<apt>` / `SITE` (BatchGet) -> apartman adi
 */
export type RoleRecord = GrantItem & { userId?: string };

export type PortfolioRepository = {
  grantItems(userId: string): Promise<GrantItem[]>;
  roleRecords(userId: string, keys: ReadonlyArray<{ apartmentId: string; role: string }>): Promise<RoleRecord[]>;
  siteNames(apartmentIds: readonly string[]): Promise<Map<string, string>>;
};

const BATCH = 100;

async function batchGetConsistent(keys: Record<string, unknown>[], projection: string, names: Record<string, string>): Promise<Record<string, unknown>[]> {
  const { client, tableName } = getDynamo();
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < keys.length; i += BATCH) {
    let pending: Record<string, unknown>[] | undefined = keys.slice(i, i + BATCH);
    for (let attempt = 0; pending?.length && attempt < 3; attempt++) {
      try {
        const res: BatchGetCommandOutput = await client.send(
          new BatchGetCommand({
            RequestItems: { [tableName]: { Keys: pending, ConsistentRead: true, ProjectionExpression: projection, ExpressionAttributeNames: names } },
          }),
        );
        out.push(...((res.Responses?.[tableName] ?? []) as Record<string, unknown>[]));
        pending = res.UnprocessedKeys?.[tableName]?.Keys;
      } catch (err) {
        throw toDataAccessError(err);
      }
    }
    // Islenemeyen anahtar kalirsa o yetki dogrulanmamis sayilir (kapali-hata: apartman listelenmez).
  }
  return out;
}

export const portfolioRepository: PortfolioRepository = {
  grantItems: (userId) => queryGrantItems(userId),
  async roleRecords(userId, keys) {
    if (keys.length === 0) return [];
    const items = await batchGetConsistent(
      keys.map((k) => apartmentRoleKeys.role(k.apartmentId, userId, k.role)),
      'entityType, apartmentId, userId, #r, #s, startDate, endDate',
      { '#r': 'role', '#s': 'status' },
    );
    return items as RoleRecord[];
  },
  async siteNames(apartmentIds) {
    return (await loadNamesFromDynamo([...apartmentIds], [])).sites;
  },
};
