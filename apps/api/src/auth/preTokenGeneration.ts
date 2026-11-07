import { type DynamoDBDocumentClient, QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { getDynamo } from '../config/dynamodb.js';
import { ROLES, type Role } from './claims.js';

/**
 * Cognito Pre Token Generation mantigi (V1 ve V2 olaylari).
 *
 *  - V1_0 (Lite katmani): claim'ler yalnizca ID token'a eklenebilir -> istemci API'ye ID token
 *    gonderir (API Gateway JWT authorizer `aud` = client id ile dogrular).
 *  - V2_0 (Essentials/Plus): claim'ler access + ID token'a eklenir.
 *
 * Aktif apartman baglamini JWT'ye `apartmentId` + `role` (+ `organizationId`) claim'leri
 * olarak ekler. Rol bilgisi Cognito group'larinda DEGIL, DynamoDB'deki uyelik kayitlarinda
 * tutulur ve GSI1 ile tek sorguda okunur:
 *   GSI1PK = `USER#<sub>`, GSI1SK = `APT#<apartmentId>#...`
 *
 * Kurallar:
 *  - `platform_admin` yalnizca Cognito group'undan gelir (apartman claim'i yok).
 *  - Kullanici aktif apartmani `custom:active_apartment` niteligiyle secer (tercihi
 *    `custom:active_role`). Bu nitelikler istemci tarafindan yazilabilir oldugu icin GUVENILMEZ:
 *    yalnizca kullanicinin o apartmanda aktif bir yetkisi varsa claim uretilir.
 *  - Secim yoksa ve kullanicinin tek apartmani varsa o apartman otomatik secilir.
 *  - Gecerli baglam yoksa rol claim'i eklenmez; API korumali uclarda 401 doner (guvenli varsayilan).
 *  - Ayni apartmanda birden fazla rol varsa tercih gecerliyse o, degilse en yetkili rol secilir.
 *  - Istemcinin gonderebilecegi ayni adli claim'ler her durumda bastirilir.
 */

// ---------------------------------------------------------------------------
// Cognito V2 olay tipleri (yalnizca kullanilan alanlar)
// ---------------------------------------------------------------------------

type ClaimsOverride = {
  claimsToAddOrOverride?: Record<string, string>;
  claimsToSuppress?: string[];
};

export type PreTokenGenerationEvent = {
  version: string;
  triggerSource: string;
  userName: string;
  request: {
    userAttributes: Record<string, string>;
    groupConfiguration?: { groupsToOverride?: string[] };
  };
  response: {
    /** V1_0 yaniti: yalnizca ID token. */
    claimsOverrideDetails?: ClaimsOverride | null;
    /** V2_0 yaniti: access + ID token. */
    claimsAndScopeOverrideDetails?: {
      idTokenGeneration?: ClaimsOverride;
      accessTokenGeneration?: ClaimsOverride & { scopesToAdd?: string[]; scopesToSuppress?: string[] };
      groupOverrideDetails?: unknown;
    } | null;
  };
};

// ---------------------------------------------------------------------------
// Yetki kayitlari (GSI1)
// ---------------------------------------------------------------------------

export const GSI1_NAME_DEFAULT = 'GSI1';
export const userGsi1Pk = (userId: string) => `USER#${userId}`;

/** GSI1 uzerinden okunan herhangi bir yetki kaydi. */
export type GrantItem = {
  entityType?: string;
  apartmentId?: string;
  organizationId?: string;
  role?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
};

export type Grant = { apartmentId: string; role: Exclude<Role, 'platform_admin'>; organizationId?: string };

/** Ayni apartmanda birden fazla rol varsa varsayilan secim sirasi. */
export const ROLE_PRECEDENCE: readonly Grant['role'][] = [
  'apartment_manager',
  'management_company',
  'observer',
  'building_staff',
  'security_guard',
  'resident',
];

const CONTEXT_CLAIMS = ['role', 'apartmentId', 'organizationId'] as const;

export function isCurrent(item: GrantItem, today: string): boolean {
  return (
    item.status === 'active' &&
    (!item.startDate || item.startDate <= today) &&
    (!item.endDate || item.endDate >= today)
  );
}

/**
 * Ham kayitlari yetkiye cevirir:
 *  - `UNIT_MEMBERSHIP` (malik/kiraci) -> `resident`
 *  - `APARTMENT_ROLE` (yonetici/personel) -> kayittaki rol (`platform_admin` ve `resident` haric)
 * Diger kayit turleri yok sayilir (GSI1'e ileride eklenecek baska kayitlar yetki vermez).
 */
export function toGrants(items: GrantItem[], today: string): Grant[] {
  const grants: Grant[] = [];
  for (const item of items) {
    if (!item.apartmentId || !isCurrent(item, today)) continue;
    if (item.entityType === 'UNIT_MEMBERSHIP') {
      grants.push({ apartmentId: item.apartmentId, role: 'resident' });
      continue;
    }
    const role = item.role;
    if (
      item.entityType === 'APARTMENT_ROLE' &&
      role &&
      role !== 'platform_admin' &&
      role !== 'resident' &&
      (ROLES as readonly string[]).includes(role)
    ) {
      grants.push({
        apartmentId: item.apartmentId,
        role: role as Grant['role'],
        organizationId: item.organizationId,
      });
    }
  }
  return grants;
}

/** Tercihlere ve yetkilere gore aktif baglami secer; yoksa undefined. */
export function selectContext(
  grants: Grant[],
  preferred: { apartmentId?: string; role?: string },
): Grant | undefined {
  const apartments = [...new Set(grants.map((g) => g.apartmentId))];
  const apartmentId =
    preferred.apartmentId && apartments.includes(preferred.apartmentId)
      ? preferred.apartmentId
      : apartments.length === 1
        ? apartments[0]
        : undefined;
  if (!apartmentId) return undefined;

  const inApartment = grants.filter((g) => g.apartmentId === apartmentId);
  const byPreference = inApartment.find((g) => g.role === preferred.role);
  if (byPreference) return byPreference;
  return [...inApartment].sort(
    (a, b) => ROLE_PRECEDENCE.indexOf(a.role) - ROLE_PRECEDENCE.indexOf(b.role),
  )[0];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export type PreTokenDeps = {
  /** Kullanicinin tum GSI1 kayitlari. */
  loadGrantItems: (userId: string) => Promise<GrantItem[]>;
  now: () => Date;
  log: Pick<Console, 'info'>;
};

export async function queryGrantItems(
  userId: string,
  indexName = process.env.GSI1_NAME ?? GSI1_NAME_DEFAULT,
  dynamo: { client: Pick<DynamoDBDocumentClient, 'send'>; tableName: string } = getDynamo(),
): Promise<GrantItem[]> {
  const items: GrantItem[] = [];
  let startKey: QueryCommandOutput['LastEvaluatedKey'];
  do {
    const out = (await dynamo.client.send(
      new QueryCommand({
        TableName: dynamo.tableName,
        IndexName: indexName,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'GSI1PK' },
        ExpressionAttributeValues: { ':pk': userGsi1Pk(userId) },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    )) as QueryCommandOutput;
    items.push(...((out.Items ?? []) as GrantItem[]));
    startKey = out.LastEvaluatedKey;
  } while (startKey);
  return items;
}

export function createPreTokenHandler(overrides: Partial<PreTokenDeps> = {}) {
  const deps: PreTokenDeps = {
    loadGrantItems: (userId) => queryGrantItems(userId),
    now: () => new Date(),
    log: console,
    ...overrides,
  };

  return async (event: PreTokenGenerationEvent): Promise<PreTokenGenerationEvent> => {
    const attrs = event.request.userAttributes ?? {};
    const userId = attrs.sub;
    const groups = event.request.groupConfiguration?.groupsToOverride ?? [];

    let claims: Record<string, string> = {};
    if (groups.includes('platform_admin')) {
      claims = { role: 'platform_admin' };
    } else if (userId) {
      // Hata firlatilirsa (DynamoDB erisilemiyor) giris basarisiz olur: kapali-hata (fail closed).
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());
      const grants = toGrants(await deps.loadGrantItems(userId), today);
      const selected = selectContext(grants, {
        apartmentId: attrs['custom:active_apartment'],
        role: attrs['custom:active_role'],
      });
      if (selected) {
        claims = {
          role: selected.role,
          apartmentId: selected.apartmentId,
          ...(selected.organizationId ? { organizationId: selected.organizationId } : {}),
        };
      }
      deps.log.info(
        JSON.stringify({
          msg: 'pre_token_context',
          trigger: event.triggerSource,
          grants: grants.length,
          role: claims.role ?? null,
          apartmentId: claims.apartmentId ?? null,
        }),
      );
    }

    const suppress = CONTEXT_CLAIMS.filter((name) => !(name in claims));
    const override: ClaimsOverride = {
      claimsToAddOrOverride: claims,
      ...(suppress.length ? { claimsToSuppress: [...suppress] } : {}),
    };
    // Cognito V1_0 tetikleyicisine version "1", V2_0'a "2" gonderir.
    event.response =
      event.version === '1'
        ? { claimsOverrideDetails: override }
        : {
            claimsAndScopeOverrideDetails: {
              idTokenGeneration: override,
              accessTokenGeneration: override,
            },
          };
    return event;
  };
}
