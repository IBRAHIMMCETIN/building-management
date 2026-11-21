import type { Context } from 'hono';

/**
 * JWT claim modeli. Rol ve apartman bilgisi Cognito Pre Token Generation
 * Lambda'sinin aktif baglam icin ekledigi claim'lerden gelir; istek govdesinden
 * veya URL'den asla alinmaz.
 */

export const ROLES = [
  'platform_admin',
  'management_company',
  'apartment_manager',
  'resident',
  'building_staff',
  'security_guard',
  'observer',
] as const;

export type Role = (typeof ROLES)[number];

export type AuthClaims = {
  userId: string;
  role: Role;
  apartmentId?: string;
  organizationId?: string;
  /**
   * Yalnizca sunucu tarafinda (destek erisimi sarmalayicisi) atanir; token'dan okunmaz.
   * Doluysa istek `platform_admin`'in sureli, gerekceli, denetlenen salt okunur erisimidir.
   */
  supportSessionId?: string;
  /**
   * Zorunlu MFA (G2) durumu: Pre Token Lambda'nin `mfa_enabled` / `mfa_required` /
   * `mfa_grace_until` claim'leri. Karari merkezi ara katman (`withMfaPolicy`) verir.
   */
  mfaEnabled?: boolean;
  mfaRequired?: boolean;
  mfaGraceUntil?: string;
};

/** Istekten dogrulanmis claim'leri cikarir; kimlik yoksa null doner. */
export type Authenticator = (c: Context) => Promise<AuthClaims | null> | AuthClaims | null;

/** Varsayilan: kimlik dogrulama baglanmadiysa tum istekler 401 alir. */
export const denyAll: Authenticator = () => null;

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Cognito claim'leri metindir ("true"); JSON/mock token'da boolean da olabilir. */
function flag(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

export function claimsFromRecord(raw: unknown): AuthClaims | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const userId = nonEmpty(r.sub);
  if (!userId || !isRole(r.role)) return null;

  const mfaEnabled = flag(r.mfa_enabled);
  const mfaRequired = flag(r.mfa_required);
  const mfaGraceUntil = nonEmpty(r.mfa_grace_until);
  return {
    userId,
    role: r.role,
    apartmentId: nonEmpty(r.apartmentId),
    organizationId: nonEmpty(r.organizationId),
    ...(mfaEnabled !== undefined ? { mfaEnabled } : {}),
    ...(mfaRequired ? { mfaRequired } : {}),
    ...(mfaGraceUntil ? { mfaGraceUntil } : {}),
  };
}

/**
 * Rolden bagimsiz kimlik. Aktif apartman baglami henuz secilmemis (Pre Token Lambda rol
 * claim'i eklememis) kullanici da kimligi dogrulanmis sayilir; yalnizca baglam secimi
 * icin gereken uclar (`/api/me/*`) bunu kullanir. Diger tum uclar `AuthClaims` ister.
 */
export type AuthIdentity = {
  userId: string;
  email?: string;
  /** `cognito:groups` (yalnizca `platform_admin` anlamlidir). */
  groups: string[];
  /** Token'da gecerli bir baglam varsa (rol + apartman). */
  claims: AuthClaims | null;
};

export type IdentityResolver = (c: Context) => Promise<AuthIdentity | null> | AuthIdentity | null;

export const denyAllIdentity: IdentityResolver = () => null;

export function identityFromRecord(raw: unknown): AuthIdentity | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const userId = nonEmpty(r.sub);
  if (!userId) return null;

  // API Gateway HTTP API dizi claim'lerini "[a b]" metni olarak iletir; JWT'de dizidir.
  const rawGroups = r['cognito:groups'];
  const groups = Array.isArray(rawGroups)
    ? rawGroups.filter((g): g is string => typeof g === 'string')
    : typeof rawGroups === 'string'
      ? rawGroups.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean)
      : [];

  return { userId, email: nonEmpty(r.email), groups, claims: claimsFromRecord(raw) };
}

type GatewayEvent = {
  requestContext?: {
    authorizer?: { jwt?: { claims?: unknown }; claims?: unknown };
  };
};

/**
 * API Gateway (Cognito JWT authorizer) arkasinda, hono/aws-lambda ile calisirken
 * authorizer'in dogruladigi claim'leri okur. HTTP API (v2) ve REST API bicimlerini destekler.
 */
export const apiGatewayAuthenticator: Authenticator = (c) => {
  const env = c.env as { event?: GatewayEvent } | undefined;
  const authorizer = env?.event?.requestContext?.authorizer;
  return claimsFromRecord(authorizer?.jwt?.claims ?? authorizer?.claims);
};

export const apiGatewayIdentityResolver: IdentityResolver = (c) => {
  const env = c.env as { event?: GatewayEvent } | undefined;
  const authorizer = env?.event?.requestContext?.authorizer;
  return identityFromRecord(authorizer?.jwt?.claims ?? authorizer?.claims);
};
