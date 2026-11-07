import { BatchGetCommand, type BatchGetCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { AuthIdentity, Role } from '../../auth/claims.js';
import {
  type Grant,
  type GrantItem,
  ROLE_PRECEDENCE,
  isCurrent,
  queryGrantItems,
  toGrants,
} from '../../auth/preTokenGeneration.js';
import { getDynamo, toDataAccessError } from '../../config/dynamodb.js';
import { coreKeys } from '../core/repository.js';
import type { UnitRelation } from '../portal/types.js';

/**
 * Kullanicinin secebilecegi apartman/rol baglamlari. Kaynak, Pre Token Generation
 * Lambda'sinin kullandigi GSI1 kayitlarinin AYNISIDIR (`toGrants`); boylece listede
 * gorunen her secim token yenilendiginde gercekten claim uretir.
 */

export type ContextUnit = { unitId: string; unitNumber?: string; relation: UnitRelation };

export type SelectableContext = {
  apartmentId: string;
  apartmentName: string;
  role: Grant['role'];
  organizationId?: string;
  /** Yalnizca `resident`: hangi dairede malik/kiraci oldugu. */
  units?: ContextUnit[];
};

export type MeContexts = {
  userId: string;
  email?: string;
  /** platform_admin, Cognito group'undan gelir ve apartman secimini gecersiz kilar. */
  isPlatformAdmin: boolean;
  /** Token'daki aktif baglam (yoksa secim gerekli). */
  active: { role: Role; apartmentId?: string; organizationId?: string } | null;
  contexts: SelectableContext[];
};

type MembershipGrantItem = GrantItem & { unitId?: string; relation?: string };

type NameLookup = {
  /** apartmentId -> site adi */
  sites: Map<string, string>;
  /** `${apartmentId}|${unitId}` -> daire numarasi */
  units: Map<string, string>;
};

export type MeDeps = {
  loadGrantItems: (userId: string) => Promise<MembershipGrantItem[]>;
  loadNames: (apartmentIds: string[], units: Array<{ apartmentId: string; unitId: string }>) => Promise<NameLookup>;
  now: () => Date;
};

export type MeService = { contexts(identity: AuthIdentity): Promise<MeContexts> };

const istanbulDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(d);

/** Saf fonksiyon: ham kayitlar + adlar -> secilebilir baglamlar (birim testlenir). */
export function buildContexts(items: MembershipGrantItem[], today: string, names: NameLookup): SelectableContext[] {
  const byKey = new Map<string, SelectableContext>();
  for (const grant of toGrants(items, today)) {
    const key = `${grant.apartmentId}|${grant.role}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      apartmentId: grant.apartmentId,
      apartmentName: names.sites.get(grant.apartmentId) ?? grant.apartmentId,
      role: grant.role,
      ...(grant.organizationId ? { organizationId: grant.organizationId } : {}),
    });
  }

  for (const item of items) {
    if (item.entityType !== 'UNIT_MEMBERSHIP' || !item.apartmentId || !item.unitId) continue;
    if (!isCurrent(item, today)) continue;
    if (item.relation !== 'owner' && item.relation !== 'tenant') continue;
    const ctx = byKey.get(`${item.apartmentId}|resident`);
    if (!ctx) continue;
    (ctx.units ??= []).push({
      unitId: item.unitId,
      unitNumber: names.units.get(`${item.apartmentId}|${item.unitId}`),
      relation: item.relation,
    });
  }

  return [...byKey.values()].sort(
    (a, b) =>
      a.apartmentName.localeCompare(b.apartmentName, 'tr') ||
      ROLE_PRECEDENCE.indexOf(a.role) - ROLE_PRECEDENCE.indexOf(b.role),
  );
}

/** Site adlari ve daire numaralari tek BatchGet turunda (100'luk parcalar) okunur. */
export async function loadNamesFromDynamo(
  apartmentIds: string[],
  units: Array<{ apartmentId: string; unitId: string }>,
): Promise<NameLookup> {
  const result: NameLookup = { sites: new Map(), units: new Map() };
  const keys = [
    ...[...new Set(apartmentIds)].map((id) => coreKeys.site(id)),
    ...units.map((u) => coreKeys.unit(u.apartmentId, u.unitId)),
  ];
  if (keys.length === 0) return result;

  const { client, tableName } = getDynamo();
  for (let i = 0; i < keys.length; i += 100) {
    let pending: Record<string, unknown>[] | undefined = keys.slice(i, i + 100);
    for (let attempt = 0; pending?.length && attempt < 3; attempt++) {
      try {
        const out: BatchGetCommandOutput = await client.send(
          new BatchGetCommand({
            RequestItems: {
              [tableName]: {
                Keys: pending,
                ProjectionExpression: 'siteId, unitId, #n, #num',
                ExpressionAttributeNames: { '#n': 'name', '#num': 'number' },
              },
            },
          }),
        );
        for (const item of out.Responses?.[tableName] ?? []) {
          if (typeof item.unitId === 'string' && typeof item.siteId === 'string' && typeof item.number === 'string') {
            result.units.set(`${item.siteId}|${item.unitId}`, item.number);
          } else if (typeof item.siteId === 'string' && typeof item.name === 'string') {
            result.sites.set(item.siteId, item.name);
          }
        }
        pending = out.UnprocessedKeys?.[tableName]?.Keys;
      } catch (err) {
        throw toDataAccessError(err);
      }
    }
  }
  return result;
}

export function createMeService(overrides: Partial<MeDeps> = {}): MeService {
  const deps: MeDeps = {
    loadGrantItems: (userId) => queryGrantItems(userId),
    loadNames: loadNamesFromDynamo,
    now: () => new Date(),
    ...overrides,
  };

  return {
    async contexts(identity) {
      const items = await deps.loadGrantItems(identity.userId);
      const today = istanbulDate(deps.now());
      const current = items.filter((i) => i.apartmentId && isCurrent(i, today));
      const names = await deps.loadNames(
        current.map((i) => i.apartmentId as string),
        current
          .filter((i) => i.entityType === 'UNIT_MEMBERSHIP' && i.unitId)
          .map((i) => ({ apartmentId: i.apartmentId as string, unitId: i.unitId as string })),
      );

      const claims = identity.claims;
      return {
        userId: identity.userId,
        ...(identity.email ? { email: identity.email } : {}),
        isPlatformAdmin: identity.groups.includes('platform_admin'),
        active: claims
          ? {
              role: claims.role,
              ...(claims.apartmentId ? { apartmentId: claims.apartmentId } : {}),
              ...(claims.organizationId ? { organizationId: claims.organizationId } : {}),
            }
          : null,
        contexts: buildContexts(items, today, names),
      };
    },
  };
}
