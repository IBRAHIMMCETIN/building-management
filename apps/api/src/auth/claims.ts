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

export function claimsFromRecord(raw: unknown): AuthClaims | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const userId = nonEmpty(r.sub);
  if (!userId || !isRole(r.role)) return null;

  return {
    userId,
    role: r.role,
    apartmentId: nonEmpty(r.apartmentId),
    organizationId: nonEmpty(r.organizationId),
  };
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
